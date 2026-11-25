import { deal, Err, Ok, StreamCloseCodes } from '@araminix/lib';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MessageChannel } from 'worker_threads';

import type AgentController from '../src/agent/AgentController.js';
import Fragment from '../src/builder/Fragment.js';
import panel from '../src/builder/Panel.js';
import { ActivityInterface } from '../src/executor/ActivityInstance.js';
import { ActivityDriver, AppError, AppInstance } from '../src/executor/AppInstance.js';
import Instance from '../src/executor/Instance.js';
import { AgentList, Data, deserialize, SendPush, SendUpdate } from '../src/executor/proto.js';
import { initWorkerDriver } from '../src/executor/workerDriver.js';
import { Nothing, UpdateTypes } from '../src/lib/actors.js';
import { Rej, RequestSocket, Res, ResponseSocket } from '../src/lib/worker_socket.js';

class CounterFragment extends Fragment<{ styles?: string[] }, { count: number }> {
    static readonly typeName = 'CounterFragment';
    private count = 0;

    constructor() {
        super({});
        this.onAction('reload', () => this.$reload());
        this.onAction('patch', (delta: number) => {
            this.count += delta;
            return this.$patch({ count: this.count });
        });
        this.onAction('full', (value: number) => {
            this.count = value;
            return this.$update({ count: this.count });
        });
    }

    load(): { count: number } {
        return { count: this.count };
    }
}

describe('SendUpdate monotonic sequence ordering', () => {
    it('emits strictly increasing seq values (1, 2, 3, ...) per fragment on sequential sendUpdate calls', async () => {
        const sent: SendUpdate[] = [];
        initWorkerDriver('user-1', null, 'app', {
            writeRead: async (request: unknown) => {
                if (request instanceof SendUpdate) {
                    sent.push(request);
                }
                return new Ok(new Res());
            },
            close: () => undefined,
        } as any);

        const app = { isActive: () => true } as unknown as AppInstance;
        const driver = new ActivityDriver(app, {} as any);

        await driver.sendUpdate('frag-a', UpdateTypes.Full, { v: 1 });
        await driver.sendUpdate('frag-a', UpdateTypes.Patch, { v: 2 });
        await driver.sendUpdate('frag-b', UpdateTypes.Full, { other: true });
        await driver.sendUpdate('frag-a', UpdateTypes.Patch, { v: 3 });
        await driver.sendUpdate('frag-b', UpdateTypes.Patch, { other: false });

        assert.deepStrictEqual(
            sent.filter((u) => u.data.fragmentId === 'frag-a').map((u) => u.data.seq),
            [1, 2, 3],
        );
        assert.deepStrictEqual(
            sent.filter((u) => u.data.fragmentId === 'frag-b').map((u) => u.data.seq),
            [1, 2],
        );
    });

    it('does not advance seq when inactive, and keeps seq monotonic across failed sends', async () => {
        const sent: SendUpdate[] = [];
        let failNext = false;
        initWorkerDriver('user-1', null, 'app', {
            writeRead: async (request: unknown) => {
                if (request instanceof SendUpdate) {
                    sent.push(request);
                }
                if (failNext) {
                    failNext = false;
                    return new Err(new Rej());
                }
                return new Ok(new Res());
            },
            close: () => undefined,
        } as any);

        let isActive = true;
        const app = { isActive: () => isActive } as unknown as AppInstance;
        const driver = new ActivityDriver(app, {} as any);

        const r1 = await driver.sendUpdate('frag-1', UpdateTypes.Full, { step: 1 });
        assert.ok(r1.isOk());

        isActive = false;
        const inactiveRes = await driver.sendUpdate('frag-1', UpdateTypes.Patch, { step: 'ignored' });
        assert.ok(inactiveRes.isErr());
        assert.strictEqual(inactiveRes.e, AppError.NonActive);

        isActive = true;
        failNext = true;
        const failedRes = await driver.sendUpdate('frag-1', UpdateTypes.Patch, { step: 2 });
        assert.ok(failedRes.isErr());
        assert.strictEqual(failedRes.e, AppError.Other);

        const r3 = await driver.sendUpdate('frag-1', UpdateTypes.Patch, { step: 3 });
        assert.ok(r3.isOk());

        assert.deepStrictEqual(
            sent.map((u) => u.data.seq),
            [1, 2, 3],
            'seq skips inactive attempts and leaves a detectable gap when delivery fails',
        );
    });

    it('emits monotonic seq values through AppInstance fragment actions ($reload, $patch, $update)', async () => {
        const updates: SendUpdate[] = [];
        initWorkerDriver('user-1', null, 'app', {
            writeRead: async (request: unknown) => {
                if (request instanceof SendUpdate) {
                    updates.push(request);
                }
                return new Ok(new Res());
            },
            close: () => undefined,
        } as any);

        let fragmentId = '';
        const mainPage: any = {
            _init: () =>
                new ActivityInterface(
                    mainPage,
                    () => new Nothing(),
                    () => undefined,
                    () => undefined,
                    async () => {
                        await panel(() => {
                            const f = new CounterFragment();
                            fragmentId = f.id;
                        });
                    },
                    () => 'Counter',
                    () => undefined,
                ),
        };

        const app = new AppInstance({ main: mainPage } as any, 12);
        await app.init();
        await app.load();
        assert.ok(fragmentId);

        assert.ok((await app.action(fragmentId, 'reload', undefined)).isOk());
        assert.ok((await app.action(fragmentId, 'patch', 1)).isOk());
        assert.ok((await app.action(fragmentId, 'full', 10)).isOk());

        assert.strictEqual(updates.length, 3);
        assert.deepStrictEqual(
            updates.map((u) => ({ type: u.data.type, data: u.data.data, seq: u.data.seq })),
            [
                { type: UpdateTypes.Full, data: { count: 0 }, seq: 1 },
                { type: UpdateTypes.Patch, data: { count: 1 }, seq: 2 },
                { type: UpdateTypes.Full, data: { count: 10 }, seq: 3 },
            ],
        );
    });
});

