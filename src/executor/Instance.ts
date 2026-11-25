import { deal, Err, err, logger, Ok, ok, once, R, Result, Socket, t, uuid } from '@araminix/lib';
import { MessageChannel, ResourceLimits, Worker } from 'worker_threads';

import AgentController from '../agent/AgentController.js';
import { Req, RequestSocket, ResponseSocket } from '../lib/worker_socket.js';
import { sendOutgoingStream } from './outgoingStream.js';
import {
    AcquireAgent,
    Action,
    AgentList,
    AgentTask,
    Close,
    Data,
    deserialize,
    Load,
    Prev,
    Query,
    Refresh,
    Reload,
    SendBuild,
    SendPush,
    SendUpdate,
    Switch,
    UpdateActivityList,
    WorkerInit,
} from './proto.js';

/** Default timeout for outgoing client streams in milliseconds (10 seconds). */
const DEFAULT_OUTGOING_STREAM_TIMEOUT_MS = 10_000;

/** Lifecycle of an {@link Instance}. */
enum Status {
    /** Constructed, worker not started. */
    Created = 0,
    /** Worker starting. */
    Initiating = 1,
    /** Worker ready, requests are served. */
    Initiated = 2,
    /** Torn down; final. */
    Destroyed = 3,
}

/** Error codes the client receives (serialized as `{ ok: false, e }`) on the instance streams. */
enum IncomingStreamErr {
    /** The stream arguments have the wrong shape. */
    Format = 'Format',
    /** The worker is not ready, rejected the request or did not answer in time. */
    Execution = 'Execution',
}

const FRAGMENT_CALL_ARGS = t.type({
    fragmentId: t.string,
    name: t.string,
    data: t.unknown,
});

/**
 * One running app instance, seen from the main thread: an app worker thread, the two IPC channels to it, and the user's
 * WebSocket on the `instance` endpoint.
 *
 * {@link Platform} creates it for a `createInstance` request, starts it with {@link Instance.init} and attaches the
 * client socket with {@link Instance.connect} when the client opens `/ws/instance/<instance id>`. The client then sends
 * requests on the streams `load`, `reload`, `prev`, `close`, `switch`, `action`, `query` and `refresh`, each forwarded to
 * the worker; the worker's output reaches the client as outgoing streams `activityList`, `build`, `push` and
 * `update-<fragmentId>`. Not exported from the package.
 */
export default class Instance {
    /** Owner of the instance ({@link ClientInfo.id}). */
    readonly userId: string;
    /** Name of the app that runs. */
    readonly appName: string;
    /** Launch profile, or `null`. */
    readonly profile: string | null;
    /** URL of the app index module, imported by the worker. */
    readonly appIndexPath: URL;
    /** Activity limit passed to the worker. */
    readonly tabLimit: number;
    /** Routes the worker's agent requests. */
    readonly agentController: AgentController;
    /** Worker resource limits; `{ maxOldGenerationSizeMb: 128, stackSizeMb: 4 }` when unset. */
    readonly resourceLimits?: ResourceLimits;
    /** Time the worker gets to exit on its own after {@link Instance.destroy} before it is terminated. */
    readonly terminationGracePeriodMs: number;
    /** Timeout of requests to the worker in milliseconds (0 = none). */
    readonly requestTimeoutMs: number;
    /** Timeout of outgoing client streams in milliseconds (0 = none). */
    readonly outgoingStreamTimeoutMs: number;
    /** The app worker thread. */
    private worker?: Worker = undefined;
    /** Requests to the worker. */
    private requestSocket?: RequestSocket = undefined;
    /** Requests from the worker. */
    private responseSocket?: ResponseSocket = undefined;
    /** Lifecycle state. */
    private status: Status = Status.Created;
    /** Random instance id; the client connects to `/ws/instance/<id>` and closes it with `closeInstance`. */
    readonly id: string = uuid();
    /** App title reported by the worker when it started. */
    appTitle: string = '';
    /** Title of the active activity, from the last activity list. */
    activityTitle?: string = undefined;
    /** Removes the instance from the platform's map; run once. */
    private onDestroy?: () => void = undefined;
    /** Last use timestamp (ms). */
    private _touched: number = Date.now();
    /** The client's current socket. */
    private userSocket?: Socket = undefined;
    /** When the instance last lost its client socket (or was created without one); `undefined` while a client is connected. */
    private disconnectedSince?: number = Date.now();
    /** Pending forced termination of the worker. */
    private terminationTimer?: NodeJS.Timeout = undefined;

