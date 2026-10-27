import { Ok } from '@araminix/lib';
import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

import { AuthProvider, UserInfo } from '../src/server/AuthProvider.js';
import Endpoint from '../src/server/Endpoint.js';
import { MIME_TYPE, MimeToExtension, MinioService } from '../src/utils/minioService.js';

describe('MinioService Options and Extensions', () => {
    it('maps MIME types to expected file extensions', () => {
        assert.strictEqual(MimeToExtension[MIME_TYPE.JPG], 'jpg');
        assert.strictEqual(MimeToExtension[MIME_TYPE.PNG], 'png');
        assert.strictEqual(MimeToExtension[MIME_TYPE.PDF], 'pdf');
        assert.strictEqual(MimeToExtension[MIME_TYPE.ZIP], 'zip');
        assert.strictEqual(MimeToExtension[MIME_TYPE.JSON], 'json');
    });

    it('validates required constructor parameters', () => {
        assert.throws(() => {
            new MinioService({} as any);
        }, /MinIO endPoint is required/);

        assert.throws(() => {
            new MinioService({ endPoint: 'localhost' } as any);
        }, /MinIO port is required/);
    });

    it('validates missing accessKey or bucketName', () => {
        assert.throws(() => {
            new MinioService({ endPoint: 'localhost', port: 9000 } as any);
        }, /MinIO accessKey is required/);
        assert.throws(() => {
            new MinioService({ endPoint: 'localhost', port: 9000, accessKey: 'k', secretKey: 's' } as any);
        }, /MinIO bucketName is required/);
    });

    it('defaults presign expiry to something shorter than 24 hours (15 minutes)', () => {
        const service = new MinioService({
            endPoint: 'localhost',
            port: 9000,
            accessKey: 'minioadmin',
            secretKey: 'minioadmin',
            bucketName: 'test-bucket',
        });
        assert.strictEqual(service.expiry, 15 * 60);
        assert.ok(service.expiry < 24 * 60 * 60, 'Default expiry must be shorter than 24 hours');
    });

    it('respects custom expiry when provided', () => {
        const service = new MinioService({
            endPoint: 'localhost',
            port: 9000,
            accessKey: 'minioadmin',
            secretKey: 'minioadmin',
            bucketName: 'test-bucket',
            expiry: 3600,
        });
        assert.strictEqual(service.expiry, 3600);
    });
});

