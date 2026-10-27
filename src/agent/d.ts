import { Err, Ok, Result } from '@araminix/lib';

import { AcquireAgent, AgentList, AgentTask, Data } from '../executor/proto.js';
import agentWorkerDriver from './agentWorkerDriver.js';

/** Discriminant of the errors returned by {@link Agent.task}. */
export enum AgentErrorType {
    /** The task got no usable answer (see {@link CommunicationAgentError}). */
    Communication = 'Communication',
    /** The agent answered with an error (see {@link ExecutionAgentError}). */
    Execution = 'Execution',
}

/** Base of the errors returned by {@link Agent.task}; switch on `type`. */
abstract class AgentError {
    /** Error kind. */
    abstract readonly type: AgentErrorType;
}

/**
 * The agent process received the task and answered with `Err(e)`.
 *
 * @typeParam E - Type of the agent's error payload.
 */
export class ExecutionAgentError<E = unknown> extends AgentError {
    /** The error sent by the agent process. */
    readonly e: E;
    /** Always {@link AgentErrorType.Execution}. */
    readonly type = AgentErrorType.Execution;

    /** @param e - The error sent by the agent process. */
    constructor(e: E) {
        super();
        this.e = e;
    }
}

/**
 * The task got no usable answer: the agent is not connected, the task stream could not be opened, no reply arrived within
 * 60 seconds, or the reply was not a serialised `Result`.
 */
export class CommunicationAgentError extends AgentError {
    /** Always {@link AgentErrorType.Communication}. */
    readonly type = AgentErrorType.Communication;

    constructor() {
        super();
    }
}

/**
 * Server-side representative of an external agent process (a device, a service, a script) that connects to the `agent`
 * endpoint with an {@link AgentInfo} identity.
 *
 * An agent class plays two roles:
 * - In the agent's own worker thread (one per connected agent id) the platform creates one instance and calls
 *   {@link Agent.onPost} for every message the agent process posts.
 * - In app worker threads (and other agent workers) {@link AgentFactory.acquire} returns an instance bound to an agent id;
 *   its public methods send commands to the agent process with the protected {@link Agent.task}.
 *
 * Subclasses must keep the `(index, id)` constructor signature.
 *
 * @typeParam INDEX - Your {@link AgentIndex} subclass.
 *
 * @example
 * ```ts
 * import { Agent, Err, Ok, Result } from '@araminix/platform';
 *
 * export class Printer extends Agent<MyAgents> {
 *     // Called from apps: this.app.index.agents.printer.acquire('printer-1') -> printer.print('hello')
 *     async print(text: string) {
 *         return this.task<{ text: string }, number>('print', { text }); // Result<number, AgentError>
 *     }
 *
 *     // Messages from the printer process: agentClient.post('status', { paper: 'low' })
 *     async onPost<TData = unknown, R = unknown, E = unknown>(name: string, data: TData): Promise<Result<R, E>> {
 *         if (name === 'status') {
 *             await saveStatus(this.id, data);
 *             return new Ok(true as R);
 *         }
 *         return new Err(`Unknown post ${name}` as E);
 *     }
 * }
 * ```
 */
export abstract class Agent<INDEX extends AgentIndex = AgentIndex> {
    /** The agent index of the current thread (gives access to other agent types). */
    protected readonly index: INDEX;
    /** Id of the agent this object talks to ({@link AgentInfo.id}). */
    readonly id: string;

    /**
     * @param index - The agent index of the current thread.
     * @param id - Agent id.
     */
    constructor(index: INDEX, id: string) {
        this.index = index;
        this.id = id;
    }

    /**
     * Sends a task to the agent process and waits for its answer.
     *
     * The platform opens a stream named `name` with `data` as its arguments on the agent's connection; the agent process
     * answers with a serialised `Result` (`AgentClient.onTask` in `@araminix/lib` does this). Tasks of one thread are sent one
     * at a time. Works only inside app and agent worker threads.
     *
     * @typeParam TData - Type of the task data (cloneable and JSON-serialisable).
     * @typeParam R - Type of the agent's success value.
     * @typeParam E - Type of the agent's error value (carried by {@link ExecutionAgentError}).
     * @param name - Task name, i.e. the stream name the agent process listens on.
     * @param data - Task data.
     * @returns `Ok(value)`, `Err(ExecutionAgentError)` when the agent answered with an error, or
     *     `Err(CommunicationAgentError)` when there was no usable answer within 60 seconds.
     */
    protected async task<TData = unknown, R = unknown, E = unknown>(name: string, data: TData): Promise<Result<R, AgentError>> {
        const result = await agentWorkerDriver().request<AgentTask<TData>, Data<Result<R, E>>>(new AgentTask(this.id, name, data));
        if (result.isErr()) {
            return new Err(new CommunicationAgentError());
        }
        const response = (result.unwrap() as Data<any>).data;
        if (response.ok === false) {
            return new Err(new ExecutionAgentError(response.e));
        }
        return new Ok(response.v as R);
    }

