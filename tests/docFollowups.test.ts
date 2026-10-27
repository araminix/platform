import { Err, Ok } from '@araminix/lib';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import request from 'supertest';

import { MainPage } from '../src/lib/d.js';
import Platform from '../src/Platform.js';
import { AuthProvider, UserInfo } from '../src/server/AuthProvider.js';
import Endpoint from '../src/server/Endpoint.js';
import { I18nService } from '../src/utils/i18n.js';
import { MIME_TYPE, MinioService } from '../src/utils/minioService.js';

function makeAuth(): AuthProvider {
    return {
        getInfo: async (token: string) =>
            token === 'user-token'
                ? new Ok(new UserInfo('user-1', 'john', 'John', 'rt-1', 'john@example.com', [], { _key: 'u1', name: 'Unit 1', code: 'U1' }))
                : new Err('invalid'),
    } as unknown as AuthProvider;
}

describe('Activity wake cleanup', () => {
    it('runs the previous afterWake() cleanup before waking again', () => {
        let started = 0;
        let stopped = 0;
        class Dashboard extends MainPage {
            title(): string {
                return 'Dashboard';
            }
            protected async render(): Promise<void> {}
            protected afterWake() {
                started++;
                return () => {
                    stopped++;
                };
            }
        }
        const activity = new Dashboard({} as any)._init(undefined, {} as any);
        activity.afterWake();
        activity.afterWake();
        assert.strictEqual(started, 2);
        assert.strictEqual(stopped, 1, 'the first wake was cleaned up before the second');
        activity.cleanUp();
        assert.strictEqual(stopped, 2);
    });
});

describe('Endpoint lifecycle and uploads', () => {
    it('can open again after close()', async () => {
        const endpoint = new Endpoint({ authProvider: makeAuth(), port: 0, cookieSecret: 'secret' });
        try {
            endpoint.open();
            endpoint.close();
            assert.strictEqual((endpoint as any).server, undefined);
            endpoint.open();
            const server = (endpoint as any).server;
            await new Promise((resolve) => (server.listening ? resolve(undefined) : server.once('listening', resolve)));
            assert.strictEqual(server.listening, true, 'the endpoint listens again after reopening');
        } finally {
            endpoint.close();
        }
    });

    it('does not serve upload metadata and keeps uploads named index.json apart from it', async () => {
        const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'araminix-meta-'));
        const id = '0b0f6b7e-6f1f-4c7a-9f6e-6a2b1f0c9d11';
        fs.mkdirSync(path.join(uploadDir, id));
        fs.writeFileSync(path.join(uploadDir, id, 'index.json'), JSON.stringify({ name: 'report.pdf', userId: 'user-1' }));
        fs.writeFileSync(path.join(uploadDir, id, 'report.pdf'), 'pdf');
        const endpoint = new Endpoint({ authProvider: makeAuth(), port: 0, cookieSecret: 'secret', uploadDir });
        try {
            await request(endpoint.express).get(`/file/${id}/index.json`).set('x-token', 'user-token').expect(404);
            await request(endpoint.express).get(`/file/${id}/report.pdf`).set('x-token', 'user-token').expect(200);
            assert.strictEqual((endpoint as any).sanitizeFilename('index.json'), '_index.json');
            assert.strictEqual((endpoint as any).sanitizeFilename('INDEX.JSON'), '_INDEX.JSON');
            assert.strictEqual((endpoint as any).sanitizeFilename('notes.json'), 'notes.json');
        } finally {
            endpoint.close();
            fs.rmSync(uploadDir, { recursive: true, force: true });
        }
    });

    it('reports PlatformConfig.version on GET /version', async () => {
        const platform = new Platform({
            appIndexPath: new URL('file:///d:/dummy/apps.js'),
            agentIndexPath: new URL('file:///d:/dummy/agents.js'),
            authProvider: makeAuth(),
            instanceUserLimit: 5,
            cookieSecret: 'secret',
            version: '9.9.9',
        });
        try {
            const res = await request(platform.endpoint.express).get('/version').expect(200);
            assert.deepStrictEqual(res.body, { version: '9.9.9' });
        } finally {
            platform.stop();
        }
    });
});

describe('MinioService and I18nService details', () => {
    it('appends the extension unless the name already ends with .<ext>', () => {
        const service = new MinioService({ endPoint: 'localhost', port: 9000, accessKey: 'a', secretKey: 'b', bucketName: 'bkt' });
        assert.strictEqual((service as any).setFileExtension(MIME_TYPE.PDF, 'reportpdf'), 'reportpdf.pdf');
        assert.strictEqual((service as any).setFileExtension(MIME_TYPE.PDF, 'report.pdf'), 'report.pdf');
        assert.strictEqual((service as any).setFileExtension(MIME_TYPE.PDF, 'report.'), 'report.pdf');
    });

    it('returns an empty translation without logging it as missing', () => {
        const i18n = new I18nService<'en', 'greeting' | 'blank'>('en');
        i18n.loadTranslations({ en: { greeting: 'Hello', blank: '' } });
        const warnings: string[] = [];
        const originalError = console.error;
        console.error = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
        try {
            assert.strictEqual(i18n.t('blank'), '');
            assert.strictEqual(i18n.t('greeting'), 'Hello');
        } finally {
            console.error = originalError;
        }
        assert.deepStrictEqual(
            warnings.filter((line) => line.includes('Missing TEXT')),
            [],
        );
    });
});
