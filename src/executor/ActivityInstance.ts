import { Err, ok, Ok, Result } from '@araminix/lib';

import builder, { BuildedPart } from '../builder/builder.js';
import type { FragmentInterface } from '../builder/Fragment.js';
import {
    Actor,
    Close,
    Destroy,
    NextPage,
    Nothing,
    OpenPage as PageOpen,
    ReplacePage as PageReplace,
    PopPage,
    Prev,
    Refresh,
    Reload,
    ReloadFragment,
    UpdateFragment,
    UpdateTypes,
    WizardAttached,
    WizardDetached,
    WizardDone,
    WizardNext,
    WizardNextReplace,
    WizardPop,
} from '../lib/actors.js';
import type { Activity } from '../lib/d.js';
import { ActivityDriver as ActivityAppDriver, AppError, AppResult } from './AppInstance.js';

/** The lifecycle hooks of one activity object, as returned by `Activity._init`; called by {@link ActivityInstance}. */
export class ActivityInterface {
    /** The activity object (a fresh instance of the template). */
    readonly activity: Activity<any>;
    /** Calls `beforeRender()`. */
    readonly beforeRender: () => Promise<Actor> | Actor;
    /** Calls `afterWake()` and stores its cleanup. */
    readonly afterWake: () => void;
    /** Runs the stored `afterWake()` cleanup. */
    readonly cleanUp: () => void;
    /** Calls `render()`. */
    readonly render: () => Promise<void>;
    /** Calls `title(ctx)`. */
    readonly title: () => Promise<string> | string;
    /** Replaces the activity object's context. */
    readonly updateCtx: (ctx: any) => void;

    /**
     * @param activity - The activity object.
     * @param beforeRender - `beforeRender` hook.
     * @param afterWake - `afterWake` hook.
     * @param cleanUp - Cleanup hook.
     * @param render - `render` hook.
     * @param title - `title` hook.
     * @param updateCtx - Context setter.
     */
    constructor(
        activity: Activity<any>,
        beforeRender: () => Promise<Actor> | Actor,
        afterWake: () => void,
        cleanUp: () => void,
        render: () => Promise<void>,
        title: () => Promise<string> | string,
        updateCtx: (ctx: any) => void,
    ) {
        this.activity = activity;
        this.beforeRender = beforeRender;
        this.afterWake = afterWake;
        this.cleanUp = cleanUp;
        this.render = render;
        this.title = title;
        this.updateCtx = updateCtx;
    }
}

/** What activities and fragments use at runtime: `push`, `trigger` and the activity status. */
export class ActivityDriver {
    /** The activity. */
    private activity: ActivityInstance;
    /** The activity's driver on the app. */
    private instanceDriver: ActivityAppDriver;

    /**
     * @param activity - The activity.
     * @param instanceDriver - The activity's driver on the app.
     */
    constructor(activity: ActivityInstance, instanceDriver: ActivityAppDriver) {
        this.activity = activity;
        this.instanceDriver = instanceDriver;
    }

    /** Current lifecycle status of the activity. */
    get status(): Status {
        return this.activity.status;
    }

    /**
     * Sends data on the `push` stream.
     *
     * @param data - The data.
     */
    async push<TData = unknown>(data: TData): Promise<AppResult> {
        return await this.instanceDriver.sendPush(data);
    }

    /**
     * Applies `actor` to the activity under the app lock.
     *
     * @param actor - The actor.
     */
    async trigger(actor: Actor): Promise<AppResult> {
        return await this.instanceDriver.exclusive(() => this.activity.handleActor(actor));
    }
}

/** Lifecycle status of an {@link ActivityInstance}. */
enum Status {
    /** Nothing prepared yet (or reset for a refresh). */
    Initiated = 0,
    /** Title and `beforeRender` done; not rendered (also the state of suspended activities). */
    Prepared = 1,
    /** Build created. */
    Rendered = 2,
    /** Build sent and `afterWake()` ran. */
    Waked = 3,
    /** Reserved. */
    Done = 4,
}

/** The `on` callback of a wizard actor. */
type WizardHandler = void | ((result: Result<any, any> | undefined) => Promise<any> | any);

/**
 * Runtime state of one opened activity: its context, fragments, last build, lifecycle status and its links to other
 * activities (`underActivity` for "back", `sourceActivity` to return to, `popActivity`).
 */
