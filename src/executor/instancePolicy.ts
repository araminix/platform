import type Instance from './Instance.js';

export function findSingletonInstance(instances: Iterable<Instance>, appName: string): Instance | undefined {
    for (const instance of instances) {
        if (!instance.isDestroyed && instance.appName === appName) {
            return instance;
        }
    }
    return undefined;
}

/** Instances that have had no client socket for at least `idleTimeoutMs` at time `now`. */
export function findIdleInstances(instances: Iterable<Instance>, now: number, idleTimeoutMs: number): Instance[] {
    const idle: Instance[] = [];
    for (const instance of instances) {
        const since = instance.idleSince;
        if (since !== undefined && now - since >= idleTimeoutMs) {
            idle.push(instance);
        }
    }
    return idle;
}

/** Counts all running app instances belonging to `userId` across all client runtimes. */
export function countUserInstances(allInstances: ReadonlyMap<string, ReadonlyMap<string, Instance>>, userId: string): number {
    let count = 0;
    for (const runtimeInstances of allInstances.values()) {
        for (const instance of runtimeInstances.values()) {
            if (instance.userId === userId) {
                count++;
            }
        }
    }
    return count;
}

export function evictOldestRegularInstances(instances: Map<string, Instance>, limit: number, singletonApps: ReadonlySet<string>): void {
    let regularCount = 0;
    for (const instance of instances.values()) {
        if (!singletonApps.has(instance.appName)) {
            regularCount++;
        }
    }

    while (regularCount >= limit) {
        let oldest: Instance | undefined;
        for (const instance of instances.values()) {
            if (singletonApps.has(instance.appName)) {
                continue;
            }
            if (!oldest || instance.touched < oldest.touched) {
                oldest = instance;
            }
        }
        if (!oldest) {
            return;
        }
        instances.delete(oldest.id);
        oldest.destroy();
        regularCount--;
    }
}
