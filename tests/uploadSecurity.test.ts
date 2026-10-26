import { deal, Ok } from '@araminix/lib';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

import { AuthProvider, UserInfo } from '../src/server/AuthProvider.js';
import Endpoint from '../src/server/Endpoint.js';

describe('Endpoint Upload Security and Stored XSS Defenses', () => {
    let mockAuth: AuthProvider;
    let endpoint: Endpoint;
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'araminix-upload-test-'));
        mockAuth = {
            getInfo: async (token: string) => {
                if (token === 'valid-token') {
                    return new Ok(new UserInfo('user-1', 'john', 'John Doe', 'rt-1', 'john@example.com', [], { _key: 'u1', name: 'Unit 1', code: 'U1' }));
                }
                return { isErr: () => true, isOk: () => false, unwrap: () => null } as any;
            },
            auth: async () => new Ok('token'),
            googleAuth: async () => new Ok('token'),
            destroy: async () => {},
            refreshToken: async () => new Ok('token'),
            request2FA: async () => ({}) as any,
            verify2FA: async () => new Ok('token'),
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
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('rejects unauthenticated upload requests with 401 Unauthorized', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            uploadDir: tempDir,
            port: 0,
        });

        const res = await request(endpoint.express).post('/file').attach('file', Buffer.from('hello'), 'test.txt');

        assert.strictEqual(res.status, 401);
    });

    it('uploads valid file within size limit and stores sanitized metadata', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            uploadDir: tempDir,
            port: 0,
        });

        const fileContent = 'Hello secure world!';
        const res = await request(endpoint.express).post('/file').set('x-token', 'valid-token').attach('file', Buffer.from(fileContent), 'document.txt');

        assert.strictEqual(res.status, 200);
        assert.ok(res.body.id, 'Response must contain file ID');
        assert.strictEqual(res.body.name, 'document.txt');
        assert.strictEqual(res.body.size, Buffer.byteLength(fileContent));
        assert.strictEqual(res.body.userId, 'user-1');

        const savedFilePath = path.join(tempDir, res.body.id, 'document.txt');
        assert.ok(fs.existsSync(savedFilePath), 'Uploaded file must exist in UUID directory on disk');
        assert.strictEqual(fs.readFileSync(savedFilePath, 'utf8'), fileContent);

        const indexJsonPath = path.join(tempDir, res.body.id, 'index.json');
        assert.ok(fs.existsSync(indexJsonPath), 'index.json metadata file must exist on disk');
        const metadata = JSON.parse(fs.readFileSync(indexJsonPath, 'utf8'));
        assert.strictEqual(metadata.name, 'document.txt');
        assert.strictEqual(metadata.userId, 'user-1');
    });

    it('rejects upload exceeding maxUploadBytes with HTTP 413 Payload Too Large', async () => {
        const maxBytes = 100;
        endpoint = new Endpoint({
            authProvider: mockAuth,
            uploadDir: tempDir,
            port: 0,
            maxUploadBytes: maxBytes,
        });

        const oversizedData = Buffer.alloc(maxBytes + 50, 'a');
        const res = await request(endpoint.express).post('/file').set('x-token', 'valid-token').attach('file', oversizedData, 'oversized.txt');

        assert.strictEqual(res.status, 413);
        assert.ok(res.body.error, 'Response must return error message');
        assert.ok(res.body.error.includes('File exceeds maximum allowed size of 100 bytes'));
    });

    it('rejects upload with disallowed extension with HTTP 415 Unsupported Media Type', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            uploadDir: tempDir,
            port: 0,
            uploadAllowlist: {
                extensions: ['png', 'jpg', 'pdf'],
            },
        });

        const res = await request(endpoint.express).post('/file').set('x-token', 'valid-token').attach('file', Buffer.from('<script>alert(1)</script>'), 'malicious.html');

        assert.strictEqual(res.status, 415);
        assert.strictEqual(res.body.error, 'File extension not allowed');
    });

    it('rejects upload with disallowed MIME type with HTTP 415 Unsupported Media Type', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            uploadDir: tempDir,
            port: 0,
            uploadAllowlist: {
                mimetypes: ['image/png', 'image/jpeg'],
            },
        });

        const res = await request(endpoint.express).post('/file').set('x-token', 'valid-token').attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), {
            filename: 'graphic.svg',
            contentType: 'image/svg+xml',
        });

        assert.strictEqual(res.status, 415);
        assert.strictEqual(res.body.error, 'MIME type not allowed');
    });

    it('allows upload when both extension and MIME type match configured allowlist', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            uploadDir: tempDir,
            port: 0,
            uploadAllowlist: {
                extensions: ['png'],
                mimetypes: ['image/png'],
            },
        });

        const res = await request(endpoint.express)
            .post('/file')
            .set('x-token', 'valid-token')
            .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
                filename: 'icon.png',
                contentType: 'image/png',
            });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.name, 'icon.png');
    });

    it('sanitizes filename by stripping directory traversal, control characters, and capping length', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            uploadDir: tempDir,
            port: 0,
        });

        // Test 1: directory traversal and control characters
        const traversalName = '../../../../etc/passwd\ttest.txt';
        const res1 = await request(endpoint.express).post('/file').set('x-token', 'valid-token').attach('file', Buffer.from('safe payload'), traversalName);

        assert.strictEqual(res1.status, 200);
        assert.strictEqual(res1.body.name, 'passwdtest.txt');

        // Test 2: unit verification of fallback for empty, dot-only, and complex traversal names
        assert.strictEqual((endpoint as any).sanitizeFilename('..'), 'upload');
        assert.strictEqual((endpoint as any).sanitizeFilename('.'), 'upload');
        assert.strictEqual((endpoint as any).sanitizeFilename(''), 'upload');
        assert.strictEqual((endpoint as any).sanitizeFilename('   '), 'upload');
        assert.strictEqual((endpoint as any).sanitizeFilename('foo/../../bar'), 'bar');
        assert.strictEqual((endpoint as any).sanitizeFilename('file\x00\r\n\tname.txt'), 'filename.txt');

        // Test 3: excessively long filename is capped at 255 chars
        const longBase = 'a'.repeat(300) + '.txt';
        const res3 = await request(endpoint.express).post('/file').set('x-token', 'valid-token').attach('file', Buffer.from('long payload'), longBase);

        assert.strictEqual(res3.status, 200);
        assert.strictEqual(res3.body.name.length, 255);
    });

    it('rejects upload missing file field with HTTP 400 Bad Request', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            uploadDir: tempDir,
            port: 0,
        });

        const res = await request(endpoint.express).post('/file').set('x-token', 'valid-token').send({ otherField: 'some-value' });

        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error, 'No file uploaded');
    });

    it('serves static files with nosniff, attachment, and CSP sandbox headers', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            uploadDir: tempDir,
            port: 0,
        });

        const htmlPayload = '<html><script>alert("XSS")</script></html>';
        const uploadRes = await request(endpoint.express).post('/file').set('x-token', 'valid-token').attach('file', Buffer.from(htmlPayload), 'page.html');

        assert.strictEqual(uploadRes.status, 200);
        const fileId = uploadRes.body.id;

        const downloadRes = await request(endpoint.express).get(`/file/${fileId}/page.html`).set('x-token', 'valid-token');

        assert.strictEqual(downloadRes.status, 200);
        assert.strictEqual(downloadRes.text, htmlPayload);

        // Verify Stored XSS defense headers
        assert.strictEqual(downloadRes.headers['x-content-type-options'], 'nosniff');
        assert.strictEqual(downloadRes.headers['content-disposition'], 'attachment');
        assert.strictEqual(downloadRes.headers['content-security-policy'], "default-src 'none'; sandbox");
    });

    it('denies access to dotfiles', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            uploadDir: tempDir,
            port: 0,
        });

        // Pre-create a dotfile directly in an upload folder
        const folderId = 'dotfile-folder-id';
        const folderPath = path.join(tempDir, folderId);
        fs.mkdirSync(folderPath, { recursive: true });
        fs.writeFileSync(path.join(folderPath, '.env'), 'SECRET_KEY=12345');

        const res = await request(endpoint.express).get(`/file/${folderId}/.env`).set('x-token', 'valid-token');

        assert.ok(res.status === 403 || res.status === 404, 'Dotfiles must be denied access');
        assert.notStrictEqual(res.text, 'SECRET_KEY=12345', 'Dotfile contents must never be served');
    });

    it('redirects /file/:fileId to /file/:fileId/:safeName for backward compatibility', async () => {
        endpoint = new Endpoint({
            authProvider: mockAuth,
            uploadDir: tempDir,
            port: 0,
        });

        const uploadRes = await request(endpoint.express).post('/file').set('x-token', 'valid-token').attach('file', Buffer.from('my report'), 'my report.txt');

        assert.strictEqual(uploadRes.status, 200);
        const fileId = uploadRes.body.id;

        const redirectRes = await request(endpoint.express).get(`/file/${fileId}`).set('x-token', 'valid-token');

        assert.strictEqual(redirectRes.status, 302);
        assert.strictEqual(redirectRes.headers.location, `/file/${fileId}/my%20report.txt`);
    });
});
