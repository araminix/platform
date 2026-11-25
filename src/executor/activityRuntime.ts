import { Result } from '@araminix/lib';

import { Actor } from '../lib/actors.js';
import type { Activity } from '../lib/d.js';
import type { ActivityDriver as ActivityAppDriver } from './ActivityDriver.js';
import type { ActivityInstance } from './ActivityInstance.js';
import { AppResult } from './types.js';

/** Lifecycle status of an {@link ActivityInstance}. */
export enum ActivityStatus {
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
export type WizardHandler = void | ((result: Result<any, any> | undefined) => Promise<any> | any);

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
    get status(): ActivityStatus {
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
