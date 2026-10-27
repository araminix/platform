import * as Minio from 'minio';
import { Err, Ok } from '@araminix/lib';
import express from 'express';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import request from 'supertest';

import { AuthProvider, UserInfo } from '../src/server/AuthProvider.js';
import Endpoint from '../src/server/Endpoint.js';
import { logMiddleware } from '../src/utils/log_middleware.js';
import { MinioService } from '../src/utils/minioService.js';

function makeAuth(overrides: Partial<Record<keyof AuthProvider, any>> = {}): AuthProvider & { getInfoCalls: number } {
    const auth: any = {
        getInfoCalls: 0,
        getInfo: async (token: string) => {
            auth.getInfoCalls++;
            if (token === 'user-token') {
                return new Ok(new UserInfo('user-1', 'john', 'John', 'rt-1', 'john@example.com', [], { _key: 'u1', name: 'Unit 1', code: 'U1' }));
            }
            return new Err('invalid');
        },
        auth: async () => new Ok('token'),
        googleAuth: async () => new Ok('token'),
        destroy: async () => {},
        refreshToken: async () => new Ok('token'),
        request2FA: async () => new Ok('otpauth://'),
        enable2FA: async () => new Ok(true),
        verify2FA: async () => new Ok(true),
        disable2FA: async () => new Ok(true),
        requestUploadUrl: async () => new Ok(''),
        requestDownloadUrl: async () => new Ok(''),
        mobileRequests: async () => ({ status: 200 }),
        ...overrides,
    };
    return auth;
}

describe('Endpoint hardening', () => {
    it('does not resolve sessions for /health and /version', async () => {
        const auth = makeAuth();
        const endpoint = new Endpoint({ authProvider: auth, port: 0, cookieSecret: 'secret' });
        try {
            await request(endpoint.express).get('/health').set('x-token', 'user-token').expect(200);
            await request(endpoint.express).get('/version').set('x-token', 'user-token').expect(200);
            assert.strictEqual(auth.getInfoCalls, 0);
        } finally {
            endpoint.close();
        }
    });

    it('returns AuthProvider error codes but hides error objects', async () => {
        const leaky = new Endpoint({ authProvider: makeAuth({ auth: async () => new Err(new Error('db password=hunter2')) }), port: 0, cookieSecret: 'secret' });
        const coded = new Endpoint({ authProvider: makeAuth({ auth: async () => new Err('Invalid credentials') }), port: 0, cookieSecret: 'secret' });
        try {
            const hidden = await request(leaky.express).post('/auth').send({ username: 'a' });
            assert.strictEqual(hidden.status, 401);
            assert.deepStrictEqual(hidden.body, { error: 'Unauthorized' });

            const shown = await request(coded.express).post('/auth').send({ username: 'a' });
            assert.deepStrictEqual(shown.body, { error: 'Invalid credentials' });
        } finally {
            leaky.close();
            coded.close();
        }
    });

    it('answers /auth/refresh without old_token with 400 instead of a 500', async () => {
        const endpoint = new Endpoint({ authProvider: makeAuth(), port: 0, cookieSecret: 'secret' });
        try {
            await request(endpoint.express).put('/auth/refresh').expect(400);
        } finally {
            endpoint.close();
        }
    });

    it('rejects file ids that are not upload UUIDs', async () => {
        const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'araminix-uploads-'));
        fs.writeFileSync(path.join(uploadDir, 'index.json'), JSON.stringify({ name: 'secret.txt' }));
        const endpoint = new Endpoint({ authProvider: makeAuth(), port: 0, cookieSecret: 'secret', uploadDir });
        try {
            const res = await request(endpoint.express).get('/file/..').set('x-token', 'user-token');
            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.headers.location, undefined);
        } finally {
            endpoint.close();
            fs.rmSync(uploadDir, { recursive: true, force: true });
        }
    });

    it('rate-limits /2fa/enable and /2fa/disable (shared auth bucket)', async () => {
        const endpoint = new Endpoint({ authProvider: makeAuth(), port: 0, cookieSecret: 'secret', authRateLimit: { limit: 2, windowMs: 60000 } });
        try {
            await request(endpoint.express).post('/2fa/enable').set('x-token', 'user-token').send({ code: '1', secret: 's' }).expect(200);
            await request(endpoint.express).delete('/2fa/disable').set('x-token', 'user-token').send({ code: '1' }).expect(200);
            await request(endpoint.express).delete('/2fa/disable').set('x-token', 'user-token').send({ code: '1' }).expect(429);
            await request(endpoint.express).post('/2fa/enable').set('x-token', 'user-token').send({ code: '1', secret: 's' }).expect(429);
        } finally {
            endpoint.close();
        }
    });

    it('closes WebSocket messages larger than maxMessageBytes with 1009', async () => {
        const endpoint = new Endpoint({ authProvider: makeAuth(), port: 0, cookieSecret: 'secret', maxMessageBytes: 64 });
        endpoint.acquire('svc');
        endpoint.open();
        try {
            const port = (endpoint as any).server.address().port;
            const ws = new WebSocket(`ws://127.0.0.1:${port}/ws-token/user-token/svc`);
            const code = await new Promise<number>((resolve) => {
                ws.addEventListener('open', () => ws.send('x'.repeat(1000)));
                ws.addEventListener('close', (event) => resolve(event.code));
                ws.addEventListener('error', () => {});
            });
            assert.strictEqual(code, 1009);
        } finally {
            endpoint.close();
        }
    });

    it('terminates sockets that stop answering pings', async () => {
        const endpoint = new Endpoint({ authProvider: makeAuth(), port: 0, cookieSecret: 'secret', heartbeatIntervalMs: 10 });
        const makeSocket = () => {
            const handlers: Record<string, () => void> = {};
            const socket = {
                pings: 0,
                terminated: false,
                ping: () => socket.pings++,
                terminate: () => {
                    socket.terminated = true;
                    handlers.close?.();
                },
                on: (event: string, handler: () => void) => {
                    handlers[event] = handler;
                },
                pong: () => handlers.pong?.(),
                close: () => handlers.close?.(),
            };
            return socket;
        };
        const silent = makeSocket();
        const responsive = makeSocket();
        (endpoint as any).startHeartbeat(silent);
        (endpoint as any).startHeartbeat(responsive);
        const pongs = setInterval(() => responsive.pong(), 2);
        try {
            await new Promise((resolve) => setTimeout(resolve, 60));
            assert.strictEqual(silent.terminated, true);
            assert.strictEqual(responsive.terminated, false);
            assert.ok(responsive.pings > 1);
        } finally {
            clearInterval(pongs);
            responsive.close();
            endpoint.close();
        }
    });

    it('terminates open WebSocket clients on close()', () => {
        const endpoint = new Endpoint({ authProvider: makeAuth(), port: 0, cookieSecret: 'secret' });
        let terminated = false;
        (endpoint as any).wsInstance.getWss().clients.add({ terminate: () => (terminated = true) });
        endpoint.close();
        assert.strictEqual(terminated, true);
    });
});

