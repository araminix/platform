import { Err, Ok } from '@araminix/lib';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { AgentInfo, AuthProvider, UserInfo } from '../../src/server/AuthProvider.js';
import Endpoint from '../../src/server/Endpoint.js';

export function makeUser(userId: string, runtimeId: string): UserInfo {
    return new UserInfo(userId, `${userId}-name`, `${userId} Display`, runtimeId, `${userId}@example.com`, [], {
        _key: 'u1',
        name: 'Unit 1',
        code: 'U1',
    });
}

export function makeSessionAuth(sessions: Map<string, UserInfo | AgentInfo>): AuthProvider & { destroyedTokens: string[] } {
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

export function createTempFixtures(): { dir: string; appIndexPath: URL; agentIndexPath: URL } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'araminix-multidevice-'));
    const platformModule = new URL('../../index.js', import.meta.url).href;

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

export interface WsHelper {
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

export async function openEndpointWs(port: number, wsPath: string, token: string): Promise<WsHelper> {
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

export async function waitForListeningPort(endpoint: Endpoint): Promise<number> {
    const server = (endpoint as any).server;
    await new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', () => resolve())));
    return server.address().port;
}

export function mockRawWs() {
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