    constructor(
        userId: string,
        appName: string,
        profile: string | null,
        appIndexPath: URL,
        tabLimit: number,
        agentController: AgentController,
        resourceLimits?: ResourceLimits,
        terminationGracePeriodMs: number = 500,
        requestTimeoutMs: number = 0,
        outgoingStreamTimeoutMs: number = DEFAULT_OUTGOING_STREAM_TIMEOUT_MS,
    ) {
        this.userId = userId;
        this.appName = appName;
        this.profile = profile;
        this.appIndexPath = appIndexPath;
        this.tabLimit = tabLimit;
        this.agentController = agentController;
        this.resourceLimits = resourceLimits;
        this.terminationGracePeriodMs = terminationGracePeriodMs;
        this.requestTimeoutMs = requestTimeoutMs;
        this.outgoingStreamTimeoutMs = outgoingStreamTimeoutMs;
    }

    /** Whether {@link Instance.destroy} ran. */
    get isDestroyed(): boolean {
        return this.status === Status.Destroyed;
    }

    /** Last use timestamp in milliseconds; {@link Platform} evicts the least recently touched instance first. */
    get touched(): number {
        return this._touched;
    }

    /**
     * Marks the instance as used (called when a client socket connects).
     *
     * @param time - Timestamp in milliseconds; now by default.
     */
    touch(time: number = Date.now()): void {
        this._touched = time;
    }

    /**
     * Since when no client socket has been attached, in milliseconds; `undefined` while one is. A socket counts as attached
     * until its connection is destroyed, so short network drops that the client reconnects through do not start the clock.
     * {@link Platform} destroys instances that stay without a client for `instanceIdleTimeoutMs`.
     */
    get idleSince(): number | undefined {
        return this.disconnectedSince;
    }

    /**
     * Attaches the client's socket (destroying a previous one) and serves its request streams until it closes.
     *
     * @param socket - The accepted socket of the `instance` endpoint.
     */
    connect(socket: Socket): void {
        this.touch();
        if (this.userSocket) {
            this.userSocket.destroy();
        }
        this.userSocket = socket;
        this.disconnectedSince = undefined;
        once(async () => {
            const streams: Array<[string, (args: unknown) => Promise<Result<unknown, IncomingStreamErr>>]> = [
                ['load', () => this.sendWorkerRequest(new Load())],
                ['reload', (args) => this.sendStringArgRequest(args, (id) => new Reload(id))],
                ['prev', (args) => this.sendStringArgRequest(args, (id) => new Prev(id))],
                ['close', (args) => this.sendStringArgRequest(args, (id) => new Close(id))],
                ['switch', (args) => this.sendStringArgRequest(args, (id) => new Switch(id))],
                ['action', (args) => this.action(args)],
                ['query', (args) => this.query(args)],
                ['refresh', (args) => this.sendStringArgRequest(args, (id) => new Refresh(id))],
            ];
            for (const [streamName, handler] of streams) {
                this.processStream(socket, streamName, handler).catch((err) => {
                    logger.error(`Unhandled error in processStream ${streamName}:`, err);
                });
            }
            await socket.waitClose();
            if (this.userSocket === socket) {
                this.userSocket = undefined;
                this.disconnectedSince = Date.now();
            }
        });
    }

    private async sendWorkerRequest(req: Req): Promise<Result<void, IncomingStreamErr>> {
        if (!this.requestSocket) {
            return new Err(IncomingStreamErr.Execution);
        }
        const result = await this.requestSocket.writeRead(req);
        if (result.isErr()) {
            return new Err(IncomingStreamErr.Execution);
        }
        return ok();
    }

    private async sendStringArgRequest(args: unknown, buildReq: (activityId: string) => Req): Promise<Result<void, IncomingStreamErr>> {
        if (typeof args !== 'string') {
            return new Err(IncomingStreamErr.Format);
        }
        return this.sendWorkerRequest(buildReq(args));
    }

