import { CloseCodes, Err, err, Ok, ok, WsCloseCodes } from '@araminix/lib';
import { Store } from 'express-rate-limit';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import request from 'supertest';

import Instance from '../src/executor/Instance.js';
import Platform from '../src/Platform.js';
import { AgentInfo, AuthProvider, UserInfo } from '../src/server/AuthProvider.js';
import Endpoint from '../src/server/Endpoint.js';
import EndpointController from '../src/server/EndpointController.js';

function makeUser(userId: string, runtimeId: string): UserInfo {
    return new UserInfo(userId, `${userId}-name`, `${userId} Display`, runtimeId, `${userId}@example.com`, [], {
        _key: 'u1',
        name: 'Unit 1',
        code: 'U1',
    });
}

function makeSessionAuth(sessions: Map<string, UserInfo | AgentInfo>): AuthProvider & { destroyedTokens: string[] } {
    const destroyedTokens: string[] = [];
    return {
        destroyedTokens,
        getInfo: async (token: string) => {
            const info = sessions.get(token);
            return info ? new Ok(info as any) : new Err('InvalidToken' as any);
        },
        auth: async () => new Ok('token' as any),
        googleAuth: async () => new Ok('token' as any),
        destroy: async (token: string) => {
            destroyedTokens.push(token);
            sessions.delete(token);
        },
        refreshToken: async () => new Ok('refreshed-token' as any),
        request2FA: async () => new Ok('otpauth://' as any),
        enable2FA: async () => new Ok(true as any),
        verify2FA: async () => new Ok(true as any),
        disable2FA: async () => new Ok(true as any),
        requestUploadUrl: async () => new Ok('' as any),
        requestDownloadUrl: async () => new Ok('' as any),
        mobileRequests: async () => ({ status: 200 }),
    };
}

function createTempFixtures(): { dir: string; appIndexPath: URL; agentIndexPath: URL } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'araminix-multidevice-'));
    const platformModule = new URL('../index.js', import.meta.url).href;

    const appIndexFile = path.join(dir, 'apps.mjs');
    fs.writeFileSync(
        appIndexFile,
        `import { AgentIndex, App, AppIndex, MainPage, Ok } from '${platformModule}';

class TestAgentIndex extends AgentIndex {}

class HomePage extends MainPage {
    title() { return 'Home'; }
    async render() {}
}

class DemoApp extends App {
    title = 'Demo';
    main = new HomePage(this);
    setupWizard = undefined;
    async _getSettings() { return new Ok(undefined); }
    async _getUnits() { return new Ok([]); }
}

export default class TestAppIndex extends AppIndex {
    agents = new TestAgentIndex();
    appA = new DemoApp(this);
    appB = new DemoApp(this);
    notif = new DemoApp(this);

    async _getUserApps() {
        return new Ok([
            { name: 'appA', title: 'App A', profiles: [null, 'default'] },
            { name: 'appB', title: 'App B', profiles: [null, 'default'] },
            { name: 'notif', title: 'Notif', profiles: [null, 'default'] },
        ]);
    }
}
`,
    );

    const agentIndexFile = path.join(dir, 'agents.mjs');
    fs.writeFileSync(
        agentIndexFile,
        `import { AgentIndex } from '${platformModule}';
export default class TestAgentIndex extends AgentIndex {}
`,
    );

    return {
        dir,
        appIndexPath: pathToFileURL(appIndexFile),
        agentIndexPath: pathToFileURL(agentIndexFile),
    };
}

interface WsHelper {
    isOpen: () => boolean;
    terminate: () => void;
    closed: Promise<{ code: number; reason: string }>;
    accepted: Promise<void>;
    requestStream: (name: string, args: unknown) => Promise<{ ok: boolean; data: unknown[] }>;
}

function encodeClientTextFrame(text: string): Buffer {
    const payload = Buffer.from(text, 'utf8');
    const mask = crypto.randomBytes(4);
    let header: Buffer;
    if (payload.length < 126) {
        header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
        masked[i] = payload[i] ^ mask[i & 3];
    }
    return Buffer.concat([header, mask, masked]);
}

