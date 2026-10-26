import { Result } from '@araminix/lib';

import { Rej, Req, RequestSocket, Res } from '../lib/worker_socket.js';

export class WorkerDriver {
    readonly userId: string;
    readonly profile: string | null;
    readonly appName: string;
    private requestSocket: RequestSocket;

    constructor(userId: string, profile: string | null, appName: string, requestSocket: RequestSocket) {
        this.userId = userId;
        this.profile = profile;
        this.appName = appName;
        this.requestSocket = requestSocket;
    }

    request<TReq extends Req = Req, TRes extends Res = Res, TRej extends Rej = Rej>(input: TReq): Promise<Result<TRes, TRej | undefined>> {
        return this.requestSocket.writeRead(input);
    }

    destroy(): void {
        this.requestSocket.close();
    }
}

let workerDriverObj: WorkerDriver;

export function initWorkerDriver(userId: string, profile: string | null, appName: string, requestSocket: RequestSocket): void {
    workerDriverObj = new WorkerDriver(userId, profile, appName, requestSocket);
}

export default function workerDriver(): WorkerDriver {
    return workerDriverObj;
}