/** Wires an Instance's responseLoop directly to a MessageChannel + fake client Socket without spawning a worker thread. */
function attachResponseLoop(instance: Instance, userSocket: any): { workerRequest: RequestSocket; cleanup: () => void } {
    const channel = new MessageChannel();
    const workerRequest = new RequestSocket(channel.port1, deserialize);
    const responseSocket = new ResponseSocket(channel.port2, deserialize);
    (instance as any).responseSocket = responseSocket;
    (instance as any).userSocket = userSocket;
    (instance as any).status = 2; // Status.Initiated
    (instance as any).responseLoop().then();
    return {
        workerRequest,
        cleanup: () => {
            workerRequest.close();
            instance.destroy();
        },
    };
}

describe('Instance.outgoingStream timeout and SendUpdate forwarding', () => {
    it('defaults outgoingStreamTimeoutMs to 10_000 ms', () => {
        const instance = new Instance('user-1', 'app', null, new URL('file:///dummy/apps.js'), 12, {} as AgentController);
        assert.strictEqual(instance.outgoingStreamTimeoutMs, 10_000);
    });

    it('forwards { data, type, seq } on update-<fragmentId> and remains backward-compatible without seq', async () => {
        const received: Array<{ name: string; arg: unknown }> = [];
        const userSocket = {
            outgoingStream: async (name: string, arg: unknown) => {
                received.push({ name, arg });
                return new Ok({
                    waitClose: async () => StreamCloseCodes.Normal,
                    closeErr: () => undefined,
                });
            },
            destroy: () => undefined,
        };

        const instance = new Instance('user-1', 'app', null, new URL('file:///dummy/apps.js'), 12, {} as AgentController, undefined, 50, 0, 500);
        const { workerRequest, cleanup } = attachResponseLoop(instance, userSocket);
        try {
            const res1 = await workerRequest.writeRead(new SendUpdate({ activityId: 'act-1', fragmentId: 'frag-42', type: UpdateTypes.Patch, data: { a: 1 }, seq: 1 }));
            assert.ok(res1.isOk());

            const res2 = await workerRequest.writeRead(new SendUpdate({ activityId: 'act-1', fragmentId: 'frag-42', type: UpdateTypes.Full, data: { a: 2 }, seq: 2 }));
            assert.ok(res2.isOk());

            const legacyRes = await workerRequest.writeRead(new SendUpdate({ activityId: 'act-1', fragmentId: 'frag-legacy', type: UpdateTypes.Full, data: { old: true } }));
            assert.ok(legacyRes.isOk());

            assert.deepStrictEqual(received, [
                { name: 'update-frag-42', arg: { data: { a: 1 }, type: UpdateTypes.Patch, seq: 1 } },
                { name: 'update-frag-42', arg: { data: { a: 2 }, type: UpdateTypes.Full, seq: 2 } },
                { name: 'update-frag-legacy', arg: { data: { old: true }, type: UpdateTypes.Full } },
            ]);
        } finally {
            cleanup();
        }
    });

    it('times out a client that accepts a stream but never closes it, closes with closeErr, replies Rej, and unblocks responseLoop', async () => {
        let closeErrCalls = 0;
        const delivered: Array<{ name: string; arg: unknown }> = [];
        let callIndex = 0;

        const userSocket = {
            outgoingStream: async (name: string, arg: unknown) => {
                callIndex++;
                delivered.push({ name, arg });
                if (callIndex === 1) {
                    // Accepted stream whose client never closes it; closeErr transitions it to StreamCloseCodes.Error.
                    const [closePromise, resolveClose] = deal<StreamCloseCodes>();
                    return new Ok({
                        waitClose: () => closePromise,
                        closeErr: () => {
                            closeErrCalls++;
                            resolveClose(StreamCloseCodes.Error);
                        },
                    });
                }
                return new Ok({
                    waitClose: async () => StreamCloseCodes.Normal,
                    closeErr: () => undefined,
                });
            },
            destroy: () => undefined,
        };

        const agentController = {
            list: (type: string) => [`${type}-1`],
        } as unknown as AgentController;

        const timeoutMs = 60;
        const instance = new Instance('user-1', 'app', null, new URL('file:///dummy/apps.js'), 12, agentController, undefined, 50, 0, timeoutMs);
        const { workerRequest, cleanup } = attachResponseLoop(instance, userSocket);

        try {
            const startedAt = Date.now();
            const stalled = await workerRequest.writeRead(new SendUpdate({ activityId: 'act-1', fragmentId: 'frag-1', type: UpdateTypes.Patch, data: { n: 1 }, seq: 1 }));
            const elapsedMs = Date.now() - startedAt;

            assert.ok(stalled.isErr(), 'stalled stream must reject the worker request');
            assert.ok(stalled.e instanceof Rej, 'worker must receive a Rej reply');
            assert.strictEqual(closeErrCalls, 1, 'stalled stream must be closed with closeErr()');
            assert.ok(elapsedMs < 1000, `expected timeout near ${timeoutMs}ms, took ${elapsedMs}ms`);

            // Subsequent responseLoop messages (both another outgoing stream and an agent IPC request) proceed normally.
            const nextUpdate = await workerRequest.writeRead(new SendUpdate({ activityId: 'act-1', fragmentId: 'frag-1', type: UpdateTypes.Patch, data: { n: 2 }, seq: 2 }));
            assert.ok(nextUpdate.isOk(), 'subsequent outgoing stream should succeed after timeout');

            const agentListRes = await workerRequest.writeRead<AgentList, Data<string[]>>(new AgentList('printer'));
            assert.ok(agentListRes.isOk(), 'subsequent non-stream responseLoop request should succeed');
            assert.deepStrictEqual(agentListRes.unwrap().data, ['printer-1']);

            assert.strictEqual(delivered.length, 2);
            assert.deepStrictEqual(delivered[1], {
                name: 'update-frag-1',
                arg: { data: { n: 2 }, type: UpdateTypes.Patch, seq: 2 },
            });
        } finally {
            cleanup();
        }
    });

    it('times out when userSocket.outgoingStream itself stalls and closes any late-accepted stream with closeErr', async () => {
        let lateCloseErrCalls = 0;
        const [lateOpenPromise, resolveLateOpen] = deal<any>();
        let callIndex = 0;

        const userSocket = {
            outgoingStream: async () => {
                callIndex++;
                if (callIndex === 1) {
                    return lateOpenPromise;
                }
                return new Ok({
                    waitClose: async () => StreamCloseCodes.Normal,
                    closeErr: () => undefined,
                });
            },
            destroy: () => undefined,
        };

        const timeoutMs = 60;
        const instance = new Instance('user-1', 'app', null, new URL('file:///dummy/apps.js'), 12, {} as AgentController, undefined, 50, 0, timeoutMs);
        const { workerRequest, cleanup } = attachResponseLoop(instance, userSocket);

        try {
            const stalled = await workerRequest.writeRead(new SendPush({ msg: 'stuck-open' }));
            assert.ok(stalled.isErr());
            assert.ok(stalled.e instanceof Rej);

            // Simulate the client accepting the first stream after the timeout has already fired.
            resolveLateOpen(
                new Ok({
                    waitClose: async () => StreamCloseCodes.Error,
                    closeErr: () => {
                        lateCloseErrCalls++;
                    },
                }),
            );
            await new Promise((resolve) => setTimeout(resolve, 10));
            assert.strictEqual(lateCloseErrCalls, 1, 'late-accepted stream after timeout must be closed with closeErr()');

            // Subsequent push proceeds immediately.
            const nextPush = await workerRequest.writeRead(new SendPush({ msg: 'recovered' }));
            assert.ok(nextPush.isOk());
        } finally {
            cleanup();
        }
    });
});
