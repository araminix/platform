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

/** One app in the list a user receives on the `listApps` stream (see {@link AppIndex.userApps}). */
export type AppEntry = {
    /** App name: the property name of the app on the {@link AppIndex}. Pass it to `createInstance`. */
    name: string;
    /** Title for this user, as returned by {@link AppIndex._getUserApps} (not {@link App.title}). */
    title: string;
    /** {@link App.category}. */
    category: string;
    /** {@link App.hidden}. */
    hidden: boolean;
    /** {@link App.widget}. */
    widget: boolean;
    /** {@link App.multiInstance}. */
    multiInstance: boolean;
    /** {@link App.description}. */
    description: string;
    /** Profiles the user may launch the app with (duplicates removed); `null` stands for "no profile". */
    profiles: Array<string | null>;
};

/** Apps of one category, as sent on the `listApps` stream. */
export type AppListing = {
    /** Category name. */
    category: string;
    /** Apps in this category, in declaration order. */
    apps: Array<AppEntry>;
};

/**
 * Root of your application: declares every app and the agent index. The module at {@link PlatformConfig.appIndexPath}
 * must `export default` a subclass with a no-argument constructor.
 *
 * Every own property that holds an {@link App} with a `main` page is an app; the property name becomes {@link App.name}.
 * {@link AppIndex._getUserApps} decides which of them a user may launch, with which title and profiles.
 *
 * @typeParam AGENT_INDEX - Your {@link AgentIndex} subclass.
 *
 * @remarks
 * The class is instantiated once in the main thread (for app listings) and once in every app worker thread, so keep the
 * constructor cheap and free of side effects, and do not rely on state shared between threads.
 *
 * @example
 * ```ts
 * import { AppIndex, Ok } from '@araminix/platform';
 *
 * export default class MyApps extends AppIndex<MyAgents> {
 *     agents = new MyAgents();
 *     tasks = new TasksApp(this); // app name "tasks"
 *     reports = new ReportsApp(this); // app name "reports"
 *
 *     protected async _getUserApps(userId: string) {
 *         const rows = await db.appsOfUser(userId); // e.g. [{ name: 'tasks', title: 'Tasks', profiles: [null] }]
 *         return new Ok(rows);
 *     }
 * }
 * ```
 */
export abstract class AppIndex<AGENT_INDEX extends AgentIndex = AgentIndex> {
    /** Translation service for your apps. Declared for convenience; the platform never assigns it. */
    protected i18n!: I18nService<any, any>;
    /** Your agent index; apps reach agents through `this.index.agents.<type>` (see {@link AgentFactory.acquire}). */
    abstract agents: AGENT_INDEX;
    /** Cached result of {@link AppIndex.appList}. */
    private _appList?: Array<{ appName: string; app: App<any, any> }> = undefined;

    /** Subclasses must keep a no-argument constructor: the platform creates the index with `new YourIndex()`. */
    constructor() {}

    /**
     * Returns the apps `userId` may launch: the app `name` (property name on this index), the `title` to show and the
     * allowed `profiles` (use `[null]` for an app without profiles). Entries without a matching declared app are ignored.
     *
     * Called in the main thread for every `listApps` and `createInstance` request, so cache it if it is expensive.
     *
     * @param userId - {@link ClientInfo.id} of the user.
     * @returns The allowed apps, or an `Err` (the request then fails).
     */
    protected abstract _getUserApps(userId: string): Promise<Result<Array<{ name: string; profiles: Array<string | null>; title: string }>, unknown>>;

    /**
     * Declared apps (own properties that hold an {@link App} with a `main` page), discovered on first access. Discovery also
     * sets {@link App.name} and the {@link AgentFactory.name}s of {@link AppIndex.agents}.
     */
    get appList(): Array<{ appName: string; app: App<any, any> }> {
        if (!this._appList) {
            if (this.agents) {
                this.agents.agentTypeList; // init agent names
            }
            this._appList = this.getAppsList();
        }
        return this._appList;
    }

    /** Scans the own properties for apps. */
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

