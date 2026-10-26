import { Connection } from '@araminix/lib';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { AgentInfo } from '../src/server/AuthProvider.js';
import { AcceptError, ConnectRequest } from '../src/server/ConnectRequest.js';

describe('ConnectRequest', () => {
    it('accepts connection', () => {
        const inter = {
            onDestroy: () => {},
            onDisconnect: () => {},
            onAccept: () => {},
        };
        const conn = new Connection(inter, 'test-arg');
        const mockWs = {
            send: () => {},
            close: () => {},
            onopen: null,
            onerror: null,
            onclose: null,
            onmessage: null,
            readyState: 1,
        };
        conn.connect(mockWs as any);
        const info = new AgentInfo('agent-1', 'test');
        const req = new ConnectRequest(conn, info);

        assert.strictEqual(req.arg, 'test-arg');
        const res = req.accept();
        assert.strictEqual(res.isOk(), true);

        // Second accept should be Staled
        const res2 = req.accept();
        assert.strictEqual(res2.isErr(), true);
        if (res2.isErr()) {
            assert.strictEqual(res2.e, AcceptError.Staled);
        }
        conn.destroy('Intentional' as any);
    });

    it('denies connection', () => {
        const inter = {
            onDestroy: () => {},
            onDisconnect: () => {},
            onAccept: () => {},
        };
        const conn = new Connection(inter, 'test-arg');
        const info = new AgentInfo('agent-1', 'test');
        const req = new ConnectRequest(conn, info);

        const res = req.deny();
        assert.strictEqual(res.isOk(), true);

        const res2 = req.deny();
        assert.strictEqual(res2.isErr(), true);
        if (res2.isErr()) {
            assert.strictEqual(res2.e, AcceptError.Staled);
        }
    });
});
