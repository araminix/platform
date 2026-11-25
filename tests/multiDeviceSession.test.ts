import { WsCloseCodes } from '@araminix/lib';
import assert from 'node:assert';
import fs from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import request from 'supertest';

import Platform from '../src/Platform.js';
import { AgentInfo, UserInfo } from '../src/server/AuthProvider.js';
import { createTempFixtures, makeSessionAuth, makeUser, openEndpointWs, waitForListeningPort } from './helpers/sessionTestUtils.js';

describe('Multi-device sessions and immediate revocation', () => {
    const cleanups: Array<() => void> = [];

    afterEach(() => {
        while (cleanups.length > 0) {
            const fn = cleanups.pop()!;
            try {
                fn();
            } catch {}
        }
    });

    it('DELETE /auth closes only the logged-out session WebSockets and destroys only its worker instances while keeping other devices alive', async () => {
        const fixtures = createTempFixtures();
        cleanups.push(() => fs.rmSync(fixtures.dir, { recursive: true, force: true }));

        const sessions = new Map<string, UserInfo | AgentInfo>([
            ['token-A', makeUser('user-1', 'runtimeId-A')],
            ['token-B', makeUser('user-1', 'runtimeId-B')],
        ]);
        const auth = makeSessionAuth(sessions);
        const platform = new Platform({
            appIndexPath: fixtures.appIndexPath,
            agentIndexPath: fixtures.agentIndexPath,
            authProvider: auth,
            instanceUserLimit: 5,
            port: 0,
            cookieSecret: 'test-secret',
            cookieOptions: { secure: false },
        });
        cleanups.push(() => platform.stop());

        await platform.start();
        const port = await waitForListeningPort(platform.endpoint);

        const platformA = await openEndpointWs(port, '/ws/platform', 'token-A');
        await platformA.accepted;
        cleanups.push(() => platformA.terminate());

        const platformB = await openEndpointWs(port, '/ws/platform', 'token-B');
        await platformB.accepted;
        cleanups.push(() => platformB.terminate());

        const createA = await platformA.requestStream('createInstance', { appName: 'appA', profile: null });
        assert.strictEqual(createA.ok, true);
        const instIdA = createA.data[0] as string;
        assert.ok(instIdA);

        const createB = await platformB.requestStream('createInstance', { appName: 'appA', profile: null });
        assert.strictEqual(createB.ok, true);
        const instIdB = createB.data[0] as string;
        assert.ok(instIdB);

        const instA = platform.instances.get('runtimeId-A')!.get(instIdA)!;
        const instB = platform.instances.get('runtimeId-B')!.get(instIdB)!;
        assert.strictEqual(instA.isDestroyed, false);
        assert.strictEqual(instB.isDestroyed, false);

        const wsInstA = await openEndpointWs(port, `/ws/instance/${instIdA}`, 'token-A');
        await wsInstA.accepted;
        cleanups.push(() => wsInstA.terminate());

        const wsInstB = await openEndpointWs(port, `/ws/instance/${instIdB}`, 'token-B');
        await wsInstB.accepted;
        cleanups.push(() => wsInstB.terminate());

        await request(platform.endpoint.express).delete('/auth').set('x-token', 'token-A').expect(200);
        assert.deepStrictEqual(auth.destroyedTokens, ['token-A']);

        const [closedPlatA, closedInstA] = await Promise.all([platformA.closed, wsInstA.closed]);
        assert.strictEqual(closedPlatA.code, WsCloseCodes.Unauthorized);
        assert.ok(closedInstA.code === WsCloseCodes.Unauthorized || closedInstA.code === WsCloseCodes.Normal);
        assert.strictEqual(instA.isDestroyed, true);
        assert.strictEqual(platform.instances.has('runtimeId-A'), false);

        assert.strictEqual(instB.isDestroyed, false);
        assert.strictEqual(platform.instances.get('runtimeId-B')?.get(instIdB), instB);
        assert.strictEqual(platformB.isOpen(), true);
        assert.strictEqual(wsInstB.isOpen(), true);

        const listB = await platformB.requestStream('listInstances', null);
        assert.strictEqual(listB.ok, true);
        const listed = listB.data[0] as Array<{ id: string }>;
        assert.strictEqual(listed.length, 1);
        assert.strictEqual(listed[0].id, instIdB);
    });

    it('platform.deauthSession(runtimeId) destroys only that session while sparing sibling sessions', async () => {
        const fixtures = createTempFixtures();
        cleanups.push(() => fs.rmSync(fixtures.dir, { recursive: true, force: true }));

        const sessions = new Map<string, UserInfo | AgentInfo>([
            ['token-A', makeUser('user-1', 'runtimeId-A')],
            ['token-B', makeUser('user-1', 'runtimeId-B')],
        ]);
        const platform = new Platform({
            appIndexPath: fixtures.appIndexPath,
            agentIndexPath: fixtures.agentIndexPath,
            authProvider: makeSessionAuth(sessions),
            instanceUserLimit: 5,
            port: 0,
            cookieSecret: 'test-secret',
        });
        cleanups.push(() => platform.stop());

        await platform.start();
        const port = await waitForListeningPort(platform.endpoint);

        const platformA = await openEndpointWs(port, '/ws/platform', 'token-A');
        await platformA.accepted;
        cleanups.push(() => platformA.terminate());

        const platformB = await openEndpointWs(port, '/ws/platform', 'token-B');
        await platformB.accepted;
        cleanups.push(() => platformB.terminate());

        const instIdA = (await platformA.requestStream('createInstance', { appName: 'appA', profile: null })).data[0] as string;
        const instIdB = (await platformB.requestStream('createInstance', { appName: 'appA', profile: null })).data[0] as string;
        const instA = platform.instances.get('runtimeId-A')!.get(instIdA)!;
        const instB = platform.instances.get('runtimeId-B')!.get(instIdB)!;

        platform.deauthSession('runtimeId-A');

        const closedA = await platformA.closed;
        assert.strictEqual(closedA.code, WsCloseCodes.Unauthorized);
        assert.strictEqual(instA.isDestroyed, true);
        assert.strictEqual(platform.instances.has('runtimeId-A'), false);

        assert.strictEqual(instB.isDestroyed, false);
        assert.strictEqual(platformB.isOpen(), true);
        const listB = await platformB.requestStream('listInstances', null);
        assert.strictEqual(listB.ok, true);
    });

    it('platform.deauthUser(userId, exceptRuntimeId) kills all other sessions of userId while keeping exceptRuntimeId and other users alive', async () => {
        const fixtures = createTempFixtures();
        cleanups.push(() => fs.rmSync(fixtures.dir, { recursive: true, force: true }));

        const sessions = new Map<string, UserInfo | AgentInfo>([
            ['token-A', makeUser('user-1', 'runtimeId-A')],
            ['token-B', makeUser('user-1', 'runtimeId-B')],
            ['token-C', makeUser('user-2', 'runtimeId-C')],
        ]);
        const platform = new Platform({
            appIndexPath: fixtures.appIndexPath,
            agentIndexPath: fixtures.agentIndexPath,
            authProvider: makeSessionAuth(sessions),
            instanceUserLimit: 5,
            port: 0,
            cookieSecret: 'test-secret',
        });
        cleanups.push(() => platform.stop());

        await platform.start();
        const port = await waitForListeningPort(platform.endpoint);

        const platformA = await openEndpointWs(port, '/ws/platform', 'token-A');
        await platformA.accepted;
        cleanups.push(() => platformA.terminate());

        const platformB = await openEndpointWs(port, '/ws/platform', 'token-B');
        await platformB.accepted;
        cleanups.push(() => platformB.terminate());

        const platformC = await openEndpointWs(port, '/ws/platform', 'token-C');
        await platformC.accepted;
        cleanups.push(() => platformC.terminate());

        const instIdA = (await platformA.requestStream('createInstance', { appName: 'appA', profile: null })).data[0] as string;
        const instIdB = (await platformB.requestStream('createInstance', { appName: 'appA', profile: null })).data[0] as string;
        const instIdC = (await platformC.requestStream('createInstance', { appName: 'appA', profile: null })).data[0] as string;

        const instA = platform.instances.get('runtimeId-A')!.get(instIdA)!;
        const instB = platform.instances.get('runtimeId-B')!.get(instIdB)!;
        const instC = platform.instances.get('runtimeId-C')!.get(instIdC)!;

        const wsInstA = await openEndpointWs(port, `/ws/instance/${instIdA}`, 'token-A');
        await wsInstA.accepted;
        cleanups.push(() => wsInstA.terminate());

        const wsInstB = await openEndpointWs(port, `/ws/instance/${instIdB}`, 'token-B');
        await wsInstB.accepted;
        cleanups.push(() => wsInstB.terminate());

        platform.deauthUser('user-1', 'runtimeId-A');

        const [closedPlatB, closedInstB] = await Promise.all([platformB.closed, wsInstB.closed]);
        assert.strictEqual(closedPlatB.code, WsCloseCodes.Unauthorized);
        assert.ok(closedInstB.code === WsCloseCodes.Unauthorized || closedInstB.code === WsCloseCodes.Normal);
        assert.strictEqual(instB.isDestroyed, true);
        assert.strictEqual(platform.instances.has('runtimeId-B'), false);

        assert.strictEqual(instA.isDestroyed, false);
        assert.strictEqual(platformA.isOpen(), true);
        assert.strictEqual(wsInstA.isOpen(), true);
        const listA = await platformA.requestStream('listInstances', null);
        assert.strictEqual(listA.ok, true);
        assert.strictEqual((listA.data[0] as Array<{ id: string }>)[0].id, instIdA);

        assert.strictEqual(instC.isDestroyed, false);
        assert.strictEqual(platformC.isOpen(), true);
        const listC = await platformC.requestStream('listInstances', null);
        assert.strictEqual(listC.ok, true);
    });

    it('platform.deauthUser(userId) kills all WebSockets and worker instances for userId without affecting other users', async () => {
        const fixtures = createTempFixtures();
        cleanups.push(() => fs.rmSync(fixtures.dir, { recursive: true, force: true }));

        const sessions = new Map<string, UserInfo | AgentInfo>([
            ['token-A', makeUser('user-1', 'runtimeId-A')],
            ['token-B', makeUser('user-1', 'runtimeId-B')],
            ['token-C', makeUser('user-2', 'runtimeId-C')],
        ]);
        const platform = new Platform({
            appIndexPath: fixtures.appIndexPath,
            agentIndexPath: fixtures.agentIndexPath,
            authProvider: makeSessionAuth(sessions),
            instanceUserLimit: 5,
            port: 0,
            cookieSecret: 'test-secret',
        });
        cleanups.push(() => platform.stop());

        await platform.start();
        const port = await waitForListeningPort(platform.endpoint);

        const platformA = await openEndpointWs(port, '/ws/platform', 'token-A');
        await platformA.accepted;
        cleanups.push(() => platformA.terminate());

        const platformB = await openEndpointWs(port, '/ws/platform', 'token-B');
        await platformB.accepted;
        cleanups.push(() => platformB.terminate());

        const platformC = await openEndpointWs(port, '/ws/platform', 'token-C');
        await platformC.accepted;
        cleanups.push(() => platformC.terminate());

        const instIdA = (await platformA.requestStream('createInstance', { appName: 'appA', profile: null })).data[0] as string;
        const instIdB = (await platformB.requestStream('createInstance', { appName: 'appA', profile: null })).data[0] as string;
        const instIdC = (await platformC.requestStream('createInstance', { appName: 'appA', profile: null })).data[0] as string;

        const instA = platform.instances.get('runtimeId-A')!.get(instIdA)!;
        const instB = platform.instances.get('runtimeId-B')!.get(instIdB)!;
        const instC = platform.instances.get('runtimeId-C')!.get(instIdC)!;

        platform.deauthUser('user-1');

        const [closedA, closedB] = await Promise.all([platformA.closed, platformB.closed]);
        assert.strictEqual(closedA.code, WsCloseCodes.Unauthorized);
        assert.strictEqual(closedB.code, WsCloseCodes.Unauthorized);
        assert.strictEqual(instA.isDestroyed, true);
        assert.strictEqual(instB.isDestroyed, true);
        assert.strictEqual(platform.instances.has('runtimeId-A'), false);
        assert.strictEqual(platform.instances.has('runtimeId-B'), false);

        assert.strictEqual(instC.isDestroyed, false);
        assert.strictEqual(platformC.isOpen(), true);
        const listC = await platformC.requestStream('listInstances', null);
        assert.strictEqual(listC.ok, true);
    });
});
