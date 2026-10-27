import { uuid } from '@araminix/lib';

import type { ActivityDriver } from '../executor/ActivityInstance.js';
import type { AppResult } from '../executor/AppInstance.js';
import { Actor, Nothing, ReloadFragment, UpdateFragment, UpdateTypes } from '../lib/actors.js';
import { typeNameOf } from '../lib/worker_socket.js';
import type { BuildedPart, OnAction, Part, Response } from './builder.js';
import builder from './builder.js';

export class FragmentInterface implements Part {
    readonly type: string;
    readonly id: string;
    readonly styles: Array<string> | undefined;
    readonly actions: Map<string, OnAction<any>>;
    readonly queries: Map<string, Response<any, any>>;
    readonly load: () => Promise<unknown>;
    readonly cleanUp: () => void;

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

    _build(): BuildedPart {
        return {
            id: this.id,
            type: this.type,
            styles: this.styles,
        };
    }
}

export default abstract class Fragment<I extends { styles?: Array<string> | undefined }, O = unknown> {
    static readonly typeName?: string;
    readonly input: I;
    readonly id: string;
    private actions: Map<string, OnAction<any>> = new Map();
    private queries: Map<string, Response<any, any>> = new Map();
    private driver: ActivityDriver;
    private cleanUp?: (() => void) | void = undefined;

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

    async push<TData = unknown>(data: TData): Promise<AppResult> {
        return await this.driver.push(data);
    }

    async trigger(actor: Actor): Promise<AppResult> {
        return await this.driver.trigger(actor);
    }

    protected onAction<TActionData = unknown>(name: string, on: OnAction<TActionData>): void {
        this.actions.set(name, on);
    }

    protected onQuery<TQueryData = unknown, TQueryResponse = unknown>(name: string, on: Response<TQueryData, TQueryResponse>): void {
        this.queries.set(name, on);
    }

    protected resetActions(): void {
        this.actions.clear();
    }

    protected resetRequests(): void {
        this.queries.clear();
    }

    private async _load(): Promise<O> {
        if (this.cleanUp) {
            this.cleanUp();
        }
        const result = await this.load();
        this.cleanUp = this.afterLoad();
        return result;
    }

    private _cleanUp(): void {
        if (this.cleanUp) {
            this.cleanUp();
            this.cleanUp = undefined;
        }
    }

    protected $reload(): ReloadFragment {
        return new ReloadFragment(this.id);
    }

    protected $update<TData = unknown>(data: TData): UpdateFragment<TData> {
        return new UpdateFragment(this.id, UpdateTypes.Full, data);
    }

    protected $patch<TData = unknown>(data: TData): UpdateFragment<TData> {
        return new UpdateFragment(this.id, UpdateTypes.Patch, data);
    }

    protected $nothing(): Nothing {
        return new Nothing();
    }

    abstract load(): Promise<O> | O;
    protected afterLoad(): (() => void) | void {}
}