export class ActivityInstance {
    /** The declared page or stage the activity was created from. */
    private activityTemplate: Activity<any>;
    /** Current context. */
    private ctx: any;
    /** Driver on the app. */
    driver!: ActivityAppDriver;
    /** Fragments of the last render, by id. */
    private fragments: Map<string, FragmentInterface> = new Map();
    /** The last build. */
    private panel?: BuildedPart = undefined;
    /** Hooks of the activity object. */
    protected activityInterface!: ActivityInterface;
    /** Activity to go back to (`prev`). */
    underActivity: ActivityInstance | undefined = undefined;
    /** Activity to return to when this one (a pop-up or wizard) finishes. */
    sourceActivity: ActivityInstance | undefined = undefined;
    /** Pop-up shown by this activity, if any. */
    popActivity: ActivityInstance | undefined = undefined;
    /** Lifecycle status. */
    status: Status = Status.Initiated;
    /** Driver handed to the activity object and its fragments. */
    private activityDriver!: ActivityDriver;
    /** Title computed by the last prepare. */
    title: string = '';
    /** Whether the activity is shown as a pop-up. */
    isPop: boolean = false;

    /**
     * @param activityTemplate - The declared page or stage.
     * @param ctx - Initial context.
     */
    constructor(activityTemplate: Activity<any>, ctx: any) {
        this.activityTemplate = activityTemplate;
        this.ctx = ctx;
    }

    /**
     * Binds the activity to the app and creates its activity object from the template.
     *
     * @param driver - Driver on the app.
     * @param underActivity - Activity to go back to.
     * @param sourceActivity - Activity to return to.
     * @param isPop - Whether the activity is a pop-up.
     */
    init(driver: ActivityAppDriver, underActivity: ActivityInstance | undefined, sourceActivity: ActivityInstance | undefined, isPop: boolean = false): void {
        this.driver = driver;
        this.underActivity = underActivity;
        this.sourceActivity = sourceActivity;
        this.isPop = isPop;
        this.activityDriver = new ActivityDriver(this, this.driver);
        this.activityInterface = this.activityTemplate._init(this.ctx, this.activityDriver);
    }

    /** Handles the user's close request (same as {@link ActivityInstance.cancel}). */
    async triggerClose(): Promise<AppResult> {
        return await this.cancel();
    }

    /** Runs the `afterLoad()` cleanups of all fragments. */
    private cleanUpFragments(): void {
        for (const fragment of this.fragments.values()) {
            fragment.cleanUp();
        }
    }

    /** Resets to {@link Status.Initiated}, running cleanups, so the next load prepares again. */
    resetBeforeLoad(): void {
        if (this.status > Status.Initiated) {
            this.status = Status.Initiated;
            this.cleanUpFragments();
            this.activityInterface.cleanUp();
        }
    }

    /** Prepares and renders if needed, sends the build, and wakes the activity unless it is already awake. */
    async load(): Promise<AppResult> {
        const isWaked = this.status === Status.Waked;
        if (this.status < Status.Rendered) {
            if (this.status === Status.Initiated) {
                const prepareResult = await this.prepare();
                if (prepareResult.isErr()) {
                    return prepareResult;
                }
            }
            const build = await builder.build(this.activityDriver, this.activityInterface.render);
            this.panel = build.mainPanel._build();
            this.fragments = build.fragments;
            this.status = Status.Rendered;
        }
        const result = await this.driver.sendBuild(this.panel!, this.isPop, this.hasPrev());
        if (result.isErr()) {
            return result;
        }
        if (!isWaked) {
            await this.wake();
        }
        return ok();
    }

    /** Resets to {@link Status.Prepared}, running cleanups, so the next load renders again. */
    private resetBeforeReload(): void {
        if (this.status > Status.Prepared) {
            this.status = Status.Prepared;
            this.cleanUpFragments();
            this.activityInterface.cleanUp();
        }
    }

    /** Renders again and sends the build. */
    async reload(): Promise<AppResult> {
        this.resetBeforeReload();
        return await this.load();
    }

    /** Refreshes with the current context. */
    async refreshSelf(): Promise<AppResult> {
        return await this.refresh(this.ctx);
    }

    /** Resets to {@link Status.Initiated}, running cleanups. */
    resetBeforeRefresh(): void {
        if (this.status > Status.Initiated) {
            this.status = Status.Initiated;
            this.cleanUpFragments();
            this.activityInterface.cleanUp();
        }
    }

