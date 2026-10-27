import { CloseCodes, Connection, deal, Err, Ok, Result, WsCloseCodes } from '@araminix/lib';
import { WebSocket } from 'ws';

import { ClientInfo } from './AuthProvider.js';
import { ConnectRequest } from './ConnectRequest.js';

class ConnectionEntry {
    token: string;
    connection: Connection;
    accepted: boolean = false;

    constructor(token: string, connection: Connection) {
        this.token = token;
        this.connection = connection;
    }
}

const DEFAULT_MAX_CONNECTIONS_PER_CLIENT = 32;
const DEFAULT_MAX_PENDING_STREAMS = 64;
const POLICY_VIOLATION = 1008; // WebSocket close code; the client library retries it with backoff

export interface EndpointControllerOptions {
    /** Distinct connections (args) one client may hold on this endpoint; 0 disables the cap. Default 32. */
    maxConnectionsPerClient?: number;
    /** Unaccepted stream requests per connection (needs @araminix/lib >= 1.4); 0 disables the cap. Default 64. */
    maxPendingStreams?: number;
}

export default class EndpointController {
    private connections: Map<string, ConnectionEntry> = new Map();
    private connectionQueue: ConnectRequest[] = [];
    private promise?: (result: Result<ConnectRequest, void>) => void;
    private readonly maxConnectionsPerClient: number;
    private readonly maxPendingStreams: number;

    constructor(options: EndpointControllerOptions = {}) {
        this.maxConnectionsPerClient = options.maxConnectionsPerClient ?? DEFAULT_MAX_CONNECTIONS_PER_CLIENT;
        this.maxPendingStreams = options.maxPendingStreams ?? DEFAULT_MAX_PENDING_STREAMS;
    }

    private countClientConnections(clientId: string): number {
        let count = 0;
        for (const connectionId of this.connections.keys()) {
            if (connectionId.startsWith(`${clientId}/`)) {
                count++;
            }
        }
        return count;
    }

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

    deauthUser<INFO extends ClientInfo>(info: INFO, token: string): void {
        const connectionId = `${info.clientType}/${info.runtimeId}/`;
        this.connections.forEach((connectionEntry, id) => {
            if (id.startsWith(connectionId) && connectionEntry.token === token) {
                connectionEntry.connection.destroy(CloseCodes.Unauthorized);
            }
        });
    }
}
