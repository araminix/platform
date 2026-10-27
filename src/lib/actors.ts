import type { Result } from '@araminix/lib';

import type { Activity, App, Page, Stage, Wizard } from './d.js';

/**
 * An instruction for the app runtime: "open this page", "close me", "send this data to that fragment", ...
 *
 * Activities never change the UI directly. They return an actor, and the runtime (inside the app's worker thread, under
 * the app lock) carries it out. Actors are created with the `$` helpers:
 *
 * | Helper | Defined on | Actor | Effect |
 * | --- | --- | --- | --- |
 * | `page.$open(ctx)` | {@link Page} (target) | {@link OpenPage} | open the page as a new activity (tab) |
 * | `page.$next(ctx)` | {@link Page} (target) | {@link NextPage} | show the page in the current activity, with "back" |
 * | `page.$replace(ctx)` | {@link Page} (target) | {@link ReplacePage} | show the page in the current activity, no "back" |
 * | `page.$pop(ctx)` | {@link Page} (target) | {@link PopPage} | show the page as a pop-up of the current activity |
 * | `this.$close()` | {@link Page} | {@link Close} | close this activity |
 * | `this.$destroy()` | {@link Page}, {@link Stage} | {@link Destroy} | end the whole app instance |
 * | `this.$refresh(ctx)` | {@link Activity} | {@link Refresh} | rebuild this activity with a new context |
 * | `this.$reload()` | {@link Activity} | {@link Reload} | re-render the active activity |
 * | `this.$nothing()` | {@link Activity}, {@link Fragment} | {@link Nothing} | no change |
 * | `wizard.$detached(ctx, on)` | {@link Wizard} | {@link WizardDetached} | run the wizard in a new activity |
 * | `wizard.$attached(ctx, on)` | {@link Wizard} | {@link WizardAttached} | run the wizard in place of the current activity |
 * | `wizard.$pop(ctx, on)` | {@link Wizard} | {@link WizardPop} | run the wizard as a pop-up |
 * | `stage.$next(ctx)` / `stage.$nextReplace(ctx)` | {@link Stage} (target) | {@link WizardNext} / {@link WizardNextReplace} | go to another stage |
 * | `this.$ok(v)` / `this.$err(e)` / `this.$cancel()` | {@link Stage} | {@link WizardDone} | finish the wizard |
 * | `this.$back()` | {@link Stage} | {@link Prev} | go back one stage |
 * | `this.$update(d)` / `this.$patch(d)` | {@link Fragment} | {@link UpdateFragment} | send data to the fragment's component |
 * | `this.$reload()` | {@link Fragment} | {@link ReloadFragment} | run the fragment's `load()` again and send the result |
 *
 * Return actors from fragment actions ({@link Fragment.onAction}), from {@link Activity.beforeRender} and from wizard
 * callbacks, or apply them later with {@link Activity.trigger} / {@link Fragment.trigger}. An actor that does not fit the
 * activity (for example another activity's `Close`, or `$next` of a stage of a different wizard) is rejected with
 * `AppError.WrongAction`.
 *
 * @example
 * ```ts
 * new Button({ label: 'Details', onClick: () => this.app.details.$open({ id: row.id }) });
 * new Button({ label: 'Done', onClick: () => this.$close() });
 * ```
 */
export interface Actor {}

/**
 * Closes an activity; created by `Page.$close()`. Only the activity that created it may use it.
 *
 * For a page the activity is removed from the app and the previously active activity becomes active again; closing the
 * last activity ends the app instance. For a {@link Stage} it cancels the wizard (like `$cancel()`).
 *
 * @typeParam C - Context type of the activity.
 */
export class Close<C = unknown> implements Actor {
    /** The activity to close. */
    readonly activity: Activity<C>;
    /** @param activity - The activity to close (must be the one that applies the actor). */
    constructor(activity: Activity<C>) {
        this.activity = activity;
    }
}

/**
 * Goes back one step; created by `Stage.$back()`. In a wizard it returns to the stage that opened the current one with
 * `$next`; on the first stage of an attached or pop-up wizard it cancels the wizard and returns to the opener. On the
 * first stage of a detached wizard it is rejected (`AppError.WrongAction`).
 *
 * @typeParam C - Context type of the activity.
 */
