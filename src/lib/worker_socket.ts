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

    constructor(port: MessagePort, deserialize: (data: unknown) => Req | Res | Rej | undefined) {
        super(port);
        this.deserialize = deserialize;
    }

    protected onMessage(data: unknown): void {
        if (this.readPromise) {
            this.readPromise(this.deserialize(data));
            this.readPromise = undefined;
        }
    }

    protected onClose(): void {
        if (this.readPromise) {
            this.readPromise(undefined);
            this.readPromise = undefined;
        }
    }

    protected onMessageError(_error: Error): void {
        if (this.readPromise) {
            this.readPromise(undefined);
            this.readPromise = undefined;
        }
    }

    async writeRead<TReq extends Req = Req, TRes extends Res = Res, TRej extends Rej = Rej>(input: TReq): Promise<Result<TRes, TRej | undefined>> {
        const wait = Promise.all([...this.blockPromise]);
        const [blockPromise, blockResolve] = deal<void>();
        this.blockPromise.push(blockPromise);
        await wait;

        const result = await new Promise<Req | Res | Rej | undefined>((res) => {
            if (!this.active) {
                res(undefined);
                return;
            }
            if (this.readPromise) {
                res(undefined);
                return;
            }
            if (this.send(input).isErr()) {
                res(undefined);
                return;
            }
            this.readPromise = res;
        });

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
    private latestMessage?: Req;

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
        if (this.readPromise) {
            this.readPromise(new Ok(message));
            return;
        }
        this.latestMessage = message;
    }

    protected onClose(): void {
        if (this.readPromise) {
            this.readPromise(new Err(undefined));
        }
    }

    protected onMessageError(_error: Error): void {}

    write<T = unknown>(response: (Res | Rej) | undefined): Result<void, T> {
        return this.send(response) as Result<void, T>;
    }

    resolve<TRes extends Res = Res, TErr = unknown>(response: TRes = new Res() as TRes): Result<void, TErr> {
        return this.send(response) as Result<void, TErr>;
    }

    reject<TRej extends Rej = Rej, TErr = unknown>(response: TRej = new Rej() as TRej): Result<void, TErr> {
        return this.send(response) as Result<void, TErr>;
    }

    read<TReq extends Req = Req>(): Promise<Result<TReq, undefined>> {
        return new Promise((res) => {
            if (!this.active) {
                res(new Err(undefined));
                return;
            }
            if (this.latestMessage) {
                res(new Ok(this.latestMessage as TReq));
                this.latestMessage = undefined;
                return;
            }
            this.readPromise = res as (value: Result<Req, undefined>) => void;
        });
    }
}
