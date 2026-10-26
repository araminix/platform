import { Logger } from '@araminix/lib';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { logMiddleware } from '../src/utils/log_middleware.js';

describe('LogMiddleware', () => {
    it('is a standard express middleware function', () => {
        assert.strictEqual(typeof logMiddleware, 'function');
        assert.strictEqual(logMiddleware.length, 3);
    });

    it('redacts cleartext session tokens from /ws-token/ paths', () => {
        let loggedMessage = '';
        const originalInfo = Logger.prototype.info;
        Logger.prototype.info = function (...args: any[]) {
            loggedMessage = args.map(String).join(' ');
        };

        try {
            const req = {
                method: 'GET',
                url: '/mount/ws-token/my-super-secret-session-token-999/chat/arg',
            } as any;
            const res = new EventEmitter() as any;
            res.statusCode = 200;

            let nextCalled = false;
            logMiddleware(req, res, () => {
                nextCalled = true;
            });

            assert.strictEqual(nextCalled, true);
            res.emit('finish');

            assert.ok(loggedMessage.includes('/ws-token/[REDACTED]/chat/arg'));
            assert.ok(!loggedMessage.includes('my-super-secret-session-token-999'));
        } finally {
            Logger.prototype.info = originalInfo;
        }
    });

    it('leaves standard non-token paths unchanged', () => {
        let loggedMessage = '';
        const originalInfo = Logger.prototype.info;
        Logger.prototype.info = function (...args: any[]) {
            loggedMessage = args.map(String).join(' ');
        };

        try {
            const req = {
                method: 'GET',
                url: '/ws/dashboard/summary',
            } as any;
            const res = new EventEmitter() as any;
            res.statusCode = 200;

            logMiddleware(req, res, () => {});
            res.emit('finish');

            assert.ok(loggedMessage.includes('/ws/dashboard/summary'));
            assert.ok(!loggedMessage.includes('[REDACTED]'));
        } finally {
            Logger.prototype.info = originalInfo;
        }
    });
});
