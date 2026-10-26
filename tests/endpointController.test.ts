import assert from 'node:assert';
import { describe, it } from 'node:test';

import { AgentInfo } from '../src/server/AuthProvider.js';
import EndpointController from '../src/server/EndpointController.js';

describe('EndpointController', () => {
    it('acquires and connects', async () => {
        const controller = new EndpointController();
        const acquirePromise = controller.acquire();

        const mockWs = {
            send: () => {},
            close: () => {},
            onopen: null,
            onerror: null,
            onclose: null,
            onmessage: null,
            readyState: 1,
        };

        const info = new AgentInfo('agent-10', 'typeX');
        await controller.connect(mockWs as any, 'token-123', info, 'arg-1');

        const result = await acquirePromise;
        assert.strictEqual(result.isOk(), true);
        const req = result.unwrap();
        assert.strictEqual(req.info.id, 'agent-10');
        assert.strictEqual(req.arg, 'arg-1');
        req.deny();
    });
});
