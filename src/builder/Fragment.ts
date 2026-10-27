import { uuid } from '@araminix/lib';

import type { ActivityDriver } from '../executor/ActivityInstance.js';
import type { AppResult } from '../executor/AppInstance.js';
import { Actor, Nothing, ReloadFragment, UpdateFragment, UpdateTypes } from '../lib/actors.js';
import { typeNameOf } from '../lib/worker_socket.js';
import type { BuildedPart, OnAction, Part, Response } from './builder.js';
import builder from './builder.js';

/**
 * Runtime view of a {@link Fragment}: what the activity needs to route actions, queries, reloads and cleanup to it.
 * Created by the fragment's constructor; not used by application code.
 */
export class FragmentInterface implements Part {
    /** Component type sent to the client (see {@link typeNameOf}). */
    readonly type: string;
    /** Fragment id. */
    readonly id: string;
    /** Style names from the fragment input. */
    readonly styles: Array<string> | undefined;
    /** Registered action handlers by name. */
    readonly actions: Map<string, OnAction<any>>;
    /** Registered query handlers by name. */
    readonly queries: Map<string, Response<any, any>>;
    /** Runs the fragment's load cycle (previous cleanup, `load()`, `afterLoad()`) and returns the data. */
    readonly load: () => Promise<unknown>;
    /** Runs the cleanup returned by the last `afterLoad()`. */
    readonly cleanUp: () => void;

    /**
     * @param type - Component type.
     * @param id - Fragment id.
     * @param styles - Style names.
     * @param actions - Action handlers (live map).
     * @param queries - Query handlers (live map).
     * @param load - Load cycle.
     * @param cleanUp - Cleanup.
     */
    constructor(
        type: string,
        id: string,
        styles: Array<string> | undefined,
        actions: Map<string, OnAction<any>>,
        queries: Map<string, Response<any, any>>,
        load: () => Promise<unknown>,
        cleanUp: () => void,
    ) {
        this.type = type;
        this.id = id;
        this.styles = styles;
        this.actions = actions;
        this.queries = queries;
        this.load = load;
        this.cleanUp = cleanUp;
    }

    /** Serialises the fragment as `{ id, type, styles }`. */
    _build(): BuildedPart {
        return {
            id: this.id,
            type: this.type,
            styles: this.styles,
        };
    }
}

/**
 * A UI component of an activity: the server half of a front-end component.
 *
 * Create fragments with `new` inside an activity's `render()` (directly or inside {@link panel}); the constructor
 * registers the fragment in the current panel. The client finds the component by the fragment's type name (`static
 * typeName`, or the class name) and talks to it through the fragment `id`:
 *
 * - **actions** ({@link Fragment.onAction}) handle client events and return an {@link Actor};
 * - **queries** ({@link Fragment.onQuery}) answer client questions with data;
 * - **updates** (`$update`, `$patch`, `$reload`) push data to the component on the stream `update-<id>`.
 *
 * {@link Fragment.load} produces the component's data. The runtime does not call it during `render()`; it runs when the
 * fragment applies `$reload()`, so let the component ask for it (for example with a `load` action, as below) or trigger it
 * from the page.
 *
 * @typeParam I - Constructor input; may carry `styles` (style names sent with the build).
 * @typeParam O - Type of the data returned by {@link Fragment.load}.
 *
 * @remarks
 * Declare `static typeName` when the server code is bundled or minified; otherwise the client receives the mangled class
 * name. Constructing a fragment outside of a render throws a `TypeError`.
 *
 * @example
 * ```ts
 * import { Fragment } from '@araminix/platform';
 *
 * type CounterInput = { label: string; styles?: string[] };
 * type CounterData = { label: string; count: number };
 *
 * export class Counter extends Fragment<CounterInput, CounterData> {
 *     static readonly typeName = 'Counter';
 *     private count = 0;
 *
 *     constructor(input: CounterInput) {
 *         super(input);
 *         this.onAction('load', () => this.$reload()); // sent by the component when it mounts
 *         this.onAction('increment', () => {
 *             this.count++;
 *             return this.$patch({ count: this.count });
 *         });
 *         this.onQuery<{ step: number }, number>('preview', ({ step }) => this.count + step);
 *     }
 *
 *     load(): CounterData {
 *         return { label: this.input.label, count: this.count };
 *     }
 * }
 * ```
 */
export default abstract class Fragment<I extends { styles?: Array<string> | undefined }, O = unknown> {
    /** Component type name sent to the client; declare it to survive minification (see {@link typeNameOf}). */
    static readonly typeName?: string;
    /** The constructor input. */
    readonly input: I;
    /** Random UUID of this fragment instance; the client addresses actions, queries and updates with it. */
    readonly id: string;
    /** Action handlers by name. */
    private actions: Map<string, OnAction<any>> = new Map();
    /** Query handlers by name. */
    private queries: Map<string, Response<any, any>> = new Map();
    /** Driver of the activity that rendered the fragment. */
    private driver: ActivityDriver;
    /** Cleanup returned by the last `afterLoad()`. */
    private cleanUp?: (() => void) | void = undefined;

