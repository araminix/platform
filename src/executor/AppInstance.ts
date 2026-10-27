import { Defined, Err, ok, Result, uuid } from '@araminix/lib';
import { AsyncLocalStorage } from 'node:async_hooks';

import { BuildedPart } from '../builder/builder.js';
import { Nothing, ReloadFragment, UpdateFragment, UpdateTypes } from '../lib/actors.js';
import { App } from '../lib/d.js';
import { ActivityInstance, StageInstance } from './ActivityInstance.js';
import { ActivityList, SendBuild, SendPush, SendUpdate, UpdateActivityList } from './proto.js';
import workerDriver from './workerDriver.js';

/** Why an activity operation failed inside an app worker (the `E` of {@link AppResult}). */
export enum AppError {
    /** The actor or request does not apply: unknown fragment, action or activity, or an actor of another activity/wizard. */
    WrongAction = 'WrongAction',
    /** The target activity is not the active one. */
    NonActive = 'NonActive',
    /** Reserved; not produced by the runtime. */
    Skipped = 'Skipped',
    /** Reserved; not produced by the runtime. */
    NotFound = 'NotFound',
    /** A message to the main thread failed (no client connected, stream closed with an error, channel closed). */
    Other = 'Other',
}

/**
 * Result of activity operations such as {@link Activity.trigger}, {@link Activity.push} and {@link Fragment.push}: `Ok`
 * or `Err(AppError)`.
 */
export type AppResult = Result<void, AppError>;

// Serialises everything that changes an app's activities: requests from the main thread and trigger() calls made
// from timers or callbacks. Calls made while the lock is held (e.g. trigger() awaited inside an action) run directly.
/**
 * Mutex of one app instance (a promise chain) with re-entrancy based on `AsyncLocalStorage`.
 *
 * {@link ActivityLock.run} waits for every earlier task and then runs its task with a "held" token in the async context.
 * A `run` call made from inside a task (directly or in code it awaits) sees the token and runs immediately instead of
 * deadlocking. When the task ends the token is cleared, so callbacks created during the task (timers, event handlers)
 * queue like any other caller from then on.
 *
 * @remarks
 * Known limit: a timer started directly inside a task inherits the token. If it fires while that task is still running,
 * its `run` call executes immediately, inside the task, instead of waiting. Timers started from `afterWake()` are not
 * affected: the runtime calls `afterWake()` through {@link ActivityLock.outside}, so they never carry the token and always
 * queue. Wrap other timer set-ups in `outsideLock()` for the same effect.
 */
class ActivityLock {
    /** Settles when the last queued task has finished. */
    private tail: Promise<void> = Promise.resolve();
    /** Token of the task that holds the lock in the current async context. */
    private readonly holder: AsyncLocalStorage<{ held: boolean }> = new AsyncLocalStorage();

    /**
     * Runs `task` exclusively, or directly when the caller already holds the lock.
     *
     * @typeParam T - Task result type.
     * @param task - The work to run.
     * @returns The task's result; a rejection is passed through and the lock is released anyway.
     */
    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.holder.getStore()?.held) {
            return task();
        }
        const previous = this.tail;
        let release!: () => void;
        this.tail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        // Timers created inside the task inherit this token; clearing `held` on release makes them queue like any other caller.
        const token = { held: true };
        try {
            return await this.holder.run(token, task);
        } finally {
            token.held = false;
            release();
        }
    }

    /**
     * Runs `callback` without the lock token in its async context, so timers and callbacks it creates queue for the lock.
     *
     * @typeParam T - Callback result type.
     * @param callback - The code to run.
     */
    outside<T>(callback: () => T): T {
        return this.holder.exit(callback);
    }
}

/**
 * Runtime driver of one activity inside the app worker. It carries out navigation on the {@link AppInstance} (open,
 * replace, overlay, pop, source, close, destroy) and sends builds, fragment updates, pushes and activity lists to the main
 * thread. Navigation and updates only take effect while the activity is the active one.
 */