    /**
     * Builds the app listing of a user: the declared apps that {@link AppIndex._getUserApps} allows, grouped by
     * {@link App.category} (categories in order of first appearance).
     *
     * @typeParam TErr - Error type of `_getUserApps`.
     * @param userId - {@link ClientInfo.id} of the user.
     * @returns The listing, or the error of `_getUserApps`.
     */
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

/**
 * One application: its metadata, its pages and its entry page {@link App.main}.
 *
 * Declare pages and wizards as properties so that other pages can reach them through `this.app`; each property holds a
 * template, and every time a page is opened the runtime creates a fresh instance of it. An instance of the app runs in
 * its own worker thread per user launch.
 *
 * @typeParam SETTINGS - Type of the per-user settings returned by {@link App.getSettings}.
 * @typeParam APP_INDEX - Your {@link AppIndex} subclass.
 *
 * @example
 * ```ts
 * import { App, Ok, Result } from '@araminix/platform';
 *
 * export class TasksApp extends App<void, MyApps> {
 *     readonly title = 'Tasks';
 *     category = 'Productivity';
 *     description = 'Track your tasks';
 *     main = new HomePage(this);
 *     task = new TaskPage(this); // opened with this.app.task.$open({ id })
 *     setupWizard = undefined;
 *
 *     protected async _getSettings(userId: string, profile: string | null): Promise<Result<void, unknown>> {
 *         return new Ok(undefined);
 *     }
 *
 *     protected async _getUnits(userId: string): Promise<Result<string[], unknown>> {
 *         return new Ok([]);
 *     }
 * }
 * ```
 */
export abstract class App<SETTINGS = unknown, APP_INDEX extends AppIndex<any> = AppIndex<any>> {
    /** The app index that declares this app (gives access to other apps and to `index.agents`). */
    readonly index: APP_INDEX;
    /** App name, set to the property name on the {@link AppIndex} when the index discovers its apps; `''` before that. */
    name: string = '';
    /**
     * App title, or an async function returning it. It becomes the instance's `appTitle` (see {@link UserInstance}); app
     * listings use the per-user title from {@link AppIndex._getUserApps} instead.
     */
    abstract readonly title: string | (() => Promise<string>);
    /**
     * Short description shown in app listings.
     *
     * @defaultValue `''`
     */
    description: string = '';
    /**
     * Category used to group app listings.
     *
     * @defaultValue `'Other'`
     */
    category: string = 'Other';
    /**
     * Hint for the front-end to hide the app from menus. The platform still lets the user launch it.
     *
     * @defaultValue `false`
     */
    hidden: boolean = false;
    /**
     * Hint for the front-end that the app can be shown as a dashboard widget.
     *
     * @defaultValue `false`
     */
    widget: boolean = false;
    /**
     * Hint for the front-end that the app may be opened several times at once. Not enforced by the platform.
     *
     * @defaultValue `false`
     */
    multiInstance: boolean = false;
    /** Entry page, opened when an instance starts. Apps whose `main` is `undefined` are ignored by the index. */
    abstract main: MainPage<any, App<SETTINGS, APP_INDEX>> | void;
    /**
     * Optional wizard that edits the app's settings. The runtime does not start it; open it yourself, e.g.
     * `this.app.setupWizard.$detached(currentSettings, onDone)`. Set it to `undefined` when not needed.
     */
    abstract setupWizard: SetupWizard<SETTINGS, App<SETTINGS, APP_INDEX>> | void;

    /** @param index - The app index that declares the app (pass `this` from the index). */
    constructor(index: APP_INDEX) {
        this.index = index;
    }

    /**
     * Profile the current instance was launched with, when this app is the launched app; otherwise `null`. Only meaningful
     * inside the app's worker thread.
     */
    protected get profile(): string | null {
        const launchedApp = workerDriver()?.appName;
        const profile = workerDriver()?.profile;
        if (launchedApp !== this.name) {
            return null;
        }
        return profile;
    }

    /**
     * Routing hook for subclasses; the default returns `[this.main, undefined]`. Not called by the platform runtime.
     *
     * @param _action - Action name.
     * @param _args - Action arguments.
     */
    dispatch(_action: string, _args: unknown): (void | MainPage<any, App<SETTINGS, APP_INDEX>>)[] {
        return [this.main, undefined];
    }

    /**
     * Loads the settings of the current user and profile through {@link App._getSettings}. Call it from pages and stages
     * (inside the app worker thread).
     *
     * @typeParam TErr - Error type.
     * @returns The settings, or the error of `_getSettings`.
     */
    async getSettings<TErr = unknown>(): Promise<Result<SETTINGS, TErr>> {
        return (await this._getSettings(workerDriver().userId, this.profile)) as Result<SETTINGS, TErr>;
    }

