/**
 * Message protocol between the main thread and the worker threads (app and agent workers).
 *
 * Main thread to app worker: {@link Load}, {@link Reload}, {@link Refresh}, {@link Prev}, {@link Close}, {@link Switch},
 * {@link Action}, {@link Query}. App worker to main thread: {@link SendBuild}, {@link SendUpdate}, {@link SendPush},
 * {@link UpdateActivityList}, plus the agent requests {@link AgentTask}, {@link AgentList} and {@link AcquireAgent}
 * (which agent workers send too). Main thread to agent worker: {@link AgentPost}. Replies are {@link Data},
 * {@link NotFound}, {@link Other} or the plain `Res`/`Rej`.
 *
 * Every class declares `static typeName`, so the wire names survive minification (see `typeNameOf`).
 *
 * @module
 */
import { MessagePort } from 'worker_threads';

import type { BuildedPart } from '../builder/builder.js';
import { UpdateTypes } from '../lib/actors.js';
import { Rej, Req, Res, typeNameOf } from '../lib/worker_socket.js';

/** Payload of {@link SendBuild}, forwarded to the client on the `build` stream. */
export interface Build {
    /** `true` when the activity is shown as a pop-up. */
    isPop: boolean;
    /** `true` when the client may go back (`prev` request). */
    hasPrev: boolean;
    /** Id of the activity the build belongs to. */
    activityId: string;
    /** The UI tree. */
    build: BuildedPart;
}

/** Worker to main: is agent `agentId` of type `type` connected? Resolved with a plain `Res`, rejected otherwise. */
export class AcquireAgent extends Req {
    static readonly typeName = 'AcquireAgent';
    /** Agent type. */
    type: string;
    /** Agent id. */
    readonly agentId: string;

    /**
     * @param type - Agent type.
     * @param agentId - Agent id.
     */
    constructor(type: string, agentId: string) {
        super();
        this.type = type;
        this.agentId = agentId;
    }
}

/**
 * Worker to main: send task `name` with `data` to agent `id`; resolved with {@link Data} holding the agent's serialised
 * `Result`.
 *
 * @typeParam TData - Task data type.
 */
export class AgentTask<TData = unknown> extends Req {
    static readonly typeName = 'AgentTask';
    /** Agent id. */
    id: string;
    /** Task name. */
    readonly name: string;
    /** Task data. */
    readonly data: TData;
    /** Reply timeout in seconds. */
    hp: number;

    /**
     * @param id - Agent id.
     * @param name - Task name.
     * @param data - Task data.
     * @param hp - Reply timeout in seconds (default 60).
     */
    constructor(id: string, name: string, data: TData, hp: number = 60) {
        super();
        this.id = id;
        this.name = name;
        this.data = data;
        this.hp = hp;
    }
}

/**
 * Main to agent worker: a message posted by the agent process; resolved with {@link Data} holding the serialised result
 * of `Agent.onPost`.
 *
 * @typeParam TData - Posted data type.
 */
export class AgentPost<TData = unknown> extends Req {
    static readonly typeName = 'AgentPost';
    /** Message name. */
    readonly name: string;
    /** Posted data. */
    readonly data: TData;

    /**
     * @param name - Message name.
     * @param data - Posted data.
     */
    constructor(name: string, data: TData) {
        super();
        this.name = name;
        this.data = data;
    }
}

/** Worker to main: list the connected agents of `type`; resolved with {@link Data} holding the ids. */
export class AgentList extends Req {
    static readonly typeName = 'AgentList';
    /** Agent type. */
    type: string;

    /** @param type - Agent type. */
    constructor(type: string) {
        super();
        this.type = type;
    }
}

/** App worker to main: forward a build to the client (`build` stream). */
export class SendBuild extends Req {
    static readonly typeName = 'SendBuild';
    /** The build. */
    readonly data: Build;

    /** @param data - The build. */
    constructor(data: Build) {
        super();
        this.data = data;
    }
}

/**
 * App worker to main: forward data to the client (`push` stream).
 *
 * @typeParam TData - Data type.
 */
export class SendPush<TData = unknown> extends Req {
    static readonly typeName = 'SendPush';
    /** The data. */
    readonly data: TData;

    /** @param data - The data. */
    constructor(data: TData) {
        super();
        this.data = data;
    }
}

/**
 * Payload of {@link SendUpdate}; the client receives `{ data, type }` on the stream `update-<fragmentId>`.
 *
 * @typeParam TData - Data type.
 */
export interface Update<TData = unknown> {
    /** Activity of the fragment. */
    activityId: string;
    /** Target fragment. */
    fragmentId: string;
    /** Full replacement or patch. */
    type: UpdateTypes;
    /** The data. */
    data: TData;
}

/**
 * App worker to main: forward a fragment update to the client.
 *
 * @typeParam TData - Data type.
 */
export class SendUpdate<TData = unknown> extends Req {
    static readonly typeName = 'SendUpdate';
    /** The update. */
    readonly data: Update<TData>;

    /** @param data - The update. */
    constructor(data: Update<TData>) {
        super();
        this.data = data;
    }
}

/**
 * Successful reply that carries data.
 *
 * @typeParam T - Data type.
 */
export class Data<T = unknown> extends Res {
    static readonly typeName = 'Data';
    /** The data. */
    readonly data: T;

    /** @param data - The data. */
    constructor(data: T) {
        super();
        this.data = data;
    }
}

