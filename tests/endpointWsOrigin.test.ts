import { deal } from '@araminix/lib';
import assert from 'node:assert';
import http from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

import { AuthProvider } from '../src/server/AuthProvider.js';
import Endpoint from '../src/server/Endpoint.js';
import { createMockAuth } from './helpers/mockAuth.js';

function attemptUpgrade(port: number, headers: http.OutgoingHttpHeaders): Promise<{ statusCode: number }> {
    const [resultPromise, resolveResult] = deal<{ statusCode: number }>();

    const req = http.request({
        port,
        path: '/ws/agent',
        agent: false,
        headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            ...headers,
        },
    });

    req.on('response', (res) => {
        resolveResult({ statusCode: res.statusCode || 403 });
    });

    req.on('upgrade', (res, socket) => {
        socket.destroy();
        resolveResult({ statusCode: res.statusCode || 101 });
    });

    req.end();
    return resultPromise;
}

describe('Endpoint Cross-Site WebSocket Hijacking Protection', () => {
    let mockAuth: AuthProvider;
    let endpoint: Endpoint;

    beforeEach(() => {
        mockAuth = createMockAuth();
    });

    afterEach(() => {
        if (endpoint) {
            endpoint.close();
        }
    });

    function openEndpoint(allowedOrigins?: string[]): number {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            cookieOptions: { secure: false },
            ...(allowedOrigins !== undefined ? { allowedOrigins } : {}),
        });
        endpoint.declare('agent');
        endpoint.open();

        const address = (endpoint as any).server?.address();
        return typeof address === 'object' && address ? address.port : 3000;
    }

    it('allows WebSocket upgrade when Origin matches allowedOrigins', async () => {
        const port = openEndpoint(['https://app.example.com']);
        const res = await attemptUpgrade(port, { Origin: 'https://app.example.com', 'x-token': 'valid-token' });
        assert.strictEqual(res.statusCode, 101);
    });

    it('rejects WebSocket upgrade when Origin is not in allowedOrigins', async () => {
        const port = openEndpoint(['https://app.example.com']);
        const res = await attemptUpgrade(port, { Origin: 'https://evil.com', 'x-token': 'valid-token' });
        assert.strictEqual(res.statusCode, 403);
    });

    it('allows WebSocket upgrade when Origin is missing (non-browser client)', async () => {
        const port = openEndpoint(['https://app.example.com']);
        const res = await attemptUpgrade(port, { 'x-token': 'valid-token' });
        assert.strictEqual(res.statusCode, 101);
    });

    it('rejects WebSocket upgrade when allowedOrigins is not configured and Origin is present', async () => {
        const port = openEndpoint();
        const res = await attemptUpgrade(port, { Origin: 'https://evil.com', 'x-token': 'valid-token' });
        assert.strictEqual(res.statusCode, 403);
    });

    it('normalizes origin case and trailing slash when validating allowedOrigins', async () => {
        const port = openEndpoint(['https://app.example.com/']);
        const res = await attemptUpgrade(port, { Origin: 'HTTPS://APP.EXAMPLE.COM', 'x-token': 'valid-token' });
        assert.strictEqual(res.statusCode, 101);
    });

    it('authenticates WebSocket upgrade via session cookie with allowed Origin', async () => {
        const port = openEndpoint(['https://app.example.com']);
        const authRes = await request(endpoint.express).post('/auth').send({ username: 'john' });
        const cookie = authRes.headers['set-cookie']?.[0]?.split(';')[0];
        assert.ok(cookie, 'Cookie must be set');

        const res = await attemptUpgrade(port, { Origin: 'https://app.example.com', Cookie: cookie });
        assert.strictEqual(res.statusCode, 101);
    });

    it('rejects WebSocket upgrade via session cookie with unauthorized Origin (cross-site WebSocket hijacking attempt)', async () => {
        const port = openEndpoint(['https://app.example.com']);
        const authRes = await request(endpoint.express).post('/auth').send({ username: 'john' });
        const cookie = authRes.headers['set-cookie']?.[0]?.split(';')[0];
        assert.ok(cookie);

        const res = await attemptUpgrade(port, { Origin: 'https://attacker-hijack.com', Cookie: cookie });
        assert.strictEqual(res.statusCode, 403);
    });

    it('rejects cookie-bearing WebSocket upgrade without Origin header when allowedOrigins is configured', async () => {
        const port = openEndpoint(['https://app.example.com']);
        const authRes = await request(endpoint.express).post('/auth').send({ username: 'john' });
        const cookie = authRes.headers['set-cookie']?.[0]?.split(';')[0];
        assert.ok(cookie, 'Cookie must be set');

        const res = await attemptUpgrade(port, { Cookie: cookie });
        assert.strictEqual(res.statusCode, 403);

        // Defense-in-depth check on isOriginAllowed for signedCookies without Origin
        assert.strictEqual((endpoint as any).isOriginAllowed({ headers: {}, signedCookies: { token: 'valid-token' } }), false);
        assert.strictEqual((endpoint as any).isOriginAllowed({ headers: { 'x-token': 'valid-token' } }), true);
    });
});