    /**
     * Reads the settings of a user for a profile from your storage.
     *
     * @param userId - Id of the user.
     * @param profile - Profile of the instance, or `null`.
     */
    protected abstract _getSettings(userId: string, profile: string | null): Promise<Result<SETTINGS, unknown>>;

    /**
     * Loads the units of the current user through {@link App._getUnits} (inside the app worker thread).
     *
     * @typeParam TErr - Error type.
     * @returns The unit keys, or the error of `_getUnits`.
     */
    async getUnits<TErr = unknown>(): Promise<Result<string[], TErr>> {
        return (await this._getUnits(workerDriver().userId)) as Result<string[], TErr>;
    }

    /**
     * Reads the organisational units of a user from your storage.
     *
     * @param userId - Id of the user.
     */
    protected abstract _getUnits(userId: string): Promise<Result<string[], unknown>>;
}

/**
 * Base class of everything that is shown as one screen: {@link Page} (and {@link MainPage}) and wizard {@link Stage}s.
 *
 * The object you declare is a template. Each time it is opened, the runtime creates a fresh instance (see `new()`) with
 * the given context and runs the lifecycle:
 *
 * 1. `title(ctx)` - the activity title, sent with the activity list (`activityList` stream).
 * 2. `beforeRender()` - may return an actor to redirect or close before anything is shown.
 * 3. `render()` - builds the panels and fragments; the result is sent on the `build` stream.
 * 4. `afterWake()` - start timers or subscriptions; return a cleanup function.
 *
 * The cleanup runs when the activity stops being the active one, is closed, reloaded or refreshed. All lifecycle calls,
 * fragment actions and `trigger()` calls of an app instance are serialised by the app lock.
 *
 * @typeParam CONTEXT - Type of the context the activity is opened with (available as `this.ctx`).
 */
export abstract class Activity<CONTEXT = unknown> {
    /** The context this activity was opened (or last refreshed) with. */
    protected ctx!: CONTEXT;
    /** Connection to the runtime, set by `_init`. */
    private driver!: ActivityDriver;
    /** Cleanup returned by the last `afterWake()`. */
    private cleanUp?: (() => void) | void = undefined;

    /**
     * Internal: creates a fresh instance of this template with `new()`, binds the context and the runtime driver, and
     * returns the hooks the runtime calls. Not meant for application code.
     *
     * @param ctx - Context of the new activity.
     * @param driver - Runtime driver of the new activity.
     */
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

    /**
     * Internal: like `_init`, but binds this very object instead of a fresh instance. Not used by the runtime.
     *
     * @param ctx - Context of the activity.
     * @param driver - Runtime driver of the activity.
     */
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

    /**
     * Title of the activity (shown in tabs); evaluated when the activity is prepared, i.e. on first display and on refresh.
     *
     * @param ctx - The activity's context.
     */
    abstract title(ctx: CONTEXT): Promise<string> | string;

    /** Id of the user who owns the app instance. */
    protected get userId(): string {
        return workerDriver().userId;
    }

    /** Creates a blank instance of the same class; implemented by {@link Page} and {@link Stage}. */
    protected abstract new(): Activity<CONTEXT>;

    /**
     * Runs before the first render (and again on refresh). Return `$nothing()` to continue, or another actor, e.g.
     * `this.app.login.$replace(undefined)` or `this.$close()`, to redirect instead.
     *
     * @defaultValue returns `$nothing()`
     */
    protected beforeRender(): Promise<Actor> | Actor {
        return this.$nothing();
    }

    /** Calls `afterWake()` and stores its cleanup. */
    private _afterWake(): void {
        this.cleanUp = this.afterWake();
    }

    /** Runs and forgets the stored `afterWake()` cleanup. */
    private _cleanUp(): void {
        if (this.cleanUp) {
            this.cleanUp();
            this.cleanUp = undefined;
        }
    }

