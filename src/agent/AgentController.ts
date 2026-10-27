import { CloseCodes, deal, Err, err, logger, loop, LoopResult, Ok, ok, once, R, Result, Socket, t } from '@araminix/lib';
import { MessageChannel, MessagePort, Worker } from 'worker_threads';

import { AcquireAgent, AgentList, AgentPost, AgentTask, Data, deserialize } from '../executor/proto.js';
import { RequestSocket, ResponseSocket } from '../lib/worker_socket.js';
import { AgentInfo } from '../server/AuthProvider.js';
import { ConnectRequest } from '../server/ConnectRequest.js';

/** First message sent to an agent worker thread. */
export type AgentInit = {
    /** Identity of the agent. */
    info: AgentInfo;
    /** Port on which the worker receives requests from the main thread. */
    responsePort: MessagePort;
    /** Port on which the worker sends requests to the main thread. */
    requestPort: MessagePort;
    /** URL of the agent index module. */
    workerIndexPath: string;
};

/**
 * One connected agent in the main thread: its worker thread, the ports to it, the agent's WebSocket and a keep-alive
 * that sends a `ping` task every 30 seconds while a socket is attached.
 *
 * The instance outlives disconnects so that a reconnecting agent finds its worker again; it is destroyed when the agent
 * closes its connection intentionally, when its worker stops, or by {@link AgentController.stop}.
 */
export class AgentInstance {
    /** URL of the agent index module. */
    private workerIndex: URL;
    /** Identity of the agent. */
    readonly info: AgentInfo;
    /** The agent's worker thread. */
    private worker?: Worker = undefined;
    /** Requests to the worker (`AgentPost`). */
    private requestSocket!: RequestSocket;
    /** Requests from the worker (tasks, lists, acquires). */
    private responseSocket!: ResponseSocket;
    /** The agent's current WebSocket session, if connected. */
    private socket?: Socket = undefined;
    /** Removes the instance from the controller. */
    private onDestroy?: () => void = undefined;
    /** Keep-alive timer (unref'd). */
    private timer?: NodeJS.Timeout = setInterval(() => {
        this.task('ping', '').then();
    }, 30000);
    /** Owning controller (routes the worker's requests). */
    private controller: AgentController;
    /** Default worker start-up timeout. */
    private initTimeoutMs: number;
    /** Timeout of requests to the worker. */
    private requestTimeoutMs: number;

    /**
     * @param workerIndex - URL of the agent index module.
     * @param info - Identity of the agent.
     * @param controller - Owning controller.
     * @param initTimeoutMs - Worker start-up timeout in milliseconds (default 5000).
     * @param requestTimeoutMs - Timeout of requests to the worker in milliseconds (default 0 = none).
     */
    constructor(workerIndex: URL, info: AgentInfo, controller: AgentController, initTimeoutMs: number = 5000, requestTimeoutMs: number = 0) {
        this.workerIndex = workerIndex;
        this.info = info;
        this.controller = controller;
        this.initTimeoutMs = initTimeoutMs;
        this.requestTimeoutMs = requestTimeoutMs;
        if (this.timer && typeof this.timer.unref === 'function') {
            this.timer.unref();
        }
    }

    /**
     * Starts the worker thread and waits until it reports ready. On failure (exit, error or timeout) it terminates the
     * worker, stops the keep-alive and closes the ports.
     *
     * @param onDestroy - Called once when the instance is destroyed later.
     * @param timeoutMs - Start-up timeout in milliseconds; `0` disables it.
     * @returns `Ok` when the worker is ready, `Err` otherwise.
     */
    async init(onDestroy: () => void, timeoutMs: number = this.initTimeoutMs): Promise<R> {
        let timerId: NodeJS.Timeout | undefined = undefined;
        try {
            const requestChannel = new MessageChannel();
            const responseChannel = new MessageChannel();
            const workerInit: AgentInit = {
                info: this.info,
                responsePort: requestChannel.port2,
                requestPort: responseChannel.port2,
                workerIndexPath: this.workerIndex.href,
            };
            this.requestSocket = new RequestSocket(requestChannel.port1, deserialize, this.requestTimeoutMs);
            this.responseSocket = new ResponseSocket(responseChannel.port1, deserialize);
            this.worker = new Worker(new URL('./worker.js', import.meta.url));
            const [promise, resolve] = deal<R>();
            if (timeoutMs > 0) {
                timerId = setTimeout(() => {
                    resolve(err());
                }, timeoutMs);
                if (typeof timerId.unref === 'function') {
                    timerId.unref();
                }
            }
            this.worker.postMessage(workerInit, [workerInit.requestPort, workerInit.responsePort]);
            this.worker.on('message', () => {
                resolve(ok());
            });
            this.worker.on('exit', () => {
                resolve(err());
            });
            this.worker.on('error', (error: unknown) => {
                if (error !== true) {
                    logger.error('Agent worker error:', error);
                }
                resolve(err());
            });
            const result = await promise;
            if (timerId !== undefined) {
                clearTimeout(timerId);
                timerId = undefined;
            }
            if (result.isOk()) {
                this.onDestroy = onDestroy;
                this.run().then();
                return result;
            }
        } catch (e) {
            // failed
        } finally {
            if (timerId !== undefined) {
                clearTimeout(timerId);
                timerId = undefined;
            }
        }
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        if (this.worker) {
            const worker = this.worker;
            this.worker = undefined;
            worker.terminate().catch(() => {});
        }
        try {
            this.requestSocket?.close();
        } catch {}
        try {
            this.responseSocket?.close();
        } catch {}
        return err();
    }

