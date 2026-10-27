import { deal, Ok } from '@araminix/lib';
import axios from 'axios';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
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

describe('Endpoint Google OAuth Security (/gauth)', () => {
    let mockAuth: AuthProvider;
    let endpoint: Endpoint;
    let originalAxiosGet: typeof axios.get;

    beforeEach(() => {
        originalAxiosGet = axios.get;
        mockAuth = {
            getInfo: async () => ({ isErr: () => true, isOk: () => false, unwrap: () => null }) as any,
            auth: async () => new Ok('session-token'),
            googleAuth: async (data) => new Ok(`google-token-for-${data.email}`),
            destroy: async () => {},
            refreshToken: async () => new Ok('refreshed-token'),
            request2FA: async () => ({}) as any,
            verify2FA: async () => new Ok('2fa-token'),
            enable2FA: async () => ({}) as any,
            disable2FA: async () => ({}) as any,
            requestUploadUrl: async () => ({}) as any,
            requestDownloadUrl: async () => ({}) as any,
            mobileRequests: async () => ({}) as any,
        };
    });

    afterEach(() => {
        axios.get = originalAxiosGet;
        if (endpoint) {
            endpoint.close();
        }
    });

    it('refuses /gauth with 503 when googleClientIds is not configured', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
        });

        const res = await request(endpoint.express).post('/gauth').send({ access_token: 'some-token' });
        assert.strictEqual(res.status, 503);
    });

    it('refuses /gauth with 503 when googleClientIds is empty array', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            googleClientIds: [],
        });

        const res = await request(endpoint.express).post('/gauth').send({ access_token: 'some-token' });
        assert.strictEqual(res.status, 503);
    });

    it('rejects /gauth with 422 when access_token is missing or not a string', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            googleClientIds: ['my-client-id.apps.googleusercontent.com'],
        });

        const res1 = await request(endpoint.express).post('/gauth').send({});
        assert.strictEqual(res1.status, 422);

        const res2 = await request(endpoint.express).post('/gauth').send({ access_token: 12345 });
        assert.strictEqual(res2.status, 422);
    });

    it('validates token with tokeninfo using encodeURIComponent and timeout', async () => {
        const calls: { url: string; config?: any }[] = [];
        axios.get = (async (url: string, config?: any) => {
            calls.push({ url, config });
            if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
                return {
                    status: 200,
                    data: {
                        aud: 'my-client-id.apps.googleusercontent.com',
                        email_verified: 'true',
                        email: 'user@example.com',
                    },
                };
            }
            if (url.startsWith('https://www.googleapis.com/oauth2/v1/userinfo')) {
                return {
                    status: 200,
                    data: {
                        email: 'user@example.com',
                        name: 'User Name',
                        given_name: 'User',
                        family_name: 'Name',
                        picture: 'https://pic.example.com/photo.jpg',
                        verified_email: true,
                    },
                };
            }
            throw new Error(`Unexpected url: ${url}`);
        }) as any;

        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            googleClientIds: ['my-client-id.apps.googleusercontent.com'],
        });

        const rawToken = 'token+with special/chars&symbols=1';
        const res = await request(endpoint.express).post('/gauth').send({ access_token: rawToken });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(calls.length, 2);

        // Verify tokeninfo call
        const tokenInfoCall = calls[0];
        assert.strictEqual(tokenInfoCall.url, `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(rawToken)}`);
        assert.strictEqual(tokenInfoCall.config?.timeout, 10000);

        // Verify userinfo call has Authorization header only and no query string
        const userInfoCall = calls[1];
        assert.strictEqual(userInfoCall.url, 'https://www.googleapis.com/oauth2/v1/userinfo');
        assert.strictEqual(userInfoCall.config?.headers?.Authorization, `Bearer ${rawToken}`);
        assert.strictEqual(userInfoCall.config?.timeout, 10000);
    });

    it('rejects /gauth with 401 when token was issued to a different client (token replay attack)', async () => {
        const calls: { url: string }[] = [];
        axios.get = (async (url: string) => {
            calls.push({ url });
            return {
                status: 200,
                data: {
                    aud: 'attacker-client-id.apps.googleusercontent.com',
                    azp: 'attacker-client-id.apps.googleusercontent.com',
                    email_verified: 'true',
                    email: 'victim@example.com',
                },
            };
        }) as any;

        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            googleClientIds: ['my-client-id.apps.googleusercontent.com'],
        });

        const res = await request(endpoint.express).post('/gauth').send({ access_token: 'attacker-replayed-token' });

        assert.strictEqual(res.status, 401);
        // Ensure userinfo was never called
        assert.strictEqual(calls.length, 1);
    });

    it('rejects /gauth with 401 when email_verified is not "true"', async () => {
        axios.get = (async (url: string) => {
            return {
                status: 200,
                data: {
                    aud: 'my-client-id.apps.googleusercontent.com',
                    email_verified: 'false',
                    email: 'unverified@example.com',
                },
            };
        }) as any;

        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            googleClientIds: ['my-client-id.apps.googleusercontent.com'],
        });

        const res = await request(endpoint.express).post('/gauth').send({ access_token: 'unverified-token' });

        assert.strictEqual(res.status, 401);
    });

    it('rejects /gauth with 401 when tokeninfo request fails', async () => {
        axios.get = (async () => {
            throw new Error('Google tokeninfo network error');
        }) as any;

        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            googleClientIds: ['my-client-id.apps.googleusercontent.com'],
        });

        const res = await request(endpoint.express).post('/gauth').send({ access_token: 'bad-token' });

        assert.strictEqual(res.status, 401);
    });

    it('accepts token when azp matches googleClientIds', async () => {
        axios.get = (async (url: string) => {
            if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
                return {
                    status: 200,
                    data: {
                        aud: 'other-aud',
                        azp: 'trusted-client-azp.apps.googleusercontent.com',
                        email_verified: 'true',
                        email: 'user@example.com',
                    },
                };
            }
            return {
                status: 200,
                data: {
                    email: 'user@example.com',
                    name: 'User Name',
                    given_name: 'User',
                    family_name: 'Name',
                    picture: 'https://pic.example.com/photo.jpg',
                    verified_email: true,
                },
            };
        }) as any;

        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            googleClientIds: ['trusted-client-azp.apps.googleusercontent.com'],
        });

        const res = await request(endpoint.express).post('/gauth').send({ access_token: 'valid-token' });

        assert.strictEqual(res.status, 200);
        const cookies = res.headers['set-cookie'];
        assert.ok(Array.isArray(cookies) && cookies.length > 0);
    });

    it('rejects /gauth with 401 when userinfo email does not match tokeninfo email', async () => {
        axios.get = (async (url: string) => {
            if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
                return {
                    status: 200,
                    data: {
                        aud: 'my-client-id.apps.googleusercontent.com',
                        email_verified: 'true',
                        email: 'user1@example.com',
                    },
                };
            }
            return {
                status: 200,
                data: {
                    email: 'user2@example.com',
                    name: 'User Name',
                    given_name: 'User',
                    family_name: 'Name',
                    picture: 'https://pic.example.com/photo.jpg',
                    verified_email: true,
                },
            };
        }) as any;

        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            googleClientIds: ['my-client-id.apps.googleusercontent.com'],
        });

        const res = await request(endpoint.express).post('/gauth').send({ access_token: 'mismatched-token' });

        assert.strictEqual(res.status, 401);
    });

    it('rejects /gauth with 401 when userinfo verified_email is false', async () => {
        axios.get = (async (url: string) => {
            if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
                return {
                    status: 200,
                    data: {
                        aud: 'my-client-id.apps.googleusercontent.com',
                        email_verified: 'true',
                        email: 'user@example.com',
                    },
                };
            }
            return {
                status: 200,
                data: {
                    email: 'user@example.com',
                    name: 'User Name',
                    given_name: 'User',
                    family_name: 'Name',
                    picture: 'https://pic.example.com/photo.jpg',
                    verified_email: false,
                },
            };
        }) as any;

        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            googleClientIds: ['my-client-id.apps.googleusercontent.com'],
        });

        const res = await request(endpoint.express).post('/gauth').send({ access_token: 'token-with-unverified-userinfo' });

        assert.strictEqual(res.status, 401);
    });
});

