import { Ok } from '@araminix/lib';
import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

import { AuthProvider } from '../src/server/AuthProvider.js';
import Endpoint from '../src/server/Endpoint.js';
import { createMockAuth } from './helpers/mockAuth.js';

describe('Endpoint Login and 2FA Hardening', () => {
    let mockAuth: AuthProvider;
    let endpoint: Endpoint;
    let capturedDisable2FAArgs: { userId: string; code?: string } | undefined;
    let disable2FAResult: any = new Ok(true);

    beforeEach(() => {
        capturedDisable2FAArgs = undefined;
        disable2FAResult = new Ok(true);
        mockAuth = createMockAuth({
            auth: async (data: any) => {
                if (data?.username === 'error-user') {
                    return { isErr: () => true, isOk: () => false, e: 'invalid credentials' } as any;
                }
                return new Ok('session-token-123');
            },
            googleAuth: async () => new Ok('google-session-token'),
            refreshToken: async () => new Ok('new-token-456'),
            request2FA: async () => new Ok('server-generated-secret-xyz'),
            verify2FA: async () => new Ok('verified-2fa-token'),
            enable2FA: async () => new Ok(true),
            disable2FA: async (userId: string, code?: string) => {
                capturedDisable2FAArgs = { userId, code };
                return disable2FAResult;
            },
        });
    });

    afterEach(() => {
        if (endpoint) {
            endpoint.close();
        }
    });

    it('enforces rate limiting on /auth keyed by IP and account', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            authRateLimit: { limit: 2, windowMs: 60000 },
        });

        const res1 = await request(endpoint.express).post('/auth').send({ username: 'userA' });
        assert.strictEqual(res1.status, 200);

        const res2 = await request(endpoint.express).post('/auth').send({ username: 'userA' });
        assert.strictEqual(res2.status, 200);

        const res3 = await request(endpoint.express).post('/auth').send({ username: 'userA' });
        assert.strictEqual(res3.status, 429);
        assert.strictEqual(res3.body.error, 'Too many requests');

        // Different account on same IP has its own bucket
        const resUserB = await request(endpoint.express).post('/auth').send({ username: 'userB' });
        assert.strictEqual(resUserB.status, 200);
    });

    it('enforces rate limiting on /2fa/verify keyed by IP and account', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            authRateLimit: { limit: 2, windowMs: 60000 },
        });

        const payloadA = { accountName: 'userA', code: '123456', uuid: 'uuid-1' };
        const res1 = await request(endpoint.express).post('/2fa/verify').send(payloadA);
        assert.strictEqual(res1.status, 200);

        const res2 = await request(endpoint.express).post('/2fa/verify').send(payloadA);
        assert.strictEqual(res2.status, 200);

        const res3 = await request(endpoint.express).post('/2fa/verify').send(payloadA);
        assert.strictEqual(res3.status, 429);

        // Different account on same IP is not throttled
        const payloadB = { accountName: 'userB', code: '123456', uuid: 'uuid-1' };
        const resUserB = await request(endpoint.express).post('/2fa/verify').send(payloadB);
        assert.strictEqual(resUserB.status, 200);
    });

    it('enforces IP-only rate limiting on /auth/refresh even when old_token varies', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            authRateLimit: { limit: 2, windowMs: 60000 },
        });

        const res1 = await request(endpoint.express).put('/auth/refresh').send({ old_token: 'tokenA' });
        assert.strictEqual(res1.status, 200);

        const res2 = await request(endpoint.express).put('/auth/refresh').send({ old_token: 'tokenB' });
        assert.strictEqual(res2.status, 200);

        const res3 = await request(endpoint.express).put('/auth/refresh').send({ old_token: 'tokenC' });
        assert.strictEqual(res3.status, 429);

        // Passing an accountName in /auth/refresh body must not bypass IP-only keying
        const res4 = await request(endpoint.express).put('/auth/refresh').send({ old_token: 'tokenD', accountName: 'otherUser' });
        assert.strictEqual(res4.status, 429);
    });

    it('enforces IP-only ceiling on /auth so randomizing accountName cannot bypass rate limits', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            authRateLimit: { limit: 2, ipLimit: 4, windowMs: 60000 },
        });

        for (let i = 1; i <= 4; i++) {
            const res = await request(endpoint.express)
                .post('/auth')
                .send({ accountName: `random-user-${i}` });
            assert.strictEqual(res.status, 200);
        }

        const blocked = await request(endpoint.express).post('/auth').send({ accountName: 'random-user-5' });
        assert.strictEqual(blocked.status, 429);
    });

    it('allows rate limiting to be disabled via authRateLimit: false', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            authRateLimit: false,
        });

        for (let i = 0; i < 5; i++) {
            const res = await request(endpoint.express).post('/auth').send({ username: 'userA' });
            assert.strictEqual(res.status, 200);
        }
    });

    it('accepts optional code parameter on DELETE /2fa/disable from body or query', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
        });

        const resWithoutCode = await request(endpoint.express).delete('/2fa/disable').set('x-token', 'valid-token');
        assert.strictEqual(resWithoutCode.status, 200);
        assert.strictEqual(capturedDisable2FAArgs?.userId, 'user-1');
        assert.strictEqual(capturedDisable2FAArgs?.code, undefined);

        const resWithBodyCode = await request(endpoint.express).delete('/2fa/disable').set('x-token', 'valid-token').send({ code: '654321' });
        assert.strictEqual(resWithBodyCode.status, 200);
        assert.strictEqual(capturedDisable2FAArgs?.userId, 'user-1');
        assert.strictEqual(capturedDisable2FAArgs?.code, '654321');

        const resWithQueryCode = await request(endpoint.express).delete('/2fa/disable?code=987654').set('x-token', 'valid-token');
        assert.strictEqual(resWithQueryCode.status, 200);
        assert.strictEqual(capturedDisable2FAArgs?.userId, 'user-1');
        assert.strictEqual(capturedDisable2FAArgs?.code, '987654');

        disable2FAResult = { isErr: () => true, isOk: () => false, e: 'Invalid 2FA code' };
        const resFailed = await request(endpoint.express).delete('/2fa/disable').set('x-token', 'valid-token').send({ code: '000000' });
        assert.strictEqual(resFailed.status, 401);
        assert.strictEqual(resFailed.body.error, 'Invalid 2FA code');
    });
});