/** Failed reply: the addressed item does not exist. */
export class NotFound extends Rej {
    static readonly typeName = 'NotFound';
    /** Creates the reply. */
    constructor() {
        super();
    }
}

/**
 * Failed reply with an error; the app worker sends it when app code throws while handling a request.
 *
 * @typeParam TErr - Error type.
 */
export class Other<TErr = unknown> extends Rej {
    static readonly typeName = 'Other';
    /** The error (the message of a thrown `Error`). */
    readonly err: TErr;

    /** @param err - The error. */
    constructor(err: TErr) {
        super();
        this.err = err;
    }
}

/**
 * Main to app worker: run action `name` of fragment `fragmentId` with `data` (client `action` stream).
 *
 * @typeParam TData - Action data type.
 */
export class Action<TData = unknown> extends Req {
    static readonly typeName = 'Action';
    /** Target fragment. */
    readonly fragmentId: string;
    /** Action name. */
    readonly name: string;
    /** Action data. */
    readonly data: TData;

    /**
     * @param fragmentId - Target fragment.
     * @param name - Action name.
     * @param data - Action data.
     */
    constructor(fragmentId: string, name: string, data: TData) {
        super();
        this.fragmentId = fragmentId;
        this.name = name;
        this.data = data;
    }
}

/**
 * Main to app worker: run query `name` of fragment `fragmentId` with `data` (client `query` stream); resolved with
 * {@link Data}.
 *
 * @typeParam TData - Query data type.
 */
export class Query<TData = unknown> extends Req {
    static readonly typeName = 'Query';
    /** Target fragment. */
    readonly fragmentId: string;
    /** Query name. */
    readonly name: string;
    /** Query data. */
    readonly data: TData;

    /**
     * @param fragmentId - Target fragment.
     * @param name - Query name.
     * @param data - Query data.
     */
    constructor(fragmentId: string, name: string, data: TData) {
        super();
        this.fragmentId = fragmentId;
        this.name = name;
        this.data = data;
    }
}

/** Main to app worker: re-render the active activity (client `reload` stream; the id is checked for its format only). */
export class Reload extends Req {
    static readonly typeName = 'Reload';
    /** Activity id sent by the client. */
    readonly activityId: string;

    /** @param activityId - Activity id sent by the client. */
    constructor(activityId: string) {
        super();
        this.activityId = activityId;
    }
}

/** Main to app worker: (re)send the build of the active activity, rendering it first if needed (client `load` stream). */
export class Load extends Req {
    static readonly typeName = 'Load';
    /** Creates the request. */
    constructor() {
        super();
    }
}

/** Activity list sent to the client on the `activityList` stream: one entry per activity (tab) of the instance. */
export type ActivityList = Array<{
    /** Activity id. */
    id: string;
    /** Activity title. */
    title: string;
    /** `true` for the active activity. */
    active: boolean;
    /** `true` for the first activity in the list. */
    main: boolean;
    /** `true` when the activity can go back. */
    prev: boolean;
}>;

/** App worker to main: forward the activity list to the client; the main thread also records the active title. */
export class UpdateActivityList extends Req {
    static readonly typeName = 'UpdateActivityList';
    /** The list. */
    readonly list: ActivityList;

    /** @param list - The list. */
    constructor(list: ActivityList) {
        super();
        this.list = list;
    }
}

/** Main to app worker: rebuild activity `activityId` with its current context (client `refresh` stream). */
export class Refresh extends Req {
    static readonly typeName = 'Refresh';
    /** Target activity. */
    readonly activityId: string;

    /** @param activityId - Target activity. */
    constructor(activityId: string) {
        super();
        this.activityId = activityId;
    }
}

/** Main to app worker: make activity `activityId` the active one (client `switch` stream). */
export class Switch extends Req {
    static readonly typeName = 'Switch';
    /** Target activity. */
    readonly activityId: string;

    /** @param activityId - Target activity. */
    constructor(activityId: string) {
        super();
        this.activityId = activityId;
    }
}

/** Main to app worker: the user closes activity `activityId` (client `close` stream). */
export class Close extends Req {
    static readonly typeName = 'Close';
    /** Target activity. */
    readonly activityId: string;

    /** @param activityId - Target activity. */
    constructor(activityId: string) {
        super();
        this.activityId = activityId;
    }
}

/** Main to app worker: go back in activity `activityId` (client `prev` stream). */
export class Prev extends Req {
    static readonly typeName = 'Prev';
    /** Target activity. */
    readonly activityId: string;

    /** @param activityId - Target activity. */
    constructor(activityId: string) {
        super();
        this.activityId = activityId;
    }
}

/** Reserved: suspend the app. Defined in the protocol but not sent by the platform. */
export class Suspend extends Req {
    static readonly typeName = 'Suspend';
    /** Creates the request. */
    constructor() {
        super();
    }
}

/**
 * Turns a structured-clone message back into an instance of its protocol class, by its `_type`.
 *
 * @param message - Raw message.
 * @returns The instance, or `undefined` for empty or unknown messages.
 */
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

/** First message sent to an app worker thread. */
export type WorkerInit = {
    /** URL of the app index module. */
    appIndexPath: string;
    /** Port on which the worker sends requests to the main thread. */
    requestPort: MessagePort;
    /** Port on which the worker receives requests from the main thread. */
    responsePort: MessagePort;
    /** App to run. */
    appName: string;
    /** Launch profile. */
    profile: string | null;
    /** Owner of the instance. */
    userId: string;
    /** Activity limit. */
    tabLimit: number;
};