describe('Endpoint Cross-Site WebSocket Hijacking Protection', () => {
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
            auth: async () => new Ok('valid-token'),
            googleAuth: async () => new Ok('valid-token'),
            destroy: async () => {},
            refreshToken: async () => new Ok('valid-token'),
            request2FA: async () => ({}) as any,
            verify2FA: async () => new Ok('valid-token'),
            enable2FA: async () => ({}) as any,
            disable2FA: async () => ({}) as any,
            requestUploadUrl: async () => ({}) as any,
            requestDownloadUrl: async () => ({}) as any,
            mobileRequests: async () => ({ status: 200 }) as any,
        };
    });

    afterEach(() => {
        if (endpoint) {
            endpoint.close();
        }
    });

    it('allows WebSocket upgrade when Origin matches allowedOrigins', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            cookieOptions: { secure: false },
            allowedOrigins: ['https://app.example.com'],
        });
        endpoint.declare('agent');
        endpoint.open();

        const address = (endpoint as any).server?.address();
        const port = typeof address === 'object' && address ? address.port : 3000;

        const [upgradePromise, resolveUpgrade] = deal<{ statusCode: number }>();

        const req = http.request({
            port,
            path: '/ws/agent',
            agent: false,
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                Origin: 'https://app.example.com',
                'x-token': 'valid-token',
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

    it('rejects WebSocket upgrade when Origin is not in allowedOrigins', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            cookieOptions: { secure: false },
            allowedOrigins: ['https://app.example.com'],
        });
        endpoint.declare('agent');
        endpoint.open();

        const address = (endpoint as any).server?.address();
        const port = typeof address === 'object' && address ? address.port : 3000;

        const [rejectPromise, resolveReject] = deal<{ statusCode: number }>();

        const req = http.request({
            port,
            path: '/ws/agent',
            agent: false,
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                Origin: 'https://evil.com',
                'x-token': 'valid-token',
            },
        });

        req.on('response', (res) => {
            resolveReject({ statusCode: res.statusCode || 403 });
        });

        req.on('upgrade', (_res, socket) => {
            socket.destroy();
            resolveReject({ statusCode: 101 });
        });

        req.end();

        const rejectResult = await rejectPromise;
        assert.strictEqual(rejectResult.statusCode, 403);
    });

    it('allows WebSocket upgrade when Origin is missing (non-browser client)', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            cookieOptions: { secure: false },
            allowedOrigins: ['https://app.example.com'],
        });
        endpoint.declare('agent');
        endpoint.open();

        const address = (endpoint as any).server?.address();
        const port = typeof address === 'object' && address ? address.port : 3000;

        const [upgradePromise, resolveUpgrade] = deal<{ statusCode: number }>();

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
            resolveUpgrade({ statusCode: res.statusCode || 101 });
            socket.destroy();
        });

        req.end();

        const upgradeResult = await upgradePromise;
        assert.strictEqual(upgradeResult.statusCode, 101);
    });

    it('rejects WebSocket upgrade when allowedOrigins is not configured and Origin is present', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            cookieOptions: { secure: false },
        });
        endpoint.declare('agent');
        endpoint.open();

        const address = (endpoint as any).server?.address();
        const port = typeof address === 'object' && address ? address.port : 3000;

        const [rejectPromise, resolveReject] = deal<{ statusCode: number }>();

        const req = http.request({
            port,
            path: '/ws/agent',
            agent: false,
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                Origin: 'https://evil.com',
                'x-token': 'valid-token',
            },
        });

        req.on('response', (res) => {
            resolveReject({ statusCode: res.statusCode || 403 });
        });

        req.on('upgrade', (_res, socket) => {
            socket.destroy();
            resolveReject({ statusCode: 101 });
        });

        req.end();

        const rejectResult = await rejectPromise;
        assert.strictEqual(rejectResult.statusCode, 403);
    });

    it('normalizes origin case and trailing slash when validating allowedOrigins', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            cookieOptions: { secure: false },
            allowedOrigins: ['https://app.example.com/'],
        });
        endpoint.declare('agent');
        endpoint.open();

        const address = (endpoint as any).server?.address();
        const port = typeof address === 'object' && address ? address.port : 3000;

        const [upgradePromise, resolveUpgrade] = deal<{ statusCode: number }>();

        const req = http.request({
            port,
            path: '/ws/agent',
            agent: false,
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                Origin: 'HTTPS://APP.EXAMPLE.COM',
                'x-token': 'valid-token',
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

    it('authenticates WebSocket upgrade via session cookie with allowed Origin', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            cookieOptions: { secure: false },
            allowedOrigins: ['https://app.example.com'],
        });
        endpoint.declare('agent');
        endpoint.open();

        const authRes = await request(endpoint.express).post('/auth').send({ username: 'john' });
        const cookie = authRes.headers['set-cookie']?.[0]?.split(';')[0];
        assert.ok(cookie, 'Cookie must be set');

        const address = (endpoint as any).server?.address();
        const port = typeof address === 'object' && address ? address.port : 3000;

        const [upgradePromise, resolveUpgrade] = deal<{ statusCode: number }>();

        const req = http.request({
            port,
            path: '/ws/agent',
            agent: false,
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                Origin: 'https://app.example.com',
                Cookie: cookie,
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

    it('rejects WebSocket upgrade via session cookie with unauthorized Origin (cross-site WebSocket hijacking attempt)', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            cookieOptions: { secure: false },
            allowedOrigins: ['https://app.example.com'],
        });
        endpoint.declare('agent');
        endpoint.open();

        const authRes = await request(endpoint.express).post('/auth').send({ username: 'john' });
        const cookie = authRes.headers['set-cookie']?.[0]?.split(';')[0];
        assert.ok(cookie);

        const address = (endpoint as any).server?.address();
        const port = typeof address === 'object' && address ? address.port : 3000;

        const [rejectPromise, resolveReject] = deal<{ statusCode: number }>();

        const req = http.request({
            port,
            path: '/ws/agent',
            agent: false,
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                Origin: 'https://attacker-hijack.com',
                Cookie: cookie,
            },
        });

        req.on('response', (res) => {
            resolveReject({ statusCode: res.statusCode || 403 });
        });

        req.on('upgrade', (_res, socket) => {
            socket.destroy();
            resolveReject({ statusCode: 101 });
        });

        req.end();

        const rejectResult = await rejectPromise;
        assert.strictEqual(rejectResult.statusCode, 403);
    });
});

