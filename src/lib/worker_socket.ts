import { deal, Err, Ok, Result } from '@araminix/lib';
import type { MessagePort } from 'worker_threads';

export enum MessageRole {
    Request = 0,
    Resolve = 1,
    Reject = 2,
}

abstract class Message {
    readonly _type: string = (this.constructor as typeof Message).name;
    abstract readonly _role: MessageRole;
    _rid?: number;
}

export abstract class Req extends Message {
    readonly _role = MessageRole.Request;
}

export class Res extends Message {
    readonly _role = MessageRole.Resolve;
}

export class Rej extends Message {
    readonly _role = MessageRole.Reject;
}

function readRid(data: unknown): number | undefined {
    const rid = (data as { _rid?: unknown } | null | undefined)?._rid;
    return typeof rid === 'number' ? rid : undefined;
}

abstract class WorkerSocket {
    private port: MessagePort;
    private _active: boolean = true;

    constructor(port: MessagePort) {
        this.port = port;
        this.port.addListener('message', (data: unknown) => {
            this.onMessage(data);
        });
        this.port.addListener('close', () => {
            this._active = false;
            this.onClose();
        });
        this.port.addListener('messageerror', (error: Error) => {
            this.onMessageError(error);
        });
    }

    get active(): boolean {
        return this._active;
    }

    protected send<T = unknown>(data: T): Result<void, unknown> {
        try {
            this.port.postMessage(data);
            return new Ok(undefined);
        } catch (e) {
            return new Err(e);
        }
    }

    close(): void {
        if (this._active) {
            this.port.close();
        }
    }

    protected abstract onMessage(data: unknown): void;
    protected abstract onClose(): void;
    protected abstract onMessageError(error: Error): void;
}

export class RequestSocket extends WorkerSocket {
    private deserialize: (data: unknown) => Req | Res | Rej | undefined;
    private blockPromise: Promise<void>[] = [];
    private readPromise?: (value: Req | Res | Rej | undefined) => void;
    private pendingRid?: number;
    private lastRid: number = 0;
    private timeoutMs: number;

    constructor(port: MessagePort, deserialize: (data: unknown) => Req | Res | Rej | undefined, timeoutMs: number = 0) {
        super(port);
        this.deserialize = deserialize;
        this.timeoutMs = timeoutMs;
    }

    protected onMessage(data: unknown): void {
        if (!this.readPromise) {
            return;
        }
        const rid = readRid(data);
        if (rid !== undefined && rid !== this.pendingRid) {
            // A late reply to a request that already timed out.
            return;
        }
        this.settle(this.deserialize(data));
    }

    protected onClose(): void {
        this.settle(undefined);
    }

    protected onMessageError(_error: Error): void {
        this.settle(undefined);
    }

    private settle(value: Req | Res | Rej | undefined): void {
        if (this.readPromise) {
            const resolve = this.readPromise;
            this.readPromise = undefined;
            this.pendingRid = undefined;
            resolve(value);
        }
    }

    async writeRead<TReq extends Req = Req, TRes extends Res = Res, TRej extends Rej = Rej>(
        input: TReq,
        timeoutMs: number = this.timeoutMs,
    ): Promise<Result<TRes, TRej | undefined>> {
        const wait = Promise.all([...this.blockPromise]);
        const [blockPromise, blockResolve] = deal<void>();
        this.blockPromise.push(blockPromise);
        await wait;

        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await new Promise<Req | Res | Rej | undefined>((res) => {
            if (!this.active) {
                res(undefined);
                return;
            }
            if (this.readPromise) {
                res(undefined);
                return;
            }
            const rid = ++this.lastRid;
            input._rid = rid;
            if (this.send(input).isErr()) {
                res(undefined);
                return;
            }
            this.pendingRid = rid;
            this.readPromise = res;
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    if (this.readPromise === res) {
                        this.settle(undefined);
                    }
                }, timeoutMs);
            }
        });
        if (timer !== undefined) {
            clearTimeout(timer);
        }

        blockResolve(undefined);
        this.blockPromise = this.blockPromise.filter((promise) => promise !== blockPromise);

        if (result instanceof Res) {
            return new Ok(result as TRes);
        }
        if (result instanceof Rej) {
            return new Err(result as TRej);
        }
        return new Err(undefined);
    }
}

export class ResponseSocket extends WorkerSocket {
    private deserialize: (data: unknown) => Req | Res | Rej | undefined;
    private readPromise?: (value: Result<Req, undefined>) => void;
    private queue: Req[] = [];
    private currentRid?: number;

    constructor(port: MessagePort, deserialize: (data: unknown) => Req | Res | Rej | undefined) {
        super(port);
        this.deserialize = deserialize;
    }

    protected onMessage(data: unknown): void {
        const message = this.deserialize(data);
        if (!(message instanceof Req)) {
            this.send(undefined);
            return;
        }
        message._rid = readRid(data);
        if (this.readPromise) {
            const resolve = this.readPromise;
            this.readPromise = undefined;
            this.currentRid = message._rid;
            resolve(new Ok(message));
            return;
        }
        this.queue.push(message);
    }

    protected onClose(): void {
        if (this.readPromise) {
            const resolve = this.readPromise;
            this.readPromise = undefined;
            resolve(new Err(undefined));
        }
    }

    protected onMessageError(_error: Error): void {}

    private reply<T>(response: (Res | Rej) | undefined): Result<void, T> {
        if (response) {
            response._rid = this.currentRid;
        }
        const result = this.send(response);
        if (result.isErr() && response) {
            // e.g. a DataCloneError: still answer, otherwise the requester waits forever.
            const fallback = new Rej();
            fallback._rid = this.currentRid;
            this.send(fallback);
        }
        return result as Result<void, T>;
    }

    write<T = unknown>(response: (Res | Rej) | undefined): Result<void, T> {
        return this.reply<T>(response);
    }

    resolve<TRes extends Res = Res, TErr = unknown>(response: TRes = new Res() as TRes): Result<void, TErr> {
        return this.reply<TErr>(response);
    }

    reject<TRej extends Rej = Rej, TErr = unknown>(response: TRej = new Rej() as TRej): Result<void, TErr> {
        return this.reply<TErr>(response);
    }

    read<TReq extends Req = Req>(): Promise<Result<TReq, undefined>> {
        return new Promise((res) => {
            if (!this.active) {
                res(new Err(undefined));
                return;
            }
            const next = this.queue.shift();
            if (next) {
                this.currentRid = next._rid;
                res(new Ok(next as TReq));
                return;
            }
            this.readPromise = res as (value: Result<Req, undefined>) => void;
        });
    }
}
