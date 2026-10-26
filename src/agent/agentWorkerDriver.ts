import { Result } from '@araminix/lib';

import { Rej, Req, RequestSocket, Res } from '../lib/worker_socket.js';

export class AgentWorkerDriver {
    private requestSocket: RequestSocket;

    constructor(requestSocket: RequestSocket) {
        this.requestSocket = requestSocket;
    }

    request<TReq extends Req = Req, TRes extends Res = Res, TRej extends Rej = Rej>(input: TReq): Promise<Result<TRes, TRej | undefined>> {
        return this.requestSocket.writeRead(input);
    }

    destroy(): void {
        this.requestSocket.close();
    }
}

let workerDriverObj: AgentWorkerDriver;

export function initAgentWorkerDriver(requestSocket: RequestSocket): void {
    workerDriverObj = new AgentWorkerDriver(requestSocket);
}

export default function agentWorkerDriver(): AgentWorkerDriver {
    return workerDriverObj;
}