describe('Endpoint CSRF Defense for Cookie-Authenticated Mutations', () => {
    let mockAuth: AuthProvider;
    let endpoint: Endpoint;
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'araminix-csrf-test-'));
        mockAuth = {
            getInfo: async (token: string) => {
                if (token === 'valid-token') {
                    return new Ok(new UserInfo('user-1', 'john', 'John Doe', 'rt-1', 'john@example.com', [], { _key: 'u1', name: 'Unit 1', code: 'U1' }));
                }
                return { isErr: () => true, isOk: () => false, unwrap: () => null } as any;
            },
            auth: async () => new Ok('valid-token'),
            googleAuth: async () => new Ok('valid-token'),
            destroy: async () => {},
            refreshToken: async () => new Ok('valid-token'),
            request2FA: async () => ({}) as any,
            verify2FA: async () => new Ok('valid-token'),
            enable2FA: async () => ({}) as any,
            disable2FA: async () => ({}) as any,
            requestUploadUrl: async () => ({}) as any,
            requestDownloadUrl: async () => ({}) as any,
            mobileRequests: async (req) => ({ status: 200, data: req.data }),
        };
    });

    afterEach(() => {
        if (endpoint) {
            endpoint.close();
        }
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('allows cookie-authenticated POST /mobile/:module/:action with Content-Type: application/json', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            cookieOptions: { secure: false },
        });

        const authRes = await request(endpoint.express).post('/auth').send({ username: 'john' });
        const cookie = authRes.headers['set-cookie'];

        const res = await request(endpoint.express).post('/mobile/system/restart').set('Cookie', cookie).set('Content-Type', 'application/json').send({ reason: 'maintenance' });

        assert.strictEqual(res.status, 200);
    });

    it('allows cookie-authenticated POST /mobile/:module/:action with custom X-Requested-With header', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            cookieOptions: { secure: false },
        });

        const authRes = await request(endpoint.express).post('/auth').send({ username: 'john' });
        const cookie = authRes.headers['set-cookie'];

        const res = await request(endpoint.express)
            .post('/mobile/system/restart')
            .set('Cookie', cookie)
            .set('X-Requested-With', 'XMLHttpRequest')
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .send('reason=maintenance');

        assert.strictEqual(res.status, 200);
    });

    it('rejects cookie-authenticated POST /mobile/:module/:action simple form request with 403 Forbidden', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            cookieOptions: { secure: false },
        });

        const authRes = await request(endpoint.express).post('/auth').send({ username: 'john' });
        const cookie = authRes.headers['set-cookie'];

        const res = await request(endpoint.express)
            .post('/mobile/system/restart')
            .set('Cookie', cookie)
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .send('reason=malicious_cross_site_action');

        assert.strictEqual(res.status, 403);
        assert.ok(res.body.error || res.body.message);
    });

    it('rejects cookie-authenticated POST /mobile/:module/:action simple text/plain request with 403 Forbidden', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            cookieOptions: { secure: false },
        });

        const authRes = await request(endpoint.express).post('/auth').send({ username: 'john' });
        const cookie = authRes.headers['set-cookie'];

        const res = await request(endpoint.express).post('/mobile/system/restart').set('Cookie', cookie).set('Content-Type', 'text/plain').send('{"reason": "exploit"}');

        assert.strictEqual(res.status, 403);
    });

    it('rejects cookie-authenticated POST /file simple request without custom headers with 403 Forbidden', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            uploadDir: tempDir,
            port: 0,
            cookieOptions: { secure: false },
        });

        const authRes = await request(endpoint.express).post('/auth').send({ username: 'john' });
        const cookie = authRes.headers['set-cookie'];

        const res = await request(endpoint.express).post('/file').set('Cookie', cookie).attach('file', Buffer.from('malicious payload'), 'exploit.txt');

        assert.strictEqual(res.status, 403);
    });

    it('allows cookie-authenticated POST /file with X-Requested-With header', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            uploadDir: tempDir,
            port: 0,
            cookieOptions: { secure: false },
        });

        const authRes = await request(endpoint.express).post('/auth').send({ username: 'john' });
        const cookie = authRes.headers['set-cookie'];

        const res = await request(endpoint.express)
            .post('/file')
            .set('Cookie', cookie)
            .set('X-Requested-With', 'XMLHttpRequest')
            .attach('file', Buffer.from('valid file content'), 'upload.txt');

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.name, 'upload.txt');
    });

    it('allows header-authenticated (x-token) mutations without X-Requested-With or application/json', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            uploadDir: tempDir,
            port: 0,
        });

        const resMobile = await request(endpoint.express)
            .post('/mobile/system/restart')
            .set('x-token', 'valid-token')
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .send('reason=api_call');
        assert.strictEqual(resMobile.status, 200);

        const resUpload = await request(endpoint.express).post('/file').set('x-token', 'valid-token').attach('file', Buffer.from('api upload'), 'api.txt');
        assert.strictEqual(resUpload.status, 200);
    });

    it('allows cookie-authenticated non-mutation GET requests without custom headers', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            uploadDir: tempDir,
            port: 0,
            cookieOptions: { secure: false },
        });

        const authRes = await request(endpoint.express).post('/auth').send({ username: 'john' });
        const cookie = authRes.headers['set-cookie'];

        const res = await request(endpoint.express).get('/file/non-existent-id').set('Cookie', cookie);

        // Not blocked by CSRF 403, returns standard 404 for missing file
        assert.strictEqual(res.status, 404);
    });
});