    /**
     * Sets a new context and runs the whole lifecycle again.
     *
     * @param ctx - The new context.
     */
    async refresh(ctx: any): Promise<AppResult> {
        this.ctx = ctx;
        this.resetBeforeRefresh();
        this.activityInterface.updateCtx(ctx);
        return await this.load();
    }

    /** Goes back to the previous activity; `Err(WrongAction)` when there is none. */
    async prev(): Promise<AppResult> {
        if (this.underActivity) {
            return await this.driver.replace(this.underActivity);
        }
        return new Err(AppError.WrongAction);
    }

    /** Runs all cleanups and drops to {@link Status.Prepared}; the next load renders again. */
    suspend(): void {
        this.cleanUpFragments();
        this.activityInterface.cleanUp();
        this.status = Status.Prepared;
    }

    /**
     * Runs the action handler of a fragment and applies the returned actor.
     *
     * @param fragmentId - Fragment id.
     * @param name - Action name.
     * @param data - Action data.
     * @returns The actor's result; `Err(WrongAction)` for an unknown fragment or action.
     */
    async action(fragmentId: string, name: string, data: any): Promise<Result<void, AppError>> {
        const fragment = this.fragments.get(fragmentId);
        if (!fragment) {
            return new Err(AppError.WrongAction);
        }
        const action = fragment.actions.get(name);
        if (!action) {
            return new Err(AppError.WrongAction);
        }
        const actor = await action(data);
        return await this.handleActor(actor);
    }

    /**
     * Runs the query handler of a fragment.
     *
     * @param fragmentId - Fragment id.
     * @param name - Query name.
     * @param data - Query data.
     * @returns The answer; `Err(WrongAction)` for an unknown fragment or query.
     */
    async query(fragmentId: string, name: string, data: any): Promise<Result<any, AppError>> {
        const fragment = this.fragments.get(fragmentId);
        if (!fragment) {
            return new Err(AppError.WrongAction);
        }
        const query = fragment.queries.get(name);
        if (!query) {
            return new Err(AppError.WrongAction);
        }
        const result = await query(data);
        return new Ok(result);
    }

    /** Marks the activity awake, calls `afterWake()` outside the app lock, and loads its pop-up if it has one. */
    async wake(): Promise<AppResult> {
        this.status = Status.Waked;
        // afterWake is where activities start timers; keep them out of the current lock context.
        this.driver.outsideLock(() => this.activityInterface.afterWake());
        if (this.popActivity) {
            return await this.popActivity.load();
        }
        return ok();
    }

    /** Computes the title, sends the activity list, runs `beforeRender()` and applies its actor unless it is `Nothing`. */
    async prepare(): Promise<AppResult> {
        this.title = await this.activityInterface.title();
        await this.driver.updateActivityList();
        const action = await this.activityInterface.beforeRender();
        this.status = Status.Prepared;
        if (!(action instanceof Nothing)) {
            return await this.handleActor(action);
        }
        return ok();
    }

    /**
     * Applies an actor to this activity.
     *
     * @param actor - The actor.
     * @returns The result; `Err(WrongAction)` for actors that do not apply here.
     */
    async handleActor(actor: Actor): Promise<AppResult> {
        switch (true) {
            case actor instanceof PageOpen:
                return await this.handleOpenPage(actor);
            case actor instanceof PageReplace:
                return await this.handleReplacePage(actor);
            case actor instanceof PopPage:
                return await this.handlePagePop(actor);
            case actor instanceof NextPage:
                return await this.handleNextPage(actor);
            case actor instanceof Close:
                return await this.handleClose(actor);
            case actor instanceof Prev:
                return await this.handlePrev(actor);
            case actor instanceof Destroy:
                return await this.handleDestroy(actor);
            case actor instanceof WizardAttached:
                return await this.handleWizardAttached(actor);
            case actor instanceof WizardPop:
                return await this.handleWizardPop(actor);
            case actor instanceof WizardDetached:
                return await this.handleWizardDetached(actor);
            case actor instanceof WizardNext:
                return await this.handleWizardNext(actor);
            case actor instanceof WizardNextReplace:
                return await this.handleWizardNextReplace(actor);
            case actor instanceof WizardDone:
                return await this.handleWizardDone(actor);
            case actor instanceof ReloadFragment:
                return await this.handleFragmentReload(actor);
            case actor instanceof UpdateFragment:
                return await this.handleFragmentUpdate(actor);
            case actor instanceof Reload:
                return await this.handleReload(actor);
            case actor instanceof Refresh:
                return await this.handleRefresh(actor);
            case actor instanceof Nothing:
                return await this.driver.wake();
            default:
                return new Err(AppError.WrongAction);
        }
    }

