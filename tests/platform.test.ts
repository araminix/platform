import { err, ok, Ok } from '@araminix/lib';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { Worker } from 'worker_threads';

import { AgentErrorType, CommunicationAgentError, ExecutionAgentError } from '../src/agent/d.js';
import { AppError } from '../src/executor/AppInstance.js';
import Instance from '../src/executor/Instance.js';
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

    it('passes authRateLimit configuration to Endpoint and sanitizes clientInfo', () => {
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
            authRateLimit: { limit: 10, windowMs: 60000 },
        });

        assert.ok((platform.endpoint as any).authRateLimiter);

        const rawClientInfo: any = {
            id: 'u1',
            settings: {
                two_factor: {
                    enabled: true,
                    secret: 'LEAKED_SECRET',
                    code: 'LEAKED_CODE',
                },
            },
        };

        const sanitized = (platform as any).sanitizeClientInfo(rawClientInfo);
        assert.strictEqual(sanitized.settings.two_factor.enabled, true);
        assert.strictEqual(sanitized.settings.two_factor.secret, undefined);
        assert.strictEqual(sanitized.settings.two_factor.code, undefined);
        assert.deepStrictEqual(sanitized.settings.two_factor, { enabled: true });

        platform.stop();
    });
});

describe('Instance Lifecycle and Resource Management', () => {
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

    it('Instance.destroy() is idempotent, guards sockets, and executes onDestroy once', () => {
        const dummyAgentCtrl = {} as any;
        const instance = new Instance('u1', 'app1', 'default', new URL('file:///dummy/apps.js'), 12, dummyAgentCtrl, { maxOldGenerationSizeMb: 64, stackSizeMb: 2 }, 50);

        assert.strictEqual(instance.isDestroyed, false);

        let cleanupCalls = 0;
        (instance as any).onDestroy = () => {
            cleanupCalls++;
        };

        // destroy before init / without requestSocket should not crash
        assert.doesNotThrow(() => {
            instance.destroy();
        });
        assert.strictEqual(instance.isDestroyed, true);
        assert.strictEqual(cleanupCalls, 1);

        // Calling destroy() multiple times should be completely safe and not re-call cleanup
        assert.doesNotThrow(() => {
            instance.destroy();
            instance.destroy();
        });
        assert.strictEqual(cleanupCalls, 1);
        assert.strictEqual(instance.isDestroyed, true);
    });

    it('terminates stuck worker after short grace period when destroy() is called', async () => {
        const dummyAgentCtrl = {} as any;
        const instance = new Instance('u1', 'app1', 'default', new URL('file:///dummy/apps.js'), 12, dummyAgentCtrl, undefined, 50);

        // Create a real worker running a CPU loop
        const stuckWorker = new Worker('while(true) {}', { eval: true });
        (instance as any).worker = stuckWorker;

        let exitEventFired = false;
        stuckWorker.on('exit', () => {
            exitEventFired = true;
        });

        // Destroy instance; worker should be terminated after grace period
        instance.destroy();

        // Wait slightly more than grace period (50ms)
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.strictEqual(exitEventFired, true);
        assert.strictEqual((instance as any).worker, undefined);
    });

    it('while (instances.size >= limit) evicts oldest instances by touched timestamp and cleans up map', () => {
        const platform = new Platform({
            appIndexPath: new URL('file:///d:/dummy/apps.js'),
            agentIndexPath: new URL('file:///d:/dummy/agents.js'),
            authProvider: mockAuth,
            instanceUserLimit: 2,
        });

        const runtimeId = 'runtime-overshoot';
        const userInstances = new Map<string, Instance>();
        platform.instances.set(runtimeId, userInstances);

        const destroyedIds: string[] = [];
        const createMockInst = (id: string, touched: number) => {
            const inst = new Instance('u1', 'app1', null, new URL('file:///dummy'), 10, {} as any);
            (inst as any).id = id;
            inst.touch(touched);
            const origDestroy = inst.destroy.bind(inst);
            inst.destroy = () => {
                destroyedIds.push(id);
                origDestroy();
            };
            return inst;
        };

        // Simulate 4 concurrent instances created (overshot beyond limit of 2)
        const inst1 = createMockInst('inst-oldest', 100);
        const inst2 = createMockInst('inst-second-oldest', 200);
        const inst3 = createMockInst('inst-third', 300);
        const inst4 = createMockInst('inst-newest', 400);

        userInstances.set(inst1.id, inst1);
        userInstances.set(inst2.id, inst2);
        userInstances.set(inst3.id, inst3);
        userInstances.set(inst4.id, inst4);

        assert.strictEqual(userInstances.size, 4);

        // Simulate the eviction logic executed in createInstance
        const limit = (platform as any).config.instanceUserLimit;
        while (userInstances.size >= limit) {
            let oldest: Instance | undefined;
            for (const inst of userInstances.values()) {
                if (!oldest || inst.touched < oldest.touched) {
                    oldest = inst;
                }
            }
            if (!oldest) break;
            userInstances.delete(oldest.id);
            oldest.destroy();
        }

        // Must have evicted down to < 2 (i.e. size 1)
        assert.strictEqual(userInstances.size, 1);
        // inst-oldest (100), inst-second-oldest (200), inst-third (300) should be evicted in order
        assert.deepStrictEqual(destroyedIds, ['inst-oldest', 'inst-second-oldest', 'inst-third']);
        assert.ok(userInstances.has('inst-newest'));

        platform.stop();
    });

    it('zombie instances without onDestroy are cleaned from map on eviction', () => {
        const platform = new Platform({
            appIndexPath: new URL('file:///d:/dummy/apps.js'),
            agentIndexPath: new URL('file:///d:/dummy/agents.js'),
            authProvider: mockAuth,
            instanceUserLimit: 1,
        });

        const runtimeId = 'runtime-zombie';
        const userInstances = new Map<string, Instance>();
        platform.instances.set(runtimeId, userInstances);

        // Zombie instance whose init failed, onDestroy was undefined
        const zombie = new Instance('u1', 'app1', null, new URL('file:///dummy'), 10, {} as any);
        (zombie as any).id = 'zombie-1';
        (zombie as any).onDestroy = undefined;
        userInstances.set(zombie.id, zombie);

        const limit = (platform as any).config.instanceUserLimit;
        while (userInstances.size >= limit) {
            let oldest: Instance | undefined;
            for (const inst of userInstances.values()) {
                if (!oldest || inst.touched < oldest.touched) {
                    oldest = inst;
                }
            }
            if (!oldest) break;
            userInstances.delete(oldest.id);
            oldest.destroy();
        }

        assert.strictEqual(userInstances.size, 0);
        assert.strictEqual(zombie.isDestroyed, true);

        platform.stop();
    });

    it('enforces optional global cap maxInstances across all users', async () => {
        const platform = new Platform({
            appIndexPath: new URL('file:///d:/dummy/apps.js'),
            agentIndexPath: new URL('file:///d:/dummy/agents.js'),
            authProvider: mockAuth,
            instanceUserLimit: 5,
            maxInstances: 3,
        });

        // Add 2 instances to user A, 1 to user B -> total = 3 (reached cap)
        const mapA = new Map<string, Instance>();
        const mapB = new Map<string, Instance>();
        platform.instances.set('userA-rt', mapA);
        platform.instances.set('userB-rt', mapB);

        const instA1 = new Instance('uA', 'app1', null, new URL('file:///dummy'), 10, {} as any);
        const instA2 = new Instance('uA', 'app2', null, new URL('file:///dummy'), 10, {} as any);
        const instB1 = new Instance('uB', 'app1', null, new URL('file:///dummy'), 10, {} as any);

        mapA.set(instA1.id, instA1);
        mapA.set(instA2.id, instA2);
        mapB.set(instB1.id, instB1);

        assert.strictEqual(platform.totalInstances, 3);

        let streamClosedWithErr = false;
        let incomingStreamClosed = false;
        const mockStream = {
            args: { appName: 'app1', profile: 'default' },
            write: async () => ok(),
            closeOk: () => {},
            closeErr: () => {
                streamClosedWithErr = true;
            },
        };

        const mockSocket = {
            incomingStream: async (name: string) => {
                if (name === 'createInstance' && !incomingStreamClosed) {
                    incomingStreamClosed = true;
                    return new Ok(mockStream as any);
                }
                return err();
            },
        };

        (platform as any).appIndex = {
            userApps: async () => new Ok([{ apps: [{ name: 'app1', profiles: ['default'] }] }]),
        };

        // User C tries to create an instance when global cap of 3 is reached
        (platform as any).processInstanceStream('userC', 'userC-rt', mockSocket as any);

        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.strictEqual(streamClosedWithErr, true);
        assert.strictEqual(platform.totalInstances, 3);

        // Now destroy one instance from user A -> total = 2
        instA1.destroy();
        mapA.delete(instA1.id);
        assert.strictEqual(platform.totalInstances, 2);

        platform.stop();
    });

    it('passes custom resourceLimits to Instance and Worker', () => {
        const dummyAgentCtrl = {} as any;
        const customLimits = {
            maxOldGenerationSizeMb: 256,
            stackSizeMb: 8,
        };
        const instance = new Instance('u1', 'app1', 'default', new URL('file:///dummy/apps.js'), 12, dummyAgentCtrl, customLimits);

        assert.deepStrictEqual(instance.resourceLimits, customLimits);
    });
});