export class Prev<C = unknown> implements Actor {
    /** The activity that goes back (must be the one that applies the actor). */
    readonly activity: Activity<C>;
    /** @param activity - The activity that goes back. */
    constructor(activity: Activity<C>) {
        this.activity = activity;
    }
}

/**
 * Ends the whole app instance; created by `$destroy()`. The app's worker thread shuts down, the instance is removed from
 * the user's instance list and the client's `instance` socket is closed. Applied only by the active activity.
 *
 * @typeParam SETTINGS - Settings type of the app.
 */
export class Destroy<SETTINGS = unknown> implements Actor {
    /** The app whose instance ends. */
    readonly app: App<SETTINGS, any>;
    /** @param app - The app whose instance ends. */
    constructor(app: App<SETTINGS, any>) {
        this.app = app;
    }
}

/**
 * Runs a wizard in a new activity (tab); created by {@link Wizard.$detached}. When the wizard finishes, `on` receives the
 * result (its return value is ignored) and the wizard's activity closes.
 *
 * @typeParam C - Wizard context type.
 * @typeParam O - Wizard output type.
 * @typeParam W - Wizard type.
 * @typeParam R - Return type of `on` (ignored).
 */
export class WizardDetached<C = unknown, O = unknown, W extends Wizard<C, O, any> = Wizard<C, O, any>, R = unknown> implements Actor {
    /** First stage of the wizard. */
    readonly mainStage: Stage<C, O, W>;
    /** Context for the first stage. */
    readonly ctx: C;
    /** Called with `Ok(output)`, `Err(error)` or `undefined` (cancelled) when the wizard finishes. */
    readonly on?: ((result: Result<O, unknown> | undefined) => Promise<R> | R) | undefined;

    /**
     * @param mainStage - First stage of the wizard.
     * @param ctx - Context for the first stage.
     * @param on - Optional result callback.
     */
    constructor(mainStage: Stage<C, O, W>, ctx: C, on?: ((result: Result<O, unknown> | undefined) => Promise<R> | R) | undefined) {
        this.mainStage = mainStage;
        this.ctx = ctx;
        this.on = on;
    }
}

/**
 * Runs a wizard in place of the current activity; created by {@link Wizard.$attached}. When the wizard finishes, the
 * original activity comes back and the actor returned by `on` is applied to it (nothing else happens when `on` is
 * missing or returns `$nothing()` or a fragment `$reload()`).
 *
 * @typeParam C - Wizard context type.
 * @typeParam O - Wizard output type.
 * @typeParam W - Wizard type.
 */
export class WizardAttached<C = unknown, O = unknown, W extends Wizard<C, O, any> = Wizard<C, O, any>> implements Actor {
    /** First stage of the wizard. */
    readonly mainStage: Stage<C, O, W>;
    /** Context for the first stage. */
    readonly ctx: C;
    /** Receives `Ok(output)`, `Err(error)` or `undefined` (cancelled) and returns the actor to apply to the original activity. */
    readonly on?: ((result: Result<O, unknown> | undefined) => Promise<Actor> | Actor) | undefined;

    /**
     * @param mainStage - First stage of the wizard.
     * @param ctx - Context for the first stage.
     * @param on - Optional result callback.
     */
    constructor(mainStage: Stage<C, O, W>, ctx: C, on?: ((result: Result<O, unknown> | undefined) => Promise<Actor> | Actor) | undefined) {
        this.mainStage = mainStage;
        this.ctx = ctx;
        this.on = on;
    }
}

/**
 * Runs a wizard as a pop-up of the current activity (its builds carry `isPop: true`); created by {@link Wizard.$pop}.
 * Finishing works like {@link WizardAttached}.
 *
 * @typeParam C - Wizard context type.
 * @typeParam O - Wizard output type.
 * @typeParam W - Wizard type.
 */
export class WizardPop<C = unknown, O = unknown, W extends Wizard<C, O, any> = Wizard<C, O, any>> implements Actor {
    /** First stage of the wizard. */
    readonly mainStage: Stage<C, O, W>;
    /** Context for the first stage. */
    readonly ctx: C;
    /** Receives the result and returns the actor to apply to the original activity. */
    readonly on?: ((result: Result<O, unknown> | undefined) => Promise<Actor> | Actor) | undefined;