    /**
     * Called every time the activity is woken: after its build was sent and whenever it becomes active again. Start timers,
     * polling or subscriptions here and return a function that stops them.
     *
     * It runs outside the app lock, so a timer started here that calls {@link Activity.trigger} waits for the lock like any
     * other caller instead of interleaving with a running action.
     *
     * @returns An optional cleanup function.
     *
     * @example
     * ```ts
     * protected afterWake() {
     *     const timer = setInterval(() => this.trigger(this.$reload()), 30_000);
     *     return () => clearInterval(timer);
     * }
     * ```
     */
    protected afterWake(): (() => void) | void {}

    /**
     * Builds the UI: create {@link panel}s and {@link Fragment}s (with `new`). Fragments must be created while `render()` runs
     * (awaiting inside it is fine); fragments created later are not part of the build.
     *
     * @example
     * ```ts
     * protected async render(): Promise<void> {
     *     const rows = await loadRows(this.ctx.id);
     *     panel({ styles: ['column'], render: () => {
     *         new Title({ text: `Order ${this.ctx.id}` });
     *         new Table({ rows });
     *     } });
     * }
     * ```
     */
    protected abstract render(): Promise<void>;

    /** Actor that changes nothing (see {@link Nothing}). */
    protected $nothing(): Nothing {
        return new Nothing();
    }

    /**
     * Actor that rebuilds this activity with a new context (see {@link Refresh}).
     *
     * @param ctx - The new context.
     */
    protected $refresh(ctx: CONTEXT): Refresh<CONTEXT> {
        return new Refresh(this, ctx);
    }

    /** Actor that re-renders the active activity with its current context (see {@link Reload}). */
    protected $reload(): Reload {
        return new Reload();
    }

    /**
     * Sends arbitrary data to the client on the instance's `push` stream, whether or not this activity is active (for
     * notifications, progress, clocks, ...).
     *
     * @typeParam TData - Data type; must be JSON-serialisable.
     * @param data - The data.
     * @returns `Ok` once the client accepted the stream and closed it normally; `Err(AppError.Other)` when no client is
     *     connected or the stream failed.
     */
    async push<TData = unknown>(data: TData): Promise<AppResult> {
        return await this.driver.push(data);
    }

    /**
     * Applies an actor outside of a fragment action, e.g. from a timer or a callback. The call waits for the app lock, so it
     * never interleaves with a running action.
     *
     * @param actor - The actor to apply.
     * @returns The result of the actor; most actors fail with `AppError.NonActive` when this activity is not active.
     *
     * @example
     * ```ts
     * protected afterWake() {
     *     const unsubscribe = orders.onChange(() => this.trigger(this.$refresh(this.ctx)));
     *     return unsubscribe;
     * }
     * ```
     */
    async trigger(actor: Actor): Promise<AppResult> {
        return await this.driver.trigger(actor);
    }
}

/**
 * A screen of an {@link App}. Declare page templates as properties of the app and navigate with the `$` helpers of the
 * target page: `$open` (new activity), `$next` (same activity, with back), `$replace` (same activity, no back) and `$pop`
 * (pop-up).
 *
 * Subclasses must keep the `(app)` constructor signature: the runtime creates fresh instances with
 * `new YourPage(this.app)`.
 *
 * @typeParam CONTEXT - Type of the context the page is opened with.
 * @typeParam APP - Your {@link App} subclass.
 *
 * @example
 * ```ts
 * import { Page, panel } from '@araminix/platform';
 *
 * class TaskPage extends Page<{ id: string }, TasksApp> {
 *     title(ctx: { id: string }) {
 *         return `Task ${ctx.id}`;
 *     }
 *
 *     protected async render(): Promise<void> {
 *         panel(() => {
 *             new TaskDetails({ id: this.ctx.id });
 *             new Button({ label: 'Edit', onClick: () => this.app.editTask.$next({ id: this.ctx.id }) });
 *             new Button({ label: 'Close', onClick: () => this.$close() });
 *         });
 *     }
 * }
 * ```
 */
export abstract class Page<CONTEXT = unknown, APP extends App<any, any> = App<any, any>> extends Activity<CONTEXT> {
    /** The app this page belongs to. */
    app: APP;

    /** @param app - The app that declares the page (pass `this` from the app). */
    constructor(app: APP) {
        super();
        this.app = app;
    }

    /** Creates a fresh page with `new this.constructor(this.app)`. */
    protected new(): Activity<CONTEXT> {
        return new (this.constructor as new (app: APP) => Page<CONTEXT, APP>)(this.app);
    }

