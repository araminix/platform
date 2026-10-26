import assert from 'node:assert';
import { describe, it } from 'node:test';

import { logMiddleware } from '../src/utils/log_middleware.js';

describe('LogMiddleware', () => {
    it('is a standard express middleware function', () => {
        assert.strictEqual(typeof logMiddleware, 'function');
        assert.strictEqual(logMiddleware.length, 3);
    });
});