    /**
     * Registers the fragment in the panel that is currently rendering.
     *
     * @param input - Fragment input; `input.styles` is sent with the build.
     * @throws TypeError when called outside of an activity's `render()`.
     */
    constructor(input: I) {
        this.input = input;
        this.id = uuid();
        this.driver = builder.addFragment(
            new FragmentInterface(
                // The frontend picks its component by this name; declare `static typeName` if the server code is minified.
                typeNameOf(this.constructor as typeof Fragment),
                this.id,
                this.input.styles,
                this.actions,
                this.queries,
                () => this._load(),
                () => this._cleanUp(),
            ),
        );
    }

    /**
     * Sends data on the instance's `push` stream (same as {@link Activity.push}; not addressed to this fragment).
     *
     * @typeParam TData - Data type.
     * @param data - The data.
     * @returns `Ok` once the client accepted and closed the stream, `Err(AppError.Other)` otherwise.
     */
    async push<TData = unknown>(data: TData): Promise<AppResult> {
        return await this.driver.push(data);
    }

    /**
     * Applies an actor in the context of the activity that rendered this fragment, under the app lock (same as
     * {@link Activity.trigger}). Use it from timers and callbacks, e.g. `this.trigger(this.$update(data))`.
     *
     * @param actor - The actor.
     * @returns The actor's result.
     */
    async trigger(actor: Actor): Promise<AppResult> {
        return await this.driver.trigger(actor);
    }

    /**
     * Registers the handler of the client action `name` (replacing an earlier one). The client sends actions on the instance
     * socket's `action` stream as `{ fragmentId, name, data }`; the returned actor is applied to the activity, and the client
     * receives the serialised `Ok`/`Err` result.
     *
     * @typeParam TActionData - Type of the action data. It is not validated: check it if the client is not trusted.
     * @param name - Action name.
     * @param on - Handler returning an {@link Actor}.
     */
    protected onAction<TActionData = unknown>(name: string, on: OnAction<TActionData>): void {
        this.actions.set(name, on);
    }

    /**
     * Registers the handler of the client query `name` (replacing an earlier one). Queries arrive on the `query` stream as
     * `{ fragmentId, name, data }`; the returned value is sent back as `Ok(value)`. Use queries for look-ups such as
     * autocomplete; they do not apply actors.
     *
     * @typeParam TQueryData - Type of the query data (not validated).
     * @typeParam TQueryResponse - Type of the answer; must be cloneable and JSON-serialisable.
     * @param name - Query name.
     * @param on - Handler returning the answer.
     */
    protected onQuery<TQueryData = unknown, TQueryResponse = unknown>(name: string, on: Response<TQueryData, TQueryResponse>): void {
        this.queries.set(name, on);
    }

    /** Removes all action handlers. */
    protected resetActions(): void {
        this.actions.clear();
    }

    /** Removes all query handlers. */
    protected resetRequests(): void {
        this.queries.clear();
    }

    /** Runs the previous `afterLoad()` cleanup, then `load()`, then `afterLoad()`. */
    private async _load(): Promise<O> {
        if (this.cleanUp) {
            this.cleanUp();
        }
        const result = await this.load();
        this.cleanUp = this.afterLoad();
        return result;
    }

    /** Runs and forgets the `afterLoad()` cleanup. */
    private _cleanUp(): void {
        if (this.cleanUp) {
            this.cleanUp();
            this.cleanUp = undefined;
        }
    }

    /** Actor that runs {@link Fragment.load} again and sends the result as a full update (see {@link ReloadFragment}). */
    protected $reload(): ReloadFragment {
        return new ReloadFragment(this.id);
    }

    /**
     * Actor that sends `data` to the component as a full replacement (see {@link UpdateFragment}).
     *
     * @typeParam TData - Data type.
     * @param data - The new data.
     */
    protected $update<TData = unknown>(data: TData): UpdateFragment<TData> {
        return new UpdateFragment(this.id, UpdateTypes.Full, data);
    }

    /**
     * Actor that sends `data` to the component as a partial change (see {@link UpdateFragment}).
     *
     * @typeParam TData - Data type.
     * @param data - The changed fields.
     */
    protected $patch<TData = unknown>(data: TData): UpdateFragment<TData> {
        return new UpdateFragment(this.id, UpdateTypes.Patch, data);
    }

    /** Actor that changes nothing (see {@link Nothing}). */
    protected $nothing(): Nothing {
        return new Nothing();
    }

    /**
     * Produces the component's data. Runs whenever the fragment applies {@link Fragment.$reload}; the result is sent as a full
     * update.
     *
     * @returns The data (cloneable and JSON-serialisable).
     */
    abstract load(): Promise<O> | O;
    /**
     * Called after every {@link Fragment.load}. Start fragment-level timers or subscriptions here and return a cleanup; the
     * cleanup runs before the next load and when the activity is suspended, reloaded or closed.
     *
     * @returns An optional cleanup function.
     */
    protected afterLoad(): (() => void) | void {}
}