    /** Profile the instance was launched with, or `null` when this page's app is not the launched app. */
    protected get profile(): string | null {
        const launchedApp = workerDriver()?.appName;
        const profile = workerDriver()?.profile;
        if (launchedApp !== this.app.name) {
            return null;
        }
        return profile;
    }

    /**
     * Actor that shows this page as a pop-up of the current activity (see {@link PopPage}). Call it on the target page.
     *
     * @param ctx - Context for the page.
     */
    $pop(ctx: CONTEXT): PopPage<CONTEXT> {
        return new PopPage(this, ctx);
    }

    /**
     * Actor that opens this page as a new activity (see {@link OpenPage}). Call it on the target page.
     *
     * @param ctx - Context for the page.
     *
     * @example
     * ```ts
     * new Button({ label: 'Open', onClick: () => this.app.task.$open({ id: '42' }) });
     * ```
     */
    $open(ctx: CONTEXT): OpenPage<CONTEXT> {
        return new OpenPage(this, ctx);
    }

    /**
     * Actor that replaces the current page with this one, without "back" (see {@link ReplacePage}). Call it on the target
     * page.
     *
     * @param ctx - Context for the page.
     */
    $replace(ctx: CONTEXT): ReplacePage<CONTEXT> {
        return new ReplacePage(this, ctx);
    }

    /**
     * Actor that shows this page in the current activity and keeps the current page for "back" (see {@link NextPage}). Call
     * it on the target page.
     *
     * @param ctx - Context for the page.
     */
    $next(ctx: CONTEXT): NextPage<CONTEXT> {
        return new NextPage(this, ctx);
    }

    /** Actor that closes this activity (see {@link Close}). */
    protected $close(): Close<CONTEXT> {
        return new Close(this);
    }

    /** Actor that ends the whole app instance (see {@link Destroy}). */
    protected $destroy(): Destroy {
        return new Destroy(this.app);
    }
}

/**
 * A multi-step flow made of {@link Stage}s that produces a result of type `OUTPUT`.
 *
 * Declare the stages as properties (the first one as `main`), create the wizard as a property of the page that starts it,
 * and start it with {@link Wizard.$detached}, {@link Wizard.$attached} or {@link Wizard.$pop}. Stages move with
 * `next.$next(ctx)` and finish with `$ok(output)`, `$err(error)` or `$cancel()`.
 *
 * @typeParam CONTEXT - Context type shared by the stages.
 * @typeParam OUTPUT - Result type.
 * @typeParam PAGE - The page that owns the wizard.
 *
 * @example
 * ```ts
 * import { Stage, Wizard } from '@araminix/platform';
 *
 * type Task = { title: string; due: string };
 *
 * class TitleStage extends Stage<Partial<Task>, Task, NewTaskWizard> {
 *     protected async render() {
 *         new Form<{ title: string }>({ fields: ['title'], onSubmit: ({ title }) => this.wizard.due.$next({ ...this.ctx, title }) });
 *     }
 * }
 *
 * class DueStage extends Stage<Partial<Task>, Task, NewTaskWizard> {
 *     protected async render() {
 *         new Form<{ due: string }>({ fields: ['due'], onSubmit: ({ due }) => this.$ok({ title: this.ctx.title ?? '', due }) });
 *         new Button({ label: 'Back', onClick: () => this.$back() });
 *     }
 * }
 *
 * class NewTaskWizard extends Wizard<Partial<Task>, Task, HomePage> {
 *     protected main = new TitleStage(this);
 *     readonly due = new DueStage(this);
 *     title() {
 *         return 'New task';
 *     }
 * }
 *
 * // In HomePage: readonly newTask = new NewTaskWizard(this);
 * new Button({
 *     label: 'New task',
 *     onClick: () => this.newTask.$attached({}, (result) => (result?.isOk() ? this.$reload() : this.$nothing())),
 * });
 * ```
 */
export abstract class Wizard<CONTEXT = unknown, OUTPUT = unknown, PAGE extends Page<any, any> = Page<any, any>> {
    /** First stage. */
    protected abstract main: Stage<CONTEXT, OUTPUT, Wizard<CONTEXT, OUTPUT, PAGE>>;
    /** The page that owns the wizard. */
    readonly page: PAGE;

