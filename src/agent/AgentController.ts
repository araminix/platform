import { CloseCodes, deal, Err, err, logger, loop, LoopResult, Ok, ok, once, R, Result, Socket, t } from '@araminix/lib';
import { MessageChannel, MessagePort, Worker } from 'worker_threads';

import { AcquireAgent, AgentList, AgentPost, AgentTask, Data, deserialize } from '../executor/proto.js';
import { RequestSocket, ResponseSocket } from '../lib/worker_socket.js';
import { AgentInfo } from '../server/AuthProvider.js';
import { ConnectRequest } from '../server/ConnectRequest.js';

export type AgentInit = {
    info: AgentInfo;
    responsePort: MessagePort;
    requestPort: MessagePort;
    workerIndexPath: string;
};

export class AgentInstance {
    private workerIndex: URL;
    readonly info: AgentInfo;
    private worker?: Worker = undefined;
    private requestSocket!: RequestSocket;
    private responseSocket!: ResponseSocket;
    private socket?: Socket = undefined;
    private onDestroy?: () => void = undefined;
    private timer?: NodeJS.Timeout = setInterval(() => {
        this.task('ping', '').then();
    }, 30000);
    private controller: AgentController;
    private initTimeoutMs: number;
    private requestTimeoutMs: number;

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

export default class AgentController {
    private workerIndex: URL;
    private instances: Map<string, AgentInstance> = new Map();
    private pending: Map<string, Promise<R>> = new Map();
    private initTimeoutMs: number;
    private requestTimeoutMs: number;

    constructor(workerIndex: URL, initTimeoutMs: number = 5000, requestTimeoutMs: number = 0) {
        this.workerIndex = workerIndex;
        this.initTimeoutMs = initTimeoutMs;
        this.requestTimeoutMs = requestTimeoutMs;
    }

    async task(id: string, taskName: string, data: t.Any | unknown, hp: number): Promise<Result<any, undefined>> {
        const worker = this.instances.get(id);
        if (!worker) {
            return new Err(undefined);
        }
        return await worker.task(taskName, data, hp);
    }

    list(type: string): string[] {
        return [...this.instances.values()].filter((instance) => instance.info.agentType === type).map((instance) => instance.info.id);
    }

    acquire(type: string, id: string): R {
        const agent = this.instances.get(id);
        if (agent && agent.info.agentType === type) {
            return ok();
        }
        return err();
    }

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

    stop(): void {
        for (const instance of [...this.instances.values()]) {
            instance.destroy();
        }
        this.instances.clear();
        this.pending.clear();
    }
}