export class ActivityDriver {
    /** The app the activity belongs to. */
    private appInstance: AppInstance;
    /** The driven activity. */
    private activity: ActivityInstance;
    /** Activity id, used by the client to address the activity. */
    readonly id: string = uuid();

    /**
     * @param appInstance - The app the activity belongs to.
     * @param activity - The driven activity.
     */
    constructor(appInstance: AppInstance, activity: ActivityInstance) {
        this.appInstance = appInstance;
        this.activity = activity;
    }

    /**
     * Runs `task` under the app lock (see {@link AppInstance.exclusive}); used by `trigger()`.
     *
     * @typeParam T - Task result type.
     * @param task - The work to run.
     */
    exclusive<T>(task: () => Promise<T>): Promise<T> {
        return this.appInstance.exclusive(task);
    }

    /**
     * Runs `callback` outside the app lock context (see {@link AppInstance.outsideLock}); used to call `afterWake()`.
     *
     * @typeParam T - Callback result type.
     * @param callback - The code to run.
     */
    outsideLock<T>(callback: () => T): T {
        return this.appInstance.outsideLock(callback);
    }

    /** Runs `runnable` when this activity is active (or the pop-up of the active one), else returns `Err(AppError.NonActive)`. */
    private async executeIfActive<T>(runnable: () => Promise<Result<T, AppError>>): Promise<Result<T, AppError>> {
        if (!this.appInstance.isActive(this.id)) {
            return new Err(AppError.NonActive);
        }
        return runnable();
    }

    /** Sends `req` to the main thread (only while active unless `ignoreActiveCheck`); `Err(AppError.Other)` when it fails. */
    private async request(req: any, ignoreActiveCheck: boolean = false): Promise<AppResult> {
        const runnable = async (): Promise<AppResult> => {
            const result = await workerDriver().request(req);
            if (result.isErr()) {
                return new Err(AppError.Other);
            }
            return ok();
        };
        if (ignoreActiveCheck) {
            return await runnable();
        }
        return this.executeIfActive(runnable);
    }

    /** Sends the current activity list to the client. */
    updateActivityList(): Promise<AppResult> {
        return this.request(new UpdateActivityList(this.appInstance.activityList));
    }

    /**
     * Opens `activity` as a new activity (tab) and wakes it.
     *
     * @param activity - The new activity.
     */
    async open(activity: ActivityInstance): Promise<AppResult> {
        const result = await this.executeIfActive(async () => {
            if (!activity.driver) {
                activity.init(new ActivityDriver(this.appInstance, activity), undefined, undefined);
            }
            await this.appInstance.open(activity);
            return ok();
        });
        if (result.isErr()) {
            return result;
        }
        return await this.appInstance.wake();
    }

    /**
     * Puts `activity` in this activity's place (keeping this activity's source and pop-up flag) and wakes the active activity.
     *
     * @param activity - The replacement.
     * @param wake - Wake the active activity afterwards (default `true`).
     */
    async replace(activity: ActivityInstance, wake: boolean = true): Promise<AppResult> {
        const result = await this.executeIfActive(async () => {
            if (!activity.driver) {
                activity.init(new ActivityDriver(this.appInstance, activity), undefined, this.activity.sourceActivity, this.activity.isPop);
            }
            const parent = this.appInstance.getParentActivity(this.id);
            if (parent) {
                this.activity.suspend();
                parent.setPop(activity);
            } else {
                await this.appInstance.replace(this.id, activity);
            }
            return ok();
        });
        if (result.isErr()) {
            return result;
        }
        if (wake) {
            return await this.appInstance.wake();
        }
        return ok();
    }

