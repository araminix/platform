import { deal, Err, err, logger, Ok, ok, once, R, Result, Socket, StreamCloseCodes, t, uuid } from '@araminix/lib';
import { MessageChannel, ResourceLimits, Worker } from 'worker_threads';

import AgentController from '../agent/AgentController.js';
import { Rej, RequestSocket, Res, ResponseSocket } from '../lib/worker_socket.js';
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

enum Status {
    Created = 0,
    Initiating = 1,
    Initiated = 2,
    Destroyed = 3,
}

enum IncomingStreamErr {
    Format = 'Format',
    Execution = 'Execution',
}

export default class Instance {
    readonly userId: string;
    readonly appName: string;
    readonly profile: string | null;
    readonly appIndexPath: URL;
    readonly tabLimit: number;
    readonly agentController: AgentController;
    readonly resourceLimits?: ResourceLimits;
    readonly terminationGracePeriodMs: number;
    private worker?: Worker = undefined;
    private requestSocket?: RequestSocket = undefined;
    private responseSocket?: ResponseSocket = undefined;
    private status: Status = Status.Created;
    readonly id: string = uuid();
    appTitle: string = '';
    activityTitle?: string = undefined;
    private onDestroy?: () => void = undefined;
    private _touched: number = Date.now();
    private userSocket?: Socket = undefined;
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
    ) {
        this.userId = userId;
        this.appName = appName;
        this.profile = profile;
        this.appIndexPath = appIndexPath;
        this.tabLimit = tabLimit;
        this.agentController = agentController;
        this.resourceLimits = resourceLimits;
        this.terminationGracePeriodMs = terminationGracePeriodMs;
    }

    get isDestroyed(): boolean {
        return this.status === Status.Destroyed;
    }

    get touched(): number {
        return this._touched;
    }

    touch(time: number = Date.now()): void {
        this._touched = time;
    }

    connect(socket: Socket): void {
        this.touch();
        if (this.userSocket) {
            this.userSocket.destroy();
        }
        this.userSocket = socket;
        once(async () => {
            this.processStream(socket, 'load', () => this.load()).catch((err) => {
                logger.error('Unhandled error in processStream load:', err);
            });
            this.processStream(socket, 'reload', (args) => this.reload(args)).catch((err) => {
                logger.error('Unhandled error in processStream reload:', err);
            });
            this.processStream(socket, 'prev', (args) => this.prev(args)).catch((err) => {
                logger.error('Unhandled error in processStream prev:', err);
            });
            this.processStream(socket, 'close', (args) => this.close(args)).catch((err) => {
                logger.error('Unhandled error in processStream close:', err);
            });
            this.processStream(socket, 'switch', (args) => this.switchActive(args)).catch((err) => {
                logger.error('Unhandled error in processStream switch:', err);
            });
            this.processStream(socket, 'action', (args) => this.action(args)).catch((err) => {
                logger.error('Unhandled error in processStream action:', err);
            });
            this.processStream(socket, 'query', (args) => this.query(args)).catch((err) => {
                logger.error('Unhandled error in processStream query:', err);
            });
            this.processStream(socket, 'refresh', (args) => this.refresh(args)).catch((err) => {
                logger.error('Unhandled error in processStream refresh:', err);
            });
            await socket.waitClose();
            if (this.userSocket === socket) {
                this.userSocket = undefined;
            }
        });
    }

    private async load(): Promise<Result<void, IncomingStreamErr>> {
        if (!this.requestSocket) {
            return new Err(IncomingStreamErr.Execution);
        }
        const result = await this.requestSocket.writeRead(new Load());
        if (result.isErr()) {
            return new Err(IncomingStreamErr.Execution);
        }
        return ok();
    }

    private async reload(args: unknown): Promise<Result<void, IncomingStreamErr>> {
        if (typeof args !== 'string') {
            return new Err(IncomingStreamErr.Format);
        }
        if (!this.requestSocket) {
            return new Err(IncomingStreamErr.Execution);
        }
        const result = await this.requestSocket.writeRead(new Reload(args));
        if (result.isErr()) {
            return new Err(IncomingStreamErr.Execution);
        }
        return ok();
    }

    private async prev(args: unknown): Promise<Result<void, IncomingStreamErr>> {
        if (typeof args !== 'string') {
            return new Err(IncomingStreamErr.Format);
        }
        if (!this.requestSocket) {
            return new Err(IncomingStreamErr.Execution);
        }
        const result = await this.requestSocket.writeRead(new Prev(args));
        if (result.isErr()) {
            return new Err(IncomingStreamErr.Execution);
        }
        return ok();
    }

    private async close(args: unknown): Promise<Result<void, IncomingStreamErr>> {
        if (typeof args !== 'string') {
            return new Err(IncomingStreamErr.Format);
        }
        if (!this.requestSocket) {
            return new Err(IncomingStreamErr.Execution);
        }
        const result = await this.requestSocket.writeRead(new Close(args));
        if (result.isErr()) {
            return new Err(IncomingStreamErr.Execution);
        }
        return ok();
    }

    private async switchActive(args: unknown): Promise<Result<void, IncomingStreamErr>> {
        if (typeof args !== 'string') {
            return new Err(IncomingStreamErr.Format);
        }
        if (!this.requestSocket) {
            return new Err(IncomingStreamErr.Execution);
        }
        const result = await this.requestSocket.writeRead(new Switch(args));
        if (result.isErr()) {
            return new Err(IncomingStreamErr.Execution);
        }
        return ok();
    }

    private async refresh(args: unknown): Promise<Result<void, IncomingStreamErr>> {
        if (typeof args !== 'string') {
            return new Err(IncomingStreamErr.Format);
        }
        if (!this.requestSocket) {
            return new Err(IncomingStreamErr.Execution);
        }
        const result = await this.requestSocket.writeRead(new Refresh(args));
        if (result.isErr()) {
            return new Err(IncomingStreamErr.Execution);
        }
        return ok();
    }

    private async action(args: unknown): Promise<Result<void, IncomingStreamErr>> {
        const argsType = t.type({
            fragmentId: t.string,
            name: t.string,
            data: t.unknown,
        });
        if (!argsType.is(args)) {
            return new Err(IncomingStreamErr.Format);
        }
        if (!this.requestSocket) {
            return new Err(IncomingStreamErr.Execution);
        }
        const result = await this.requestSocket.writeRead(new Action(args.fragmentId, args.name, args.data));
        if (result.isErr()) {
            return new Err(IncomingStreamErr.Execution);
        }
        return ok();
    }

    private async query(args: unknown): Promise<Result<unknown, IncomingStreamErr>> {
        const argsType = t.type({
            fragmentId: t.string,
            name: t.string,
            data: t.unknown,
        });
        if (!argsType.is(args)) {
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
        this.requestSocket = new RequestSocket(requestChannel.port1, deserialize);
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
        if (!this.userSocket || !this.responseSocket) {
            this.responseSocket?.write(new Rej());
            return;
        }
        const streamResult = await this.userSocket.outgoingStream(name, arg);
        if (streamResult.isErr()) {
            this.responseSocket.write(new Rej());
            return;
        }
        const stream = streamResult.unwrap();
        const closeCode = await stream.waitClose();
        if (closeCode !== StreamCloseCodes.Normal) {
            this.responseSocket.write(new Rej());
            return;
        }
        this.responseSocket.write(new Res());
    }

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
                    await this.outgoingStream(`update-${sendUpdate.data.fragmentId}`, {
                        data: sendUpdate.data.data,
                        type: sendUpdate.data.type,
                    });
                    break;
                }
            }
        }
        this.destroy();
    }
}
