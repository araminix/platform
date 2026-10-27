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

export class ActivityInterface {
    readonly activity: Activity<any>;
    readonly beforeRender: () => Promise<Actor> | Actor;
    readonly afterWake: () => void;
    readonly cleanUp: () => void;
    readonly render: () => Promise<void>;
    readonly title: () => Promise<string> | string;
    readonly updateCtx: (ctx: any) => void;

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

export class ActivityDriver {
    private activity: ActivityInstance;
    private instanceDriver: ActivityAppDriver;

    constructor(activity: ActivityInstance, instanceDriver: ActivityAppDriver) {
        this.activity = activity;
        this.instanceDriver = instanceDriver;
    }

    get status(): Status {
        return this.activity.status;
    }

    async push<TData = unknown>(data: TData): Promise<AppResult> {
        return await this.instanceDriver.sendPush(data);
    }

    async trigger(actor: Actor): Promise<AppResult> {
        return await this.instanceDriver.exclusive(() => this.activity.handleActor(actor));
    }
}

enum Status {
    Initiated = 0,
    Prepared = 1,
    Rendered = 2,
    Waked = 3,
    Done = 4,
}

type WizardHandler = void | ((result: Result<any, any> | undefined) => Promise<any> | any);

export class ActivityInstance {
    private activityTemplate: Activity<any>;
    private ctx: any;
    driver!: ActivityAppDriver;
    private fragments: Map<string, FragmentInterface> = new Map();
    private panel?: BuildedPart = undefined;
    protected activityInterface!: ActivityInterface;
    underActivity: ActivityInstance | undefined = undefined;
    sourceActivity: ActivityInstance | undefined = undefined;
    popActivity: ActivityInstance | undefined = undefined;
    status: Status = Status.Initiated;
    private activityDriver!: ActivityDriver;
    title: string = '';
    isPop: boolean = false;

    constructor(activityTemplate: Activity<any>, ctx: any) {
        this.activityTemplate = activityTemplate;
        this.ctx = ctx;
    }

    init(driver: ActivityAppDriver, underActivity: ActivityInstance | undefined, sourceActivity: ActivityInstance | undefined, isPop: boolean = false): void {
        this.driver = driver;
        this.underActivity = underActivity;
        this.sourceActivity = sourceActivity;
        this.isPop = isPop;
        this.activityDriver = new ActivityDriver(this, this.driver);
        this.activityInterface = this.activityTemplate._init(this.ctx, this.activityDriver);
    }

    async triggerClose(): Promise<AppResult> {
        return await this.cancel();
    }

    private cleanUpFragments(): void {
        for (const fragment of this.fragments.values()) {
            fragment.cleanUp();
        }
    }

    resetBeforeLoad(): void {
        if (this.status > Status.Initiated) {
            this.status = Status.Initiated;
            this.cleanUpFragments();
            this.activityInterface.cleanUp();
        }
    }

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

    private resetBeforeReload(): void {
        if (this.status > Status.Prepared) {
            this.status = Status.Prepared;
            this.cleanUpFragments();
            this.activityInterface.cleanUp();
        }
    }

    async reload(): Promise<AppResult> {
        this.resetBeforeReload();
        return await this.load();
    }

    async refreshSelf(): Promise<AppResult> {
        return await this.refresh(this.ctx);
    }

    resetBeforeRefresh(): void {
        if (this.status > Status.Initiated) {
            this.status = Status.Initiated;
            this.cleanUpFragments();
            this.activityInterface.cleanUp();
        }
    }

    async refresh(ctx: any): Promise<AppResult> {
        this.ctx = ctx;
        this.resetBeforeRefresh();
        this.activityInterface.updateCtx(ctx);
        return await this.load();
    }

    async prev(): Promise<AppResult> {
        if (this.underActivity) {
            return await this.driver.replace(this.underActivity);
        }
        return new Err(AppError.WrongAction);
    }

    suspend(): void {
        this.cleanUpFragments();
        this.activityInterface.cleanUp();
        this.status = Status.Prepared;
    }

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

    async wake(): Promise<AppResult> {
        this.status = Status.Waked;
        // afterWake is where activities start timers; keep them out of the current lock context.
        this.driver.outsideLock(() => this.activityInterface.afterWake());
        if (this.popActivity) {
            return await this.popActivity.load();
        }
        return ok();
    }

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

    protected async handleNextPage(actor: NextPage): Promise<AppResult> {
        const instance = new ActivityInstance(actor.page, actor.ctx);
        return await this.driver.overlay(instance);
    }

    protected async handleOpenPage(actor: PageOpen): Promise<AppResult> {
        const instance = new ActivityInstance(actor.page, actor.ctx);
        return await this.driver.open(instance);
    }

    protected async handlePagePop(actor: PopPage): Promise<AppResult> {
        const instance = new ActivityInstance(actor.page, actor.ctx);
        return await this.driver.pop(instance);
    }

