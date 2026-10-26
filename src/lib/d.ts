import { Err, Ok, Result } from '@araminix/lib';

import { AgentIndex } from '../agent/d.js';
import { ActivityDriver, ActivityInterface } from '../executor/ActivityInstance.js';
import { AppResult } from '../executor/AppInstance.js';
import workerDriver from '../executor/workerDriver.js';
import { I18nService } from '../utils/i18n.js';
import {
    Actor,
    Close,
    Destroy,
    NextPage,
    Nothing,
    OpenPage,
    PopPage,
    Prev,
    Refresh,
    Reload,
    ReplacePage,
    WizardAttached,
    WizardDetached,
    WizardDone,
    WizardNext,
    WizardNextReplace,
    WizardPop,
} from './actors.js';

export type AppEntry = {
    name: string;
    title: string;
    category: string;
    hidden: boolean;
    widget: boolean;
    multiInstance: boolean;
    description: string;
    profiles: Array<string | null>;
};

export type AppListing = {
    category: string;
    apps: Array<AppEntry>;
};

export abstract class AppIndex<AGENT_INDEX extends AgentIndex = AgentIndex> {
    protected i18n!: I18nService<any, any>;
    abstract agents: AGENT_INDEX;
    private _appList?: Array<{ appName: string; app: App<any, any> }> = undefined;

    constructor() {}

    protected abstract _getUserApps(userId: string): Promise<Result<Array<{ name: string; profiles: Array<string | null>; title: string }>, unknown>>;

    get appList(): Array<{ appName: string; app: App<any, any> }> {
        if (!this._appList) {
            if (this.agents) {
                this.agents.agentTypeList; // init agent names
            }
            this._appList = this.getAppsList();
        }
        return this._appList;
    }

    private getAppsList(): Array<{ appName: string; app: App<any, any> }> {
        const arr: Array<{ appName: string; app: App<any, any> }> = [];
        for (const key of Object.getOwnPropertyNames(this)) {
            const prop = (this as any)[key];
            if (!(prop instanceof App)) {
                continue;
            }
            if (prop.main === undefined) {
                continue;
            }
            const name = key;
            const app = prop;
            app.name = name;
            arr.push({ appName: name, app: app });
        }
        return arr;
    }

    async userApps<TErr = unknown>(userId: string): Promise<Result<Array<AppListing>, TErr>> {
        const result = await this._getUserApps(userId);
        if (result.isErr()) {
            return new Err(result.e as TErr);
        }
        const userApps = result.unwrap();
        const listing: AppEntry[] = [];
        for (const entry of this.appList) {
            const name = entry.appName;
            const app = entry.app;
            const userApp = userApps.find((a) => a.name === name);
            if (userApp) {
                listing.push({
                    name: name,
                    title: userApp.title,
                    category: app.category,
                    hidden: app.hidden,
                    widget: app.widget,
                    multiInstance: app.multiInstance,
                    description: app.description,
                    profiles: [...new Set(userApp.profiles)],
                });
            }
        }

        const byCategory = listing.reduce<Record<string, AppListing>>((acc, item) => {
            if (!acc[item.category]) {
                acc[item.category] = { category: item.category, apps: [] };
            }
            const appDesc: AppEntry = {
                name: item.name,
                title: item.title,
                hidden: item.hidden,
                widget: item.widget,
                multiInstance: item.multiInstance,
                category: item.category,
                profiles: item.profiles,
                description: item.description,
            };
            acc[item.category].apps.push(appDesc);
            return acc;
        }, {});

        return new Ok(Object.values(byCategory));
    }
}

export abstract class App<SETTINGS = unknown, APP_INDEX extends AppIndex<any> = AppIndex<any>> {
    readonly index: APP_INDEX;
    name: string = '';
    abstract readonly title: string | (() => Promise<string>);
    description: string = '';
    category: string = 'Other';
    hidden: boolean = false;
    widget: boolean = false;
    multiInstance: boolean = false;
    abstract main: MainPage<any, App<SETTINGS, APP_INDEX>> | void;
    abstract setupWizard: SetupWizard<SETTINGS, App<SETTINGS, APP_INDEX>> | void;

    constructor(index: APP_INDEX) {
        this.index = index;
    }

    protected get profile(): string | null {
        const launchedApp = workerDriver()?.appName;
        const profile = workerDriver()?.profile;
        if (launchedApp !== this.name) {
            return null;
        }
        return profile;
    }

    dispatch(_action: string, _args: unknown): (void | MainPage<any, App<SETTINGS, APP_INDEX>>)[] {
        return [this.main, undefined];
    }