    /**
     * Finishes the wizard this stage belongs to: calls the wizard's result handler with `result`, then closes the stage
     * activity (detached wizard) or returns to the activity that started the wizard and applies the actor the handler
     * returned.
     *
     * @param result - `Ok(output)`, `Err(error)` or `undefined` (cancelled).
     */
    async wizardDone(result: any): Promise<AppResult> {
        const thisActivity = this.activity as StageInstance;
        const actor = thisActivity.on ? await thisActivity.on(result) : undefined;
        if (!thisActivity.sourceActivity) {
            return await this.close();
        }
        const parent = this.appInstance.getParentActivity(this.id);
        if (!parent) {
            await this.replace(thisActivity.sourceActivity, false);
        } else if (parent === thisActivity.sourceActivity) {
            thisActivity.suspend();
            parent.setPop(undefined);
            parent.resetBeforeLoad();
        } else {
            thisActivity.suspend();
            parent.setPop(thisActivity.sourceActivity);
        }
        if (actor instanceof Nothing || actor === undefined || actor instanceof ReloadFragment) {
            return await thisActivity.sourceActivity.wake();
        }
        if (actor instanceof UpdateFragment) {
            await thisActivity.sourceActivity.wake();
        }
        return await thisActivity.sourceActivity.handleActor(actor);
    }

    /**
     * Puts `activity` in this activity's place and makes this activity its "previous" one (used by `$next`).
     *
     * @param activity - The new activity.
     */
    async overlay(activity: ActivityInstance): Promise<AppResult> {
        const result = await this.executeIfActive(async () => {
            if (!activity.driver) {
                activity.init(new ActivityDriver(this.appInstance, activity), this.activity, this.activity.sourceActivity, this.activity.isPop);
            }
            const parent = this.appInstance.getParentActivity(this.id);
            if (parent) {
                this.activity.suspend();
                parent.setPop(activity);
            } else {
                await this.appInstance.replace(this.id, activity);
            }
            return ok();
        });
        if (result.isErr()) {
            return result;
        }
        return await this.appInstance.wake();
    }

    /**
     * Shows `activity` as a pop-up whose source is this activity (used by `$pop`).
     *
     * @param activity - The pop-up activity.
     */
    async pop(activity: ActivityInstance): Promise<AppResult> {
        const result = await this.executeIfActive(async () => {
            if (!activity.driver) {
                activity.init(new ActivityDriver(this.appInstance, activity), undefined, this.activity, true);
            }
            const parent = this.appInstance.getParentActivity(this.id);
            if (parent) {
                parent.setPop(activity);
            } else {
                await this.appInstance.replace(this.id, activity);
            }
            return ok();
        });
        if (result.isErr()) {
            return result;
        }
        return await this.appInstance.wake();
    }

    /**
     * Puts `activity` in this activity's place with this activity as its source to return to (used by attached wizards).
     *
     * @param activity - The new activity.
     */
    async source(activity: ActivityInstance): Promise<AppResult> {
        const result = await this.executeIfActive(async () => {
            if (!activity.driver) {
                activity.init(new ActivityDriver(this.appInstance, activity), undefined, this.activity);
            }
            const parent = this.appInstance.getParentActivity(this.id);
            if (parent) {
                parent.setPop(activity);
            } else {
                await this.appInstance.replace(this.id, activity);
            }
            return ok();
        });
        if (result.isErr()) {
            return result;
        }
        return await this.appInstance.wake();
    }

    /** Re-renders the active activity. */
    async reload(): Promise<AppResult> {
        return this.appInstance.reload();
    }

    /**
     * Rebuilds this activity with `ctx`, if it is active.
     *
     * @param ctx - The new context.
     */
    async refresh(ctx: Defined<any> | undefined): Promise<AppResult> {
        return await this.executeIfActive(async () => {
            await this.activity.refresh(ctx);
            return ok();
        });
    }