    /** `$next`: shows the page in this slot with this activity as "previous". */
    protected async handleNextPage(actor: NextPage): Promise<AppResult> {
        const instance = new ActivityInstance(actor.page, actor.ctx);
        return await this.driver.overlay(instance);
    }

    /** `$open`: opens the page as a new activity. */
    protected async handleOpenPage(actor: PageOpen): Promise<AppResult> {
        const instance = new ActivityInstance(actor.page, actor.ctx);
        return await this.driver.open(instance);
    }

    /** `$pop`: shows the page as a pop-up of this activity. */
    protected async handlePagePop(actor: PopPage): Promise<AppResult> {
        const instance = new ActivityInstance(actor.page, actor.ctx);
        return await this.driver.pop(instance);
    }

    /** `$replace`: puts the page in this slot without "back". */
    protected async handleReplacePage(actor: PageReplace): Promise<AppResult> {
        const instance = new ActivityInstance(actor.page, actor.ctx);
        return await this.driver.replace(instance);
    }

    /** `$refresh`: rebuilds this activity with the new context (only its own actor). */
    protected async handleRefresh(actor: Refresh): Promise<AppResult> {
        if (this.activityInterface.activity === actor.activity) {
            return await this.driver.refresh(actor.ctx);
        } else {
            return new Err(AppError.WrongAction);
        }
    }

    /** `$reload`: re-renders the active activity. */
    protected async handleReload(_actor: Reload): Promise<AppResult> {
        return await this.driver.reload();
    }

    /** Fragment `$reload`: runs the fragment's load cycle and sends the result as a full update. */
    protected async handleFragmentReload(actor: ReloadFragment): Promise<AppResult> {
        const fragment = this.fragments.get(actor.fragmentId);
        if (fragment) {
            const load = await fragment.load();
            return await this.driver.sendUpdate(fragment.id, UpdateTypes.Full, load);
        }
        return new Err(AppError.WrongAction);
    }

    /** Fragment `$update`/`$patch`: sends the data to the fragment's component. */
    protected async handleFragmentUpdate(actor: UpdateFragment): Promise<AppResult> {
        const fragment = this.fragments.get(actor.fragmentId);
        if (fragment) {
            return await this.driver.sendUpdate(fragment.id, actor.type, actor.data);
        }
        return new Err(AppError.WrongAction);
    }

    /** `$attached`: runs the wizard in this slot with this activity as its source. */
    protected async handleWizardAttached(actor: WizardAttached): Promise<AppResult> {
        const instance = new StageInstance(actor.mainStage, actor.ctx, actor.on);
        return await this.driver.source(instance);
    }

    /**
     * Sets (or clears) the pop-up shown by this activity.
     *
     * @param activity - The pop-up, or `undefined`.
     */
    setPop(activity?: ActivityInstance): void {
        this.popActivity = activity;
        if (this.status === Status.Done) {
            this.status = Status.Waked;
        }
    }

    /** Wizard `$pop`: runs the wizard as a pop-up of this activity. */
    protected async handleWizardPop(actor: WizardPop): Promise<AppResult> {
        const instance = new StageInstance(actor.mainStage, actor.ctx, actor.on);
        return await this.driver.pop(instance);
    }

    /** `$detached`: runs the wizard in a new activity. */
    protected async handleWizardDetached(actor: WizardDetached): Promise<AppResult> {
        const instance = new StageInstance(actor.mainStage, actor.ctx, actor.on);
        return await this.driver.open(instance);
    }

    /** `$destroy`: ends the app instance. */
    protected async handleDestroy(_: Destroy): Promise<AppResult> {
        return await this.driver.destroy();
    }

    /** `$close`: closes this activity (only its own actor). */
    protected async handleClose(close: Close): Promise<AppResult> {
        if (close.activity !== this.activityInterface.activity) {
            return new Err(AppError.WrongAction);
        }
        return await this.driver.close();
    }

