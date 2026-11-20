import { Ok } from '@araminix/lib';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import panel from '../src/builder/Panel.js';
import { ActivityInterface } from '../src/executor/ActivityInstance.js';
import { AppInstance } from '../src/executor/AppInstance.js';
import { SendBuild } from '../src/executor/proto.js';
import { initWorkerDriver } from '../src/executor/workerDriver.js';
import { type Actor, Nothing, OpenPage, PopPage, Refresh } from '../src/lib/actors.js';
import { Res } from '../src/lib/worker_socket.js';

let builds: SendBuild[] = [];

// Answers every request from the app to the main thread and records the builds it sends to the client.
function recordBuilds(): void {
    builds = [];
    initWorkerDriver('user-1', null, 'app', {
        writeRead: async (request: unknown) => {
            if (request instanceof SendBuild) builds.push(request);
            return new Ok(new Res());
        },
        close: () => undefined,
    } as any);
}

// A page that renders one empty panel; `beforeRender` decides its first actor from its context.
function page(title: string, beforeRender: (ctx: any, template: any) => Actor = () => new Nothing()): any {
    const template: any = {
        _init: (initialCtx: any) => {
            let ctx = initialCtx;
            return new ActivityInterface(
                template,
                () => beforeRender(ctx, template),
                () => undefined,
                () => undefined,
                async () => {
                    panel(() => undefined);
                },
                () => title,
                (next: any) => {
                    ctx = next;
                },
            );
        },
    };
    return template;
}

async function startedApp(main: any): Promise<AppInstance> {
    const app = new AppInstance({ main } as any, 12);
    await app.init();
    await app.load();
    return app;
}

const active = (app: AppInstance): any => (app as any).active;

describe('activity loading', () => {
    beforeEach(recordBuilds);

    it('sends the build of a page opened with $open', async () => {
        const app = await startedApp(page('main'));
        builds = [];

        await active(app).handleActor(new OpenPage(page('second'), undefined));

        assert.strictEqual(builds.length, 1);
        assert.strictEqual(builds[0].data.activityId, app.activeId);
        assert.ok(builds[0].data.build, 'the build has content');
        assert.strictEqual(builds[0].data.isPop, false);
    });

    it('sends the build of a page opened with $pop, marked as a pop', async () => {
        const app = await startedApp(page('main'));
        builds = [];

        await active(app).handleActor(new PopPage(page('pop'), undefined));

        assert.strictEqual(builds.length, 1);
        assert.ok(builds[0].data.build, 'the build has content');
        assert.strictEqual(builds[0].data.isPop, true);
    });

    it('never sends an empty build when the client loads again', async () => {
        const app = await startedApp(page('main'));
        await active(app).handleActor(new PopPage(page('pop'), undefined));
        builds = [];

        await app.load();

        assert.strictEqual(builds.length, 1);
        assert.ok(builds[0].data.build, 'the build has content');
    });

    it('sends the previous page again when the active tab is closed', async () => {
        const app = await startedApp(page('main'));
        const mainId = app.activeId;
        await active(app).handleActor(new OpenPage(page('second'), undefined));
        builds = [];

        await app.close(app.activeId);

        assert.strictEqual(app.activeId, mainId);
        assert.strictEqual(builds.length, 1);
        assert.strictEqual(builds[0].data.activityId, mainId);
        assert.ok(builds[0].data.build, 'the build has content');
    });

    it('builds once when beforeRender() refreshes the page with a default context', async () => {
        await startedApp(page('main', (ctx, template) => (ctx?.ready ? new Nothing() : new Refresh(template, { ready: true }))));

        assert.strictEqual(builds.length, 1);
        assert.ok(builds[0].data.build, 'the build has content');
    });
});
