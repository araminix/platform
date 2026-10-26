import { Connection, Err, ok, Ok, Result, Socket } from '@araminix/lib';

import { ClientInfo } from './AuthProvider.js';

export enum AcceptError {
    Write = 'Write',
    Staled = 'Staled',
}

export class ConnectRequest {
    readonly info: ClientInfo;
    private connection: Connection | undefined = undefined;
    readonly arg: string;

    constructor(connection: Connection, info: ClientInfo) {
        this.info = info;
        this.connection = connection;
        this.arg = this.connection.arg;
    }

    accept(): Result<Socket, AcceptError> {
        if (!this.connection) {
            return new Err(AcceptError.Staled);
        }
        const connection = this.connection;
        this.connection = undefined;
        if (connection.accept().isErr()) {
            return new Err(AcceptError.Write);
        }
        return new Ok(new Socket(connection));
    }

    deny(): Result<void, AcceptError> {
        if (!this.connection) {
            return new Err(AcceptError.Staled);
        }
        this.connection.deny();
        this.connection = undefined;
        return ok();
    }
}
