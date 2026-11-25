import workerDriver from '../executor/workerDriver.js';
import { Activity } from './Activity.js';
import { Close, Destroy, NextPage, OpenPage, PopPage, ReplacePage } from './actors.js';
import type { App } from './App.js';

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
