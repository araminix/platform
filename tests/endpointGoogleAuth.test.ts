import { Ok } from '@araminix/lib';
import axios from 'axios';
import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

import { AuthProvider } from '../src/server/AuthProvider.js';
import Endpoint from '../src/server/Endpoint.js';
import { createMockAuth } from './helpers/mockAuth.js';

describe('Endpoint Google OAuth Security (/gauth)', () => {
    let mockAuth: AuthProvider;
    let endpoint: Endpoint;
    let originalAxiosGet: typeof axios.get;

    beforeEach(() => {
        originalAxiosGet = axios.get;
        mockAuth = createMockAuth({
            getInfo: async () => ({ isErr: () => true, isOk: () => false, unwrap: () => null }) as any,
            auth: async () => new Ok('session-token'),
            googleAuth: async (data) => new Ok(`google-token-for-${data.email}`),
            refreshToken: async () => new Ok('refreshed-token'),
            verify2FA: async () => new Ok('2fa-token'),
        });
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

        const tokenInfoCall = calls[0];
        assert.strictEqual(tokenInfoCall.url, `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(rawToken)}`);
        assert.strictEqual(tokenInfoCall.config?.timeout, 10000);

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
        assert.strictEqual(calls.length, 1);
    });

    it('rejects /gauth with 401 when email_verified is not "true"', async () => {
        axios.get = (async () => {
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
