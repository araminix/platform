import { CloseCodes, Err, Socket, SocketErr } from '@araminix/lib';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import AgentController from '../src/agent/AgentController.js';
import Instance from '../src/executor/Instance.js';
import { evictOldestRegularInstances, findIdleInstances, findSingletonInstance } from '../src/executor/instancePolicy.js';

// A client socket that serves no streams and closes when `close` is called.
function fakeSocket(): { socket: Socket; close: () => void } {
    let resolveClose!: (code: CloseCodes) => void;
    const closed = new Promise<CloseCodes>((resolve) => {
        resolveClose = resolve;
    });
    const socket = {
        incomingStream: async () => new Err(SocketErr.Closed),
        waitClose: async () => closed,
        destroy: () => resolveClose(CloseCodes.Intentional),
    } as unknown as Socket;
    return { socket, close: () => resolveClose(CloseCodes.Died) };
}

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

    it('tracks since when an instance has had no client socket', async () => {
        const instance = createInstance('instance-1', 'app', 1);
        assert.ok(instance.idleSince !== undefined, 'a new instance counts as idle until a client connects');

        const { socket, close } = fakeSocket();
        instance.connect(socket);
        assert.strictEqual(instance.idleSince, undefined);

        const beforeClose = Date.now();
        close();
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok((instance.idleSince ?? 0) >= beforeClose);
    });

    it('finds only the instances idle for at least the timeout', () => {
        const idle = createInstance('idle-1', 'app-a', 1);
        const connected = createInstance('connected-1', 'app-b', 2);
        connected.connect(fakeSocket().socket);
        const since = idle.idleSince ?? 0;

        assert.deepStrictEqual(
            findIdleInstances([idle, connected], since + 1000, 1000).map((instance) => instance.id),
            ['idle-1'],
        );
        assert.deepStrictEqual(findIdleInstances([idle, connected], since + 999, 1000), []);
    });
});
