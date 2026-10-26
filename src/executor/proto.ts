import { MessagePort } from 'worker_threads';

import type { BuildedPart } from '../builder/builder.js';
import { UpdateTypes } from '../lib/actors.js';
import { Rej, Req, Res } from '../lib/worker_socket.js';

export interface Build {
    isPop: boolean;
    hasPrev: boolean;
    activityId: string;
    build: BuildedPart;
}

export class AcquireAgent extends Req {
    type: string;
    readonly agentId: string;

    constructor(type: string, agentId: string) {
        super();
        this.type = type;
        this.agentId = agentId;
    }
}

export class AgentTask<TData = unknown> extends Req {
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
    readonly name: string;
    readonly data: TData;

    constructor(name: string, data: TData) {
        super();
        this.name = name;
        this.data = data;
    }
}

export class AgentList extends Req {
    type: string;

    constructor(type: string) {
        super();
        this.type = type;
    }
}

export class SendBuild extends Req {
    readonly data: Build;

    constructor(data: Build) {
        super();
        this.data = data;
    }
}

export class SendPush<TData = unknown> extends Req {
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
    readonly data: Update<TData>;

    constructor(data: Update<TData>) {
        super();
        this.data = data;
    }
}

export class Data<T = unknown> extends Res {
    readonly data: T;

    constructor(data: T) {
        super();
        this.data = data;
    }
}

export class NotFound extends Rej {
    constructor() {
        super();
    }
}

export class Other<TErr = unknown> extends Rej {
    readonly err: TErr;

    constructor(err: TErr) {
        super();
        this.err = err;
    }
}

export class Action<TData = unknown> extends Req {
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
    readonly activityId: string;

    constructor(activityId: string) {
        super();
        this.activityId = activityId;
    }
}

export class Load extends Req {
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
    readonly list: ActivityList;

    constructor(list: ActivityList) {
        super();
        this.list = list;
    }
}

export class Refresh extends Req {
    readonly activityId: string;

    constructor(activityId: string) {
        super();
        this.activityId = activityId;
    }
}

export class Switch extends Req {
    readonly activityId: string;

    constructor(activityId: string) {
        super();
        this.activityId = activityId;
    }
}

export class Close extends Req {
    readonly activityId: string;

    constructor(activityId: string) {
        super();
        this.activityId = activityId;
    }
}

export class Prev extends Req {
    readonly activityId: string;

    constructor(activityId: string) {
        super();
        this.activityId = activityId;
    }
}

export class Suspend extends Req {
    constructor() {
        super();
    }
}

export function deserialize(message: any): Req | Res | Rej | undefined {
    if (!message) {
        return undefined;
    }
    switch (message._type) {
        case AgentPost.name:
            return new AgentPost(message.name, message.data);
        case AgentTask.name:
            return new AgentTask(message.id, message.name, message.data, message.hp);
        case AcquireAgent.name:
            return new AcquireAgent(message.type, message.agentId);
        case AgentList.name:
            return new AgentList(message.type);
        case NotFound.name:
            return new NotFound();
        case Other.name:
            return new Other(message.err);
        case SendUpdate.name:
            return new SendUpdate(message.data);
        case SendBuild.name:
            return new SendBuild(message.data);
        case SendPush.name:
            return new SendPush(message.data);
        case Data.name:
            return new Data(message.data);
        case Reload.name:
            return new Reload(message.activityId);
        case Switch.name:
            return new Switch(message.activityId);
        case Load.name:
            return new Load();
        case Close.name:
            return new Close(message.activityId);
        case Prev.name:
            return new Prev(message.activityId);
        case UpdateActivityList.name:
            return new UpdateActivityList(message.list);
        case Refresh.name:
            return new Refresh(message.activityId);
        case Suspend.name:
            return new Suspend();
        case Action.name:
            return new Action(message.fragmentId, message.name, message.data);
        case Query.name:
            return new Query(message.fragmentId, message.name, message.data);
        case Res.name:
            return new Res();
        case Rej.name:
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
