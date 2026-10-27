import assert from 'node:assert';
import { describe, it } from 'node:test';

import { AgentInfo, ClientType, UserInfo } from '../src/server/AuthProvider.js';

describe('AuthProvider & ClientInfo', () => {
    it('instantiates UserInfo correctly', () => {
        const user = new UserInfo('user-1', 'john_doe', 'John Doe', 'rt-1', 'john@example.com', [{ _key: 'u1', name: 'Unit 1', code: 'U1' }], {
            _key: 'u1',
            name: 'Unit 1',
            code: 'U1',
        });

        assert.strictEqual(user.id, 'user-1');
        assert.strictEqual(user.username, 'john_doe');
        assert.strictEqual(user.clientType, ClientType.User);
        assert.strictEqual(user.units.length, 1);
    });

    it('instantiates AgentInfo correctly', () => {
        const agent = new AgentInfo('agent-1', 'workerAgent');
        assert.strictEqual(agent.id, 'agent-1');
        assert.strictEqual(agent.agentType, 'workerAgent');
        assert.strictEqual(agent.clientType, ClientType.Agent);
        assert.strictEqual(agent.runtimeId, 'agent-1');
    });

    it('sanitizes settings.two_factor at runtime to strip secret and code', () => {
        const user = new UserInfo('user-1', 'john_doe', 'John Doe', 'rt-1', 'john@example.com', [], { _key: 'u1', name: 'Unit 1', code: 'U1' }, undefined, undefined, undefined, {
            notifications: {} as any,
            widgets: [],
            two_factor: {
                enabled: true,
                secret: 'SUPER_SECRET_KEY_123',
                code: '654321',
            } as any,
        });

        assert.strictEqual(user.settings?.two_factor?.enabled, true);
        assert.strictEqual((user.settings?.two_factor as any)?.secret, undefined);
        assert.strictEqual((user.settings?.two_factor as any)?.code, undefined);
        assert.deepStrictEqual(user.settings?.two_factor, { enabled: true });
    });
});