    /** `action` stream (args: `{ fragmentId, name, data }`): run a fragment action. */
    private async action(args: unknown): Promise<Result<void, IncomingStreamErr>> {
        if (!FRAGMENT_CALL_ARGS.is(args)) {
            return new Err(IncomingStreamErr.Format);
        }
        return this.sendWorkerRequest(new Action(args.fragmentId, args.name, args.data));
    }

    /** `query` stream (args: `{ fragmentId, name, data }`): run a fragment query and return its answer. */
    private async query(args: unknown): Promise<Result<unknown, IncomingStreamErr>> {
        if (!FRAGMENT_CALL_ARGS.is(args)) {
            return new Err(IncomingStreamErr.Format);
        }
        if (!this.requestSocket) {
            return new Err(IncomingStreamErr.Execution);
        }
        const result = await this.requestSocket.writeRead(new Query(args.fragmentId, args.name, args.data));
        if (result.isErr() || !(result.unwrap() instanceof Data)) {
            return new Err(IncomingStreamErr.Execution);
        }
        return new Ok((result.unwrap() as Data).data);
    }

    /**
     * Serves one request stream name: for every incoming stream it runs `handler(args)`, writes the serialized result and
     * closes the stream, until the socket closes.
     */
    private async processStream(socket: Socket, streamName: string, handler: (args: unknown) => Promise<Result<unknown, unknown>>): Promise<void> {
        while (true) {
            const streamResult = await socket.incomingStream(streamName);
            if (streamResult.isErr()) {
                return;
            }
            const stream = streamResult.unwrap();
            try {
                const result = await handler(stream.args);
                await stream.write((result as any).serialize());
                stream.closeOk();
            } catch (err) {
                logger.error(`Error processing stream '${streamName}':`, err);
                try {
                    stream.closeErr();
                } catch {}
            }
        }
    }

    /**
     * Starts the worker thread and waits for it to report the app title. On failure the instance is destroyed.
     *
     * @param onDestroy - Called once when the instance is destroyed.
     * @returns `Ok` when the worker is ready; `Err` when it failed, exited, the instance was destroyed meanwhile, or `init`
     *     was called twice.
     */
    async init(onDestroy: () => void): Promise<R> {
        if (this.status !== Status.Created) {
            logger.warn('Tried to initiate instance more than once or when not in Created status');
            return err();
        }
        this.onDestroy = onDestroy;
        this.status = Status.Initiating;
        const requestChannel = new MessageChannel();
        const responseChannel = new MessageChannel();
        const workerInit: WorkerInit = {
            userId: this.userId,
            appName: this.appName,
            profile: this.profile,
            responsePort: requestChannel.port2,
            requestPort: responseChannel.port2,
            appIndexPath: this.appIndexPath.href,
            tabLimit: this.tabLimit,
        };
        this.requestSocket = new RequestSocket(requestChannel.port1, deserialize, this.requestTimeoutMs);
        this.responseSocket = new ResponseSocket(responseChannel.port1, deserialize);
        const resourceLimits: ResourceLimits = this.resourceLimits ?? {
            maxOldGenerationSizeMb: 128,
            stackSizeMb: 4,
        };
        this.worker = new Worker(new URL('./worker.js', import.meta.url), {
            resourceLimits,
        });
        const [promise, resolve] = deal<R>();
        this.worker.postMessage(workerInit, [workerInit.requestPort, workerInit.responsePort]);
        this.worker.on('message', (appTitle: string) => {
            if (resolve(ok()).isOk()) {
                this.appTitle = appTitle;
            }
        });
        this.worker.on('exit', () => {
            resolve(err());
        });
        this.worker.on('error', (error: unknown) => {
            if (error !== true) {
                logger.error('worker error', error);
            }
            resolve(err());
        });

        const result = await promise;
        if (result.isOk() && !this.isDestroyed) {
            this.status = Status.Initiated;
            this.responseLoop().then();
            return result;
        }
        this.destroy();
        return err();
    }