    protected async handleReplacePage(actor: PageReplace): Promise<AppResult> {
        const instance = new ActivityInstance(actor.page, actor.ctx);
        return await this.driver.replace(instance);
    }

    protected async handleRefresh(actor: Refresh): Promise<AppResult> {
        if (this.activityInterface.activity === actor.activity) {
            return await this.driver.refresh(actor.ctx);
        } else {
            return new Err(AppError.WrongAction);
        }
    }

    protected async handleReload(_actor: Reload): Promise<AppResult> {
        return await this.driver.reload();
    }

    protected async handleFragmentReload(actor: ReloadFragment): Promise<AppResult> {
        const fragment = this.fragments.get(actor.fragmentId);
        if (fragment) {
            const load = await fragment.load();
            return await this.driver.sendUpdate(fragment.id, UpdateTypes.Full, load);
        }
        return new Err(AppError.WrongAction);
    }

    protected async handleFragmentUpdate(actor: UpdateFragment): Promise<AppResult> {
        const fragment = this.fragments.get(actor.fragmentId);
        if (fragment) {
            return await this.driver.sendUpdate(fragment.id, actor.type, actor.data);
        }
        return new Err(AppError.WrongAction);
    }

    protected async handleWizardAttached(actor: WizardAttached): Promise<AppResult> {
        const instance = new StageInstance(actor.mainStage, actor.ctx, actor.on);
        return await this.driver.source(instance);
    }

    setPop(activity?: ActivityInstance): void {
        this.popActivity = activity;
        if (this.status === Status.Done) {
            this.status = Status.Waked;
        }
    }

    protected async handleWizardPop(actor: WizardPop): Promise<AppResult> {
        const instance = new StageInstance(actor.mainStage, actor.ctx, actor.on);
        return await this.driver.pop(instance);
    }

    protected async handleWizardDetached(actor: WizardDetached): Promise<AppResult> {
        const instance = new StageInstance(actor.mainStage, actor.ctx, actor.on);
        return await this.driver.open(instance);
    }

    protected async handleDestroy(_: Destroy): Promise<AppResult> {
        return await this.driver.destroy();
    }

    protected async handleClose(close: Close): Promise<AppResult> {
        if (close.activity !== this.activityInterface.activity) {
            return new Err(AppError.WrongAction);
        }
        return await this.driver.close();
    }

    protected async handlePrev(prev: Prev): Promise<AppResult> {
        if (prev.activity !== this.activityInterface.activity) {
            return new Err(AppError.WrongAction);
        }
        if (this.underActivity) {
            return await this.driver.replace(this.underActivity);
        }
        return new Err(AppError.WrongAction);
    }

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

    protected async handleWizardDone(_actor: WizardDone): Promise<AppResult> {
        return new Err(AppError.WrongAction);
    }

    protected async handleWizardNext(_actor: WizardNext): Promise<AppResult> {
        return new Err(AppError.WrongAction);
    }

    protected async handleWizardNextReplace(_actor: WizardNextReplace): Promise<AppResult> {
        return new Err(AppError.WrongAction);
    }

    hasPrev(): boolean {
        return !!this.underActivity;
    }
}

export class StageInstance extends ActivityInstance {
    on: WizardHandler;

    constructor(activity: Activity<any>, ctx: any, on: WizardHandler) {
        super(activity, ctx);
        this.on = on;
    }

    hasPrev(): boolean {
        return !!this.underActivity || !!this.sourceActivity;
    }

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

    protected async handleWizardDone(actor: WizardDone): Promise<AppResult> {
        return await this.driver.wizardDone(actor.result);
    }

    async cancel(): Promise<AppResult> {
        return await this.driver.wizardDone(undefined);
    }

    protected async handleClose(close: Close): Promise<AppResult> {
        if (close.activity !== this.activityInterface.activity) {
            return new Err(AppError.WrongAction);
        }
        return await this.driver.wizardDone(undefined);
    }

    protected async handleNextPage(_actor: NextPage): Promise<AppResult> {
        return new Err(AppError.WrongAction);
    }

    protected async handleReplacePage(_actor: PageReplace): Promise<AppResult> {
        return new Err(AppError.WrongAction);
    }

    protected async handleWizardNext(actor: WizardNext): Promise<AppResult> {
        if ((actor.stage as any).wizard === (this.activityInterface.activity as any).wizard) {
            const instance = new StageInstance(actor.stage, actor.ctx, this.on);
            return await this.driver.overlay(instance);
        }
        return new Err(AppError.WrongAction);
    }

    protected async handleWizardNextReplace(actor: WizardNextReplace): Promise<AppResult> {
        if ((actor.stage as any).wizard === (this.activityInterface.activity as any).wizard) {
            const instance = new StageInstance(actor.stage, actor.ctx, this.on);
            return await this.driver.replace(instance);
        }
        return new Err(AppError.WrongAction);
    }
}