    async getSettings<TErr = unknown>(): Promise<Result<SETTINGS, TErr>> {
        return (await this._getSettings(workerDriver().userId, this.profile)) as Result<SETTINGS, TErr>;
    }

    protected abstract _getSettings(userId: string, profile: string | null): Promise<Result<SETTINGS, unknown>>;

    async getUnits<TErr = unknown>(): Promise<Result<string[], TErr>> {
        return (await this._getUnits(workerDriver().userId)) as Result<string[], TErr>;
    }

    protected abstract _getUnits(userId: string): Promise<Result<string[], unknown>>;
}

export abstract class Activity<CONTEXT = unknown> {
    protected ctx!: CONTEXT;
    private driver!: ActivityDriver;
    private cleanUp?: (() => void) | void = undefined;

    _init(ctx: CONTEXT, driver: ActivityDriver): ActivityInterface {
        const instance = this.new();
        instance.ctx = ctx;
        instance.driver = driver;
        return new ActivityInterface(
            instance,
            () => instance.beforeRender(),
            () => instance._afterWake(),
            () => instance._cleanUp(),
            () => instance.render(),
            () => instance.title(instance.ctx),
            (c: CONTEXT) => (instance.ctx = c),
        );
    }

    _init2(ctx: CONTEXT, driver: ActivityDriver): ActivityInterface {
        this.ctx = ctx;
        this.driver = driver;
        return new ActivityInterface(
            this,
            () => this.beforeRender(),
            () => this._afterWake(),
            () => this._cleanUp(),
            () => this.render(),
            () => this.title(this.ctx),
            (c: CONTEXT) => (this.ctx = c),
        );
    }

    abstract title(ctx: CONTEXT): Promise<string> | string;

    protected get userId(): string {
        return workerDriver().userId;
    }

    protected abstract new(): Activity<CONTEXT>;

    protected beforeRender(): Promise<Actor> | Actor {
        return this.$nothing();
    }

    private _afterWake(): void {
        this.cleanUp = this.afterWake();
    }

    private _cleanUp(): void {
        if (this.cleanUp) {
            this.cleanUp();
            this.cleanUp = undefined;
        }
    }

    protected afterWake(): (() => void) | void {}

    protected abstract render(): Promise<void>;

    protected $nothing(): Nothing {
        return new Nothing();
    }

    protected $refresh(ctx: CONTEXT): Refresh<CONTEXT> {
        return new Refresh(this, ctx);
    }

    protected $reload(): Reload {
        return new Reload();
    }

    async push<TData = unknown>(data: TData): Promise<AppResult> {
        return await this.driver.push(data);
    }

    async trigger(actor: Actor): Promise<AppResult> {
        return await this.driver.trigger(actor);
    }
}

export abstract class Page<CONTEXT = unknown, APP extends App<any, any> = App<any, any>> extends Activity<CONTEXT> {
    app: APP;

    constructor(app: APP) {
        super();
        this.app = app;
    }

    protected new(): Activity<CONTEXT> {
        return new (this.constructor as new (app: APP) => Page<CONTEXT, APP>)(this.app);
    }

    protected get profile(): string | null {
        const launchedApp = workerDriver()?.appName;
        const profile = workerDriver()?.profile;
        if (launchedApp !== this.app.name) {
            return null;
        }
        return profile;
    }

    $pop(ctx: CONTEXT): PopPage<CONTEXT> {
        return new PopPage(this, ctx);
    }

    $open(ctx: CONTEXT): OpenPage<CONTEXT> {
        return new OpenPage(this, ctx);
    }

    $replace(ctx: CONTEXT): ReplacePage<CONTEXT> {
        return new ReplacePage(this, ctx);
    }

    $next(ctx: CONTEXT): NextPage<CONTEXT> {
        return new NextPage(this, ctx);
    }

    protected $close(): Close<CONTEXT> {
        return new Close(this);
    }

    protected $destroy(): Destroy {
        return new Destroy(this.app);
    }
}

export abstract class Wizard<CONTEXT = unknown, OUTPUT = unknown, PAGE extends Page<any, any> = Page<any, any>> {
    protected abstract main: Stage<CONTEXT, OUTPUT, Wizard<CONTEXT, OUTPUT, PAGE>>;
    readonly page: PAGE;

    constructor(page: PAGE) {
        this.page = page;
    }

    abstract title(ctx: CONTEXT): Promise<string> | string;

    $detached<R = unknown>(ctx: CONTEXT, on?: (result: Result<OUTPUT, unknown> | undefined) => Promise<R> | R): WizardDetached<CONTEXT, OUTPUT, this, R> {
        return new WizardDetached(this.main as any, ctx, on);
    }