async function openEndpointWs(port: number, wsPath: string, token: string): Promise<WsHelper> {
    let open = false;
    let closeSettled = false;
    let acceptSettled = false;

    let resolveClosed!: (v: { code: number; reason: string }) => void;
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        resolveClosed = resolve;
    });

    let resolveAccepted!: () => void;
    let rejectAccepted!: (err: Error) => void;
    const accepted = new Promise<void>((resolve, reject) => {
        resolveAccepted = resolve;
        rejectAccepted = reject;
    });
    accepted.catch(() => {});

    const pendingStreams = new Map<string, { data: unknown[]; resolve: (res: { ok: boolean; data: unknown[] }) => void }>();

    const finishClose = (code: number, reason: string) => {
        open = false;
        if (!closeSettled) {
            closeSettled = true;
            resolveClosed({ code, reason });
        }
        if (!acceptSettled) {
            acceptSettled = true;
            rejectAccepted(new Error(`Socket closed before accept_endpoint (code=${code})`));
        }
        for (const entry of pendingStreams.values()) {
            entry.resolve({ ok: false, data: entry.data });
        }
        pendingStreams.clear();
    };

    const socket = await new Promise<net.Socket>((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: wsPath,
            agent: false,
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
                'x-token': token,
            },
        });
        req.on('error', reject);
        req.on('response', (res) => {
            reject(new Error(`WebSocket upgrade failed with HTTP ${res.statusCode}`));
        });
        req.on('upgrade', (_res, upgradedSocket, head) => {
            open = true;
            let buffer = Buffer.alloc(0);

            const processBuffer = () => {
                while (buffer.length >= 2) {
                    const opcode = buffer[0] & 0x0f;
                    const masked = (buffer[1] & 0x80) !== 0;
                    let length = buffer[1] & 0x7f;
                    let offset = 2;
                    if (length === 126) {
                        if (buffer.length < 4) return;
                        length = buffer.readUInt16BE(2);
                        offset = 4;
                    } else if (length === 127) {
                        if (buffer.length < 10) return;
                        length = Number(buffer.readBigUInt64BE(2));
                        offset = 10;
                    }
                    const maskOffset = masked ? 4 : 0;
                    if (buffer.length < offset + maskOffset + length) return;
                    const payload = buffer.subarray(offset + maskOffset, offset + maskOffset + length);
                    buffer = buffer.subarray(offset + maskOffset + length);

                    if (opcode === 0x08) {
                        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
                        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
                        finishClose(code, reason);
                        upgradedSocket.destroy();
                        return;
                    }
                    if (opcode === 0x01) {
                        const msg = JSON.parse(payload.toString('utf8'));
                        if (msg.type === 'accept_endpoint') {
                            if (!acceptSettled) {
                                acceptSettled = true;
                                resolveAccepted();
                            }
                        } else if (msg.type === 'data_stream') {
                            const entry = pendingStreams.get(msg.id);
                            if (entry) {
                                entry.data.push(msg.data);
                            }
                        } else if (msg.type === 'close_stream') {
                            const entry = pendingStreams.get(msg.id);
                            if (entry) {
                                pendingStreams.delete(msg.id);
                                entry.resolve({ ok: msg.code === 'Normal', data: entry.data });
                            }
                        }
                    }
                }
            };

            upgradedSocket.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
                processBuffer();
            });
            upgradedSocket.on('close', () => {
                finishClose(1006, '');
            });
            upgradedSocket.on('error', () => {
                finishClose(1006, '');
            });

            if (head && head.length > 0) {
                buffer = Buffer.concat([buffer, head]);
                processBuffer();
            }
            resolve(upgradedSocket);
        });
        req.end();
    });

    let streamCounter = 0;
    const requestStream = (name: string, args: unknown): Promise<{ ok: boolean; data: unknown[] }> => {
        const id = `s-${++streamCounter}-${Math.random().toString(36).slice(2)}`;
        return new Promise((resolve) => {
            pendingStreams.set(id, { data: [], resolve });
            socket.write(encodeClientTextFrame(JSON.stringify({ type: 'new_stream', id, name, args })));
        });
    };

    return {
        isOpen: () => open && !socket.destroyed,
        terminate: () => {
            open = false;
            socket.destroy();
        },
        closed,
        accepted,
        requestStream,
    };
}

