import { deal, Ok } from '@araminix/lib';
import assert from 'node:assert';
import http from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

import { AuthProvider, UserInfo } from '../src/server/AuthProvider.js';
import Endpoint from '../src/server/Endpoint.js';

describe('Endpoint Session Cookie and Header Security', () => {
    let mockAuth: AuthProvider;
    let endpoint: Endpoint;

    beforeEach(() => {
        mockAuth = {
            getInfo: async (token: string) => {
                if (token === 'valid-token') {
                    return new Ok(new UserInfo('user-1', 'john', 'John Doe', 'rt-1', 'john@example.com', [], { _key: 'u1', name: 'Unit 1', code: 'U1' }));
                }
                return { isErr: () => true, isOk: () => false, unwrap: () => null } as any;
            },
            auth: async () => new Ok('new-session-token-123'),
            googleAuth: async () => new Ok('google-session-token-456'),
            destroy: async () => {},
            refreshToken: async () => new Ok('refreshed-session-token-789'),
            request2FA: async () => ({}) as any,
            verify2FA: async () => new Ok('2fa-session-token-abc'),
            enable2FA: async () => ({}) as any,
            disable2FA: async () => ({}) as any,
            requestUploadUrl: async () => ({}) as any,
            requestDownloadUrl: async () => ({}) as any,
            mobileRequests: async () => ({}) as any,
        };
    });

    afterEach(() => {
        if (endpoint) {
            endpoint.close();
        }
    });

    it('sets session cookie with HttpOnly, Secure, SameSite=Lax, and Path=/ by default', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
        });

        const res = await request(endpoint.express).post('/auth').send({ username: 'john' });
        assert.strictEqual(res.status, 200);

        const cookies = res.headers['set-cookie'];
        assert.ok(Array.isArray(cookies) && cookies.length > 0, 'Set-Cookie header must be present');
        const tokenCookie = cookies[0];

        assert.ok(tokenCookie.startsWith('token='), 'Cookie name must be token');
        assert.ok(tokenCookie.includes('HttpOnly'), 'Cookie must have HttpOnly flag');
        assert.ok(tokenCookie.includes('Secure'), 'Cookie must have Secure flag');
        assert.ok(/SameSite=Lax/i.test(tokenCookie), 'Cookie must have SameSite=Lax');
        assert.ok(/Path=\//i.test(tokenCookie), 'Cookie must have Path=/');
    });

    it('allows cookieOptions to override default cookie flags', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            cookieOptions: {
                secure: false,
                sameSite: 'strict',
                path: '/app',
            },
        });

        const res = await request(endpoint.express).post('/auth').send({ username: 'john' });
        assert.strictEqual(res.status, 200);

        const cookies = res.headers['set-cookie'];
        assert.ok(Array.isArray(cookies) && cookies.length > 0);
        const tokenCookie = cookies[0];

        assert.ok(tokenCookie.startsWith('token='));
        assert.ok(tokenCookie.includes('HttpOnly'));
        assert.ok(!tokenCookie.includes('Secure'), 'Secure flag must be omitted when overridden to false');
        assert.ok(/SameSite=Strict/i.test(tokenCookie), 'SameSite must be Strict');
        assert.ok(/Path=\/app/i.test(tokenCookie), 'Path must be /app');
    });

    it('clears session cookie on DELETE /auth using configured cookieOptions', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            cookieOptions: {
                path: '/app',
            },
        });

        const res = await request(endpoint.express).delete('/auth');
        assert.strictEqual(res.status, 200);

        const cookies = res.headers['set-cookie'];
        assert.ok(Array.isArray(cookies) && cookies.length > 0);
        const tokenCookie = cookies[0];

        assert.ok(tokenCookie.startsWith('token='));
        assert.ok(/Path=\/app/i.test(tokenCookie), 'Cleared cookie must preserve matching Path');
        assert.ok(/Expires=Thu, 01 Jan 1970/i.test(tokenCookie), 'Cleared cookie must have past expiration');
    });

    it('authenticates WebSocket upgrade to /ws/:endpoint using x-token header', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            cookieOptions: { secure: false },
        });
        endpoint.declare('agent');
        endpoint.open();

        const address = (endpoint as any).server?.address();
        const port = typeof address === 'object' && address ? address.port : 3000;

        const [upgradePromise, resolveUpgrade] = deal<{ statusCode: number; headers: http.IncomingHttpHeaders }>();

        const req = http.request({
            port,
            path: '/ws/agent',
            agent: false,
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                'x-token': 'valid-token',
            },
        });

        req.on('upgrade', (res, socket) => {
            resolveUpgrade({ statusCode: res.statusCode || 101, headers: res.headers });
            socket.destroy();
        });

        req.end();

        const upgradeResult = await upgradePromise;
        assert.strictEqual(upgradeResult.statusCode, 101, 'Upgrade must succeed with HTTP 101 Switching Protocols');
    });

    it('rejects WebSocket upgrade to /ws/:endpoint without token or cookie', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            cookieOptions: { secure: false },
        });
        endpoint.declare('agent');
        endpoint.open();

        const address = (endpoint as any).server?.address();
        const port = typeof address === 'object' && address ? address.port : 3000;

        const [closePromise, resolveClose] = deal<{ closed: boolean }>();

        const req = http.request({
            port,
            path: '/ws/agent',
            agent: false,
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            },
        });

        req.on('upgrade', (_res, socket, head) => {
            if (head && head.length > 0) {
                resolveClose({ closed: true });
                socket.destroy();
                return;
            }
            socket.on('data', () => {
                resolveClose({ closed: true });
                socket.destroy();
            });
            socket.on('close', () => {
                resolveClose({ closed: true });
            });
        });

        req.end();

        const closeResult = await closePromise;
        assert.strictEqual(closeResult.closed, true);
    });

    it('maintains backward compatibility for /ws-token/:token/:endpoint route', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            cookieOptions: { secure: false },
        });
        endpoint.declare('legacy');
        endpoint.open();

        const address = (endpoint as any).server?.address();
        const port = typeof address === 'object' && address ? address.port : 3000;

        const [upgradePromise, resolveUpgrade] = deal<{ statusCode: number }>();

        const req = http.request({
            port,
            path: '/ws-token/valid-token/legacy',
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            },
        });

        req.on('upgrade', (res, socket) => {
            resolveUpgrade({ statusCode: res.statusCode || 101 });
            socket.destroy();
        });

        req.end();

        const upgradeResult = await upgradePromise;
        assert.strictEqual(upgradeResult.statusCode, 101);
    });
});
