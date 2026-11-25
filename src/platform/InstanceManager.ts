import { logger } from '@araminix/lib';

import AgentController from '../agent/AgentController.js';
import Instance from '../executor/Instance.js';
import { countUserInstances, evictOldestRegularInstances, findIdleInstances, findSingletonInstance } from '../executor/instancePolicy.js';
import { DEFAULT_OUTGOING_STREAM_TIMEOUT_MS, DEFAULT_WORKER_REQUEST_TIMEOUT_MS, PlatformConfig, UserInstance } from './types.js';

/** Manages the registry, creation locks, limits, eviction, and teardown of running app {@link Instance}s. */
export class InstanceManager {
    /** Running app instances: client runtime id, then instance id. */
    readonly instances: Map<string, Map<string, Instance>> = new Map();
    readonly singletonApps: ReadonlySet<string>;
    private readonly instanceCreationLocks = new Map<string, Promise<void>>();
    private readonly config: PlatformConfig;

    constructor(config: PlatformConfig) {
        this.config = config;
        this.singletonApps = new Set(config.singletonApps ?? []);
    }

    /** Number of running app instances across all clients. */
    get totalInstances(): number {
        let total = 0;
        for (const userInstances of this.instances.values()) {
            total += userInstances.size;
        }
        return total;
    }

    private get workerRequestTimeoutMs(): number {
        return this.config.workerRequestTimeoutMs ?? DEFAULT_WORKER_REQUEST_TIMEOUT_MS;
    }

    private get outgoingStreamTimeoutMs(): number {
        return this.config.outgoingStreamTimeoutMs ?? DEFAULT_OUTGOING_STREAM_TIMEOUT_MS;
    }

    /** Serializes instance-creation operations per lock key (user id). */
    async withCreationLock<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.instanceCreationLocks.get(lockKey);
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.instanceCreationLocks.set(lockKey, current);
        await previous;
        try {
            return await operation();
        } finally {
            release();
            if (this.instanceCreationLocks.get(lockKey) === current) {
                this.instanceCreationLocks.delete(lockKey);
            }
        }
    }

    /** Looks up an instance by `runtimeId` and `instanceId`. */
    get(runtimeId: string, instanceId: string): Instance | undefined {
        return this.instances.get(runtimeId)?.get(instanceId);
    }

    /** Removes an instance from the runtime map and cleans up empty runtime maps. */
    remove(runtimeId: string, instanceId: string): void {
        const instances = this.instances.get(runtimeId);
        if (!instances) {
            return;
        }
        instances.delete(instanceId);
        if (instances.size === 0) {
            this.instances.delete(runtimeId);
        }
    }

    /** Lists the running instances of a client runtime. */
    listUserInstances(runtimeId: string): Array<UserInstance> {
        const userInstances = this.instances.get(runtimeId);
        if (!userInstances) {
            return [];
        }
        return [...userInstances.entries()].map(([id, instance]) => ({
            id,
            appTitle: instance.appTitle,
            appName: instance.appName,
            activityTitle: instance.activityTitle,
            profile: instance.profile,
            touched: instance.touched,
        }));
    }

    /** Destroys a single instance belonging to `runtimeId`, if it exists. */
    closeInstance(runtimeId: string, instanceId: string): void {
        const userInstances = this.instances.get(runtimeId);
        if (!userInstances) {
            return;
        }
        const instance = userInstances.get(instanceId);
        if (!instance) {
            return;
        }
        instance.destroy();
        userInstances.delete(instanceId);
        if (userInstances.size === 0) {
            this.instances.delete(runtimeId);
        }
    }

    /** Finds an existing singleton for `appName` in `runtimeId`, or returns `undefined`. */
    findSingleton(runtimeId: string, appName: string): Instance | undefined {
        const instances = this.instances.get(runtimeId);
        if (!instances) {
            return undefined;
        }
        return findSingletonInstance(instances.values(), appName);
    }

    /** Enforces per-runtime eviction, per-user cap, and global cap, then instantiates and registers a new `Instance`. */
    allocateInstance(userId: string, runtimeId: string, appName: string, profile: string | null, agentController: AgentController): Instance | undefined {
        if (!this.instances.has(runtimeId)) {
            this.instances.set(runtimeId, new Map());
        }
        const instances = this.instances.get(runtimeId)!;
        if (!this.singletonApps.has(appName)) {
            evictOldestRegularInstances(instances, this.config.instanceUserLimit, this.singletonApps);
        }

        if (this.config.maxInstancesPerUser !== undefined) {
            const userTotal = countUserInstances(this.instances, userId);
            if (userTotal >= this.config.maxInstancesPerUser) {
                if (instances.size === 0) {
                    this.instances.delete(runtimeId);
                }
                logger.warn(`Per-user instance limit reached for user '${userId}' (${userTotal}/${this.config.maxInstancesPerUser}). Rejecting createInstance.`);
                return undefined;
            }
        }

        if (this.config.maxInstances !== undefined && this.totalInstances >= this.config.maxInstances) {
            if (instances.size === 0) {
                this.instances.delete(runtimeId);
            }
            logger.warn(`Global instance limit reached (${this.totalInstances}/${this.config.maxInstances}). Rejecting createInstance.`);
            return undefined;
        }

        const instance = new Instance(
            userId,
            appName,
            profile,
            this.config.appIndexPath,
            this.config.tabLimit ?? 12,
            agentController,
            this.config.resourceLimits,
            undefined,
            this.workerRequestTimeoutMs,
            this.outgoingStreamTimeoutMs,
        );
        instances.set(instance.id, instance);
        return instance;
    }

    /** Destroys all running app instances belonging to `runtimeId` and removes the runtime entry. */
    destroyRuntimeInstances(runtimeId: string): void {
        const userInstances = this.instances.get(runtimeId);
        if (!userInstances) {
            return;
        }
        this.instances.delete(runtimeId);
        for (const instance of [...userInstances.values()]) {
            instance.destroy();
        }
    }

    /** Destroys all running app instances belonging to `userId` across all runtimes, optionally sparing `exceptRuntimeId`. */
    destroyUserInstances(userId: string, exceptRuntimeId?: string): void {
        for (const [runtimeId, userInstances] of [...this.instances.entries()]) {
            if (exceptRuntimeId !== undefined && runtimeId === exceptRuntimeId) {
                continue;
            }
            for (const [instanceId, instance] of [...userInstances.entries()]) {
                if (instance.userId === userId) {
                    userInstances.delete(instanceId);
                    instance.destroy();
                }
            }
            if (userInstances.size === 0) {
                this.instances.delete(runtimeId);
            }
        }
    }

    /** Destroys the instances that have had no client socket for `idleTimeoutMs`. */
    destroyIdleInstances(idleTimeoutMs: number): void {
        const now = Date.now();
        for (const [runtimeId, userInstances] of [...this.instances]) {
            for (const instance of findIdleInstances(userInstances.values(), now, idleTimeoutMs)) {
                const idleMinutes = Math.round((now - (instance.idleSince ?? now)) / 60000);
                logger.info(`Destroying idle app instance ${instance.id} (${instance.appName}): no client for ${idleMinutes} min.`);
                userInstances.delete(instance.id);
                instance.destroy();
            }
            if (userInstances.size === 0) {
                this.instances.delete(runtimeId);
            }
        }
    }

    /** Destroys every running app instance across all runtimes. */
    destroyAll(): void {
        for (const userInstances of this.instances.values()) {
            for (const instance of [...userInstances.values()]) {
                instance.destroy();
            }
        }
        this.instances.clear();
    }
}