    /**
     * Sends a build to the client (only while active).
     *
     * @param build - The UI tree.
     * @param isPop - Whether the activity is a pop-up.
     * @param hasPrev - Whether the client may go back.
     */
    async sendBuild(build: BuildedPart, isPop: boolean, hasPrev: boolean): Promise<AppResult> {
        return this.request(
            new SendBuild({
                isPop,
                hasPrev,
                activityId: this.id,
                build,
            }),
        );
    }

    /**
     * Sends a fragment update to the client (only while active).
     *
     * @param fragmentId - Target fragment.
     * @param type - Full or patch.
     * @param data - The data.
     */
    async sendUpdate(fragmentId: string, type: UpdateTypes, data: any): Promise<AppResult> {
        return this.request(
            new SendUpdate({
                activityId: this.id,
                fragmentId,
                type,
                data,
            }),
        );
    }

    /**
     * Sends data on the `push` stream, also while inactive.
     *
     * @param data - The data.
     */
    async sendPush(data: any): Promise<AppResult> {
        return this.request(new SendPush(data), true);
    }

    /** Wakes this activity again (runs `afterWake()`), if it is active. */
    async wake(): Promise<AppResult> {
        return await this.executeIfActive(async () => {
            await this.activity.wake();
            return ok();
        });
    }

    /** Removes this activity from the app (see {@link AppInstance.close}). */
    async close(): Promise<AppResult> {
        return await this.appInstance.close(this.id);
    }

    /** Ends the whole app instance, if this activity is active. */
    async destroy(): Promise<AppResult> {
        return await this.executeIfActive(async () => {
            await this.appInstance.destroy();
            return ok();
        });
    }
}

/**
 * The activities of one app instance inside its worker thread.
 *
 * `index` holds the open activities (tabs) in display order; `history` holds them in activation order, its last entry
 * being the active activity. Every request from the main thread and every `trigger()` runs through
 * {@link AppInstance.exclusive}, so activity changes never interleave.
 */
export class AppInstance {
    /** The app (template) being run. */
    private appDeclaration: App<any, any>;
    /** Activity limit; see {@link AppInstance.open}. */
    private tabLimit: number;
    /** Optional page (property name on the app) opened right after the main page; the worker never sets it. */
    private readonly secondAction?: { name: string; ctx: Record<string, any> | null } | null;
    /** Open activities in tab order. */
    private index: ActivityInstance[] = [];
    /** Open activities in activation order (last = active). */
    private history: ActivityInstance[] = [];
    /** Serialises activity changes. */
    private readonly lock: ActivityLock = new ActivityLock();

    /**
     * @param appDeclaration - The app to run.
     * @param tabLimit - Activity limit.
     * @param secondAction - Optional page to open after the main page.
     */
    constructor(appDeclaration: App<any, any>, tabLimit: number, secondAction: { name: string; ctx: Record<string, any> | null } | null = null) {
        this.appDeclaration = appDeclaration;
        this.tabLimit = tabLimit;
        this.secondAction = secondAction;
    }

    /** Runs `task` with exclusive access to this app's activities (re-entrant for calls made inside `task`). */
    exclusive<T>(task: () => Promise<T>): Promise<T> {
        return this.lock.run(task);
    }

    /** Runs `callback` outside the current lock context, so timers it starts queue for the lock instead of skipping it. */
    outsideLock<T>(callback: () => T): T {
        return this.lock.outside(callback);
    }

    /**
     * Returns the activity that shows `popId` as its pop-up, if any.
     *
     * @param popId - Id of the pop-up activity.
     */
    getParentActivity(popId: string): ActivityInstance | undefined {
        return this.index.find((activity) => activity.popActivity?.driver.id === popId);
    }

    /** Opens the main page (and the optional second page); nothing is rendered until the client sends `load`. */
    async init(): Promise<void> {
        const activityInstance = new ActivityInstance(this.appDeclaration.main as any, undefined);
        const driver = new ActivityDriver(this, activityInstance);
        activityInstance.init(driver, undefined, undefined);
        await this.open(activityInstance);

        if (this.secondAction) {
            const secondActivity = (this.appDeclaration as any)[this.secondAction.name];
            const secondActivityInstance = new ActivityInstance(secondActivity, undefined);
            const secondDriver = new ActivityDriver(this, secondActivityInstance);
            secondActivityInstance.init(secondDriver, activityInstance, undefined);
            await this.open(secondActivityInstance);
        }
    }