describe('Request log levels', () => {
    it('logs 5xx as ERROR and 4xx as WARN', async () => {
        const app = express();
        app.use(logMiddleware);
        app.get('/boom', (_req, res) => {
            res.status(500).end();
        });
        app.get('/missing', (_req, res) => {
            res.status(404).end();
        });

        const lines: string[] = [];
        const originalError = console.error;
        const originalLog = console.log;
        console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '));
        console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
        try {
            await request(app).get('/boom');
            await request(app).get('/missing');
        } finally {
            console.error = originalError;
            console.log = originalLog;
        }
        assert.ok(lines.some((line) => line.includes('[ERROR]') && line.includes('/boom 500')));
        assert.ok(lines.some((line) => line.includes('[WARN]') && line.includes('/missing 404')));
    });
});

describe('MinioService initialisation', () => {
    it('shares one bucket initialisation between concurrent first calls and uses the configured region', async () => {
        const proto = Minio.Client.prototype as any;
        const originalExists = proto.bucketExists;
        const originalMake = proto.makeBucket;
        let existsCalls = 0;
        const madeIn: string[] = [];
        proto.bucketExists = async () => {
            existsCalls++;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return false;
        };
        proto.makeBucket = async (_bucket: string, region: string) => {
            madeIn.push(region);
        };
        try {
            const service = new MinioService({ endPoint: 'localhost', port: 9000, accessKey: 'a', secretKey: 'b', bucketName: 'bkt', region: 'eu-central-1' });
            await Promise.all([(service as any).ensureInitialized(), (service as any).ensureInitialized()]);
            assert.strictEqual(existsCalls, 1);
            assert.deepStrictEqual(madeIn, ['eu-central-1']);
        } finally {
            proto.bucketExists = originalExists;
            proto.makeBucket = originalMake;
        }
    });
});
