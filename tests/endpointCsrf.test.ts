import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

import { AuthProvider } from '../src/server/AuthProvider.js';
import Endpoint from '../src/server/Endpoint.js';
import { createMockAuth } from './helpers/mockAuth.js';

describe('Endpoint CSRF Defense for Cookie-Authenticated Mutations', () => {
    let mockAuth: AuthProvider;
    let endpoint: Endpoint;
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'araminix-csrf-test-'));
        mockAuth = createMockAuth({
            mobileRequests: async (req) => ({ status: 200, data: req.data }) as any,
        });
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

        assert.strictEqual(res.status, 404);
    });
});