    /** @param page - The page that owns the wizard (pass `this` from the page). */
    constructor(page: PAGE) {
        this.page = page;
    }

    /**
     * Title of the wizard; stages use it as their title unless they override {@link Stage.title}.
     *
     * @param ctx - Current context.
     */
    abstract title(ctx: CONTEXT): Promise<string> | string;

    /**
     * Actor that runs the wizard in a new activity (see {@link WizardDetached}).
     *
     * @typeParam R - Return type of `on` (ignored).
     * @param ctx - Context for the first stage.
     * @param on - Called with `Ok(output)`, `Err(error)` or `undefined` (cancelled).
     */
    $detached<R = unknown>(ctx: CONTEXT, on?: (result: Result<OUTPUT, unknown> | undefined) => Promise<R> | R): WizardDetached<CONTEXT, OUTPUT, this, R> {
        return new WizardDetached(this.main as any, ctx, on);
    }

    /**
     * Actor that runs the wizard in place of the current activity and returns to it afterwards (see {@link WizardAttached}).
     *
     * @param ctx - Context for the first stage.
     * @param on - Receives the result and returns the actor to apply to the original activity.
     */
    $attached(ctx: CONTEXT, on?: (result: Result<OUTPUT, unknown> | undefined) => Promise<Actor> | Actor): WizardAttached<CONTEXT, OUTPUT, this> {
        return new WizardAttached(this.main as any, ctx, on);
    }

    /**
     * Actor that runs the wizard as a pop-up of the current activity (see {@link WizardPop}).
     *
     * @param ctx - Context for the first stage.
     * @param on - Receives the result and returns the actor to apply to the original activity.
     */
    $pop(ctx: CONTEXT, on?: (result: Result<OUTPUT, unknown> | undefined) => Promise<Actor> | Actor): WizardPop<CONTEXT, OUTPUT, this> {
        return new WizardPop(this.main as any, ctx, on);
    }
}

/**
 * A {@link Wizard} that edits an app's settings: it starts from the current settings (or `null`) and outputs new ones.
 * Assign it to {@link App.setupWizard}. Its {@link Wizard.page} is a placeholder {@link PhantomPage}.
 *
 * @typeParam SETTINGS - Settings type of the app.
 * @typeParam APP - The app.
 *
 * @example
 * ```ts
 * class TasksSetup extends SetupWizard<TaskSettings, TasksApp> {
 *     main = new TasksSetupStage(this);
 * }
 *
 * // in TasksApp: setupWizard = new TasksSetup(this);
 * // in a page:   this.app.setupWizard.$detached(null, (result) => saveSettings(result));
 * ```
 */
export abstract class SetupWizard<SETTINGS = unknown, APP extends App<SETTINGS, any> = App<SETTINGS, any>> extends Wizard<SETTINGS | null, SETTINGS, PhantomPage<APP>> {
    /** First stage. */
    abstract main: Stage<SETTINGS | null, SETTINGS, SetupWizard<SETTINGS, APP>>;

    /** @param app - The app whose settings the wizard edits. */
    constructor(app: APP) {
        super(new PhantomPage(app));
    }

    /** Returns `"Setup <app title> "` (with a trailing space), resolving an async app title. */
    async title(_ctx: SETTINGS | null): Promise<string> {
        const title = typeof this.page.app.title === 'string' ? this.page.app.title : await this.page.app.title();
        return `Setup ${title} `;
    }
}

/**
 * One step of a {@link Wizard}. A stage is an {@link Activity}: it renders panels and fragments and reacts to their
 * actions, but it navigates with wizard actors.
 *
 * Subclasses must keep the `(wizard)` constructor signature: the runtime creates fresh instances with
 * `new YourStage(this.wizard)`.
 *
 * @typeParam CONTEXT - Context type of the stage.
 * @typeParam OUTPUT - Result type of the wizard.
 * @typeParam WIZARD - The wizard.
 *
 * @example
 * ```ts
 * class DueStage extends Stage<Partial<Task>, Task, NewTaskWizard> {
 *     protected async render() {
 *         new Form<{ due: string }>({ fields: ['due'], onSubmit: ({ due }) => this.$ok({ title: this.ctx.title ?? '', due }) });
 *         new Button({ label: 'Back', onClick: () => this.$back() });
 *         new Button({ label: 'Cancel', onClick: () => this.$cancel() });
 *     }
 * }
 * ```
 */
export abstract class Stage<CONTEXT = unknown, OUTPUT = unknown, WIZARD extends Wizard<any, OUTPUT, any> = Wizard<any, OUTPUT, any>> extends Activity<CONTEXT> {
    /** The wizard this stage belongs to. */
    readonly wizard: WIZARD;

