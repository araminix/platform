import { Defined, Err, ok, Result, uuid } from '@araminix/lib';

import { BuildedPart } from '../builder/builder.js';
import { Nothing, ReloadFragment, UpdateFragment, UpdateTypes } from '../lib/actors.js';
import { App } from '../lib/d.js';
import { ActivityInstance, StageInstance } from './ActivityInstance.js';
import { ActivityList, SendBuild, SendPush, SendUpdate, UpdateActivityList } from './proto.js';
import workerDriver from './workerDriver.js';

export enum AppError {
    WrongAction = 'WrongAction',
    NonActive = 'NonActive',
    Skipped = 'Skipped',
    NotFound = 'NotFound',
    Other = 'Other',
}

export type AppResult = Result<void, AppError>;

export class ActivityDriver {
    private appInstance: AppInstance;
    private activity: ActivityInstance;
    readonly id: string = uuid();

    constructor(appInstance: AppInstance, activity: ActivityInstance) {
        this.appInstance = appInstance;
        this.activity = activity;
    }

    private async executeIfActive<T>(runnable: () => Promise<Result<T, AppError>>): Promise<Result<T, AppError>> {
        if (!this.appInstance.isActive(this.id)) {
            return new Err(AppError.NonActive);
        }
        return runnable();
    }

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

    updateActivityList(): Promise<AppResult> {
        return this.request(new UpdateActivityList(this.appInstance.activityList));
    }

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

    async reload(): Promise<AppResult> {
        return this.appInstance.reload();
    }

    async refresh(ctx: Defined<any> | undefined): Promise<AppResult> {
        return await this.executeIfActive(async () => {
            await this.activity.refresh(ctx);
            return ok();
        });
    }

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

    async sendPush(data: any): Promise<AppResult> {
        return this.request(new SendPush(data), true);
    }

    async wake(): Promise<AppResult> {
        return await this.executeIfActive(async () => {
            await this.activity.wake();
            return ok();
        });
    }

    async close(): Promise<AppResult> {
        return await this.appInstance.close(this.id);
    }

    async destroy(): Promise<AppResult> {
        return await this.executeIfActive(async () => {
            await this.appInstance.destroy();
            return ok();
        });
    }
}

export class AppInstance {
    private appDeclaration: App<any, any>;
    private tabLimit: number;
    private readonly secondAction?: { name: string; ctx: Record<string, any> | null } | null;
    private index: ActivityInstance[] = [];
    private history: ActivityInstance[] = [];

    constructor(appDeclaration: App<any, any>, tabLimit: number, secondAction: { name: string; ctx: Record<string, any> | null } | null = null) {
        this.appDeclaration = appDeclaration;
        this.tabLimit = tabLimit;
        this.secondAction = secondAction;
    }

    getParentActivity(popId: string): ActivityInstance | undefined {
        return this.index.find((activity) => activity.popActivity?.driver.id === popId);
    }

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

    private get active(): ActivityInstance {
        return this.history[this.history.length - 1];
    }

    get activeId(): string {
        return this.active.driver.id;
    }

    private get empty(): boolean {
        return this.index.length === 0;
    }

    get activityList(): ActivityList {
        return this.index.map((activity) => ({
            id: activity.driver.id,
            title: activity.title,
            active: activity.driver.id === this.activeId,
            main: this.index[0].driver.id === activity.driver.id,
            prev: activity.hasPrev(),
        }));
    }

    private activate(activity: ActivityInstance): void {
        this.historyRemove(activity);
        this.history.push(activity);
    }

    async wake(): Promise<AppResult> {
        await this.active.wake();
        return ok();
    }

    private historyRemove(activity: ActivityInstance): void {
        this.history = this.history.filter((presentActivity) => presentActivity !== activity);
    }

    isActive(id: string): boolean {
        return id === this.active.driver.id || this.active.popActivity?.driver.id === id;
    }

    async load(): Promise<AppResult> {
        if (this.index.length > 0) {
            return await this.active.load();
        }
        return new Err(AppError.WrongAction);
    }

    async refresh(id: string): Promise<AppResult> {
        if (id === this.activeId) {
            return await this.active.refreshSelf();
        }
        if (id === this.active.popActivity?.driver.id) {
            return await this.active.popActivity.refreshSelf();
        }
        return new Err(AppError.NonActive);
    }

    async prev(id: string): Promise<AppResult> {
        if (id === this.activeId) {
            return await this.active.prev();
        }
        if (id === this.active.popActivity?.driver.id) {
            return await this.active.popActivity.prev();
        }
        return new Err(AppError.NonActive);
    }

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

    async reload(): Promise<AppResult> {
        await this.active.reload();
        return ok();
    }

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

    async cancel(id: string): Promise<AppResult> {
        if (id === this.activeId) {
            return await this.active.cancel();
        }
        return new Err(AppError.NonActive);
    }

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

    async action(fragmentId: string, name: string, data: any): Promise<Result<void, AppError>> {
        return await this.active?.action(fragmentId, name, data);
    }

    async query(fragmentId: string, name: string, data: any): Promise<Result<any, AppError>> {
        return await this.active?.query(fragmentId, name, data);
    }

    suspend(): void {
        this.active?.suspend();
    }
}