    /**
     * @param mainStage - First stage of the wizard.
     * @param ctx - Context for the first stage.
     * @param on - Optional result callback.
     */
    constructor(mainStage: Stage<C, O, W>, ctx: C, on?: ((result: Result<O, unknown> | undefined) => Promise<Actor> | Actor) | undefined) {
        this.mainStage = mainStage;
        this.ctx = ctx;
        this.on = on;
    }
}

/**
 * Finishes a wizard; created by `Stage.$ok(v)`, `Stage.$err(e)` and `Stage.$cancel()`. Only a {@link Stage} can apply it.
 *
 * @typeParam O - Wizard output type.
 * @typeParam E - Error type.
 */
export class WizardDone<O = unknown, E = unknown> implements Actor {
    /** The wizard that finishes. */
    readonly wizard: Wizard<any, O, any>;
    /** `Ok(output)`, `Err(error)`, or `undefined` when cancelled. */
    readonly result: Result<O, E> | undefined;

    /**
     * @param wizard - The wizard that finishes.
     * @param result - Its result, or `undefined` when cancelled.
     */
    constructor(wizard: Wizard<any, O, any>, result: Result<O, E> | undefined) {
        this.wizard = wizard;
        this.result = result;
    }
}

/**
 * Moves to another stage of the same wizard and keeps the current stage for `$back()`; created by {@link Stage.$next}
 * on the target stage.
 *
 * @typeParam C - Context type of the target stage.
 * @typeParam O - Wizard output type.
 * @typeParam W - Wizard type.
 */
export class WizardNext<C = unknown, O = unknown, W extends Wizard<any, O, any> = Wizard<any, O, any>> implements Actor {
    /** The target stage. */
    readonly stage: Stage<C, O, W>;
    /** Context for the target stage. */
    readonly ctx: C;

    /**
     * @param stage - The target stage.
     * @param ctx - Context for the target stage.
     */
    constructor(stage: Stage<C, O, W>, ctx: C) {
        this.stage = stage;
        this.ctx = ctx;
    }
}

/**
 * Moves to another stage of the same wizard, replacing the current stage (no `$back()` to it); created by
 * {@link Stage.$nextReplace} on the target stage.
 *
 * @typeParam C - Context type of the target stage.
 * @typeParam O - Wizard output type.
 * @typeParam W - Wizard type.
 */
export class WizardNextReplace<C = unknown, O = unknown, W extends Wizard<any, O, any> = Wizard<any, O, any>> implements Actor {
    /** The target stage. */
    readonly stage: Stage<C, O, W>;
    /** Context for the target stage. */
    readonly ctx: C;

    /**
     * @param stage - The target stage.
     * @param ctx - Context for the target stage.
     */
    constructor(stage: Stage<C, O, W>, ctx: C) {
        this.stage = stage;
        this.ctx = ctx;
    }
}

/**
 * Opens a page as a new activity (tab) of the app; created by {@link Page.$open} on the target page.
 *
 * When this makes the app exceed `tabLimit` activities, one older activity is dropped: the second least recently used
 * one, and only if it is not the activity being left (see {@link PlatformConfig.tabLimit}).
 *
 * @typeParam C - Context type of the page.
 * @typeParam P - Page type.
 */
export class OpenPage<C = unknown, P extends Page<C, any> = Page<C, any>> implements Actor {
    /** The page template to open (a fresh instance is created from it). */
    readonly page: P;
    /** Context for the page. */
    readonly ctx: C;

    /**
     * @param page - The page template.
     * @param ctx - Context for the page.
     */
    constructor(page: P, ctx: C) {
        this.page = page;
        this.ctx = ctx;
    }
}

/**
 * Shows a page as a pop-up of the current activity (its builds carry `isPop: true`); created by {@link Page.$pop} on the
 * target page. When the user closes the pop-up (the client's `close` request), the page that opened it comes back.
 *
 * @typeParam C - Context type of the page.
 * @typeParam P - Page type.
 */
export class PopPage<C = unknown, P extends Page<C, any> = Page<C, any>> implements Actor {
    /** The page template to show. */
    readonly page: P;
    /** Context for the page. */
    readonly ctx: C;

    /**
     * @param page - The page template.
     * @param ctx - Context for the page.
     */
    constructor(page: P, ctx: C) {
        this.page = page;
        this.ctx = ctx;
    }
}