describe('Endpoint Login and 2FA Hardening', () => {
    let mockAuth: AuthProvider;
    let endpoint: Endpoint;
    let capturedDisable2FAArgs: { userId: string; code?: string } | undefined;
    let disable2FAResult: any = new Ok(true);

    beforeEach(() => {
        capturedDisable2FAArgs = undefined;
        disable2FAResult = new Ok(true);
        mockAuth = {
            getInfo: async (token: string) => {
                if (token === 'valid-token') {
                    return new Ok(
                        new UserInfo('user-1', 'john', 'John Doe', 'rt-1', 'john@example.com', [], {
                            _key: 'u1',
                            name: 'Unit 1',
                            code: 'U1',
                        }),
                    );
                }
                return { isErr: () => true, isOk: () => false, unwrap: () => null } as any;
            },
            auth: async (data: any) => {
                if (data?.username === 'error-user') {
                    return { isErr: () => true, isOk: () => false, e: 'invalid credentials' } as any;
                }
                return new Ok('session-token-123');
            },
            googleAuth: async () => new Ok('google-session-token'),
            destroy: async () => {},
            refreshToken: async () => new Ok('new-token-456'),
            request2FA: async () => new Ok('server-generated-secret-xyz'),
            verify2FA: async () => new Ok('verified-2fa-token'),
            enable2FA: async () => new Ok(true),
            disable2FA: async (userId: string, code?: string) => {
                capturedDisable2FAArgs = { userId, code };
                return disable2FAResult;
            },
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

    it('enforces rate limiting on /auth/refresh keyed by IP and account', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            authRateLimit: { limit: 2, windowMs: 60000 },
        });

        const res1 = await request(endpoint.express).put('/auth/refresh').send({ old_token: 'tokenA' });
        assert.strictEqual(res1.status, 200);

        const res2 = await request(endpoint.express).put('/auth/refresh').send({ old_token: 'tokenA' });
        assert.strictEqual(res2.status, 200);

        const res3 = await request(endpoint.express).put('/auth/refresh').send({ old_token: 'tokenA' });
        assert.strictEqual(res3.status, 429);

        const resTokenB = await request(endpoint.express).put('/auth/refresh').send({ old_token: 'tokenB' });
        assert.strictEqual(resTokenB.status, 200);
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

        // 1. Without code
        const resWithoutCode = await request(endpoint.express).delete('/2fa/disable').set('x-token', 'valid-token');
        assert.strictEqual(resWithoutCode.status, 200);
        assert.strictEqual(capturedDisable2FAArgs?.userId, 'user-1');
        assert.strictEqual(capturedDisable2FAArgs?.code, undefined);

        // 2. With code in JSON body
        const resWithBodyCode = await request(endpoint.express).delete('/2fa/disable').set('x-token', 'valid-token').send({ code: '654321' });
        assert.strictEqual(resWithBodyCode.status, 200);
        assert.strictEqual(capturedDisable2FAArgs?.userId, 'user-1');
        assert.strictEqual(capturedDisable2FAArgs?.code, '654321');

        // 3. With code in query string
        const resWithQueryCode = await request(endpoint.express).delete('/2fa/disable?code=987654').set('x-token', 'valid-token');
        assert.strictEqual(resWithQueryCode.status, 200);
        assert.strictEqual(capturedDisable2FAArgs?.userId, 'user-1');
        assert.strictEqual(capturedDisable2FAArgs?.code, '987654');

        // 4. When authProvider rejects disable2FA, returns 401
        disable2FAResult = { isErr: () => true, isOk: () => false, e: 'Invalid 2FA code' };
        const resFailed = await request(endpoint.express).delete('/2fa/disable').set('x-token', 'valid-token').send({ code: '000000' });
        assert.strictEqual(resFailed.status, 401);
        assert.strictEqual(resFailed.body.error, 'Invalid 2FA code');
    });
});
