import { ActivityDriver, ActivityInterface } from '../executor/ActivityInstance.js';
import { AppResult } from '../executor/AppInstance.js';
import workerDriver from '../executor/workerDriver.js';
import { Actor, Nothing, Refresh, Reload } from './actors.js';

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
 * fragment actions and `trigger()` calls of an app instance are serialized by the app lock.
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

    /** Runs the cleanup of the previous wake, then calls `afterWake()` and stores its new cleanup. */
    private _afterWake(): void {
        // A repeated wake (e.g. after an action returns $nothing()) must stop what the previous afterWake() started.
        this._cleanUp();
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
     * polling or subscriptions here and return a function that stops them. Before a repeated wake the previous cleanup runs,
     * so this never runs twice without its cleanup in between.
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
