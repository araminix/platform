import { Err, ok, Result } from '@araminix/lib';

import { App } from '../lib/d.js';
import { ActivityDriver } from './ActivityDriver.js';
import { ActivityInstance } from './ActivityInstance.js';
import { ActivityLock } from './ActivityLock.js';
import { ActivityList } from './proto.js';
import { AppError, AppResult } from './types.js';
import workerDriver from './workerDriver.js';

export { ActivityDriver, AppError, AppResult };

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
    /** Serializes activity changes. */
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
                activity.suspendKeptSources();
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
     * activity is suspended if it was active, unless `suspendCurrent` is `false`.
     *
     * @param id - Activity to replace.
     * @param activity - The replacement.
     * @param suspendCurrent - Pass `false` when the caller kept the active activity built (see
     * {@link ActivityInstance.keepUnderWizard}) instead of suspending it.
     */
    async replace(id: string, activity: ActivityInstance, suspendCurrent: boolean = true): Promise<void> {
        if (suspendCurrent && id === this.activeId) {
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
                toClose.suspendKeptSources();
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
                activity.suspendKeptSources();
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
