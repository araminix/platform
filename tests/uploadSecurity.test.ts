import { deal, Ok } from '@araminix/lib';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

import Platform from '../src/Platform.js';
import { AgentInfo, AuthProvider, UserInfo } from '../src/server/AuthProvider.js';
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

    it('stores unitId derived from activeUnit and merges getUploadMetadata into index.json', async () => {
        const multiAuth = {
            ...mockAuth,
            getInfo: async (token: string) => {
                if (token === 'user-obj-unit') {
                    return new Ok(new UserInfo('user-1', 'john', 'John', 'rt-1', 'john@example.com', [], { _key: 'unit-a', name: 'Unit A', code: 'UA' }));
                }
                if (token === 'user-str-unit') {
                    return new Ok({ id: 'user-2', runtimeId: 'rt-2', clientType: 'User', activeUnit: 'unit-str' } as any);
                }
                if (token === 'agent-no-unit') {
                    return new Ok(new AgentInfo('agent-1', 'worker'));
                }
                return { isErr: () => true, isOk: () => false, unwrap: () => null } as any;
            },
        } as unknown as AuthProvider;

        endpoint = new Endpoint({
            authProvider: multiAuth,
            uploadDir: tempDir,
            port: 0,
            getUploadMetadata: async (req, fileInfo) => ({
                visibility: req.header('x-visibility') ?? 'unit',
                taggedFromName: fileInfo.name,
            }),
        });

        const res1 = await request(endpoint.express).post('/file').set('x-token', 'user-obj-unit').set('x-visibility', 'public').attach('file', Buffer.from('a'), 'a.txt');
        assert.strictEqual(res1.status, 200);
        assert.strictEqual(res1.body.unitId, 'unit-a');
        assert.strictEqual(res1.body.visibility, 'public');
        assert.strictEqual(res1.body.taggedFromName, 'a.txt');
        const meta1 = JSON.parse(fs.readFileSync(path.join(tempDir, res1.body.id, 'index.json'), 'utf8'));
        assert.strictEqual(meta1.unitId, 'unit-a');
        assert.strictEqual(meta1.visibility, 'public');

        const res2 = await request(endpoint.express).post('/file').set('x-token', 'user-str-unit').attach('file', Buffer.from('b'), 'b.txt');
        assert.strictEqual(res2.status, 200);
        assert.strictEqual(res2.body.unitId, 'unit-str');

        const res3 = await request(endpoint.express).post('/file').set('x-token', 'agent-no-unit').attach('file', Buffer.from('c'), 'c.txt');
        assert.strictEqual(res3.status, 200);
        assert.strictEqual(res3.body.unitId, null);
    });

    it('enforces authorizeFileAccess on both GET /file/:fileId and direct GET /file/:fileId/:filename', async () => {
        const unitAUser = new UserInfo('user-a', 'alice', 'Alice', 'rt-a', 'alice@example.com', [], { _key: 'unit-a', name: 'Unit A', code: 'UA' });
        const unitASameUser = new UserInfo('user-a2', 'bob', 'Bob', 'rt-a2', 'bob@example.com', [], { _key: 'unit-a', name: 'Unit A', code: 'UA' });
        const unitBUser = new UserInfo('user-b', 'eve', 'Eve', 'rt-b', 'eve@example.com', [], { _key: 'unit-b', name: 'Unit B', code: 'UB' });

        const multiTenantAuth = {
            ...mockAuth,
            getInfo: async (token: string) => {
                if (token === 'token-a') return new Ok(unitAUser);
                if (token === 'token-a2') return new Ok(unitASameUser);
                if (token === 'token-b') return new Ok(unitBUser);
                return { isErr: () => true, isOk: () => false, unwrap: () => null } as any;
            },
        } as unknown as AuthProvider;

        const authCalls: Array<{ userId: string; fileId: string; unitId: unknown; visibility: unknown }> = [];
        endpoint = new Endpoint({
            authProvider: multiTenantAuth,
            uploadDir: tempDir,
            port: 0,
            getUploadMetadata: (req) => ({
                visibility: req.header('x-visibility') ?? 'unit',
            }),
            authorizeFileAccess: async (info, fileMeta, fileId) => {
                authCalls.push({ userId: info.id, fileId, unitId: fileMeta.unitId, visibility: fileMeta.visibility });
                if (fileMeta.visibility === 'public') {
                    return true;
                }
                const callerUnit = (info as UserInfo).activeUnit?._key ?? null;
                return Boolean(callerUnit && fileMeta.unitId === callerUnit);
            },
        });

        // Upload a unit-scoped file as unit-a user
        const privatePayload = 'confidential unit-a bytes';
        const uploadPrivate = await request(endpoint.express).post('/file').set('x-token', 'token-a').attach('file', Buffer.from(privatePayload), 'secret.txt');
        assert.strictEqual(uploadPrivate.status, 200);
        const privateId = uploadPrivate.body.id;

        // Upload a public-visibility file as unit-a user
        const publicPayload = 'shared public bytes';
        const uploadPublic = await request(endpoint.express)
            .post('/file')
            .set('x-token', 'token-a')
            .set('x-visibility', 'public')
            .attach('file', Buffer.from(publicPayload), 'public.txt');
        assert.strictEqual(uploadPublic.status, 200);
        const publicId = uploadPublic.body.id;

        // Cross-tenant caller (unit-b) is denied with 403 on BOTH /file/:fileId and /file/:fileId/:filename
        const deniedRedirect = await request(endpoint.express).get(`/file/${privateId}`).set('x-token', 'token-b');
        assert.strictEqual(deniedRedirect.status, 403);
        assert.strictEqual(deniedRedirect.headers.location, undefined);

        const deniedDirect = await request(endpoint.express).get(`/file/${privateId}/secret.txt`).set('x-token', 'token-b');
        assert.strictEqual(deniedDirect.status, 403);
        assert.notStrictEqual(deniedDirect.text, privatePayload);

        // Authorized caller in same unit receives 302 and file bytes with security headers intact
        const allowedRedirect = await request(endpoint.express).get(`/file/${privateId}`).set('x-token', 'token-a2');
        assert.strictEqual(allowedRedirect.status, 302);
        assert.strictEqual(allowedRedirect.headers.location, `/file/${privateId}/secret.txt`);

        const allowedDirect = await request(endpoint.express).get(`/file/${privateId}/secret.txt`).set('x-token', 'token-a2');
        assert.strictEqual(allowedDirect.status, 200);
        assert.strictEqual(allowedDirect.text, privatePayload);
        assert.strictEqual(allowedDirect.headers['x-content-type-options'], 'nosniff');
        assert.strictEqual(allowedDirect.headers['content-disposition'], 'attachment');
        assert.strictEqual(allowedDirect.headers['content-security-policy'], "default-src 'none'; sandbox");

        // Cross-tenant caller allowed via visibility metadata receives 302 and file bytes with security headers intact
        const publicRedirect = await request(endpoint.express).get(`/file/${publicId}`).set('x-token', 'token-b');
        assert.strictEqual(publicRedirect.status, 302);
        assert.strictEqual(publicRedirect.headers.location, `/file/${publicId}/public.txt`);

        const publicDirect = await request(endpoint.express).get(`/file/${publicId}/public.txt`).set('x-token', 'token-b');
        assert.strictEqual(publicDirect.status, 200);
        assert.strictEqual(publicDirect.text, publicPayload);
        assert.strictEqual(publicDirect.headers['x-content-type-options'], 'nosniff');
        assert.strictEqual(publicDirect.headers['content-disposition'], 'attachment');
        assert.strictEqual(publicDirect.headers['content-security-policy'], "default-src 'none'; sandbox");

        // Verify authorizeFileAccess was invoked for all 6 download attempts
        assert.strictEqual(authCalls.length, 6);

        // index.json must remain blocked with 404 for both authorized and unauthorized callers (including encoded/case variants)
        const metaResAuth = await request(endpoint.express).get(`/file/${privateId}/index.json`).set('x-token', 'token-a');
        assert.strictEqual(metaResAuth.status, 404);
        const metaResUnauth = await request(endpoint.express).get(`/file/${privateId}/index.json`).set('x-token', 'token-b');
        assert.strictEqual(metaResUnauth.status, 404);
        const metaResEncoded = await request(endpoint.express).get(`/file/${privateId}/index%2ejson`).set('x-token', 'token-a');
        assert.strictEqual(metaResEncoded.status, 404);
        const metaResUpper = await request(endpoint.express).get(`/file/${privateId}/INDEX.JSON`).set('x-token', 'token-a');
        assert.strictEqual(metaResUpper.status, 404);

        // Path traversal out of an authorized folder into an unauthorized folder must return 404
        const traversalRes = await request(endpoint.express).get(`/file/${publicId}/%2e%2e/${privateId}/secret.txt`).set('x-token', 'token-b');
        assert.strictEqual(traversalRes.status, 404);
        assert.notStrictEqual(traversalRes.text, privatePayload);
    });

    it('returns 404 on direct download when index.json is missing or corrupt while authorizeFileAccess is enabled', async () => {
        let authInvoked = false;
        endpoint = new Endpoint({
            authProvider: mockAuth,
            uploadDir: tempDir,
            port: 0,
            authorizeFileAccess: () => {
                authInvoked = true;
                return true;
            },
        });

        // Folder without index.json
        const missingMetaId = '11111111-1111-4111-8111-111111111111';
        fs.mkdirSync(path.join(tempDir, missingMetaId), { recursive: true });
        fs.writeFileSync(path.join(tempDir, missingMetaId, 'orphan.txt'), 'orphan');

        // Folder with corrupt index.json
        const corruptMetaId = '22222222-2222-4222-8222-222222222222';
        fs.mkdirSync(path.join(tempDir, corruptMetaId), { recursive: true });
        fs.writeFileSync(path.join(tempDir, corruptMetaId, 'index.json'), '{not-valid-json');
        fs.writeFileSync(path.join(tempDir, corruptMetaId, 'doc.txt'), 'doc');

        const missingRes = await request(endpoint.express).get(`/file/${missingMetaId}/orphan.txt`).set('x-token', 'valid-token');
        assert.strictEqual(missingRes.status, 404);

        const corruptRes = await request(endpoint.express).get(`/file/${corruptMetaId}/doc.txt`).set('x-token', 'valid-token');
        assert.strictEqual(corruptRes.status, 404);

        assert.strictEqual(authInvoked, false, 'authorizeFileAccess must not run when metadata is missing or corrupt');
    });

    it('handles async mkdir failure in multer destination without crashing and forwards hooks from PlatformConfig', async () => {
        // Point uploadDir to an existing regular file so fs.promises.mkdir rejects
        const blockingFile = path.join(tempDir, 'not-a-directory');
        fs.writeFileSync(blockingFile, 'blocker');

        endpoint = new Endpoint({
            authProvider: mockAuth,
            uploadDir: blockingFile,
            port: 0,
        });

        const failRes = await request(endpoint.express).post('/file').set('x-token', 'valid-token').attach('file', Buffer.from('hello'), 'hello.txt');
        assert.ok(failRes.status >= 400, 'Upload must fail gracefully when async mkdir rejects');

        // Verify Platform forwards getUploadMetadata and authorizeFileAccess to its Endpoint
        const platformUploadDir = path.join(tempDir, 'platform-uploads');
        fs.mkdirSync(platformUploadDir, { recursive: true });
        const platform = new Platform({
            appIndexPath: new URL('file:///d:/dummy/apps.js'),
            agentIndexPath: new URL('file:///d:/dummy/agents.js'),
            authProvider: mockAuth,
            instanceUserLimit: 5,
            cookieSecret: 'secret',
            uploadDir: platformUploadDir,
            getUploadMetadata: () => ({ customFlag: 'forwarded' }),
            authorizeFileAccess: (_info, meta) => meta.customFlag === 'denied',
        });

        try {
            const up = await request(platform.endpoint.express).post('/file').set('x-token', 'valid-token').attach('file', Buffer.from('data'), 'f.txt');
            assert.strictEqual(up.status, 200);
            assert.strictEqual(up.body.customFlag, 'forwarded');

            const redir = await request(platform.endpoint.express).get(`/file/${up.body.id}`).set('x-token', 'valid-token');
            assert.strictEqual(redir.status, 403);

            const direct = await request(platform.endpoint.express).get(`/file/${up.body.id}/f.txt`).set('x-token', 'valid-token');
            assert.strictEqual(direct.status, 403);
        } finally {
            platform.stop();
        }
    });
});