    /** Serves the worker's requests (`AgentTask`, `AgentList`, `AcquireAgent`) until its port closes, then destroys the instance. */
    async run(): Promise<void> {
        while (true) {
            const result = await this.responseSocket.read();
            if (result.isErr()) {
                break;
            }
            const request = result.unwrap();
            switch (true) {
                case request instanceof AgentTask: {
                    const agentTask = request as AgentTask;
                    const taskRes = await this.controller.task(agentTask.id, agentTask.name, agentTask.data, agentTask.hp);
                    if (taskRes.isErr()) {
                        this.responseSocket.reject();
                        break;
                    }
                    this.responseSocket.resolve(new Data(taskRes.unwrap()));
                    break;
                }
                case request instanceof AgentList: {
                    const agentList = request as AgentList;
                    const list = this.controller.list(agentList.type);
                    this.responseSocket.resolve(new Data(list));
                    break;
                }
                case request instanceof AcquireAgent: {
                    const acquireAgent = request as AcquireAgent;
                    const acqRes = this.controller.acquire(acquireAgent.type, acquireAgent.agentId);
                    if (acqRes.isErr()) {
                        this.responseSocket.reject();
                        break;
                    }
                    this.responseSocket.resolve();
                    break;
                }
                default: {
                    this.responseSocket.write(undefined);
                }
            }
        }
        this.destroy();
    }

    /**
     * Sends a task to the agent process: opens the outgoing stream `taskName` with `data` as arguments, reads one reply and
     * closes the stream.
     *
     * @param taskName - Stream name.
     * @param data - Stream arguments.
     * @param hp - Reply timeout in seconds (lib stream "hit points"); the lib default (30) when omitted.
     * @returns The raw reply (an object with an `ok` field), or `Err(undefined)` when the agent is not connected, the stream
     *     fails, times out or the reply is malformed.
     */
    async task<TData = unknown, R = unknown>(taskName: string, data: TData, hp?: number): Promise<Result<R, undefined>> {
        if (!this.socket) {
            return new Err(undefined);
        }
        const streamResult = await this.socket.outgoingStream(taskName, data);
        if (streamResult.isErr()) {
            return new Err(undefined);
        }
        const stream = streamResult.unwrap();
        const read = await stream.read<any>(hp);
        if (read.isErr()) {
            stream.closeErr();
            return new Err(undefined);
        }
        const result = read.unwrap();
        if (!result || typeof result !== 'object' || !('ok' in result)) {
            stream.closeErr();
            return new Err(undefined);
        }
        stream.closeOk();
        return new Ok(result as R);
    }

    /**
     * Attaches the agent's (new) socket, destroying the previous one, and serves its `post` streams (`{ name, data }`
     * arguments, forwarded to {@link Agent.onPost}). When the socket closes intentionally the instance is destroyed;
     * otherwise it waits for a reconnect.
     *
     * @param socket - The accepted socket.
     */
    connect(socket: Socket): void {
        if (this.socket !== undefined) {
            this.socket.destroy();
        }
        this.socket = socket;
        once(async () => {
            const code = await socket.waitClose();
            if (this.socket === socket) {
                this.socket = undefined;
                if (code === CloseCodes.Intentional) {
                    this.destroy();
                }
            }
        });

        loop(async () => {
            const streamResult = await socket.incomingStream<any, { name: unknown; data: unknown }>('post');
            if (streamResult.isErr()) {
                return LoopResult.Stop;
            }
            const stream = streamResult.unwrap();
            try {
                const args = stream.args as { name?: unknown; data?: unknown } | null;
                if (!args || typeof args !== 'object' || typeof args.name !== 'string') {
                    stream.closeErr();
                    return LoopResult.Cont;
                }
                const name = args.name;
                const data = args.data;
                const request = await this.requestSocket.writeRead(new AgentPost(name, data));
                if (request.isErr()) {
                    stream.closeErr();
                    return LoopResult.Cont;
                }
                const response = request.unwrap();
                if (!(response instanceof Data)) {
                    stream.closeErr();
                    return LoopResult.Cont;
                }
                await stream.write(response.data);
                stream.closeOk();
                return LoopResult.Cont;
            } catch (err) {
                logger.error('Unhandled error in AgentController post stream:', err);
                try {
                    stream.closeErr();
                } catch {}
                return LoopResult.Cont;
            }
        });
    }