async function waitForListeningPort(endpoint: Endpoint): Promise<number> {
    const server = (endpoint as any).server;
    await new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', () => resolve())));
    return server.address().port;
}

function mockRawWs() {
    const ws: any = {
        readyState: 1,
        closedWith: undefined as number | undefined,
        send: () => {},
        close: (code?: number) => {
            ws.closedWith = code;
        },
        onopen: null,
        onerror: null,
        onclose: null,
        onmessage: null,
    };
    return ws;
}

describe('Multi-device sessions, immediate revocation, and per-user worker caps', () => {
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

        // Connect device A and device B on /ws/platform
        const platformA = await openEndpointWs(port, '/ws/platform', 'token-A');
        await platformA.accepted;
        cleanups.push(() => platformA.terminate());

        const platformB = await openEndpointWs(port, '/ws/platform', 'token-B');
        await platformB.accepted;
        cleanups.push(() => platformB.terminate());

        // Create a worker instance on device A and device B
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

        // Connect instance sockets for both devices
        const wsInstA = await openEndpointWs(port, `/ws/instance/${instIdA}`, 'token-A');
        await wsInstA.accepted;
        cleanups.push(() => wsInstA.terminate());

        const wsInstB = await openEndpointWs(port, `/ws/instance/${instIdB}`, 'token-B');
        await wsInstB.accepted;
        cleanups.push(() => wsInstB.terminate());

        // Logout device A via DELETE /auth
        await request(platform.endpoint.express).delete('/auth').set('x-token', 'token-A').expect(200);
        assert.deepStrictEqual(auth.destroyedTokens, ['token-A']);

        // Device A's sockets close immediately with 4401 (Unauthorized) and worker is destroyed
        const [closedPlatA, closedInstA] = await Promise.all([platformA.closed, wsInstA.closed]);
        assert.strictEqual(closedPlatA.code, WsCloseCodes.Unauthorized);
        assert.ok(closedInstA.code === WsCloseCodes.Unauthorized || closedInstA.code === WsCloseCodes.Normal);
        assert.strictEqual(instA.isDestroyed, true);
        assert.strictEqual(platform.instances.has('runtimeId-A'), false);

        // Device B remains connected and fully operational
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

        // Kick all devices of user-1 EXCEPT runtimeId-A (e.g. password change from device A)
        platform.deauthUser('user-1', 'runtimeId-A');

        const [closedPlatB, closedInstB] = await Promise.all([platformB.closed, wsInstB.closed]);
        assert.strictEqual(closedPlatB.code, WsCloseCodes.Unauthorized);
        assert.ok(closedInstB.code === WsCloseCodes.Unauthorized || closedInstB.code === WsCloseCodes.Normal);
        assert.strictEqual(instB.isDestroyed, true);
        assert.strictEqual(platform.instances.has('runtimeId-B'), false);

        // Device A (spared) and user-2 (different user) remain alive and operational
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

        // Revoke all sessions of user-1 (e.g. user archival / disable)
        platform.deauthUser('user-1');

        const [closedA, closedB] = await Promise.all([platformA.closed, platformB.closed]);
        assert.strictEqual(closedA.code, WsCloseCodes.Unauthorized);
        assert.strictEqual(closedB.code, WsCloseCodes.Unauthorized);
        assert.strictEqual(instA.isDestroyed, true);
        assert.strictEqual(instB.isDestroyed, true);
        assert.strictEqual(platform.instances.has('runtimeId-A'), false);
        assert.strictEqual(platform.instances.has('runtimeId-B'), false);

        // user-2 stays connected and running
        assert.strictEqual(instC.isDestroyed, false);
        assert.strictEqual(platformC.isOpen(), true);
        const listC = await platformC.requestStream('listInstances', null);
        assert.strictEqual(listC.ok, true);
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

        // Device A creates 1 singleton + 1 regular instance (2/3 for user-1)
        const notifA = await wsA.requestStream('createInstance', { appName: 'notif', profile: null });
        assert.strictEqual(notifA.ok, true);
        const appA1 = await wsA.requestStream('createInstance', { appName: 'appA', profile: null });
        assert.strictEqual(appA1.ok, true);

        // Device B creates 1 regular instance (3/3 for user-1 -> cap reached)
        const appB1 = await wsB.requestStream('createInstance', { appName: 'appB', profile: null });
        assert.strictEqual(appB1.ok, true);
        assert.strictEqual(platform.totalInstances, 3);

        // Device B attempting another instance is rejected cleanly by maxInstancesPerUser
        const rejectedB = await wsB.requestStream('createInstance', { appName: 'appA', profile: null });
        assert.strictEqual(rejectedB.ok, false);
        assert.strictEqual(platform.totalInstances, 3);

        // Device C (brand-new session of user-1) is also rejected cleanly and leaves no empty runtime map
        const rejectedC = await wsC.requestStream('createInstance', { appName: 'appA', profile: null });
        assert.strictEqual(rejectedC.ok, false);
        assert.strictEqual(platform.instances.has('runtimeId-C'), false);
        assert.strictEqual(platform.totalInstances, 3);

        // Reusing an already-running singleton on Device A still succeeds at the cap
        const notifReuse = await wsA.requestStream('createInstance', { appName: 'notif', profile: null });
        assert.strictEqual(notifReuse.ok, true);
        assert.strictEqual(notifReuse.data[0], notifA.data[0]);
        assert.strictEqual(platform.totalInstances, 3);

        // A different user (user-2) is NOT affected by user-1's cap
        const appU2 = await wsU2.requestStream('createInstance', { appName: 'appA', profile: null });
        assert.strictEqual(appU2.ok, true);
        assert.strictEqual(platform.totalInstances, 4);

        // Once Device A logs out, user-1's count drops from 3 to 1, so Device B can create again
        await request(platform.endpoint.express).delete('/auth').set('x-token', 'token-A').expect(200);
        await wsA.closed;
        assert.strictEqual(platform.totalInstances, 2); // 1 on B + 1 on U2

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

        // Connect all three without calling acquire() -> all sit in connectionQueue & connections
        await controller.connect(wsA, 'tok-A', userA, '');
        await controller.connect(wsB, 'tok-B', userB, '');
        await controller.connect(wsAgent, 'tok-agent', agentSameId, '');

        // deauthSession with non-matching token does nothing
        controller.deauthSession('rt-A', 'wrong-tok');
        assert.strictEqual(wsA.closedWith, undefined);

        // deauthByUserId sparing rt-A kills only rt-B (not rt-A and not agent with same id)
        controller.deauthByUserId('user-1', 'rt-A');
        assert.strictEqual(wsB.closedWith, WsCloseCodes.Unauthorized);
        assert.strictEqual(wsA.closedWith, undefined);
        assert.strictEqual(wsAgent.closedWith, undefined);

        // deauthSession with matching token kills rt-A
        controller.deauthSession('rt-A', 'tok-A');
        assert.strictEqual(wsA.closedWith, WsCloseCodes.Unauthorized);
        assert.strictEqual(wsAgent.closedWith, undefined);

        // Only the agent remains in connections and connectionQueue
        assert.strictEqual((controller as any).connections.size, 1);
        assert.strictEqual((controller as any).connectionQueue.length, 1);

        // Clean up agent connection
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

        // Custom store must be initialized once even though both accountLimiter and ipLimiter are active
        assert.strictEqual(initCalls, 1);

        // PUT /auth/refresh keys on IP in accountLimiter and ip:<ip> in ipLimiter -> must allow 2 requests, block 3rd
        await request(endpoint.express).put('/auth/refresh').send({ old_token: 't1' }).expect(200);
        await request(endpoint.express).put('/auth/refresh').send({ old_token: 't2' }).expect(200);
        await request(endpoint.express).put('/auth/refresh').send({ old_token: 't3' }).expect(429);

        // Verify distinct keys were recorded in the custom store (no collision / double-counting)
        const ipCeilingKeys = [...hits.keys()].filter((k) => k.startsWith('ip:'));
        const routeKeys = [...hits.keys()].filter((k) => !k.startsWith('ip:'));
        assert.strictEqual(ipCeilingKeys.length, 1);
        assert.strictEqual(routeKeys.length, 1);
        assert.strictEqual(hits.get(ipCeilingKeys[0]), 3);
        assert.strictEqual(hits.get(routeKeys[0]), 3);

        // 4th request from same IP with a fresh account passes ipLimit (4/4), 5th is blocked by ipLimit (5 > 4)
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
