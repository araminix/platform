import { Err, Ok, Result } from '@araminix/lib';

import workerDriver from '../executor/workerDriver.js';
import { Activity } from './Activity.js';
import { Actor, Destroy, Prev, WizardAttached, WizardDetached, WizardDone, WizardNext, WizardNextReplace, WizardPop } from './actors.js';
import type { App } from './App.js';
import type { Page } from './Page.js';
import { PhantomPage } from './phantom.js';

/**
 * A multi-step flow made of {@link Stage}s that produces a result of type `OUTPUT`.
 *
 * Declare the stages as properties (the first one as `main`), create the wizard as a property of the page that starts it,
 * and start it with {@link Wizard.$detached}, {@link Wizard.$attached} or {@link Wizard.$pop}. Stages move with
 * `next.$next(ctx)` and finish with `$ok(output)`, `$err(error)` or `$cancel()`.
 *
 * @typeParam CONTEXT - Context type shared by the stages.
 * @typeParam OUTPUT - Result type.
 * @typeParam PAGE - The page that owns the wizard.
 *
 * @example
 * ```ts
 * import { Stage, Wizard } from '@araminix/platform';
 *
 * type Task = { title: string; due: string };
 *
 * class TitleStage extends Stage<Partial<Task>, Task, NewTaskWizard> {
 *     protected async render() {
 *         new Form<{ title: string }>({ fields: ['title'], onSubmit: ({ title }) => this.wizard.due.$next({ ...this.ctx, title }) });
 *     }
 * }
 *
 * class DueStage extends Stage<Partial<Task>, Task, NewTaskWizard> {
 *     protected async render() {
 *         new Form<{ due: string }>({ fields: ['due'], onSubmit: ({ due }) => this.$ok({ title: this.ctx.title ?? '', due }) });
 *         new Button({ label: 'Back', onClick: () => this.$back() });
 *     }
 * }
 *
 * class NewTaskWizard extends Wizard<Partial<Task>, Task, HomePage> {
 *     protected main = new TitleStage(this);
 *     readonly due = new DueStage(this);
 *     title() {
 *         return 'New task';
 *     }
 * }
 *
 * // In HomePage: readonly newTask = new NewTaskWizard(this);
 * new Button({
 *     label: 'New task',
 *     onClick: () => this.newTask.$attached({}, (result) => (result?.isOk() ? this.$reload() : this.$nothing())),
 * });
 * ```
 */
export abstract class Wizard<CONTEXT = unknown, OUTPUT = unknown, PAGE extends Page<any, any> = Page<any, any>> {
    /** First stage. */
    protected abstract main: Stage<CONTEXT, OUTPUT, Wizard<CONTEXT, OUTPUT, PAGE>>;
    /** The page that owns the wizard. */
    readonly page: PAGE;

    /** @param page - The page that owns the wizard (pass `this` from the page). */
    constructor(page: PAGE) {
        this.page = page;
    }

    /**
     * Title of the wizard; stages use it as their title unless they override {@link Stage.title}.
     *
     * @param ctx - Current context.
     */
    abstract title(ctx: CONTEXT): Promise<string> | string;

    /**
     * Actor that runs the wizard in a new activity (see {@link WizardDetached}).
     *
     * @typeParam R - Return type of `on` (ignored).
     * @param ctx - Context for the first stage.
     * @param on - Called with `Ok(output)`, `Err(error)` or `undefined` (cancelled).
     */
    $detached<R = unknown>(ctx: CONTEXT, on?: (result: Result<OUTPUT, unknown> | undefined) => Promise<R> | R): WizardDetached<CONTEXT, OUTPUT, this, R> {
        return new WizardDetached(this.main as any, ctx, on);
    }

    /**
     * Actor that runs the wizard in place of the current activity and returns to it afterwards (see {@link WizardAttached}).
     *
     * @param ctx - Context for the first stage.
     * @param on - Receives the result and returns the actor to apply to the original activity.
     */
    $attached(ctx: CONTEXT, on?: (result: Result<OUTPUT, unknown> | undefined) => Promise<Actor> | Actor): WizardAttached<CONTEXT, OUTPUT, this> {
        return new WizardAttached(this.main as any, ctx, on);
    }

    /**
     * Actor that runs the wizard as a pop-up of the current activity (see {@link WizardPop}).
     *
     * @param ctx - Context for the first stage.
     * @param on - Receives the result and returns the actor to apply to the original activity.
     */
    $pop(ctx: CONTEXT, on?: (result: Result<OUTPUT, unknown> | undefined) => Promise<Actor> | Actor): WizardPop<CONTEXT, OUTPUT, this> {
        return new WizardPop(this.main as any, ctx, on);
    }
}

/**
 * A {@link Wizard} that edits an app's settings: it starts from the current settings (or `null`) and outputs new ones.
 * Assign it to {@link App.setupWizard}. Its {@link Wizard.page} is a placeholder {@link PhantomPage}.
 *
 * @typeParam SETTINGS - Settings type of the app.
 * @typeParam APP - The app.
 *
 * @example
 * ```ts
 * class TasksSetup extends SetupWizard<TaskSettings, TasksApp> {
 *     main = new TasksSetupStage(this);
 * }
 *
 * // in TasksApp: setupWizard = new TasksSetup(this);
 * // in a page:   this.app.setupWizard.$detached(null, (result) => saveSettings(result));
 * ```
 */
