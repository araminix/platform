import { Err, Ok, Result } from '@araminix/lib';

import { AgentIndex } from '../agent/d.js';
import { I18nService } from '../utils/i18n.js';
import { App } from './App.js';

/** One app in the list a user receives on the `listApps` stream (see {@link AppIndex.userApps}). */
export type AppEntry = {
    /** App name: the property name of the app on the {@link AppIndex}. Pass it to `createInstance`. */
    name: string;
    /** Title for this user, as returned by {@link AppIndex._getUserApps} (not {@link App.title}). */
    title: string;
    /** {@link App.category}. */
    category: string;
    /** {@link App.hidden}. */
    hidden: boolean;
    /** {@link App.widget}. */
    widget: boolean;
    /** {@link App.multiInstance}. */
    multiInstance: boolean;
    /** {@link App.description}. */
    description: string;
    /** Profiles the user may launch the app with (duplicates removed); `null` stands for "no profile". */
    profiles: Array<string | null>;
};

/** Apps of one category, as sent on the `listApps` stream. */
export type AppListing = {
    /** Category name. */
    category: string;
    /** Apps in this category, in declaration order. */
    apps: Array<AppEntry>;
};

/**
 * Root of your application: declares every app and the agent index. The module at {@link PlatformConfig.appIndexPath}
 * must `export default` a subclass with a no-argument constructor.
 *
 * Every own property that holds an {@link App} with a `main` page is an app; the property name becomes {@link App.name}.
 * {@link AppIndex._getUserApps} decides which of them a user may launch, with which title and profiles.
 *
 * @typeParam AGENT_INDEX - Your {@link AgentIndex} subclass.
 *
 * @remarks
 * The class is instantiated once in the main thread (for app listings) and once in every app worker thread, so keep the
 * constructor cheap and free of side effects, and do not rely on state shared between threads.
 *
 * @example
 * ```ts
 * import { AppIndex, Ok } from '@araminix/platform';
 *
 * export default class MyApps extends AppIndex<MyAgents> {
 *     agents = new MyAgents();
 *     tasks = new TasksApp(this); // app name "tasks"
 *     reports = new ReportsApp(this); // app name "reports"
 *
 *     protected async _getUserApps(userId: string) {
 *         const rows = await db.appsOfUser(userId); // e.g. [{ name: 'tasks', title: 'Tasks', profiles: [null] }]
 *         return new Ok(rows);
 *     }
 * }
 * ```
 */
export abstract class AppIndex<AGENT_INDEX extends AgentIndex = AgentIndex> {
    /** Translation service for your apps. Declared for convenience; the platform never assigns it. */
    protected i18n!: I18nService<any, any>;
    /** Your agent index; apps reach agents through `this.index.agents.<type>` (see {@link AgentFactory.acquire}). */
    abstract agents: AGENT_INDEX;
    /** Cached result of {@link AppIndex.appList}. */
    private _appList?: Array<{ appName: string; app: App<any, any> }> = undefined;

    /** Subclasses must keep a no-argument constructor: the platform creates the index with `new YourIndex()`. */
    constructor() {}

    /**
     * Returns the apps `userId` may launch: the app `name` (property name on this index), the `title` to show and the
     * allowed `profiles` (use `[null]` for an app without profiles). Entries without a matching declared app are ignored.
     *
     * Called in the main thread for every `listApps` and `createInstance` request, so cache it if it is expensive.
     *
     * @param userId - {@link ClientInfo.id} of the user.
     * @returns The allowed apps, or an `Err` (the request then fails).
     */
    protected abstract _getUserApps(userId: string): Promise<Result<Array<{ name: string; profiles: Array<string | null>; title: string }>, unknown>>;

    /**
     * Declared apps (own properties that hold an {@link App} with a `main` page), discovered on first access. Discovery also
     * sets {@link App.name} and the {@link AgentFactory.name}s of {@link AppIndex.agents}.
     */
    get appList(): Array<{ appName: string; app: App<any, any> }> {
        if (!this._appList) {
            if (this.agents) {
                this.agents.agentTypeList; // init agent names
            }
            this._appList = this.getAppsList();
        }
        return this._appList;
    }

    /** Scans the own properties for apps. */
    private getAppsList(): Array<{ appName: string; app: App<any, any> }> {
        const arr: Array<{ appName: string; app: App<any, any> }> = [];
        for (const key of Object.getOwnPropertyNames(this)) {
            const prop = (this as any)[key];
            if (!(prop instanceof App)) {
                continue;
            }
            if (prop.main === undefined) {
                continue;
            }
            const name = key;
            const app = prop;
            app.name = name;
            arr.push({ appName: name, app });
        }
        return arr;
    }

    /**
     * Builds the app listing of a user: the declared apps that {@link AppIndex._getUserApps} allows, grouped by
     * {@link App.category} (categories in order of first appearance).
     *
     * @typeParam TErr - Error type of `_getUserApps`.
     * @param userId - {@link ClientInfo.id} of the user.
     * @returns The listing, or the error of `_getUserApps`.
     */
    async userApps<TErr = unknown>(userId: string): Promise<Result<Array<AppListing>, TErr>> {
        const result = await this._getUserApps(userId);
        if (result.isErr()) {
            return new Err(result.e as TErr);
        }
        const userApps = result.unwrap();
        const listing: AppEntry[] = [];
        for (const entry of this.appList) {
            const name = entry.appName;
            const app = entry.app;
            const userApp = userApps.find((a) => a.name === name);
            if (userApp) {
                listing.push({
                    name,
                    title: userApp.title,
                    category: app.category,
                    hidden: app.hidden,
                    widget: app.widget,
                    multiInstance: app.multiInstance,
                    description: app.description,
                    profiles: [...new Set(userApp.profiles)],
                });
            }
        }

        const byCategory = listing.reduce<Record<string, AppListing>>((acc, item) => {
            if (!acc[item.category]) {
                acc[item.category] = { category: item.category, apps: [] };
            }
            const appDesc: AppEntry = {
                name: item.name,
                title: item.title,
                hidden: item.hidden,
                widget: item.widget,
                multiInstance: item.multiInstance,
                category: item.category,
                profiles: item.profiles,
                description: item.description,
            };
            acc[item.category].apps.push(appDesc);
            return acc;
        }, {});

        return new Ok(Object.values(byCategory));
    }
}
