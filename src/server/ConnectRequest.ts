import { Connection, Err, ok, Ok, Result, Socket } from '@araminix/lib';

import { ClientInfo } from './AuthProvider.js';

export enum AcceptError {
    Write = 'Write',
    Staled = 'Staled',
}

export class ConnectRequest {
    readonly info: ClientInfo;
    private connection: Connection | undefined = undefined;
    private readonly onAccept?: () => void;
    readonly arg: string;

    constructor(connection: Connection, info: ClientInfo, onAccept?: () => void) {
        this.info = info;
        this.connection = connection;
        this.onAccept = onAccept;
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
        this.onAccept?.();
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
