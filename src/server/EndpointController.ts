import { CloseCodes, Connection, deal, Err, Ok, Result, WsCloseCodes } from '@araminix/lib';
import { WebSocket } from 'ws';

import { ClientInfo } from './AuthProvider.js';
import { ConnectRequest } from './ConnectRequest.js';

/** Book-keeping for one connection: the token it was (last) opened with and whether the application accepted it. */
class ConnectionEntry {
    /** Token of the most recent (re)connect; used by {@link EndpointController.deauthUser}. */
    token: string;
    /** The lib connection that survives reconnects. */
    connection: Connection;
    /** `true` once the application accepted the request; reconnects are then re-accepted automatically. */
    accepted: boolean = false;

    /**
     * @param token - Session token used to open the connection.
     * @param connection - The lib connection.
     */
    constructor(token: string, connection: Connection) {
        this.token = token;
        this.connection = connection;
    }
}

/** Default for {@link EndpointControllerOptions.maxConnectionsPerClient}. */
const DEFAULT_MAX_CONNECTIONS_PER_CLIENT = 32;
/** Default for {@link EndpointControllerOptions.maxPendingStreams}. */
const DEFAULT_MAX_PENDING_STREAMS = 64;
const POLICY_VIOLATION = 1008; // WebSocket close code; the client library retries it with backoff

/**
 * Limits applied by an {@link EndpointController}. {@link Endpoint} builds them from
 * {@link EndpointOptions.maxConnectionsPerClient} and {@link EndpointOptions.maxPendingStreams}.
 */
export interface EndpointControllerOptions {
    /** Distinct connections (args) one client may hold on this endpoint; 0 disables the cap. Default 32. */
    maxConnectionsPerClient?: number;
    /** Unaccepted stream requests per connection (needs @araminix/lib >= 1.4); 0 disables the cap. Default 64. */
    maxPendingStreams?: number;
}

/**
 * Admission queue of one named WebSocket endpoint (for example `platform`). {@link Endpoint.declare} creates one per name.
 *
 * Connections are identified by `clientType/runtimeId/arg`. A new identity is queued as a {@link ConnectRequest} until
 * the application takes it with {@link EndpointController.acquire}; a known identity (a reconnect within the lib's resume
 * window) replaces the previous WebSocket of that connection, keeping its streams, and is re-accepted automatically if it
 * had been accepted before.
 *
 * @remarks
 * Only new identities count against `maxConnectionsPerClient`; a client over the cap is closed with code 1008
 * (`Too many connections`). Disconnected connections stay registered until the lib connection dies (its resume window,
 * 5 minutes by default), which is why the cap exists.
 *
 * @example
 * ```ts
 * import { EndpointController } from '@araminix/platform';
 *
 * // Applications normally use Endpoint.acquire(name), which owns one controller per name.
 * // Driving a controller directly (for example in a test with a `ws` WebSocket):
 * const controller = new EndpointController({ maxConnectionsPerClient: 4 });
 * await controller.connect(ws, 'session-token', userInfo, '');
 * const request = (await controller.acquire()).unwrap();
 * const socket = request.accept().unwrap();
 * ```
 */
export default class EndpointController {
    /** Known connections by `clientType/runtimeId/arg`. */
    private connections: Map<string, ConnectionEntry> = new Map();
    /** New connections waiting for {@link EndpointController.acquire}. */
    private connectionQueue: ConnectRequest[] = [];
    /** Resolver of the single pending {@link EndpointController.acquire} call, if any. */
    private promise?: (result: Result<ConnectRequest, void>) => void;
    /** Effective per-client cap (0 = unlimited). */
    private readonly maxConnectionsPerClient: number;
    /** Effective pending-stream cap per connection (0 = unlimited). */
    private readonly maxPendingStreams: number;

    /**
     * @param options - Connection and stream limits; omitted fields use the defaults (32 and 64).
     */
    constructor(options: EndpointControllerOptions = {}) {
        this.maxConnectionsPerClient = options.maxConnectionsPerClient ?? DEFAULT_MAX_CONNECTIONS_PER_CLIENT;
        this.maxPendingStreams = options.maxPendingStreams ?? DEFAULT_MAX_PENDING_STREAMS;
    }

    /** Counts the registered connections whose id starts with `clientId/` (`clientType/runtimeId`). */
    private countClientConnections(clientId: string): number {
        let count = 0;
        for (const connectionId of this.connections.keys()) {
            if (connectionId.startsWith(`${clientId}/`)) {
                count++;
            }
        }
        return count;
    }