    $attached(ctx: CONTEXT, on?: (result: Result<OUTPUT, unknown> | undefined) => Promise<Actor> | Actor): WizardAttached<CONTEXT, OUTPUT, this> {
        return new WizardAttached(this.main as any, ctx, on);
    }

    $pop(ctx: CONTEXT, on?: (result: Result<OUTPUT, unknown> | undefined) => Promise<Actor> | Actor): WizardPop<CONTEXT, OUTPUT, this> {
        return new WizardPop(this.main as any, ctx, on);
    }
}

export abstract class SetupWizard<SETTINGS = unknown, APP extends App<SETTINGS, any> = App<SETTINGS, any>> extends Wizard<SETTINGS | null, SETTINGS, PhantomPage<APP>> {
    abstract main: Stage<SETTINGS | null, SETTINGS, SetupWizard<SETTINGS, APP>>;

    constructor(app: APP) {
        super(new PhantomPage(app));
    }

    async title(_ctx: SETTINGS | null): Promise<string> {
        const title = typeof this.page.app.title === 'string' ? this.page.app.title : await this.page.app.title();
        return `Setup ${title} `;
    }
}

export abstract class Stage<CONTEXT = unknown, OUTPUT = unknown, WIZARD extends Wizard<any, OUTPUT, any> = Wizard<any, OUTPUT, any>> extends Activity<CONTEXT> {
    readonly wizard: WIZARD;

    constructor(wizard: WIZARD) {
        super();
        this.wizard = wizard;
    }

    protected new(): Activity<CONTEXT> {
        return new (this.constructor as new (wizard: WIZARD) => Stage<CONTEXT, OUTPUT, WIZARD>)(this.wizard);
    }

    protected get profile(): string | null {
        const launchedApp = workerDriver()?.appName;
        const profile = workerDriver()?.profile;
        if (launchedApp !== this.wizard.page.app.name) {
            return null;
        }
        return profile;
    }

    get index(): any {
        return this.wizard.page.app.index;
    }

    async title(ctx: CONTEXT): Promise<string> {
        return this.wizard.title(ctx);
    }

    protected $ok(v: OUTPUT): WizardDone<OUTPUT, unknown> {
        return new WizardDone(this.wizard, new Ok(v));
    }

    protected $err<E = unknown>(e: E): WizardDone<OUTPUT, E> {
        return new WizardDone(this.wizard, new Err(e));
    }

    protected $cancel(): WizardDone<OUTPUT, unknown> {
        return new WizardDone(this.wizard, undefined);
    }

    protected $back(): Prev<CONTEXT> {
        return new Prev(this);
    }

    $next(ctx: CONTEXT): WizardNext<CONTEXT, OUTPUT, WIZARD> {
        return new WizardNext(this, ctx);
    }

    $nextReplace(ctx: CONTEXT): WizardNextReplace<CONTEXT, OUTPUT, WIZARD> {
        return new WizardNextReplace(this, ctx);
    }

    protected $destroy(): Destroy {
        return new Destroy(this.wizard.page.app);
    }
}

export abstract class MainPage<CONTEXT = unknown, APP extends App<any, any> = App<any, any>> extends Page<CONTEXT | void, APP> {}

export class PhantomAgentIndex extends AgentIndex {}

export class PhantomAppIndex extends AppIndex<PhantomAgentIndex> {
    protected _getUser(_userId: string): Promise<Result<void, unknown>> {
        return Promise.resolve(new Err(undefined));
    }

    agents = new PhantomAgentIndex();

    protected _getUserApps(_userId: string): Promise<Result<Array<{ name: string; profiles: Array<string | null>; title: string }>, unknown>> {
        return Promise.resolve(new Err(undefined));
    }
}

export class PhantomApp extends App<void, PhantomAppIndex> {
    protected _getSettings(_userId: string, _profile: string | null): Promise<Result<void, unknown>> {
        return Promise.resolve(new Err(undefined));
    }

    protected _getUnits(_userId: string): Promise<Result<string[], unknown>> {
        return Promise.resolve(new Err(undefined));
    }

    main = undefined;
    setupWizard = undefined;
    readonly title = '';
}

export class PhantomPage<APP extends App<any, any> = App<any, any>> extends Page<any, APP> {
    title(_ctx: unknown): string {
        return '';
    }

    protected async render(): Promise<void> {}

    protected new(): Activity<any> {
        return new PhantomPage(this.app);
    }
}

export const phantomApp: PhantomApp = new PhantomApp(new PhantomAppIndex());
export const phantomPage: PhantomPage<PhantomApp> = new PhantomPage(phantomApp);
