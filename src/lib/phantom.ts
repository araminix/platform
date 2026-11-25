import { Err, Result } from '@araminix/lib';

import { AgentIndex } from '../agent/d.js';
import { Activity } from './Activity.js';
import { App } from './App.js';
import { AppIndex } from './AppIndex.js';
import { Page } from './Page.js';

/** Empty agent index used by {@link PhantomAppIndex}. */
export class PhantomAgentIndex extends AgentIndex {}

/** Placeholder app index (it allows no apps), used by {@link phantomApp}. */
export class PhantomAppIndex extends AppIndex<PhantomAgentIndex> {
    /** Always fails; kept for compatibility. */
    protected _getUser(_userId: string): Promise<Result<void, unknown>> {
        return Promise.resolve(new Err(undefined));
    }

    /** Empty agent index. */
    agents = new PhantomAgentIndex();

    /** Always fails: the phantom index offers no apps. */
    protected _getUserApps(_userId: string): Promise<Result<Array<{ name: string; profiles: Array<string | null>; title: string }>, unknown>> {
        return Promise.resolve(new Err(undefined));
    }
}

/** Placeholder app without pages, used by {@link phantomApp} and {@link phantomPage}. */
export class PhantomApp extends App<void, PhantomAppIndex> {
    /** Always fails. */
    protected _getSettings(_userId: string, _profile: string | null): Promise<Result<void, unknown>> {
        return Promise.resolve(new Err(undefined));
    }

    /** Always fails. */
    protected _getUnits(_userId: string): Promise<Result<string[], unknown>> {
        return Promise.resolve(new Err(undefined));
    }

    /** No entry page. */
    main = undefined;
    /** No setup wizard. */
    setupWizard = undefined;
    /** Empty title. */
    readonly title = '';
}

/**
 * Placeholder page that renders nothing. {@link SetupWizard} uses one as its {@link Wizard.page}, because a setup wizard
 * is not owned by a real page.
 *
 * @typeParam APP - The app it pretends to belong to.
 */
export class PhantomPage<APP extends App<any, any> = App<any, any>> extends Page<any, APP> {
    /** Empty title. */
    title(_ctx: unknown): string {
        return '';
    }

    /** Renders nothing. */
    protected async render(): Promise<void> {}

    /** Creates another phantom page for the same app. */
    protected new(): Activity<any> {
        return new PhantomPage(this.app);
    }
}

/** Shared placeholder app. */
export const phantomApp: PhantomApp = new PhantomApp(new PhantomAppIndex());
/** Shared placeholder page of {@link phantomApp}. */
export const phantomPage: PhantomPage<PhantomApp> = new PhantomPage(phantomApp);