    /** `$back` on a page: goes back to the previous activity (only its own actor). */
    protected async handlePrev(prev: Prev): Promise<AppResult> {
        if (prev.activity !== this.activityInterface.activity) {
            return new Err(AppError.WrongAction);
        }
        if (this.underActivity) {
            return await this.driver.replace(this.underActivity);
        }
        return new Err(AppError.WrongAction);
    }

    /** Returns to the source activity without waking it, or closes this activity when it has no source. */
    async cancel(): Promise<AppResult> {
        if (this.sourceActivity) {
            const result = await this.driver.replace(this.sourceActivity, false);
            if (result.isErr()) {
                return result;
            }
            return ok();
        }
        return await this.driver.close();
    }

    /** Wizard results are only valid in stages. */
    protected async handleWizardDone(_actor: WizardDone): Promise<AppResult> {
        return new Err(AppError.WrongAction);
    }

    /** Stage navigation is only valid in stages. */
    protected async handleWizardNext(_actor: WizardNext): Promise<AppResult> {
        return new Err(AppError.WrongAction);
    }

    /** Stage navigation is only valid in stages. */
    protected async handleWizardNextReplace(_actor: WizardNextReplace): Promise<AppResult> {
        return new Err(AppError.WrongAction);
    }

    /** Whether the client may go back from this activity. */
    hasPrev(): boolean {
        return !!this.underActivity;
    }
}

/** An {@link ActivityInstance} for a wizard {@link Stage}: it carries the wizard's result handler and accepts wizard actors. */
export class StageInstance extends ActivityInstance {
    /** The wizard's result handler (`on` of `$detached`/`$attached`/`$pop`). */
    on: WizardHandler;

    /**
     * @param activity - The declared stage.
     * @param ctx - Stage context.
     * @param on - The wizard's result handler.
     */
    constructor(activity: Activity<any>, ctx: any, on: WizardHandler) {
        super(activity, ctx);
        this.on = on;
    }

    /** A stage can go back to the previous stage or, on the first stage, to the wizard's source. */
    hasPrev(): boolean {
        return !!this.underActivity || !!this.sourceActivity;
    }

    /** `$back`: previous stage, or cancel the wizard on the first stage of an attached or pop-up wizard. */
    protected async handlePrev(prev: Prev): Promise<AppResult> {
        if (prev.activity !== this.activityInterface.activity) {
            return new Err(AppError.WrongAction);
        }
        if (this.underActivity) {
            return await this.driver.replace(this.underActivity);
        }
        if (this.sourceActivity) {
            return await this.cancel();
        }
        return new Err(AppError.WrongAction);
    }

    /** `$ok`/`$err`/`$cancel`: finishes the wizard. */
    protected async handleWizardDone(actor: WizardDone): Promise<AppResult> {
        return await this.driver.wizardDone(actor.result);
    }

    /** Cancels the wizard (its handler receives `undefined`). */
    async cancel(): Promise<AppResult> {
        return await this.driver.wizardDone(undefined);
    }

    /** Closing a stage cancels the wizard. */
    protected async handleClose(close: Close): Promise<AppResult> {
        if (close.activity !== this.activityInterface.activity) {
            return new Err(AppError.WrongAction);
        }
        return await this.driver.wizardDone(undefined);
    }

    /** Page navigation is not allowed inside a wizard. */
    protected async handleNextPage(_actor: NextPage): Promise<AppResult> {
        return new Err(AppError.WrongAction);
    }

    /** Page navigation is not allowed inside a wizard. */
    protected async handleReplacePage(_actor: PageReplace): Promise<AppResult> {
        return new Err(AppError.WrongAction);
    }

    /** Stage `$next`: shows the target stage of the same wizard, keeping this stage for `$back`. */
    protected async handleWizardNext(actor: WizardNext): Promise<AppResult> {
        if ((actor.stage as any).wizard === (this.activityInterface.activity as any).wizard) {
            const instance = new StageInstance(actor.stage, actor.ctx, this.on);
            return await this.driver.overlay(instance);
        }
        return new Err(AppError.WrongAction);
    }

    /** Stage `$nextReplace`: replaces this stage with the target stage of the same wizard. */
    protected async handleWizardNextReplace(actor: WizardNextReplace): Promise<AppResult> {
        if ((actor.stage as any).wizard === (this.activityInterface.activity as any).wizard) {
            const instance = new StageInstance(actor.stage, actor.ctx, this.on);
            return await this.driver.replace(instance);
        }
        return new Err(AppError.WrongAction);
    }
}