export abstract class SetupWizard<SETTINGS = unknown, APP extends App<SETTINGS, any> = App<SETTINGS, any>> extends Wizard<SETTINGS | null, SETTINGS, PhantomPage<APP>> {
    /** First stage. */
    abstract main: Stage<SETTINGS | null, SETTINGS, SetupWizard<SETTINGS, APP>>;

    /** @param app - The app whose settings the wizard edits. */
    constructor(app: APP) {
        super(new PhantomPage(app));
    }

    /** Returns `"Setup <app title> "` (with a trailing space), resolving an async app title. */
    async title(_ctx: SETTINGS | null): Promise<string> {
        const title = typeof this.page.app.title === 'string' ? this.page.app.title : await this.page.app.title();
        return `Setup ${title} `;
    }
}

/**
 * One step of a {@link Wizard}. A stage is an {@link Activity}: it renders panels and fragments and reacts to their
 * actions, but it navigates with wizard actors.
 *
 * Subclasses must keep the `(wizard)` constructor signature: the runtime creates fresh instances with
 * `new YourStage(this.wizard)`.
 *
 * @typeParam CONTEXT - Context type of the stage.
 * @typeParam OUTPUT - Result type of the wizard.
 * @typeParam WIZARD - The wizard.
 *
 * @example
 * ```ts
 * class DueStage extends Stage<Partial<Task>, Task, NewTaskWizard> {
 *     protected async render() {
 *         new Form<{ due: string }>({ fields: ['due'], onSubmit: ({ due }) => this.$ok({ title: this.ctx.title ?? '', due }) });
 *         new Button({ label: 'Back', onClick: () => this.$back() });
 *         new Button({ label: 'Cancel', onClick: () => this.$cancel() });
 *     }
 * }
 * ```
 */
export abstract class Stage<CONTEXT = unknown, OUTPUT = unknown, WIZARD extends Wizard<any, OUTPUT, any> = Wizard<any, OUTPUT, any>> extends Activity<CONTEXT> {
    /** The wizard this stage belongs to. */
    readonly wizard: WIZARD;

    /** @param wizard - The wizard that declares the stage (pass `this` from the wizard). */
    constructor(wizard: WIZARD) {
        super();
        this.wizard = wizard;
    }

    /** Creates a fresh stage with `new this.constructor(this.wizard)`. */
    protected new(): Activity<CONTEXT> {
        return new (this.constructor as new (wizard: WIZARD) => Stage<CONTEXT, OUTPUT, WIZARD>)(this.wizard);
    }

    /** Profile the instance was launched with, or `null` when the wizard's app is not the launched app. */
    protected get profile(): string | null {
        const launchedApp = workerDriver()?.appName;
        const profile = workerDriver()?.profile;
        if (launchedApp !== this.wizard.page.app.name) {
            return null;
        }
        return profile;
    }

    /** The app index of the wizard's app (untyped). */
    get index(): any {
        return this.wizard.page.app.index;
    }

    /**
     * Title of the stage; defaults to the wizard's title.
     *
     * @param ctx - The stage's context.
     */
    async title(ctx: CONTEXT): Promise<string> {
        return this.wizard.title(ctx);
    }

    /**
     * Actor that finishes the wizard successfully (see {@link WizardDone}).
     *
     * @param v - The wizard's output.
     */
    protected $ok(v: OUTPUT): WizardDone<OUTPUT, unknown> {
        return new WizardDone(this.wizard, new Ok(v));
    }

    /**
     * Actor that finishes the wizard with an error (see {@link WizardDone}).
     *
     * @typeParam E - Error type.
     * @param e - The error.
     */
    protected $err<E = unknown>(e: E): WizardDone<OUTPUT, E> {
        return new WizardDone(this.wizard, new Err(e));
    }

    /** Actor that cancels the wizard; the result callback receives `undefined` (see {@link WizardDone}). */
    protected $cancel(): WizardDone<OUTPUT, unknown> {
        return new WizardDone(this.wizard, undefined);
    }

    /** Actor that returns to the previous stage, or cancels on the first stage of an attached wizard (see {@link Prev}). */
    protected $back(): Prev<CONTEXT> {
        return new Prev(this);
    }

    /**
     * Actor that moves to this stage, keeping the current one for `$back()` (see {@link WizardNext}). Call it on the target
     * stage, from a stage of the same wizard.
     *
     * @param ctx - Context for this stage.
     */
    $next(ctx: CONTEXT): WizardNext<CONTEXT, OUTPUT, WIZARD> {
        return new WizardNext(this, ctx);
    }

    /**
     * Actor that moves to this stage, replacing the current one (see {@link WizardNextReplace}). Call it on the target stage.
     *
     * @param ctx - Context for this stage.
     */
    $nextReplace(ctx: CONTEXT): WizardNextReplace<CONTEXT, OUTPUT, WIZARD> {
        return new WizardNextReplace(this, ctx);
    }

    /** Actor that ends the whole app instance (see {@link Destroy}). */
    protected $destroy(): Destroy {
        return new Destroy(this.wizard.page.app);
    }
}