    /** @param wizard - The wizard that declares the stage (pass `this` from the wizard). */
    constructor(wizard: WIZARD) {
        super();
        this.wizard = wizard;
    }

    /** Creates a fresh stage with `new this.constructor(this.wizard)`. */
    protected new(): Activity<CONTEXT> {
        return new (this.constructor as new (wizard: WIZARD) => Stage<CONTEXT, OUTPUT, WIZARD>)(this.wizard);
    }

    /** Profile the instance was launched with, or `null` when the wizard's app is not the launched app. */
    protected get profile(): string | null {
        const launchedApp = workerDriver()?.appName;
        const profile = workerDriver()?.profile;
        if (launchedApp !== this.wizard.page.app.name) {
            return null;
        }
        return profile;
    }

    /** The app index of the wizard's app (untyped). */
    get index(): any {
        return this.wizard.page.app.index;
    }

    /**
     * Title of the stage; defaults to the wizard's title.
     *
     * @param ctx - The stage's context.
     */
    async title(ctx: CONTEXT): Promise<string> {
        return this.wizard.title(ctx);
    }

    /**
     * Actor that finishes the wizard successfully (see {@link WizardDone}).
     *
     * @param v - The wizard's output.
     */
    protected $ok(v: OUTPUT): WizardDone<OUTPUT, unknown> {
        return new WizardDone(this.wizard, new Ok(v));
    }

    /**
     * Actor that finishes the wizard with an error (see {@link WizardDone}).
     *
     * @typeParam E - Error type.
     * @param e - The error.
     */
    protected $err<E = unknown>(e: E): WizardDone<OUTPUT, E> {
        return new WizardDone(this.wizard, new Err(e));
    }

    /** Actor that cancels the wizard; the result callback receives `undefined` (see {@link WizardDone}). */
    protected $cancel(): WizardDone<OUTPUT, unknown> {
        return new WizardDone(this.wizard, undefined);
    }

    /** Actor that returns to the previous stage, or cancels on the first stage of an attached wizard (see {@link Prev}). */
    protected $back(): Prev<CONTEXT> {
        return new Prev(this);
    }

    /**
     * Actor that moves to this stage, keeping the current one for `$back()` (see {@link WizardNext}). Call it on the target
     * stage, from a stage of the same wizard.
     *
     * @param ctx - Context for this stage.
     */
    $next(ctx: CONTEXT): WizardNext<CONTEXT, OUTPUT, WIZARD> {
        return new WizardNext(this, ctx);
    }

    /**
     * Actor that moves to this stage, replacing the current one (see {@link WizardNextReplace}). Call it on the target stage.
     *
     * @param ctx - Context for this stage.
     */
    $nextReplace(ctx: CONTEXT): WizardNextReplace<CONTEXT, OUTPUT, WIZARD> {
        return new WizardNextReplace(this, ctx);
    }

    /** Actor that ends the whole app instance (see {@link Destroy}). */
    protected $destroy(): Destroy {
        return new Destroy(this.wizard.page.app);
    }
}

/**
 * The entry page of an {@link App} (its {@link App.main}). It is opened with an `undefined` context when an instance
 * starts, so its context type includes `void`.
 *
 * @typeParam CONTEXT - Optional context type (for pages that can also be refreshed with a context).
 * @typeParam APP - Your {@link App} subclass.
 *
 * @example
 * ```ts
 * import { MainPage, panel } from '@araminix/platform';
 *
 * export class HomePage extends MainPage<void, TasksApp> {
 *     title() {
 *         return 'Tasks';
 *     }
 *
 *     protected async render(): Promise<void> {
 *         panel(() => {
 *             new Counter({ label: 'Open tasks' });
 *         });
 *     }
 * }
 * ```
 */
export abstract class MainPage<CONTEXT = unknown, APP extends App<any, any> = App<any, any>> extends Page<CONTEXT | void, APP> {}

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