    /** Removes the instance from the controller and releases the socket, ports, keep-alive timer and worker. Idempotent. */
    destroy(): void {
        if (this.onDestroy) {
            const cleanup = this.onDestroy;
            this.onDestroy = undefined;
            cleanup();
        }
        if (this.socket) {
            this.socket.destroy();
            this.socket = undefined;
        }
        try {
            this.requestSocket?.close();
        } catch {}
        try {
            this.responseSocket?.close();
        } catch {}
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        if (this.worker) {
            const worker = this.worker;
            this.worker = undefined;
            worker.terminate().catch(() => {});
        }
    }
}

/**
 * Runs the agents in the main thread: one {@link AgentInstance} (and worker thread) per connected agent id, and the
 * routing of tasks, lists and acquires between app workers, agent workers and agent processes. Created by
 * {@link Platform}; not exported from the package.
 */
export default class AgentController {
    /** URL of the agent index module. */
    private workerIndex: URL;
    /** Agents by id. */
    private instances: Map<string, AgentInstance> = new Map();
    /** Worker start-ups in progress by agent id, shared by concurrent connects. */
    private pending: Map<string, Promise<R>> = new Map();
    /** Worker start-up timeout in milliseconds. */
    private initTimeoutMs: number;
    /** Timeout of requests to agent workers in milliseconds. */
    private requestTimeoutMs: number;

    /**
     * @param workerIndex - URL of the agent index module ({@link PlatformConfig.agentIndexPath}).
     * @param initTimeoutMs - Worker start-up timeout in milliseconds (default 5000).
     * @param requestTimeoutMs - Timeout of requests to agent workers in milliseconds (default 0 = none; Platform passes
     *     `workerRequestTimeoutMs`).
     */
    constructor(workerIndex: URL, initTimeoutMs: number = 5000, requestTimeoutMs: number = 0) {
        this.workerIndex = workerIndex;
        this.initTimeoutMs = initTimeoutMs;
        this.requestTimeoutMs = requestTimeoutMs;
    }

    /**
     * Sends a task to the agent `id` (see {@link AgentInstance.task}).
     *
     * @param id - Agent id.
     * @param taskName - Task (stream) name.
     * @param data - Task data.
     * @param hp - Reply timeout in seconds.
     * @returns The raw reply, or `Err(undefined)` when the agent is unknown or did not answer.
     */
    async task(id: string, taskName: string, data: t.Any | unknown, hp: number): Promise<Result<any, undefined>> {
        const worker = this.instances.get(id);
        if (!worker) {
            return new Err(undefined);
        }
        return await worker.task(taskName, data, hp);
    }

    /**
     * Ids of the known agents of a type.
     *
     * @param type - Agent type.
     */
    list(type: string): string[] {
        return [...this.instances.values()].filter((instance) => instance.info.agentType === type).map((instance) => instance.info.id);
    }

    /**
     * Checks that agent `id` is known and of type `type`.
     *
     * @param type - Agent type.
     * @param id - Agent id.
     */
    acquire(type: string, id: string): R {
        const agent = this.instances.get(id);
        if (agent && agent.info.agentType === type) {
            return ok();
        }
        return err();
    }

    /**
     * Admits an agent connection: starts its worker if needed (concurrent connects of the same id share one start-up; a
     * worker of a different type is replaced), then accepts the request and attaches the socket. The request is denied when
     * the worker cannot start.
     *
     * @param info - Identity of the agent.
     * @param acceptRequest - The pending connection.
     * @param timeoutMs - Start-up timeout in milliseconds; the controller default when omitted.
     * @returns `Ok` when the agent is connected, `Err` otherwise.
     */
    async connect(info: AgentInfo, acceptRequest: ConnectRequest, timeoutMs?: number): Promise<R> {
        const pendingInit = this.pending.get(info.id);
        if (pendingInit) {
            try {
                const result = await pendingInit;
                if (result.isErr()) {
                    this.instances.delete(info.id);
                    acceptRequest.deny();
                    return result;
                }
            } catch {
                this.instances.delete(info.id);
                acceptRequest.deny();
                return err();
            }
        }

        let worker = this.instances.get(info.id);
        if (worker && worker.info.agentType !== info.agentType) {
            worker.destroy();
            worker = undefined;
        }
        if (!worker) {
            worker = new AgentInstance(this.workerIndex, info, this, timeoutMs ?? this.initTimeoutMs, this.requestTimeoutMs);
            this.instances.set(info.id, worker);
            const initPromise = worker.init(() => {
                this.instances.delete(info.id);
            }, timeoutMs ?? this.initTimeoutMs);
            this.pending.set(info.id, initPromise);
            let result: R;
            try {
                result = await initPromise;
            } catch {
                result = err();
            } finally {
                this.pending.delete(info.id);
            }
            if (result.isErr()) {
                this.instances.delete(info.id);
                acceptRequest.deny();
                return result;
            }
        }
        const socket = acceptRequest.accept();
        if (socket.isErr()) {
            return new Err(undefined);
        }
        worker.connect(socket.unwrap());
        return ok();
    }

    /** Destroys every agent instance and its worker. */
    stop(): void {
        for (const instance of [...this.instances.values()]) {
            instance.destroy();
        }
        this.instances.clear();
        this.pending.clear();
    }
}