    /**
     * Tears the instance down: runs `onDestroy`, closes both channels and the client socket, and terminates the worker after
     * {@link Instance.terminationGracePeriodMs} unless it exits first. Idempotent.
     */
    destroy(): void {
        const cleanup = this.onDestroy;
        this.onDestroy = undefined;
        if (cleanup) {
            try {
                cleanup();
            } catch (err) {
                logger.error('Error during instance onDestroy cleanup:', err);
            }
        }

        if (this.status === Status.Destroyed) {
            return;
        }
        this.status = Status.Destroyed;

        try {
            this.requestSocket?.close();
        } catch {}

        try {
            this.responseSocket?.close();
        } catch {}

        if (this.userSocket) {
            try {
                this.userSocket.destroy();
            } catch {}
            this.userSocket = undefined;
        }

        if (this.worker) {
            const worker = this.worker;
            this.worker = undefined;
            if (this.terminationTimer) {
                clearTimeout(this.terminationTimer);
                this.terminationTimer = undefined;
            }
            this.terminationTimer = setTimeout(() => {
                this.terminationTimer = undefined;
                worker.terminate().catch((err) => {
                    logger.error('Error terminating worker:', err);
                });
            }, this.terminationGracePeriodMs);
            if (typeof this.terminationTimer.unref === 'function') {
                this.terminationTimer.unref();
            }
            worker.once('exit', () => {
                if (this.terminationTimer) {
                    clearTimeout(this.terminationTimer);
                    this.terminationTimer = undefined;
                }
            });
        }
    }

    private async outgoingStream(name: string, arg: unknown): Promise<void> {
        await sendOutgoingStream(this.userSocket, this.responseSocket, name, arg, this.outgoingStreamTimeoutMs);
    }

    /** Serves the worker's requests one at a time (agent requests and client output) until the channel closes, then destroys the instance. */
    private async responseLoop(): Promise<void> {
        while (this.status !== Status.Destroyed) {
            if (!this.responseSocket) {
                break;
            }
            const result = await this.responseSocket.read();
            if (result.isErr()) {
                break;
            }
            const request = result.unwrap();
            switch (true) {
                case request instanceof AgentTask: {
                    const agentTask = request as AgentTask;
                    const taskRes = await this.agentController.task(agentTask.id, agentTask.name, agentTask.data, agentTask.hp);
                    if (taskRes.isErr()) {
                        this.responseSocket.reject();
                        break;
                    }
                    this.responseSocket.resolve(new Data(taskRes.unwrap()));
                    break;
                }
                case request instanceof AgentList: {
                    const agentList = request as AgentList;
                    const list = this.agentController.list(agentList.type);
                    this.responseSocket.resolve(new Data(list));
                    break;
                }
                case request instanceof AcquireAgent: {
                    const acquireAgent = request as AcquireAgent;
                    const acqRes = this.agentController.acquire(acquireAgent.type, acquireAgent.agentId);
                    if (acqRes.isErr()) {
                        this.responseSocket.reject();
                        break;
                    }
                    this.responseSocket.resolve();
                    break;
                }
                case request instanceof UpdateActivityList: {
                    const updateActivityList = request as UpdateActivityList;
                    this.activityTitle = updateActivityList.list.find((activity) => activity.active)?.title;
                    await this.outgoingStream('activityList', updateActivityList.list);
                    break;
                }
                case request instanceof SendBuild: {
                    const sendBuild = request as SendBuild;
                    await this.outgoingStream('build', sendBuild.data);
                    break;
                }
                case request instanceof SendPush: {
                    const sendPush = request as SendPush;
                    await this.outgoingStream('push', sendPush.data);
                    break;
                }
                case request instanceof SendUpdate: {
                    const sendUpdate = request as SendUpdate;
                    const payload =
                        sendUpdate.data.seq !== undefined
                            ? {
                                  data: sendUpdate.data.data,
                                  type: sendUpdate.data.type,
                                  seq: sendUpdate.data.seq,
                              }
                            : {
                                  data: sendUpdate.data.data,
                                  type: sendUpdate.data.type,
                              };
                    await this.outgoingStream(`update-${sendUpdate.data.fragmentId}`, payload);
                    break;
                }
            }
        }
        this.destroy();
    }
}
