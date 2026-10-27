import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { MessageChannel } from 'worker_threads';

import AgentController, { AgentInstance } from '../src/agent/AgentController.js';
import builder from '../src/builder/builder.js';
import Fragment from '../src/builder/Fragment.js';
import panel from '../src/builder/Panel.js';
import { AgentPost, Data } from '../src/executor/proto.js';
import { Rej, Req, RequestSocket, Res, ResponseSocket } from '../src/lib/worker_socket.js';
import { AgentInfo } from '../src/server/AuthProvider.js';
import EndpointController from '../src/server/EndpointController.js';

class CustomReq extends Req {
    payload: string;
    constructor(payload: string) {
        super();
        this.payload = payload;
    }
}

class CustomRes extends Res {
    answer: number;
    constructor(answer: number) {
        super();
        this.answer = answer;
    }
}

function deserialize(data: any): Req | Res | Rej | undefined {
    if (!data) return undefined;
    if (data._type === 'CustomReq') return new CustomReq(data.payload);
    if (data._type === 'CustomRes') return new CustomRes(data.answer);
    if (data._type === 'Res') return new Res();
    if (data._type === 'Rej') return new Rej();
    return undefined;
}

describe('Worker IPC timeouts and correlation', () => {
    it('times out a slow request, ignores its late reply and answers the next request correctly', async () => {
        const channel = new MessageChannel();
        const requester = new RequestSocket(channel.port1, deserialize, 50);
        const responder = new ResponseSocket(channel.port2, deserialize);

        const first = await requester.writeRead<CustomReq, CustomRes>(new CustomReq('slow'));
        assert.ok(first.isErr(), 'the first request times out');

        const secondPromise = requester.writeRead<CustomReq, CustomRes>(new CustomReq('fast'), 2000);

        const slow = await responder.read<CustomReq>();
        assert.strictEqual(slow.unwrap().payload, 'slow');
        responder.resolve(new CustomRes(1));

        const fast = await responder.read<CustomReq>();
        assert.strictEqual(fast.unwrap().payload, 'fast');
        responder.resolve(new CustomRes(2));

        const second = await secondPromise;
        assert.ok(second.isOk());
        assert.strictEqual(second.unwrap().answer, 2, 'the late reply to "slow" must not be taken as the answer to "fast"');

        requester.close();
        responder.close();
    });

    it('answers with Rej when the response cannot be cloned instead of leaving the requester waiting', async () => {
        const channel = new MessageChannel();
        const requester = new RequestSocket(channel.port1, deserialize);
        const responder = new ResponseSocket(channel.port2, deserialize);

        const pending = requester.writeRead<CustomReq, CustomRes>(new CustomReq('query'));
        await responder.read();
        const unclonable = new CustomRes(1);
        (unclonable as any).callback = () => {};
        assert.ok(responder.resolve(unclonable).isErr());

        const result = await pending;
        assert.ok(result.isErr());
        assert.ok(result.e instanceof Rej);

        requester.close();
        responder.close();
    });
});

function mockWs() {
    const sent: any[] = [];
    const ws: any = {
        readyState: 1,
        send: (data: string) => sent.push(JSON.parse(data)),
        close: () => {},
        onopen: null,
        onerror: null,
        onclose: null,
        onmessage: null,
    };
    return { ws, sent };
}

describe('EndpointController reconnect acceptance', () => {
    it('does not accept a reconnecting connection until the app accepts it, then re-accepts on later reconnects', async () => {
        const controller = new EndpointController();
        const acquirePromise = controller.acquire();
        const info = new AgentInfo('agent-reconnect', 'typeX');

        const first = mockWs();
        await controller.connect(first.ws, 'token-1', info, 'arg');
        const request = (await acquirePromise).unwrap();

        const second = mockWs();
        await controller.connect(second.ws, 'token-1', info, 'arg');
        assert.ok(!second.sent.some((m) => m.type === 'accept_endpoint'), 'pending connection must not be auto-accepted');

        const socket = request.accept().unwrap();
        assert.ok(second.sent.some((m) => m.type === 'accept_endpoint'));

        const third = mockWs();
        await controller.connect(third.ws, 'token-1', info, 'arg');
        assert.ok(
            third.sent.some((m) => m.type === 'accept_endpoint'),
            'accepted connection is re-accepted on reconnect',
        );

        socket.destroy();
    });
});

class LabelFragment extends Fragment<{ label: string; styles?: string[] }, string> {
    load(): string {
        return this.input.label;
    }
}

describe('Builder isolation', () => {
    it('keeps fragments of overlapping builds apart', async () => {
        const driver: any = { push: async () => {}, trigger: async () => {} };
        const slow = builder.build(driver, async () => {
            await panel(async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                new LabelFragment({ label: 'slow' });
            });
        });
        const fast = builder.build(driver, async () => {
            new LabelFragment({ label: 'fast' });
        });

        const [slowResult, fastResult] = await Promise.all([slow, fast]);
        assert.deepStrictEqual(await Promise.all([...slowResult.fragments.values()].map((f) => f.load())), ['slow']);
        assert.deepStrictEqual(await Promise.all([...fastResult.fragments.values()].map((f) => f.load())), ['fast']);
        assert.strictEqual(slowResult.mainPanel._build().content![0].type, 'Panel');
        assert.strictEqual(fastResult.mainPanel._build().content![0].type, 'LabelFragment');
    });
});

describe('Agent worker exception containment', () => {
    it('answers a throwing onPost with an error and keeps the worker serving', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'araminix-agent-'));
        const indexFile = path.join(dir, 'agents.mjs');
        const agentModule = new URL('../src/agent/d.js', import.meta.url).href;
        fs.writeFileSync(
            indexFile,
            `import { Agent, AgentFactory, AgentIndex } from '${agentModule}';
class Boom extends Agent {
    async onPost(name) {
        if (name === 'explode') throw new Error('kaboom');
        return { serialize: () => ({ ok: true, v: 'fine' }) };
    }
}
export default class Index extends AgentIndex {
    boom = new AgentFactory(this, Boom);
}
`,
        );
        const indexUrl = pathToFileURL(indexFile);
        const instance = new AgentInstance(indexUrl, new AgentInfo('agent-boom', 'boom'), new AgentController(indexUrl), 10000);
        try {
            const init = await instance.init(() => {});
            assert.ok(init.isOk(), 'agent worker starts');
            const requestSocket: RequestSocket = (instance as any).requestSocket;

            const failed = await requestSocket.writeRead(new AgentPost('explode', {}));
            assert.ok(failed.isOk());
            assert.deepStrictEqual((failed.unwrap() as unknown as Data).data, { ok: false, e: 'kaboom' });

            const ok = await requestSocket.writeRead(new AgentPost('hello', {}));
            assert.deepStrictEqual((ok.unwrap() as unknown as Data).data, { ok: true, v: 'fine' });
        } finally {
            instance.destroy();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
