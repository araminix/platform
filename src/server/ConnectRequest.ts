import { Connection, Err, ok, Ok, Result, Socket } from '@araminix/lib';

import { ClientInfo } from './AuthProvider.js';

/** Why {@link ConnectRequest.accept} or {@link ConnectRequest.deny} failed. */
export enum AcceptError {
    /** The accept message could not be written to the WebSocket (the client is already gone). */
    Write = 'Write',
    /** The request was already accepted or denied; every request can be decided once. */
    Staled = 'Staled',
}

/**
 * A WebSocket client waiting to be admitted to a named endpoint, as returned by {@link Endpoint.acquire}.
 *
 * Every request must be decided exactly once: {@link ConnectRequest.accept} turns it into a multiplexed `Socket`
 * (from `@araminix/lib`), {@link ConnectRequest.deny} closes the client's WebSocket with code 4403 (`WsCloseCodes.Denied`).
 * Until the request is accepted, a reconnect of the same client does not re-admit it.
 *
 * @example
 * ```ts
 * import { ClientType, loop, LoopResult } from '@araminix/platform';
 *
 * loop(async () => {
 *     const next = await platform.endpoint.acquire('chat'); // clients connect to /ws/chat or /ws/chat/:arg
 *     if (next.isErr()) return LoopResult.Stop;
 *     const request = next.unwrap();
 *     if (request.info.clientType !== ClientType.User) {
 *         request.deny();
 *         return LoopResult.Cont;
 *     }
 *     const socket = request.accept();
 *     if (socket.isOk()) serveChat(request.info, request.arg, socket.unwrap());
 *     return LoopResult.Cont;
 * });
 * ```
 */
export class ConnectRequest {
    /** The client, as resolved by {@link AuthProvider.getInfo} during the upgrade. */
    readonly info: ClientInfo;
    /** The pending connection; cleared once the request is decided. */
    private connection: Connection | undefined = undefined;
    /** Called after a successful accept (the controller uses it to re-admit later reconnects automatically). */
    private readonly onAccept?: () => void;
    /**
     * The optional `:arg` path segment of `/ws/:endpoint/:arg` (empty string when absent). {@link Platform} uses it as the
     * instance id on the `instance` endpoint.
     */
    readonly arg: string;

    /**
     * Created by {@link EndpointController}; applications receive instances from {@link Endpoint.acquire}.
     *
     * @param connection - The lib `Connection` that wraps the client's WebSocket.
     * @param info - The authenticated client.
     * @param onAccept - Optional callback run after a successful {@link ConnectRequest.accept}.
     */
    constructor(connection: Connection, info: ClientInfo, onAccept?: () => void) {
        this.info = info;
        this.connection = connection;
        this.onAccept = onAccept;
        this.arg = this.connection.arg;
    }

    /**
     * Admits the client and sends it the `accept_endpoint` message.
     *
     * @returns `Ok(socket)` on success; `Err(AcceptError.Staled)` if the request was already decided;
     *     `Err(AcceptError.Write)` if the client could not be reached (the connection is then destroyed).
     */
    accept(): Result<Socket, AcceptError> {
        if (!this.connection) {
            return new Err(AcceptError.Staled);
        }
        const connection = this.connection;
        this.connection = undefined;
        if (connection.accept().isErr()) {
            return new Err(AcceptError.Write);
        }
        this.onAccept?.();
        return new Ok(new Socket(connection));
    }

    /**
     * Refuses the client: its WebSocket is closed with code 4403 and the connection is destroyed.
     *
     * @returns `Ok` on success, `Err(AcceptError.Staled)` if the request was already decided.
     */
    deny(): Result<void, AcceptError> {
        if (!this.connection) {
            return new Err(AcceptError.Staled);
        }
        this.connection.deny();
        this.connection = undefined;
        return ok();
    }
}
