import { MessagePort } from 'worker_threads';

import type { BuildedPart } from '../builder/builder.js';
import { UpdateTypes } from '../lib/actors.js';
import { Rej, Req, Res, typeNameOf } from '../lib/worker_socket.js';

export interface Build {
    isPop: boolean;
    hasPrev: boolean;
    activityId: string;
    build: BuildedPart;
}

export class AcquireAgent extends Req {
    static readonly typeName = 'AcquireAgent';
    type: string;
    readonly agentId: string;

    constructor(type: string, agentId: string) {
        super();
        this.type = type;
        this.agentId = agentId;
    }
}

export class AgentTask<TData = unknown> extends Req {
    static readonly typeName = 'AgentTask';
    id: string;
    readonly name: string;
    readonly data: TData;
    hp: number;

    constructor(id: string, name: string, data: TData, hp: number = 60) {
        super();
        this.id = id;
        this.name = name;
        this.data = data;
        this.hp = hp;
    }
}

export class AgentPost<TData = unknown> extends Req {
    static readonly typeName = 'AgentPost';
    readonly name: string;
    readonly data: TData;

    constructor(name: string, data: TData) {
        super();
        this.name = name;
        this.data = data;
    }
}

export class AgentList extends Req {
    static readonly typeName = 'AgentList';
    type: string;

    constructor(type: string) {
        super();
        this.type = type;
    }
}

export class SendBuild extends Req {
    static readonly typeName = 'SendBuild';
    readonly data: Build;

    constructor(data: Build) {
        super();
        this.data = data;
    }
}

export class SendPush<TData = unknown> extends Req {
    static readonly typeName = 'SendPush';
    readonly data: TData;

    constructor(data: TData) {
        super();
        this.data = data;
    }
}

export interface Update<TData = unknown> {
    activityId: string;
    fragmentId: string;
    type: UpdateTypes;
    data: TData;
}

export class SendUpdate<TData = unknown> extends Req {
    static readonly typeName = 'SendUpdate';
    readonly data: Update<TData>;

    constructor(data: Update<TData>) {
        super();
        this.data = data;
    }
}

export class Data<T = unknown> extends Res {
    static readonly typeName = 'Data';
    readonly data: T;

    constructor(data: T) {
        super();
        this.data = data;
    }
}

export class NotFound extends Rej {
    static readonly typeName = 'NotFound';
    constructor() {
        super();
    }
}

export class Other<TErr = unknown> extends Rej {
    static readonly typeName = 'Other';
    readonly err: TErr;

    constructor(err: TErr) {
        super();
        this.err = err;
    }
}

export class Action<TData = unknown> extends Req {
    static readonly typeName = 'Action';
    readonly fragmentId: string;
    readonly name: string;
    readonly data: TData;

    constructor(fragmentId: string, name: string, data: TData) {
        super();
        this.fragmentId = fragmentId;
        this.name = name;
        this.data = data;
    }
}

export class Query<TData = unknown> extends Req {
    static readonly typeName = 'Query';
    readonly fragmentId: string;
    readonly name: string;
    readonly data: TData;

    constructor(fragmentId: string, name: string, data: TData) {
        super();
        this.fragmentId = fragmentId;
        this.name = name;
        this.data = data;
    }
}

export class Reload extends Req {
    static readonly typeName = 'Reload';
    readonly activityId: string;

    constructor(activityId: string) {
        super();
        this.activityId = activityId;
    }
}

export class Load extends Req {
    static readonly typeName = 'Load';
    constructor() {
        super();
    }
}

export type ActivityList = Array<{
    id: string;
    title: string;
    active: boolean;
    main: boolean;
    prev: boolean;
}>;

export class UpdateActivityList extends Req {
    static readonly typeName = 'UpdateActivityList';
    readonly list: ActivityList;

    constructor(list: ActivityList) {
        super();
        this.list = list;
    }
}

export class Refresh extends Req {
    static readonly typeName = 'Refresh';
    readonly activityId: string;

    constructor(activityId: string) {
        super();
        this.activityId = activityId;
    }
}

export class Switch extends Req {
    static readonly typeName = 'Switch';
    readonly activityId: string;

    constructor(activityId: string) {
        super();
        this.activityId = activityId;
    }
}

export class Close extends Req {
    static readonly typeName = 'Close';
    readonly activityId: string;

    constructor(activityId: string) {
        super();
        this.activityId = activityId;
    }
}

export class Prev extends Req {
    static readonly typeName = 'Prev';
    readonly activityId: string;

    constructor(activityId: string) {
        super();
        this.activityId = activityId;
    }
}

export class Suspend extends Req {
    static readonly typeName = 'Suspend';
    constructor() {
        super();
    }
}

export function deserialize(message: any): Req | Res | Rej | undefined {
    if (!message) {
        return undefined;
    }
    switch (message._type) {
        case typeNameOf(AgentPost):
            return new AgentPost(message.name, message.data);
        case typeNameOf(AgentTask):
            return new AgentTask(message.id, message.name, message.data, message.hp);
        case typeNameOf(AcquireAgent):
            return new AcquireAgent(message.type, message.agentId);
        case typeNameOf(AgentList):
            return new AgentList(message.type);
        case typeNameOf(NotFound):
            return new NotFound();
        case typeNameOf(Other):
            return new Other(message.err);
        case typeNameOf(SendUpdate):
            return new SendUpdate(message.data);
        case typeNameOf(SendBuild):
            return new SendBuild(message.data);
        case typeNameOf(SendPush):
            return new SendPush(message.data);
        case typeNameOf(Data):
            return new Data(message.data);
        case typeNameOf(Reload):
            return new Reload(message.activityId);
        case typeNameOf(Switch):
            return new Switch(message.activityId);
        case typeNameOf(Load):
            return new Load();
        case typeNameOf(Close):
            return new Close(message.activityId);
        case typeNameOf(Prev):
            return new Prev(message.activityId);
        case typeNameOf(UpdateActivityList):
            return new UpdateActivityList(message.list);
        case typeNameOf(Refresh):
            return new Refresh(message.activityId);
        case typeNameOf(Suspend):
            return new Suspend();
        case typeNameOf(Action):
            return new Action(message.fragmentId, message.name, message.data);
        case typeNameOf(Query):
            return new Query(message.fragmentId, message.name, message.data);
        case typeNameOf(Res):
            return new Res();
        case typeNameOf(Rej):
            return new Rej();
        default:
            return undefined;
    }
}

export type WorkerInit = {
    appIndexPath: string;
    requestPort: MessagePort;
    responsePort: MessagePort;
    appName: string;
    profile: string | null;
    userId: string;
    tabLimit: number;
};