    /**
     * Handles a message posted by the agent process (`AgentClient.post(name, data)` on its side). Runs in the agent's worker
     * thread; the returned `Result` is serialised and sent back as the answer. A thrown error is answered with
     * `Err(error.message)` and the worker keeps running.
     *
     * @typeParam TData - Type of the posted data (not validated).
     * @typeParam R - Type of the success value.
     * @typeParam E - Type of the error value.
     * @param name - Message name chosen by the agent process.
     * @param data - Posted data.
     * @returns The answer for the agent process.
     */
    abstract onPost<TData = unknown, R = unknown, E = unknown>(name: string, data: TData): Promise<Result<R, E>>;
}

/**
 * Declares one agent type on an {@link AgentIndex} and gives apps access to the connected agents of that type. The name
 * of the property that holds the factory is the agent type ({@link AgentInfo.agentType}).
 *
 * @typeParam INDEX - Your {@link AgentIndex} subclass.
 * @typeParam AGENT - The {@link Agent} subclass.
 *
 * @remarks
 * Pass the type arguments explicitly when creating the factory inside the index (`this` would otherwise be inferred as
 * the polymorphic `this` type and the agent class would not type-check).
 *
 * @example
 * ```ts
 * import { AgentFactory, AgentIndex } from '@araminix/platform';
 *
 * export default class MyAgents extends AgentIndex {
 *     printer = new AgentFactory<MyAgents, Printer>(this, Printer); // agent type "printer"
 * }
 *
 * // In a page (app worker thread):
 * const printer = await this.app.index.agents.printer.acquire('printer-1');
 * if (printer.isOk()) await printer.unwrap().print('hello');
 * ```
 */
export class AgentFactory<INDEX extends AgentIndex = AgentIndex, AGENT extends Agent<INDEX> = Agent<INDEX>> {
    /** The agent index that declares the factory. */
    private readonly index: INDEX;
    /** The agent class; the agent worker instantiates it for a connected agent. */
    readonly _agentClass: new (index: INDEX, id: string) => AGENT;
    /** Agent type name, set to the property name when the index discovers its factories; `''` before that. */
    name: string = '';

    /**
     * @param index - The agent index that declares the factory (pass `this`).
     * @param _agentClass - The agent class.
     */
    constructor(index: INDEX, _agentClass: new (index: INDEX, id: string) => AGENT) {
        this.index = index;
        this._agentClass = _agentClass;
    }

    /**
     * Returns an agent object bound to `id` if an agent with that id and this type is currently connected. Works only inside
     * app and agent worker threads.
     *
     * @param id - Agent id.
     * @returns `Ok(agent)`, or `Err(undefined)` when no such agent is connected.
     */
    async acquire(id: string): Promise<Result<AGENT, void>> {
        const result = await agentWorkerDriver().request(new AcquireAgent(this.name, id));
        if (result.isErr()) {
            return new Err(undefined);
        }
        const agent = new this._agentClass(this.index, id);
        return new Ok(agent);
    }

    /**
     * Lists the ids of the connected agents of this type. Works only inside app and agent worker threads.
     *
     * @returns The ids, or `Err(undefined)` when the main thread could not be asked.
     */
    async list(): Promise<Result<Array<string>, void>> {
        const result = await agentWorkerDriver().request<AgentList, Data<string[]>>(new AgentList(this.name));
        if (result.isErr()) {
            return new Err(undefined);
        }
        return new Ok((result.unwrap() as Data<string[]>).data);
    }
}

/**
 * Declares every agent type of your application. Each own property holding an {@link AgentFactory} is a type; the
 * property name is the type name.
 *
 * The module at {@link PlatformConfig.agentIndexPath} must `export default` a subclass with a no-argument constructor; it
 * is loaded in every agent worker thread. Assign an instance to {@link AppIndex.agents} too, so that apps can reach the
 * agents.
 *
 * @example
 * ```ts
 * import { AgentFactory, AgentIndex } from '@araminix/platform';
 *
 * export default class MyAgents extends AgentIndex {
 *     printer = new AgentFactory<MyAgents, Printer>(this, Printer);
 *     scale = new AgentFactory<MyAgents, Scale>(this, Scale);
 * }
 * ```
 */
export abstract class AgentIndex {
    /** Cached result of {@link AgentIndex.agentTypeList}. */
    private _agentTypeList?: Array<[string, AgentFactory<any, any>]> = undefined;

    /** `[name, factory]` pairs of the declared agent types, discovered on first access (this also sets each factory's name). */
    get agentTypeList(): Array<[string, AgentFactory<any, any>]> {
        if (!this._agentTypeList) {
            this._agentTypeList = this.getTypeList();
        }
        return this._agentTypeList;
    }

    /** Scans the own properties for factories. */
    private getTypeList(): Array<[string, AgentFactory<any, any>]> {
        const arr: Array<[string, AgentFactory<any, any>]> = [];
        for (const key of Object.getOwnPropertyNames(this)) {
            const prop = (this as any)[key];
            if (!(prop instanceof AgentFactory)) {
                continue;
            }
            const name = key;
            const agent = prop;
            agent.name = name;
            arr.push([name, agent]);
        }
        return arr;
    }
}
