import assert from 'node:assert';
import { describe, it } from 'node:test';

import Platform from '../src/Platform.js';
import { AgentInfo, AuthProvider } from '../src/server/AuthProvider.js';
import EndpointController from '../src/server/EndpointController.js';

function mockWs() {
    const ws: any = {
        readyState: 1,
        closedWith: undefined as number | undefined,
        send: () => {},
        close: (code?: number) => {
            ws.closedWith = code;
        },
        onopen: null,
        onerror: null,
        onclose: null,
        onmessage: null,
    };
    return ws;
}

describe('Per-client connection cap', () => {
    it('refuses new connections beyond maxConnectionsPerClient but still allows reconnects and other clients', async () => {
        const controller = new EndpointController({ maxConnectionsPerClient: 2 });
        const alice = new AgentInfo('alice', 'typeX');
        const bob = new AgentInfo('bob', 'typeX');

        const first = mockWs();
        const second = mockWs();
        await controller.connect(first, 'token', alice, 'a');
        await controller.connect(second, 'token', alice, 'b');
        assert.strictEqual(first.closedWith, undefined);
        assert.strictEqual(second.closedWith, undefined);

        const third = mockWs();
        await controller.connect(third, 'token', alice, 'c');
        assert.strictEqual(third.closedWith, 1008, 'a third distinct connection is refused');

        const reconnect = mockWs();
        await controller.connect(reconnect, 'token', alice, 'a');
        assert.strictEqual(reconnect.closedWith, undefined, 'reconnecting an existing arg is not a new connection');

        const other = mockWs();
        await controller.connect(other, 'token', bob, 'a');
        assert.strictEqual(other.closedWith, undefined, 'the cap is per client');

        (controller as any).connections.forEach((entry: any) => entry.connection.destroy('Intentional'));
    });

    it('frees a slot when a connection is destroyed', async () => {
        const controller = new EndpointController({ maxConnectionsPerClient: 1 });
        const alice = new AgentInfo('alice', 'typeX');
        const acquire = controller.acquire();

        await controller.connect(mockWs(), 'token', alice, 'a');
        const request = (await acquire).unwrap();
        request.deny();

        const next = mockWs();
        await controller.connect(next, 'token', alice, 'b');
        assert.strictEqual(next.closedWith, undefined);
        (controller as any).connections.forEach((entry: any) => entry.connection.destroy('Intentional'));
    });

    it('defaults to 32 connections per client and passes maxPendingStreams to new connections', async () => {
        const controller = new EndpointController();
        assert.strictEqual((controller as any).maxConnectionsPerClient, 32);

        await controller.connect(mockWs(), 'token', new AgentInfo('carol', 'typeX'), 'a');
        const entry = [...(controller as any).connections.values()][0];
        assert.strictEqual(entry.connection.inter.maxPendingStreams, 64);

        const unlimited = new EndpointController({ maxConnectionsPerClient: 0, maxPendingStreams: 0 });
        for (let i = 0; i < 40; i++) {
            const ws = mockWs();
            await unlimited.connect(ws, 'token', new AgentInfo('dave', 'typeX'), `arg-${i}`);
            assert.strictEqual(ws.closedWith, undefined);
        }
        const unlimitedEntry = [...(unlimited as any).connections.values()][0];
        assert.strictEqual(unlimitedEntry.connection.inter.maxPendingStreams, undefined);

        for (const c of [controller, unlimited]) {
            (c as any).connections.forEach((e: any) => e.connection.destroy('Intentional'));
        }
    });

    it('passes the cap options from PlatformConfig to its endpoint controllers', async () => {
        const platform = new Platform({
            appIndexPath: new URL('file:///d:/dummy/apps.js'),
            agentIndexPath: new URL('file:///d:/dummy/agents.js'),
            authProvider: {} as AuthProvider,
            instanceUserLimit: 5,
            cookieSecret: 'secret',
            maxConnectionsPerClient: 3,
            maxPendingStreams: 7,
            maxMessageBytes: 1024,
        });
        // Platform's accept loops declare their endpoints on the next tick.
        await new Promise((resolve) => setImmediate(resolve));
        const controller = (platform.endpoint as any).endpoints.get('platform');
        assert.strictEqual(controller.maxConnectionsPerClient, 3);
        assert.strictEqual(controller.maxPendingStreams, 7);
        assert.strictEqual((platform.endpoint as any).wsInstance.getWss().options.maxPayload, 1024);
        platform.stop();
    });
});
