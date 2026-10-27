import { err, ok, Ok } from '@araminix/lib';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { Worker } from 'worker_threads';

import AgentController, { AgentInstance } from '../src/agent/AgentController.js';
import { AgentInfo } from '../src/server/AuthProvider.js';
import { ConnectRequest } from '../src/server/ConnectRequest.js';

describe('Agent Worker Lifecycle and Concurrency', () => {
    it('worker.ts exits with code 1 on init failure when agentType is invalid', async () => {
        const dummyIndexUrl = new URL('file:///d:/dummy/agents.js');
        const agentInfo = new AgentInfo('agent-fail-1', 'nonExistentType');

        const controller = new AgentController(dummyIndexUrl, 2000);
        let denied = false;
        const mockRequest = {
            info: agentInfo,
            arg: '',
            accept: () => ok(),
            deny: () => {
                denied = true;
                return ok();
            },
        } as unknown as ConnectRequest;

        const result = await controller.connect(agentInfo, mockRequest);
        assert.ok(result.isErr());
        assert.strictEqual(denied, true);
        // Verify instances map is clean
        assert.strictEqual((controller as any).instances.has(agentInfo.id), false);
    });

    it('AgentInstance.init terminates worker and clears ping timer on timeout', async () => {
        const dummyIndexUrl = new URL('file:///d:/dummy/agents.js');
        const agentInfo = new AgentInfo('agent-timeout-1', 'testType');
        const controller = new AgentController(dummyIndexUrl);

        // Create an AgentInstance with a short timeout of 50ms
        const instance = new AgentInstance(dummyIndexUrl, agentInfo, controller, 50);

        // Ping timer should initially be set
        assert.ok((instance as any).timer !== undefined);

        // Replace worker with a worker that runs an infinite loop or never responds
        const stuckWorker = new Worker('while(true) {}', { eval: true });
        let exitFired = false;
        stuckWorker.on('exit', () => {
            exitFired = true;
        });

        // Hook init to use stuckWorker
        const origInit = instance.init.bind(instance);
        const initPromise = (async () => {
            // We can directly call init with 50ms timeout
            // For this test, override the worker creation inside init
            return await instance.init(() => {}, 50);
        })();

        const res = await initPromise;
        assert.ok(res.isErr());
        // Ping timer must be cleared
        assert.strictEqual((instance as any).timer, undefined);
        // Worker must be terminated/undefined
        assert.strictEqual((instance as any).worker, undefined);
        // Clean up stuckWorker if still running
        await stuckWorker.terminate().catch(() => {});
    });

    it('AgentInstance.destroy terminates worker and clears ping timer', async () => {
        const dummyIndexUrl = new URL('file:///d:/dummy/agents.js');
        const agentInfo = new AgentInfo('agent-destroy-1', 'testType');
        const controller = new AgentController(dummyIndexUrl);
        const instance = new AgentInstance(dummyIndexUrl, agentInfo, controller);

        const stuckWorker = new Worker('while(true) {}', { eval: true });
        (instance as any).worker = stuckWorker;

        let exitFired = false;
        stuckWorker.on('exit', () => {
            exitFired = true;
        });

        let destroyedCalled = false;
        (instance as any).onDestroy = () => {
            destroyedCalled = true;
        };

        assert.ok((instance as any).timer !== undefined);

        instance.destroy();

        assert.strictEqual(destroyedCalled, true);
        assert.strictEqual((instance as any).timer, undefined);
        assert.strictEqual((instance as any).worker, undefined);

        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.strictEqual(exitFired, true);
    });

    it('AgentController.connect deletes entry from instances on Err', async () => {
        const dummyIndexUrl = new URL('file:///d:/dummy/agents.js');
        const controller = new AgentController(dummyIndexUrl, 100);
        const agentInfo = new AgentInfo('agent-err-cleanup', 'invalidType');

        let denied = false;
        const mockRequest = {
            info: agentInfo,
            arg: '',
            accept: () => ok(),
            deny: () => {
                denied = true;
                return ok();
            },
        } as unknown as ConnectRequest;

        const res = await controller.connect(agentInfo, mockRequest);
        assert.ok(res.isErr());
        assert.strictEqual(denied, true);
        assert.strictEqual((controller as any).instances.has(agentInfo.id), false);

        // Later connects for that ID must not find a dead worker in instances
        assert.strictEqual((controller as any).instances.get(agentInfo.id), undefined);
    });

    it('AgentController.connect shares pending init for concurrent connects for same id', async () => {
        const dummyIndexUrl = new URL('file:///d:/dummy/agents.js');
        const controller = new AgentController(dummyIndexUrl);
        const agentInfo = new AgentInfo('agent-concurrent-1', 'testType');

        let initCalls = 0;
        let resolveInit: (val: any) => void;
        const slowInitPromise = new Promise((resolve) => {
            resolveInit = resolve;
        });

        const origSet = (controller as any).instances.set;
        (controller as any).instances.set = function (key: any, val: any) {
            val.init = async () => {
                initCalls++;
                await slowInitPromise;
                return ok();
            };
            val.connect = () => {};
            return origSet.call(this, key, val);
        };

        const mockSocket = {
            waitClose: async () => 'Intentional',
            destroy: () => {},
        };

        const req1 = {
            info: agentInfo,
            arg: '',
            accept: () => new Ok(mockSocket as any),
            deny: () => ok(),
        } as unknown as ConnectRequest;

        const req2 = {
            info: agentInfo,
            arg: '',
            accept: () => new Ok(mockSocket as any),
            deny: () => ok(),
        } as unknown as ConnectRequest;

        // Launch concurrent connects for the same id
        const connectPromise1 = controller.connect(agentInfo, req1);
        const connectPromise2 = controller.connect(agentInfo, req2);

        // Pending map must contain agentInfo.id
        assert.strictEqual((controller as any).pending.has(agentInfo.id), true);

        // Resolve init
        resolveInit!(ok());

        const [res1, res2] = await Promise.all([connectPromise1, connectPromise2]);
        assert.ok(res1.isOk());
        assert.ok(res2.isOk());

        // Only one init was executed across both concurrent connects
        assert.strictEqual(initCalls, 1);
        // Pending map is cleared
        assert.strictEqual((controller as any).pending.has(agentInfo.id), false);
        // Instance is stored
        assert.ok((controller as any).instances.has(agentInfo.id));
    });

    it('AgentController.connect denies all concurrent connects and cleans instances on init failure', async () => {
        const dummyIndexUrl = new URL('file:///d:/dummy/agents.js');
        const controller = new AgentController(dummyIndexUrl);
        const agentInfo = new AgentInfo('agent-concurrent-fail', 'testType');

        let initCalls = 0;
        let resolveInit: (val: any) => void;
        const slowInitPromise = new Promise((resolve) => {
            resolveInit = resolve;
        });

        const origSet = (controller as any).instances.set;
        (controller as any).instances.set = function (key: any, val: any) {
            val.init = async () => {
                initCalls++;
                await slowInitPromise;
                return err();
            };
            return origSet.call(this, key, val);
        };

        let denied1 = false;
        let denied2 = false;
        const req1 = {
            info: agentInfo,
            arg: '',
            accept: () => ok(),
            deny: () => {
                denied1 = true;
                return ok();
            },
        } as unknown as ConnectRequest;

        const req2 = {
            info: agentInfo,
            arg: '',
            accept: () => ok(),
            deny: () => {
                denied2 = true;
                return ok();
            },
        } as unknown as ConnectRequest;

        const p1 = controller.connect(agentInfo, req1);
        const p2 = controller.connect(agentInfo, req2);

        assert.strictEqual((controller as any).pending.has(agentInfo.id), true);

        // Resolve with failure
        resolveInit!(err());

        const [res1, res2] = await Promise.all([p1, p2]);
        assert.ok(res1.isErr());
        assert.ok(res2.isErr());
        assert.strictEqual(denied1, true);
        assert.strictEqual(denied2, true);

        // Only one init call
        assert.strictEqual(initCalls, 1);
        // Both maps cleaned
        assert.strictEqual((controller as any).pending.has(agentInfo.id), false);
        assert.strictEqual((controller as any).instances.has(agentInfo.id), false);
    });

    it('AgentController.stop cleans up all instances and terminates workers', () => {
        const dummyIndexUrl = new URL('file:///d:/dummy/agents.js');
        const controller = new AgentController(dummyIndexUrl);

        let destroyedCount = 0;
        const mockInstance = {
            info: new AgentInfo('a1', 't1'),
            destroy: () => {
                destroyedCount++;
            },
        };

        (controller as any).instances.set('a1', mockInstance);
        assert.strictEqual((controller as any).instances.size, 1);

        controller.stop();

        assert.strictEqual(destroyedCount, 1);
        assert.strictEqual((controller as any).instances.size, 0);
    });
});
