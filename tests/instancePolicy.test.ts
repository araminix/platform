import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import AgentController from '../src/agent/AgentController.js';
import Instance from '../src/executor/Instance.js';
import { evictOldestRegularInstances, findSingletonInstance } from '../src/executor/instancePolicy.js';

function createInstance(id: string, appName: string, touched: number, profile: string | null = null): Instance {
    const instance = new Instance('user-1', appName, profile, new URL('file:///dummy'), 10, {} as AgentController);
    Object.defineProperty(instance, 'id', { value: id });
    instance.touch(touched);
    return instance;
}

describe('instance policy', () => {
    it('reuses the existing active singleton instance', () => {
        const singleton = createInstance('singleton-1', 'notification', 100);
        const instances = new Map([[singleton.id, singleton]]);

        assert.strictEqual(findSingletonInstance(instances.values(), 'notification'), singleton);
        assert.strictEqual(findSingletonInstance(instances.values(), 'widget'), undefined);
    });

    it('evicts the oldest regular instances without counting or evicting singletons', () => {
        const notification = createInstance('notification-1', 'notification', 1);
        const widget = createInstance('widget-1', 'widget', 2);
        const regularInstances = Array.from({ length: 6 }, (_, index) => createInstance(`regular-${index}`, `app-${index}`, index + 10));
        const instances = new Map([notification, widget, ...regularInstances].map((instance) => [instance.id, instance]));

        evictOldestRegularInstances(instances, 6, new Set(['notification', 'widget']));

        assert.strictEqual(instances.size, 7);
        assert.ok(instances.has(notification.id));
        assert.ok(instances.has(widget.id));
        assert.ok(!instances.has('regular-0'));
        assert.ok(instances.has('regular-5'));
    });
});
