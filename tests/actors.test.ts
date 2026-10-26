import { Ok } from '@araminix/lib';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
    Close,
    Destroy,
    NextPage,
    Nothing,
    OpenPage,
    PopPage,
    Prev,
    Refresh,
    Reload,
    ReloadFragment,
    ReplacePage,
    UpdateFragment,
    UpdateTypes,
    WizardDone,
    WizardNext,
} from '../src/lib/actors.js';

describe('Actors', () => {
    it('creates Page actors with context', () => {
        const mockPage: any = { name: 'TestPage' };
        const open = new OpenPage(mockPage, { id: 123 });
        assert.strictEqual(open.page, mockPage);
        assert.deepStrictEqual(open.ctx, { id: 123 });

        const pop = new PopPage(mockPage, { id: 456 });
        assert.strictEqual(pop.page, mockPage);
        assert.deepStrictEqual(pop.ctx, { id: 456 });

        const next = new NextPage(mockPage, null);
        assert.strictEqual(next.page, mockPage);

        const replace = new ReplacePage(mockPage, 'arg');
        assert.strictEqual(replace.ctx, 'arg');
    });

    it('creates Fragment actors with payload', () => {
        const update = new UpdateFragment('frag-1', UpdateTypes.Full, { count: 10 });
        assert.strictEqual(update.fragmentId, 'frag-1');
        assert.strictEqual(update.type, UpdateTypes.Full);
        assert.deepStrictEqual(update.data, { count: 10 });

        const reload = new ReloadFragment('frag-2');
        assert.strictEqual(reload.fragmentId, 'frag-2');
    });

    it('creates Wizard actors', () => {
        const mockWizard: any = { name: 'Wiz' };
        const done = new WizardDone(mockWizard, new Ok('success'));
        assert.strictEqual(done.wizard, mockWizard);
        assert.strictEqual(done.result?.unwrap(), 'success');
    });

    it('creates lifecycle actors', () => {
        const act: any = {};
        const close = new Close(act);
        assert.strictEqual(close.activity, act);

        const prev = new Prev(act);
        assert.strictEqual(prev.activity, act);

        const reload = new Reload();
        assert.ok(reload instanceof Reload);

        const nothing = new Nothing();
        assert.ok(nothing instanceof Nothing);
    });
});
