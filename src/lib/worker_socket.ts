import { deal, Err, Ok, Result } from '@araminix/lib';
import type { MessagePort } from 'worker_threads';

/** Role of a message on a worker port. */
export enum MessageRole {
    /** A request ({@link Req}). */
    Request = 0,
    /** A successful reply ({@link Res}). */
    Resolve = 1,
    /** A failed reply ({@link Rej}). */
    Reject = 2,
}

/**
 * Returns the wire name of a class: its own `static typeName` when declared, otherwise its `name`.
 *
 * Worker messages are tagged with this name (`_type`) and fragments send it to the front-end as their component type.
 * Bundlers and minifiers rename classes, so declare `static typeName` on every class whose name must survive a minified
 * build. Only a class's *own* `typeName` counts: a subclass without one falls back to its own class name instead of
 * inheriting the parent's.
 *
 * @param typeClass - The class (constructor).
 * @returns The wire name.
 *
 * @example
 * ```ts
 * class Chart extends Fragment<{ styles?: string[] }> {
 *     static readonly typeName = 'Chart'; // stays 'Chart' even if the class is renamed to `a` by a minifier
 *     load() {}
 * }
 * typeNameOf(Chart); // 'Chart'
 * ```
 */
export function typeNameOf(typeClass: { readonly name: string; readonly typeName?: string }): string {
    // Only a class's own typeName counts, so an undeclared subclass is not mistaken for its parent.
    return Object.prototype.hasOwnProperty.call(typeClass, 'typeName') && typeClass.typeName ? typeClass.typeName : typeClass.name;
}

/** Base of all worker messages: a wire type name, a role and a request id used to match replies to requests. */
abstract class Message {
    /** Wire name of the class; see {@link typeNameOf}. */
    static readonly typeName?: string;
    /** Wire name of this message's class, used by deserializers. */
    readonly _type: string = typeNameOf(this.constructor as typeof Message);
    /** Request, resolve or reject. */
    abstract readonly _role: MessageRole;
    /** Request id; set by the sockets, copied from a request to its reply. */
    _rid?: number;
}

/**
 * Base class of requests sent with {@link RequestSocket.writeRead}. Subclasses should declare `static typeName`.
 *
 * @example
 * ```ts
 * class Ping extends Req {
 *     static readonly typeName = 'Ping';
 *     constructor(readonly payload: string) {
 *         super();
 *     }
 * }
 * ```
 */
export abstract class Req extends Message {
    readonly _role = MessageRole.Request;
}

/** A successful reply; subclass it to carry data (for example `Data` in the executor protocol). */
export class Res extends Message {
    /** Wire name. */
    static readonly typeName: string = 'Res';
    readonly _role = MessageRole.Resolve;
}

/** A failed reply; also sent automatically when a reply cannot be posted (for example not cloneable). */
export class Rej extends Message {
    /** Wire name. */
    static readonly typeName: string = 'Rej';
    readonly _role = MessageRole.Reject;
}

/** Reads the numeric request id of a raw message, if any. */
function readRid(data: unknown): number | undefined {
    const rid = (data as { _rid?: unknown } | null | undefined)?._rid;
    return typeof rid === 'number' ? rid : undefined;
}

/** Wraps one `MessagePort` and tracks whether it is still open. */
abstract class WorkerSocket {
    /** The wrapped port. */
    private port: MessagePort;
    /** `false` once the port closed. */
    private _active: boolean = true;

    /** @param port - The port to wrap; its `message`, `close` and `messageerror` events are forwarded to the subclass. */
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

    /** Whether the port is still open. */
    get active(): boolean {
        return this._active;
    }

    /** Posts `data` on the port; `Err` with the exception when posting fails (e.g. `DataCloneError`). */
    protected send<T = unknown>(data: T): Result<void, unknown> {
        try {
            this.port.postMessage(data);
            return new Ok(undefined);
        } catch (e) {
            return new Err(e);
        }
    }

    /** Closes the port (both ends observe `close`). */
    close(): void {
        if (this._active) {
            this.port.close();
        }
    }

    /** Handles an incoming message. */
    protected abstract onMessage(data: unknown): void;
    /** Handles the port closing. */
    protected abstract onClose(): void;
    /** Handles a message that could not be deserialized by the port. */
    protected abstract onMessageError(error: Error): void;
}

/**
 * Request side of a worker channel: sends one {@link Req} at a time and waits for its {@link Res} or {@link Rej}.
 *
 * Concurrent `writeRead` calls are queued and sent in call order. Every request gets a fresh id (`_rid`); a reply that
 * belongs to an earlier, timed-out request is ignored instead of being taken as the answer to the current one.
 *
 * @example
 * ```ts
 * import { MessageChannel } from 'node:worker_threads';
 *
 * const { port1, port2 } = new MessageChannel();
 * const requests = new RequestSocket(port1, deserialize, 5_000);
 * const responses = new ResponseSocket(port2, deserialize);
 *
 * const reply = requests.writeRead(new Ping('hello'));
 * const request = await responses.read<Ping>();
 * responses.resolve(new Pong(request.unwrap().payload));
 * console.log((await reply).isOk()); // true
 * ```
 */
