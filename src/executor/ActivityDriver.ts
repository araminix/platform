import { Defined, Err, ok, Result, uuid } from '@araminix/lib';

import { BuildedPart } from '../builder/builder.js';
import { Nothing, ReloadFragment, UpdateFragment, UpdateTypes } from '../lib/actors.js';
import type { ActivityInstance, StageInstance } from './ActivityInstance.js';
import type { AppInstance } from './AppInstance.js';
import { SendBuild, SendPush, SendUpdate, UpdateActivityList } from './proto.js';
import { AppError, AppResult } from './types.js';
import workerDriver from './workerDriver.js';

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
    /** Per-fragment monotonic update sequence counters (starting at 1). */
    private fragmentSeq: Map<string, number> = new Map();

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
     * @param keepSource - Keep this activity built under the pop-up instead of suspending it (see
     * {@link ActivityInstance.keepUnderWizard}); used when a wizard stage pops another wizard.
     */
    async pop(activity: ActivityInstance, keepSource: boolean = false): Promise<AppResult> {
        const result = await this.executeIfActive(async () => {
            if (!activity.driver) {
                activity.init(new ActivityDriver(this.appInstance, activity), undefined, this.activity, true);
            }
            const parent = this.appInstance.getParentActivity(this.id);
            if (parent) {
                parent.setPop(activity);
            } else if (keepSource && this.activity.keepUnderWizard()) {
                await this.appInstance.replace(this.id, activity, false);
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
     * Sends a fragment update to the client (only while active) with a per-fragment monotonic sequence number (`seq`,
     * starting at 1).
     *
     * @param fragmentId - Target fragment.
     * @param type - Full or patch.
     * @param data - The data.
     */
    async sendUpdate(fragmentId: string, type: UpdateTypes, data: any): Promise<AppResult> {
        return this.executeIfActive(async () => {
            const seq = (this.fragmentSeq.get(fragmentId) ?? 0) + 1;
            this.fragmentSeq.set(fragmentId, seq);
            const result = await workerDriver().request(new SendUpdate({ activityId: this.id, fragmentId, type, data, seq }));
            if (result.isErr()) {
                return new Err(AppError.Other);
            }
            return ok();
        });
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