describe('MinIO Attachments: IDOR and Key Injection Defenses', () => {
    let mockAuth: AuthProvider;
    let endpoint: Endpoint;
    let capturedPutKey: string = '';
    let capturedPutMime: string = '';
    let capturedGetKey: string = '';
    const origPresignedPut = MinioService.prototype.presignedPutObject;
    const origPresignedGet = MinioService.prototype.presignedGetObject;

    beforeEach(() => {
        capturedPutKey = '';
        capturedPutMime = '';
        capturedGetKey = '';

        MinioService.prototype.presignedPutObject = async function (mimetype: any, fileName: string) {
            capturedPutMime = mimetype;
            capturedPutKey = fileName;
            return new Ok(`https://minio.example.com/test-bucket/${encodeURIComponent(fileName)}?sig=mock-put`);
        };

        MinioService.prototype.presignedGetObject = async function (objectName: string) {
            capturedGetKey = objectName;
            return new Ok(`https://minio.example.com/test-bucket/${encodeURIComponent(objectName)}?sig=mock-get`);
        };

        mockAuth = {
            getInfo: async (token: string) => {
                if (token === 'user1-token') {
                    return new Ok(new UserInfo('user-1', 'alice', 'Alice', 'rt-1', 'alice@example.com', [], { _key: 'u1', name: 'Unit 1', code: 'U1' }));
                }
                if (token === 'user2-token') {
                    return new Ok(new UserInfo('user-2', 'bob', 'Bob', 'rt-2', 'bob@example.com', [], { _key: 'u2', name: 'Unit 2', code: 'U2' }));
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

        endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            minio: {
                endPoint: 'localhost',
                port: 9000,
                accessKey: 'minioadmin',
                secretKey: 'minioadmin',
                bucketName: 'attachments-bucket',
            },
        });
    });

    afterEach(() => {
        if (endpoint) {
            endpoint.close();
        }
        MinioService.prototype.presignedPutObject = origPresignedPut;
        MinioService.prototype.presignedGetObject = origPresignedGet;
    });

    describe('POST /attachments/upload', () => {
        it('rejects unauthenticated requests with 401 Unauthorized', async () => {
            const res = await request(endpoint.express).post('/attachments/upload').send({ fileName: 'file.pdf', mimetype: 'application/pdf' });
            assert.strictEqual(res.status, 401);
        });

        it('rejects requests missing fileName or mimetype with 400 Bad Request', async () => {
            const res1 = await request(endpoint.express).post('/attachments/upload').set('x-token', 'user1-token').send({ mimetype: 'application/pdf' });
            assert.strictEqual(res1.status, 400);

            const res2 = await request(endpoint.express).post('/attachments/upload').set('x-token', 'user1-token').send({ fileName: 'file.pdf' });
            assert.strictEqual(res2.status, 400);
        });

        it('rejects fileName containing directory traversal ".." with 400 Bad Request', async () => {
            const maliciousNames = ['../evil.pdf', '../../etc/passwd', 'sub/../../secret.txt', '..\\evil.pdf', '%2e%2e%2fevil.pdf'];

            for (const badName of maliciousNames) {
                const res = await request(endpoint.express).post('/attachments/upload').set('x-token', 'user1-token').send({ fileName: badName, mimetype: 'application/pdf' });
                assert.strictEqual(res.status, 400, `Expected 400 for badName: ${badName}`);
            }
        });

        it('rejects fileName with leading slash with 400 Bad Request', async () => {
            const leadingSlashes = ['/root/file.pdf', '/evil.txt', '\\windows\\file.pdf', '%2ffile.pdf'];

            for (const badName of leadingSlashes) {
                const res = await request(endpoint.express).post('/attachments/upload').set('x-token', 'user1-token').send({ fileName: badName, mimetype: 'application/pdf' });
                assert.strictEqual(res.status, 400, `Expected 400 for badName: ${badName}`);
            }
        });

        it('generates safe keys server-side (${userId}/${uuid}.${ext}) and returns key to client', async () => {
            const res = await request(endpoint.express).post('/attachments/upload').set('x-token', 'user1-token').send({ fileName: 'invoice.pdf', mimetype: 'application/pdf' });

            assert.strictEqual(res.status, 200);
            assert.ok(res.body.url, 'Response must include presigned PUT URL');
            assert.ok(res.body.key, 'Response must include server-generated key');
            assert.strictEqual(res.body.attachmentId, res.body.key);

            // Key must be ${userId}/${uuid}.${ext}
            const keyRegex = /^user-1\/[a-f0-9-]+\.pdf$/i;
            assert.match(res.body.key, keyRegex, 'Key must start with userId/ and end with .pdf extension');
            assert.strictEqual(capturedPutKey, res.body.key, 'Minio presignedPutObject must receive server-generated key');
            assert.strictEqual(capturedPutMime, 'application/pdf');
            assert.ok(!res.body.key.includes('invoice'), 'Key must not use client-controlled filename');
        });

        it('extracts extension from mimetype when fileName has no extension', async () => {
            const res = await request(endpoint.express).post('/attachments/upload').set('x-token', 'user1-token').send({ fileName: 'my-avatar', mimetype: 'image/png' });

            assert.strictEqual(res.status, 200);
            assert.match(res.body.key, /^user-1\/[a-f0-9-]+\.png$/i);
        });
    });

    describe('GET /attachments/:attachmentId', () => {
        it('rejects unauthenticated requests with 401 Unauthorized', async () => {
            const res = await request(endpoint.express).get('/attachments/user-1%2Ffile.pdf');
            assert.strictEqual(res.status, 401);
        });

        it('rejects IDOR: prevents user-2 from fetching user-1 attachment with encoded slash', async () => {
            const res = await request(endpoint.express).get('/attachments/user-1%2Fsecret.pdf').set('x-token', 'user2-token');

            assert.strictEqual(res.status, 403, 'Must return 403 Forbidden for cross-user attachment access');
            assert.strictEqual(capturedGetKey, '', 'MinIO presign must not be invoked for unauthorized access');
        });

        it('rejects IDOR: prevents user-2 from fetching user-1 attachment with unencoded slash', async () => {
            const res = await request(endpoint.express).get('/attachments/user-1/secret.pdf').set('x-token', 'user2-token');

            assert.strictEqual(res.status, 403, 'Must return 403 Forbidden for cross-user attachment access');
            assert.strictEqual(capturedGetKey, '', 'MinIO presign must not be invoked for unauthorized access');
        });

        it('rejects path traversal in attachmentId with 400 Bad Request', async () => {
            const maliciousPaths = ['..%2Fsecret.pdf', 'user-1%2F..%2Fuser-2%2Fsecret.pdf', '%2Fetc%2Fpasswd'];

            for (const badPath of maliciousPaths) {
                const res = await request(endpoint.express).get(`/attachments/${badPath}`).set('x-token', 'user1-token');
                assert.strictEqual(res.status, 400, `Expected 400 for badPath: ${badPath}`);
            }
        });

        it('rejects empty filename / trailing slash in attachmentId with 400 Bad Request', async () => {
            const res = await request(endpoint.express).get('/attachments/user-1%2F').set('x-token', 'user1-token');
            assert.strictEqual(res.status, 400);
        });

        it('allows user to fetch their own attachment with encoded slash', async () => {
            const res = await request(endpoint.express).get('/attachments/user-1%2Fdocument.pdf').set('x-token', 'user1-token');

            assert.strictEqual(res.status, 200);
            assert.ok(typeof res.body.fileURL === 'string', 'fileURL must be unwrapped string');
            assert.strictEqual(capturedGetKey, 'user-1/document.pdf');
        });

        it('allows user to fetch their own attachment with unencoded slash', async () => {
            const res = await request(endpoint.express).get('/attachments/user-1/document.pdf').set('x-token', 'user1-token');

            assert.strictEqual(res.status, 200);
            assert.ok(typeof res.body.fileURL === 'string', 'fileURL must be unwrapped string');
            assert.strictEqual(capturedGetKey, 'user-1/document.pdf');
        });

        it('allows user to fetch their own attachment using bare file ID scoped to user', async () => {
            const res = await request(endpoint.express).get('/attachments/document.pdf').set('x-token', 'user1-token');

            assert.strictEqual(res.status, 200);
            assert.strictEqual(capturedGetKey, 'user-1/document.pdf');
        });
    });
});