export class RequestSocket extends WorkerSocket {
    /** Turns a raw message back into a class instance. */
    private deserialize: (data: unknown) => Req | Res | Rej | undefined;
    /** Requests in flight or queued; each call waits for the earlier ones. */
    private blockPromise: Promise<void>[] = [];
    /** Resolver of the request waiting for its reply. */
    private readPromise?: (value: Req | Res | Rej | undefined) => void;
    /** Id of the request waiting for its reply. */
    private pendingRid?: number;
    /** Last id handed out. */
    private lastRid: number = 0;
    /** Default reply timeout in milliseconds (0 = wait forever). */
    private timeoutMs: number;

    /**
     * @param port - Port to send requests on.
     * @param deserialize - Maps a raw message (matched by `_type`) to an instance of the right class, or `undefined`.
     * @param timeoutMs - Default reply timeout in milliseconds; `0` waits forever.
     */
    constructor(port: MessagePort, deserialize: (data: unknown) => Req | Res | Rej | undefined, timeoutMs: number = 0) {
        super(port);
        this.deserialize = deserialize;
        this.timeoutMs = timeoutMs;
    }

    /** Settles the pending request with the reply, unless the reply carries the id of another request. */
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

    /** Fails the pending request. */
    protected onClose(): void {
        this.settle(undefined);
    }

    /** Fails the pending request. */
    protected onMessageError(_error: Error): void {
        this.settle(undefined);
    }

    /** Resolves the pending request once. */
    private settle(value: Req | Res | Rej | undefined): void {
        if (this.readPromise) {
            const resolve = this.readPromise;
            this.readPromise = undefined;
            this.pendingRid = undefined;
            resolve(value);
        }
    }

    /**
     * Sends a request and waits for its reply (after all earlier `writeRead` calls finished).
     *
     * @typeParam TReq - Request type.
     * @typeParam TRes - Expected success reply type.
     * @typeParam TRej - Expected failure reply type.
     * @param input - The request; its `_rid` is overwritten.
     * @param timeoutMs - Reply timeout in milliseconds for this call; `0` waits forever.
     * @returns `Ok(reply)` for a {@link Res}; `Err(reply)` for a {@link Rej}; `Err(undefined)` on timeout, a closed port, a
     *     failed send or an unexpected message.
     */
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

/**
 * Response side of a worker channel: reads {@link Req}s in arrival order and answers each one.
 *
 * Answer every request you {@link ResponseSocket.read} exactly once (with `resolve`, `reject` or `write`) before reading
 * the next one: the reply is tagged with the id of the request read last. Messages that are not requests are answered
 * immediately with an empty message.
 */
export class ResponseSocket extends WorkerSocket {
    /** Turns a raw message back into a class instance. */
    private deserialize: (data: unknown) => Req | Res | Rej | undefined;
    /** Resolver of a pending `read()`. */
    private readPromise?: (value: Result<Req, undefined>) => void;
    /** Requests that arrived while nobody was reading. */
    private queue: Req[] = [];
    /** Id of the request read last; copied to the next reply. */
    private currentRid?: number;

    /**
     * @param port - Port to receive requests on.
     * @param deserialize - Maps a raw message to an instance of the right class, or `undefined`.
     */
    constructor(port: MessagePort, deserialize: (data: unknown) => Req | Res | Rej | undefined) {
        super(port);
        this.deserialize = deserialize;
    }

    /** Queues a request or hands it to the pending `read()`; answers non-requests with an empty message. */
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

    /** Fails a pending `read()`. */
    protected onClose(): void {
        if (this.readPromise) {
            const resolve = this.readPromise;
            this.readPromise = undefined;
            resolve(new Err(undefined));
        }
    }

    /** Ignored. */
    protected onMessageError(_error: Error): void {}

    /** Sends the reply for the current request; if it cannot be posted, sends a plain {@link Rej} so the requester is not left waiting. */
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

    /**
     * Sends `response` (or an empty message) as the reply to the current request.
     *
     * @typeParam T - Error type of the result.
     * @param response - Reply, or `undefined`.
     * @returns `Err` when the reply could not be posted (a fallback {@link Rej} was sent instead).
     */
    write<T = unknown>(response: (Res | Rej) | undefined): Result<void, T> {
        return this.reply<T>(response);
    }

    /**
     * Answers the current request successfully.
     *
     * @typeParam TRes - Reply type.
     * @typeParam TErr - Error type of the result.
     * @param response - Reply; a plain {@link Res} by default.
     * @returns `Err` when the reply could not be posted (a fallback {@link Rej} was sent instead).
     */
    resolve<TRes extends Res = Res, TErr = unknown>(response: TRes = new Res() as TRes): Result<void, TErr> {
        return this.reply<TErr>(response);
    }

    /**
     * Answers the current request with a failure.
     *
     * @typeParam TRej - Reply type.
     * @typeParam TErr - Error type of the result.
     * @param response - Reply; a plain {@link Rej} by default.
     * @returns `Err` when the reply could not be posted.
     */
    reject<TRej extends Rej = Rej, TErr = unknown>(response: TRej = new Rej() as TRej): Result<void, TErr> {
        return this.reply<TErr>(response);
    }

    /**
     * Returns the next request, waiting for one if necessary.
     *
     * @typeParam TReq - Expected request type.
     * @returns `Ok(request)`, or `Err(undefined)` when the port is closed.
     */
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