    /** The active activity. */
    private get active(): ActivityInstance {
        return this.history[this.history.length - 1];
    }

    /** Id of the active activity. */
    get activeId(): string {
        return this.active.driver.id;
    }

    /** Whether no activity is open. */
    private get empty(): boolean {
        return this.index.length === 0;
    }

    /** The activity list sent to the client. */
    get activityList(): ActivityList {
        return this.index.map((activity) => ({
            id: activity.driver.id,
            title: activity.title,
            active: activity.driver.id === this.activeId,
            main: this.index[0].driver.id === activity.driver.id,
            prev: activity.hasPrev(),
        }));
    }

    /** Moves `activity` to the end of the history (makes it active). */
    private activate(activity: ActivityInstance): void {
        this.historyRemove(activity);
        this.history.push(activity);
    }

    /** Wakes the active activity. */
    async wake(): Promise<AppResult> {
        await this.active.wake();
        return ok();
    }

    /** Removes `activity` from the history. */
    private historyRemove(activity: ActivityInstance): void {
        this.history = this.history.filter((presentActivity) => presentActivity !== activity);
    }

    /**
     * Whether `id` is the active activity or the pop-up of the active activity.
     *
     * @param id - Activity id.
     */
    isActive(id: string): boolean {
        return id === this.active.driver.id || this.active.popActivity?.driver.id === id;
    }

    /** Sends the build of the active activity (rendering it first if needed); `Err(WrongAction)` when nothing is open. */
    async load(): Promise<AppResult> {
        if (this.index.length > 0) {
            return await this.active.load();
        }
        return new Err(AppError.WrongAction);
    }

    /**
     * Rebuilds the activity `id` with its current context, if it is active (or the active pop-up).
     *
     * @param id - Activity id.
     */
    async refresh(id: string): Promise<AppResult> {
        if (id === this.activeId) {
            return await this.active.refreshSelf();
        }
        if (id === this.active.popActivity?.driver.id) {
            return await this.active.popActivity.refreshSelf();
        }
        return new Err(AppError.NonActive);
    }

    /**
     * Goes back in activity `id`, if it is active (or the active pop-up).
     *
     * @param id - Activity id.
     */
    async prev(id: string): Promise<AppResult> {
        if (id === this.activeId) {
            return await this.active.prev();
        }
        if (id === this.active.popActivity?.driver.id) {
            return await this.active.popActivity.prev();
        }
        return new Err(AppError.NonActive);
    }

    /** Closes the channel to the main thread (which ends the instance) and suspends every activity. */
    async destroy(): Promise<void> {
        workerDriver().destroy();
        await Promise.all(
            [...this.index].map(async (activity) => {
                activity.suspend();
            }),
        );
        this.index = [];
        this.history = [];
    }

    /** Re-renders the active activity. */
    async reload(): Promise<AppResult> {
        await this.active.reload();
        return ok();
    }

    /**
     * Puts `activity` in the slot of activity `id` (or appends it when `id` is not open) and activates it; the previous
     * activity is suspended if it was active.
     *
     * @param id - Activity to replace.
     * @param activity - The replacement.
     */
    async replace(id: string, activity: ActivityInstance): Promise<void> {
        if (id === this.activeId) {
            this.active.suspend();
        }
        const idx = this.index.findIndex((act) => act.driver.id === id);
        if (idx === -1) {
            this.index.push(activity);
        } else {
            this.historyRemove(this.index[idx]);
            this.index[idx] = activity;
        }
        this.activate(activity);
    }

