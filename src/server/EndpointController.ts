import { CloseCodes, Connection, deal, Err, Ok, Result, WsCloseCodes } from '@araminix/lib';
import { WebSocket } from 'ws';

import { ClientInfo } from './AuthProvider.js';
import { ConnectRequest } from './ConnectRequest.js';

class ConnectionEntry {
    token: string;
    connection: Connection;

    constructor(token: string, connection: Connection) {
        this.token = token;
        this.connection = connection;
    }
}

export default class EndpointController {
    private connections: Map<string, ConnectionEntry> = new Map();
    private connectionQueue: ConnectRequest[] = [];
    private promise?: (result: Result<ConnectRequest, void>) => void;

    constructor() {}

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
        if (this.promise) {
            this.promise(new Ok(new ConnectRequest(connectionEntry.connection, info)));
            this.promise = undefined;
            return;
        }
        this.connectionQueue.push(new ConnectRequest(connectionEntry.connection, info));
    }

    async connect(ws: WebSocket, token: string, info: ClientInfo, arg: string): Promise<void> {
        const id = `${info.clientType}/${info.runtimeId}`;
        const connectionId = `${id}/${arg}`;
        let connectionEntry = this.connections.get(connectionId);
        if (!connectionEntry) {
            const driver = {
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
        connectionEntry.connection.accept();
    }

    deauthUser<INFO extends ClientInfo>(info: INFO, token: string): void {
        const connectionId = `${info.clientType}/${info.runtimeId}`;
        this.connections.forEach((connectionEntry, id) => {
            if (id.startsWith(connectionId) && connectionEntry.token === token) {
                connectionEntry.connection.destroy(CloseCodes.Unauthorized);
            }
        });
    }
}
