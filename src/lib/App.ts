import { Result } from '@araminix/lib';

import workerDriver from '../executor/workerDriver.js';
import type { AppIndex } from './AppIndex.js';
import type { MainPage } from './Page.js';
import type { SetupWizard } from './Wizard.js';

/**
 * One application: its metadata, its pages and its entry page {@link App.main}.
 *
 * Declare pages and wizards as properties so that other pages can reach them through `this.app`; each property holds a
 * template, and every time a page is opened the runtime creates a fresh instance of it. An instance of the app runs in
 * its own worker thread per user launch.
 *
 * @typeParam SETTINGS - Type of the per-user settings returned by {@link App.getSettings}.
 * @typeParam APP_INDEX - Your {@link AppIndex} subclass.
 *
 * @example
 * ```ts
 * import { App, Ok, Result } from '@araminix/platform';
 *
 * export class TasksApp extends App<void, MyApps> {
 *     readonly title = 'Tasks';
 *     category = 'Productivity';
 *     description = 'Track your tasks';
 *     main = new HomePage(this);
 *     task = new TaskPage(this); // opened with this.app.task.$open({ id })
 *     setupWizard = undefined;
 *
 *     protected async _getSettings(userId: string, profile: string | null): Promise<Result<void, unknown>> {
 *         return new Ok(undefined);
 *     }
 *
 *     protected async _getUnits(userId: string): Promise<Result<string[], unknown>> {
 *         return new Ok([]);
 *     }
 * }
 * ```
 */
export abstract class App<SETTINGS = unknown, APP_INDEX extends AppIndex<any> = AppIndex<any>> {
    /** The app index that declares this app (gives access to other apps and to `index.agents`). */
    readonly index: APP_INDEX;
    /** App name, set to the property name on the {@link AppIndex} when the index discovers its apps; `''` before that. */
    name: string = '';
    /**
     * App title, or an async function returning it. It becomes the instance's `appTitle` (see {@link UserInstance}); app
     * listings use the per-user title from {@link AppIndex._getUserApps} instead.
     */
    abstract readonly title: string | (() => Promise<string>);
    /**
     * Short description shown in app listings.
     *
     * @defaultValue `''`
     */
    description: string = '';
    /**
     * Category used to group app listings.
     *
     * @defaultValue `'Other'`
     */
    category: string = 'Other';
    /**
     * Hint for the front-end to hide the app from menus. The platform still lets the user launch it.
     *
     * @defaultValue `false`
     */
    hidden: boolean = false;
    /**
     * Hint for the front-end that the app can be shown as a dashboard widget.
     *
     * @defaultValue `false`
     */
    widget: boolean = false;
    /**
     * Hint for the front-end that the app may be opened several times at once. Not enforced by the platform.
     *
     * @defaultValue `false`
     */
    multiInstance: boolean = false;
    /** Entry page, opened when an instance starts. Apps whose `main` is `undefined` are ignored by the index. */
    abstract main: MainPage<any, App<SETTINGS, APP_INDEX>> | void;
    /**
     * Optional wizard that edits the app's settings. The runtime does not start it; open it yourself, e.g.
     * `this.app.setupWizard.$detached(currentSettings, onDone)`. Set it to `undefined` when not needed.
     */
    abstract setupWizard: SetupWizard<SETTINGS, App<SETTINGS, APP_INDEX>> | void;

    /** @param index - The app index that declares the app (pass `this` from the index). */
    constructor(index: APP_INDEX) {
        this.index = index;
    }

    /**
     * Profile the current instance was launched with, when this app is the launched app; otherwise `null`. Only meaningful
     * inside the app's worker thread.
     */
    protected get profile(): string | null {
        const launchedApp = workerDriver()?.appName;
        const profile = workerDriver()?.profile;
        if (launchedApp !== this.name) {
            return null;
        }
        return profile;
    }

    /**
     * Routing hook for subclasses; the default returns `[this.main, undefined]`. Not called by the platform runtime.
     *
     * @param _action - Action name.
     * @param _args - Action arguments.
     */
    dispatch(_action: string, _args: unknown): (void | MainPage<any, App<SETTINGS, APP_INDEX>>)[] {
        return [this.main, undefined];
    }

    /**
     * Loads the settings of the current user and profile through {@link App._getSettings}. Call it from pages and stages
     * (inside the app worker thread).
     *
     * @typeParam TErr - Error type.
     * @returns The settings, or the error of `_getSettings`.
     */
    async getSettings<TErr = unknown>(): Promise<Result<SETTINGS, TErr>> {
        return (await this._getSettings(workerDriver().userId, this.profile)) as Result<SETTINGS, TErr>;
    }

    /**
     * Reads the settings of a user for a profile from your storage.
     *
     * @param userId - Id of the user.
     * @param profile - Profile of the instance, or `null`.
     */
    protected abstract _getSettings(userId: string, profile: string | null): Promise<Result<SETTINGS, unknown>>;

    /**
     * Loads the units of the current user through {@link App._getUnits} (inside the app worker thread).
     *
     * @typeParam TErr - Error type.
     * @returns The unit keys, or the error of `_getUnits`.
     */
    async getUnits<TErr = unknown>(): Promise<Result<string[], TErr>> {
        return (await this._getUnits(workerDriver().userId)) as Result<string[], TErr>;
    }

    /**
     * Reads the organizational units of a user from your storage.
     *
     * @param userId - Id of the user.
     */
    protected abstract _getUnits(userId: string): Promise<Result<string[], unknown>>;
}
