import type Instance from './Instance.js';

export function findSingletonInstance(instances: Iterable<Instance>, appName: string): Instance | undefined {
    for (const instance of instances) {
        if (!instance.isDestroyed && instance.appName === appName) {
            return instance;
        }
    }
    return undefined;
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
