import { Result } from '@araminix/lib';

import { Rej, Req, RequestSocket, Res } from '../lib/worker_socket.js';

/**
 * Channel from a worker thread (app or agent) to the main thread for agent requests: `AgentTask`, `AgentList` and
 * `AcquireAgent`. {@link Agent} and {@link AgentFactory} use it through {@link agentWorkerDriver}.
 */
export class AgentWorkerDriver {
    /** Request socket towards the main thread. */
    private requestSocket: RequestSocket;

    /** @param requestSocket - Request socket towards the main thread. */
    constructor(requestSocket: RequestSocket) {
        this.requestSocket = requestSocket;
    }

    /**
     * Sends a request to the main thread and waits for the reply.
     *
     * @typeParam TReq - Request type.
     * @typeParam TRes - Success reply type.
     * @typeParam TRej - Failure reply type.
     * @param input - The request.
     * @returns The reply, or `Err` on failure.
     */
    request<TReq extends Req = Req, TRes extends Res = Res, TRej extends Rej = Rej>(input: TReq): Promise<Result<TRes, TRej | undefined>> {
        return this.requestSocket.writeRead(input);
    }

    /** Closes the channel. */
    destroy(): void {
        this.requestSocket.close();
    }
}

/** The driver of the current thread; unset in the main thread. */
let workerDriverObj: AgentWorkerDriver;

/**
 * Installs the agent driver of the current worker thread. Called by the worker entry files.
 *
 * @param requestSocket - Request socket towards the main thread.
 */
export function initAgentWorkerDriver(requestSocket: RequestSocket): void {
    workerDriverObj = new AgentWorkerDriver(requestSocket);
}

/** Returns the agent driver of the current worker thread (`undefined` in the main thread). */
export default function agentWorkerDriver(): AgentWorkerDriver {
    return workerDriverObj;
}
