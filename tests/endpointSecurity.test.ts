import { deal, Ok } from '@araminix/lib';
import axios from 'axios';
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
