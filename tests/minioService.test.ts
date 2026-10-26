import assert from 'node:assert';
import { describe, it } from 'node:test';

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
});
