import { Err, Ok, Result } from '@araminix/lib';

import { AcquireAgent, AgentList, AgentTask, Data } from '../executor/proto.js';
import agentWorkerDriver from './agentWorkerDriver.js';

export enum AgentErrorType {
    Communication = 'Communication',
    Execution = 'Execution',
}

abstract class AgentError {
    abstract readonly type: AgentErrorType;
}

export class ExecutionAgentError<E = unknown> extends AgentError {
    readonly e: E;
    readonly type = AgentErrorType.Execution;

    constructor(e: E) {
        super();
        this.e = e;
    }
}

export class CommunicationAgentError extends AgentError {
    readonly type = AgentErrorType.Communication;

    constructor() {
        super();
    }
}

export abstract class Agent<INDEX extends AgentIndex = AgentIndex> {
    protected readonly index: INDEX;
    readonly id: string;

    constructor(index: INDEX, id: string) {
        this.index = index;
        this.id = id;
    }

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

    abstract onPost<TData = unknown, R = unknown, E = unknown>(name: string, data: TData): Promise<Result<R, E>>;
}

export class AgentFactory<INDEX extends AgentIndex = AgentIndex, AGENT extends Agent<INDEX> = Agent<INDEX>> {
    private readonly index: INDEX;
    readonly _agentClass: new (index: INDEX, id: string) => AGENT;
    name: string = '';

    constructor(index: INDEX, _agentClass: new (index: INDEX, id: string) => AGENT) {
        this.index = index;
        this._agentClass = _agentClass;
    }

    async acquire(id: string): Promise<Result<AGENT, void>> {
        const result = await agentWorkerDriver().request(new AcquireAgent(this.name, id));
        if (result.isErr()) {
            return new Err(undefined);
        }
        const agent = new this._agentClass(this.index, id);
        return new Ok(agent);
    }

    async list(): Promise<Result<Array<string>, void>> {
        const result = await agentWorkerDriver().request<AgentList, Data<string[]>>(new AgentList(this.name));
        if (result.isErr()) {
            return new Err(undefined);
        }
        return new Ok((result.unwrap() as Data<string[]>).data);
    }
}

export abstract class AgentIndex {
    private _agentTypeList?: Array<[string, AgentFactory<any, any>]> = undefined;

    get agentTypeList(): Array<[string, AgentFactory<any, any>]> {
        if (!this._agentTypeList) {
            this._agentTypeList = this.getTypeList();
        }
        return this._agentTypeList;
    }

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