/**
 * Shows a page in the current activity and keeps the current page as its "previous" one (the client can go back with
 * the `prev` request); created by {@link Page.$next} on the target page.
 *
 * @typeParam C - Context type of the page.
 * @typeParam P - Page type.
 */
export class NextPage<C = unknown, P extends Page<C, any> = Page<C, any>> implements Actor {
    /** The page template to show. */
    readonly page: P;
    /** Context for the page. */
    readonly ctx: C;

    /**
     * @param page - The page template.
     * @param ctx - Context for the page.
     */
    constructor(page: P, ctx: C) {
        this.page = page;
        this.ctx = ctx;
    }
}

/**
 * Replaces the current page of the activity without keeping it for "back"; created by {@link Page.$replace} on the
 * target page.
 *
 * @typeParam C - Context type of the page.
 * @typeParam P - Page type.
 */
export class ReplacePage<C = unknown, P extends Page<C, any> = Page<C, any>> implements Actor {
    /** The page template to show. */
    readonly page: P;
    /** Context for the page. */
    readonly ctx: C;

    /**
     * @param page - The page template.
     * @param ctx - Context for the page.
     */
    constructor(page: P, ctx: C) {
        this.page = page;
        this.ctx = ctx;
    }
}

/**
 * Rebuilds an activity with a new context; created by {@link Activity.$refresh}. The full lifecycle runs again: cleanup,
 * `title(ctx)`, `beforeRender()`, `render()`, `afterWake()`. Only the activity that created it may use it.
 *
 * @typeParam C - Context type of the activity.
 */
export class Refresh<C = unknown> implements Actor {
    /** The activity to rebuild. */
    readonly activity: Activity<C>;
    /** The new context. */
    readonly ctx: C;

    /**
     * @param activity - The activity to rebuild.
     * @param ctx - The new context.
     */
    constructor(activity: Activity<C>, ctx: C) {
        this.activity = activity;
        this.ctx = ctx;
    }
}

/**
 * Re-renders the active activity with its current context; created by {@link Activity.$reload}. Runs cleanup,
 * `render()` and `afterWake()` again, but not `title()` or `beforeRender()`.
 */
export class Reload implements Actor {
    constructor() {}
}

/** How the client should apply the data of an {@link UpdateFragment}. */
export enum UpdateTypes {
    /** The data replaces the fragment's data (sent by `$update()` and `$reload()`). */
    Full = 'Full',
    /** The data is a partial change to merge into the fragment's data (sent by `$patch()`). */
    Patch = 'Patch',
}

/**
 * Sends data to a fragment's client component; created by {@link Fragment.$update} and {@link Fragment.$patch}. The
 * client receives `{ data, type }` on the stream `update-<fragmentId>`. Sent only while the activity is active.
 *
 * @typeParam D - Data type.
 */
export class UpdateFragment<D = unknown> implements Actor {
    /** Id of the target fragment. */
    readonly fragmentId: string;
    /** Full replacement or patch. */
    readonly type: UpdateTypes;
    /** The data. */
    readonly data: D;

    /**
     * @param fragmentId - Id of the target fragment.
     * @param type - Full replacement or patch.
     * @param data - The data.
     */
    constructor(fragmentId: string, type: UpdateTypes, data: D) {
        this.fragmentId = fragmentId;
        this.type = type;
        this.data = data;
    }
}

/**
 * Runs a fragment's `load()` again and sends the result as a {@link UpdateTypes.Full} update; created by
 * {@link Fragment.$reload}. The cleanup returned by the previous `afterLoad()` runs first.
 */
export class ReloadFragment implements Actor {
    /** Id of the fragment to reload. */
    readonly fragmentId: string;

    /** @param fragmentId - Id of the fragment to reload. */
    constructor(fragmentId: string) {
        this.fragmentId = fragmentId;
    }
}

/**
 * "No change"; created by `$nothing()`. From {@link Activity.beforeRender} it lets rendering continue.
 *
 * @remarks
 * Returned from a fragment action (or passed to `trigger()`), it wakes the active activity again, which calls
 * {@link Activity.afterWake} once more. The cleanup returned by the previous `afterWake()` call is not run in that case,
 * so keep `afterWake()` idempotent (or have it clear what it started before) if your actions return `$nothing()`.
 */
export class Nothing implements Actor {}
