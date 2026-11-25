import { CloseCodes, err, Ok, ok, WsCloseCodes } from '@araminix/lib';
import { Store } from 'express-rate-limit';
import assert from 'node:assert';
import fs from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import request from 'supertest';

import Instance from '../src/executor/Instance.js';
import Platform from '../src/Platform.js';
import { AgentInfo, UserInfo } from '../src/server/AuthProvider.js';
import Endpoint from '../src/server/Endpoint.js';
import EndpointController from '../src/server/EndpointController.js';
import { createTempFixtures, makeSessionAuth, makeUser, mockRawWs, openEndpointWs, waitForListeningPort } from './helpers/sessionTestUtils.js';

describe('Per-user worker caps, controller revocation, and custom rate-limit store', () => {
    const cleanups: Array<() => void> = [];

    afterEach(() => {
        while (cleanups.length > 0) {
            const fn = cleanups.pop()!;
            try {
                fn();
            } catch {}
        }
    });

    it('enforces maxInstancesPerUser across all sessions of a single user while allowing singleton reuse and other users', async () => {
        const fixtures = createTempFixtures();
        cleanups.push(() => fs.rmSync(fixtures.dir, { recursive: true, force: true }));

        const sessions = new Map<string, UserInfo | AgentInfo>([
            ['token-A', makeUser('user-1', 'runtimeId-A')],
            ['token-B', makeUser('user-1', 'runtimeId-B')],
            ['token-C', makeUser('user-1', 'runtimeId-C')],
            ['token-U2', makeUser('user-2', 'runtimeId-U2')],
        ]);
        const platform = new Platform({
            appIndexPath: fixtures.appIndexPath,
            agentIndexPath: fixtures.agentIndexPath,
            authProvider: makeSessionAuth(sessions),
            instanceUserLimit: 5,
            maxInstancesPerUser: 3,
            singletonApps: ['notif'],
            port: 0,
            cookieSecret: 'test-secret',
        });
        cleanups.push(() => platform.stop());

        await platform.start();
        const port = await waitForListeningPort(platform.endpoint);

        const wsA = await openEndpointWs(port, '/ws/platform', 'token-A');
        await wsA.accepted;
        cleanups.push(() => wsA.terminate());

        const wsB = await openEndpointWs(port, '/ws/platform', 'token-B');
        await wsB.accepted;
        cleanups.push(() => wsB.terminate());

        const wsC = await openEndpointWs(port, '/ws/platform', 'token-C');
        await wsC.accepted;
        cleanups.push(() => wsC.terminate());

        const wsU2 = await openEndpointWs(port, '/ws/platform', 'token-U2');
        await wsU2.accepted;
        cleanups.push(() => wsU2.terminate());

        const notifA = await wsA.requestStream('createInstance', { appName: 'notif', profile: null });
        assert.strictEqual(notifA.ok, true);
        const appA1 = await wsA.requestStream('createInstance', { appName: 'appA', profile: null });
        assert.strictEqual(appA1.ok, true);

        const appB1 = await wsB.requestStream('createInstance', { appName: 'appB', profile: null });
        assert.strictEqual(appB1.ok, true);
        assert.strictEqual(platform.totalInstances, 3);

        const rejectedB = await wsB.requestStream('createInstance', { appName: 'appA', profile: null });
        assert.strictEqual(rejectedB.ok, false);
        assert.strictEqual(platform.totalInstances, 3);

        const rejectedC = await wsC.requestStream('createInstance', { appName: 'appA', profile: null });
        assert.strictEqual(rejectedC.ok, false);
        assert.strictEqual(platform.instances.has('runtimeId-C'), false);
        assert.strictEqual(platform.totalInstances, 3);

        const notifReuse = await wsA.requestStream('createInstance', { appName: 'notif', profile: null });
        assert.strictEqual(notifReuse.ok, true);
        assert.strictEqual(notifReuse.data[0], notifA.data[0]);
        assert.strictEqual(platform.totalInstances, 3);

        const appU2 = await wsU2.requestStream('createInstance', { appName: 'appA', profile: null });
        assert.strictEqual(appU2.ok, true);
        assert.strictEqual(platform.totalInstances, 4);

        await request(platform.endpoint.express).delete('/auth').set('x-token', 'token-A').expect(200);
        await wsA.closed;
        assert.strictEqual(platform.totalInstances, 2);

        const appB2 = await wsB.requestStream('createInstance', { appName: 'appA', profile: null });
        assert.strictEqual(appB2.ok, true);
        assert.strictEqual(platform.totalInstances, 3);
    });

    it('EndpointController.deauthByUserId and deauthSession handle pending connections, exceptRuntimeId, token filtering, and spare agents', async () => {
        const controller = new EndpointController();
        const userA = makeUser('user-1', 'rt-A');
        const userB = makeUser('user-1', 'rt-B');
        const agentSameId = new AgentInfo('user-1', 'printer');

        const wsA = mockRawWs();
        const wsB = mockRawWs();
        const wsAgent = mockRawWs();

        await controller.connect(wsA, 'tok-A', userA, '');
        await controller.connect(wsB, 'tok-B', userB, '');
        await controller.connect(wsAgent, 'tok-agent', agentSameId, '');

        controller.deauthSession('rt-A', 'wrong-tok');
        assert.strictEqual(wsA.closedWith, undefined);

        controller.deauthByUserId('user-1', 'rt-A');
        assert.strictEqual(wsB.closedWith, WsCloseCodes.Unauthorized);
        assert.strictEqual(wsA.closedWith, undefined);
        assert.strictEqual(wsAgent.closedWith, undefined);

        controller.deauthSession('rt-A', 'tok-A');
        assert.strictEqual(wsA.closedWith, WsCloseCodes.Unauthorized);
        assert.strictEqual(wsAgent.closedWith, undefined);

        assert.strictEqual((controller as any).connections.size, 1);
        assert.strictEqual((controller as any).connectionQueue.length, 1);

        (controller as any).connections.forEach((entry: any) => entry.connection.destroy(CloseCodes.Intentional));
    });

    it('passes custom authRateLimit store cleanly without double-initializing or double-counting between account and IP limiters', async () => {
        const hits = new Map<string, number>();
        let initCalls = 0;
        const customStore: Store = {
            init: () => {
                initCalls++;
            },
            increment: (key: string) => {
                const next = (hits.get(key) ?? 0) + 1;
                hits.set(key, next);
                return { totalHits: next, resetTime: new Date(Date.now() + 60_000) };
            },
            decrement: (key: string) => {
                const cur = hits.get(key) ?? 0;
                if (cur > 0) hits.set(key, cur - 1);
            },
            resetKey: (key: string) => {
                hits.delete(key);
            },
        };

        const endpoint = new Endpoint({
            authProvider: makeSessionAuth(new Map()),
            port: 0,
            cookieSecret: 'test-secret',
            authRateLimit: {
                limit: 2,
                ipLimit: 4,
                windowMs: 60_000,
                store: customStore,
            },
        });
        cleanups.push(() => endpoint.close());

        assert.strictEqual(initCalls, 1);

        await request(endpoint.express).put('/auth/refresh').send({ old_token: 't1' }).expect(200);
        await request(endpoint.express).put('/auth/refresh').send({ old_token: 't2' }).expect(200);
        await request(endpoint.express).put('/auth/refresh').send({ old_token: 't3' }).expect(429);

        const ipCeilingKeys = [...hits.keys()].filter((k) => k.startsWith('ip:'));
        const routeKeys = [...hits.keys()].filter((k) => !k.startsWith('ip:'));
        assert.strictEqual(ipCeilingKeys.length, 1);
        assert.strictEqual(routeKeys.length, 1);
        assert.strictEqual(hits.get(ipCeilingKeys[0]), 3);
        assert.strictEqual(hits.get(routeKeys[0]), 3);

        await request(endpoint.express).post('/auth').send({ username: 'freshUser1' }).expect(200);
        await request(endpoint.express).post('/auth').send({ username: 'freshUser2' }).expect(429);
    });

    it('rejects createInstance cleanly at maxInstancesPerUser without leaking empty runtime entries (unit check)', async () => {
        const platform = new Platform({
            appIndexPath: new URL('file:///d:/dummy/apps.js'),
            agentIndexPath: new URL('file:///d:/dummy/agents.js'),
            authProvider: makeSessionAuth(new Map()),
            instanceUserLimit: 5,
            maxInstancesPerUser: 2,
        });
        cleanups.push(() => platform.stop());

        const mapA = new Map<string, Instance>();
        const mapB = new Map<string, Instance>();
        platform.instances.set('rt-A', mapA);
        platform.instances.set('rt-B', mapB);

        const inst1 = new Instance('user-1', 'app1', null, new URL('file:///dummy'), 10, {} as any);
        const inst2 = new Instance('user-1', 'app2', null, new URL('file:///dummy'), 10, {} as any);
        mapA.set(inst1.id, inst1);
        mapB.set(inst2.id, inst2);

        let closedErr = false;
        let sent = false;
        const mockSocket = {
            incomingStream: async (name: string) => {
                if (name === 'createInstance' && !sent) {
                    sent = true;
                    return new Ok({
                        args: { appName: 'app1', profile: null },
                        write: async () => ok(),
                        closeOk: () => {},
                        closeErr: () => {
                            closedErr = true;
                        },
                    } as any);
                }
                return err();
            },
        };
        (platform as any).appIndex = {
            userApps: async () => new Ok([{ apps: [{ name: 'app1', profiles: [null] }] }]),
        };

        (platform as any).processInstanceStream('user-1', 'rt-C', mockSocket as any);
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.strictEqual(closedErr, true);
        assert.strictEqual(platform.instances.has('rt-C'), false);
        assert.strictEqual(platform.totalInstances, 2);
    });
});
