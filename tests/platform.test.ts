import assert from 'node:assert';
import { describe, it } from 'node:test';

import { AgentErrorType, CommunicationAgentError, ExecutionAgentError } from '../src/agent/d.js';
import { AppError } from '../src/executor/AppInstance.js';
import Platform from '../src/Platform.js';
import { AuthProvider } from '../src/server/AuthProvider.js';

describe('Platform Core Structure', () => {
    it('verifies AppError and AgentError enumerations and classes', () => {
        assert.strictEqual(AppError.WrongAction, 'WrongAction');
        assert.strictEqual(AppError.NonActive, 'NonActive');
        assert.strictEqual(AppError.NotFound, 'NotFound');

        const execErr = new ExecutionAgentError('bad payload');
        assert.strictEqual(execErr.type, AgentErrorType.Execution);
        assert.strictEqual(execErr.e, 'bad payload');

        const commErr = new CommunicationAgentError();
        assert.strictEqual(commErr.type, AgentErrorType.Communication);
    });

    it('instantiates Platform with valid configuration', () => {
        const mockAuth: AuthProvider = {
            getInfo: async () => ({}) as any,
            auth: async () => ({}) as any,
            googleAuth: async () => ({}) as any,
            destroy: async () => {},
            refreshToken: async () => ({}) as any,
            request2FA: async () => ({}) as any,
            verify2FA: async () => ({}) as any,
            enable2FA: async () => ({}) as any,
            disable2FA: async () => ({}) as any,
            requestUploadUrl: async () => ({}) as any,
            requestDownloadUrl: async () => ({}) as any,
            mobileRequests: async () => ({}) as any,
        };

        const platform = new Platform({
            appIndexPath: new URL('file:///d:/dummy/apps.js'),
            agentIndexPath: new URL('file:///d:/dummy/agents.js'),
            authProvider: mockAuth,
            instanceUserLimit: 5,
        });

        assert.ok(platform.endpoint);
        assert.ok(platform.instances);
        platform.stop();
    });
});