    /**
     * Appends `activity`, suspends the active one and activates the new one.
     *
     * When the number of activities exceeds `tabLimit`, the second least recently activated activity is dropped, unless it
     * is the activity that was active until now; the least recently activated one is always kept. The list can therefore
     * hold `tabLimit + 1` activities.
     *
     * @param activity - The new activity.
     */
    async open(activity: ActivityInstance): Promise<void> {
        if (!this.empty) {
            this.active.suspend();
        }
        this.index.push(activity);
        if (this.index.length > this.tabLimit) {
            const toClose = this.history[1];
            if (toClose && this.active !== toClose) {
                const idx = this.index.findIndex((act) => act === toClose);
                this.index.splice(idx, 1);
                this.historyRemove(toClose);
            }
        }
        this.activate(activity);
    }

    /**
     * Makes activity `id` active and sends its build; re-renders it when it is already active.
     *
     * @param id - Activity id.
     */
    async switch(id: string): Promise<AppResult> {
        const activity = this.index.find((act) => act.driver.id === id);
        if (!activity) {
            return new Err(AppError.WrongAction);
        }
        if (this.active === activity) {
            return await this.active.reload();
        }
        this.active.suspend();
        this.activate(activity);
        return await this.load();
    }

    /**
     * Cancels the active activity (returns to its source or closes it).
     *
     * @param id - Must be the active activity's id.
     */
    async cancel(id: string): Promise<AppResult> {
        if (id === this.activeId) {
            return await this.active.cancel();
        }
        return new Err(AppError.NonActive);
    }

    /**
     * Handles the client's close button for activity `id`: a pop-up or wizard returns to its source, other activities close.
     *
     * @param id - Activity id.
     */
    async userClose(id: string): Promise<AppResult> {
        for (let i = 0; i < this.index.length; i++) {
            const activity = this.index[i];
            if (activity.driver.id === id) {
                return activity.triggerClose();
            }
            if (activity.popActivity?.driver.id === id) {
                return activity.popActivity.triggerClose();
            }
        }
        return new Err(AppError.WrongAction);
    }

    /**
     * Removes activity `id`. Closing the last activity ends the instance; closing the active one wakes the next most recently
     * active activity; closing a pop-up reloads (or resets) the activity under it.
     *
     * @param id - Activity id.
     */
    async close(id: string): Promise<AppResult> {
        for (let i = 0; i < this.index.length; i++) {
            const activity = this.index[i];
            const isActive = this.active === activity;
            if (activity.driver.id === id) {
                activity.suspend();
                this.index.splice(i, 1);
                this.historyRemove(activity);
                if (this.empty) {
                    workerDriver().destroy();
                    return ok();
                }
                if (isActive) {
                    return await this.active.wake();
                }
                return await this.active.driver.updateActivityList();
            }
            if (activity.popActivity?.driver.id === id) {
                activity.popActivity.suspend();
                activity.popActivity = undefined;
                if (isActive) {
                    return await this.active.reload();
                } else {
                    this.active.resetBeforeRefresh();
                }
                return ok();
            }
        }
        return new Err(AppError.WrongAction);
    }

    /**
     * Runs an action of a fragment of the active activity.
     *
     * @param fragmentId - Fragment id.
     * @param name - Action name.
     * @param data - Action data.
     */
    async action(fragmentId: string, name: string, data: any): Promise<Result<void, AppError>> {
        return await this.active?.action(fragmentId, name, data);
    }

    /**
     * Runs a query of a fragment of the active activity.
     *
     * @param fragmentId - Fragment id.
     * @param name - Query name.
     * @param data - Query data.
     * @returns The answer.
     */
    async query(fragmentId: string, name: string, data: any): Promise<Result<any, AppError>> {
        return await this.active?.query(fragmentId, name, data);
    }

    /** Suspends the active activity (runs its cleanups). */
    suspend(): void {
        this.active?.suspend();
    }
}