    /**
     * Waits for the next new connection.
     *
     * Resolves immediately when a request is already queued. There is room for one waiter only: calling `acquire()` again
     * while a call is pending resolves the earlier call with `Err(undefined)`. Each endpoint name therefore needs exactly one
     * consumer loop (the {@link Platform} loops stop on `Err`).
     *
     * @returns `Ok(request)` for the next client, or `Err(undefined)` when superseded by another `acquire()` call.
     */
    acquire(): Promise<Result<ConnectRequest, void>> {
        const [promise, resolve] = deal<Result<ConnectRequest, void>>();
        if (this.promise) {
            this.promise(new Err(undefined));
        }
        const conn = this.connectionQueue.shift();
        if (conn) {
            resolve(new Ok(conn));
            return promise;
        }
        this.promise = resolve;
        return promise;
    }

    /** Registers a new connection and hands its request to the waiting `acquire()` call or queues it. */
    private addConnection(connectionEntry: ConnectionEntry, connectionId: string, info: ClientInfo): void {
        this.connections.set(connectionId, connectionEntry);
        const request = new ConnectRequest(connectionEntry.connection, info, () => {
            connectionEntry.accepted = true;
        });
        if (this.promise) {
            this.promise(new Ok(request));
            this.promise = undefined;
            return;
        }
        this.connectionQueue.push(request);
    }

    /**
     * Attaches an authenticated WebSocket to this endpoint. Called by {@link Endpoint} after the upgrade; applications do not
     * call it.
     *
     * For a new identity this creates a lib `Connection` and queues a {@link ConnectRequest} (or closes the socket with 1008
     * when the client is over its cap). For a known identity it swaps in the new socket, records the new token and repeats
     * `accept_endpoint` if the application had accepted the connection.
     *
     * @param ws - The upgraded WebSocket.
     * @param token - Session token used for the upgrade.
     * @param info - The authenticated client.
     * @param arg - The `:arg` path segment, or `''`.
     */
    async connect(ws: WebSocket, token: string, info: ClientInfo, arg: string): Promise<void> {
        const id = `${info.clientType}/${info.runtimeId}`;
        const connectionId = `${id}/${arg}`;
        let connectionEntry = this.connections.get(connectionId);
        if (!connectionEntry) {
            // Reconnects reuse their entry; only new args count against the cap. Disconnected connections linger
            // for the resume window, so without a cap one client could pile up connections with arbitrary args.
            if (this.maxConnectionsPerClient > 0 && this.countClientConnections(id) >= this.maxConnectionsPerClient) {
                ws.close(POLICY_VIOLATION, 'Too many connections');
                return;
            }
            const driver = {
                maxPendingStreams: this.maxPendingStreams > 0 ? this.maxPendingStreams : undefined,
                onDisconnect: (code: number) => {
                    switch (code) {
                        case WsCloseCodes.ConcurrentConnection: {
                            connectionEntry?.connection.destroy(CloseCodes.Unexpected);
                            break;
                        }
                        case WsCloseCodes.Denied: {
                            connectionEntry?.connection.destroy(CloseCodes.Unexpected);
                            break;
                        }
                        case WsCloseCodes.Normal: {
                            connectionEntry?.connection.destroy(CloseCodes.Intentional);
                            break;
                        }
                        case WsCloseCodes.Unauthorized: {
                            connectionEntry?.connection.destroy(CloseCodes.Unauthorized);
                            break;
                        }
                        case WsCloseCodes.NotFound: {
                            connectionEntry?.connection.destroy(CloseCodes.Unexpected);
                            break;
                        }
                    }
                },
                onDestroy: () => {
                    this.connectionQueue = this.connectionQueue.filter(
                        (connection) => !(connection.arg === arg && `${connection.info.clientType}/${connection.info.runtimeId}` === id),
                    );
                    this.connections.delete(connectionId);
                },
                onAccept: () => {},
            };
            connectionEntry = new ConnectionEntry(token, new Connection(driver, arg));
            this.addConnection(connectionEntry, connectionId, info);
            connectionEntry.connection.connect(ws as any);
            return;
        }
        connectionEntry.token = token;
        connectionEntry.connection.connect(ws as any);
        // Only repeat accept_endpoint for connections the app already accepted; pending ones wait for its decision.
        if (connectionEntry.accepted) {
            connectionEntry.connection.accept();
        }
    }

    /**
     * Destroys (with `CloseCodes.Unauthorized`) every connection of this client whose latest token is `token`. Called on
     * logout (`DELETE /auth`).
     *
     * @typeParam INFO - Client info type.
     * @param info - The client that logged out.
     * @param token - The session token that was destroyed.
     */
    deauthUser<INFO extends ClientInfo>(info: INFO, token: string): void {
        const connectionId = `${info.clientType}/${info.runtimeId}/`;
        this.connections.forEach((connectionEntry, id) => {
            if (id.startsWith(connectionId) && connectionEntry.token === token) {
                connectionEntry.connection.destroy(CloseCodes.Unauthorized);
            }
        });
    }
}
