import { Result } from '@araminix/lib';

import { Rej, Req, RequestSocket, Res } from '../lib/worker_socket.js';

/**
 * Facts about the app instance running in the current worker thread, plus its request channel to the main thread.
 * Obtain it with {@link workerDriver}.
 */
export class WorkerDriver {
    /** Owner of the instance ({@link ClientInfo.id}). */
    readonly userId: string;
    /** Launch profile, or `null`. */
    readonly profile: string | null;
    /** Name of the running app. */
    readonly appName: string;
    /** Request channel to the main thread. */
    private requestSocket: RequestSocket;

    /**
     * @param userId - Owner of the instance.
     * @param profile - Launch profile.
     * @param appName - Running app.
     * @param requestSocket - Request channel to the main thread.
     */
    constructor(userId: string, profile: string | null, appName: string, requestSocket: RequestSocket) {
        this.userId = userId;
        this.profile = profile;
        this.appName = appName;
        this.requestSocket = requestSocket;
    }

    /**
     * Sends a protocol request to the main thread and waits for the reply.
     *
     * @typeParam TReq - Request type.
     * @typeParam TRes - Success reply type.
     * @typeParam TRej - Failure reply type.
     * @param input - The request.
     */
    request<TReq extends Req = Req, TRes extends Res = Res, TRej extends Rej = Rej>(input: TReq): Promise<Result<TRes, TRej | undefined>> {
        return this.requestSocket.writeRead(input);
    }

    /** Closes the channel, which makes the main thread end the instance. */
    destroy(): void {
        this.requestSocket.close();
    }
}

/** The driver of the current app worker; unset in the main thread and in agent workers. */
let workerDriverObj: WorkerDriver;

/**
 * Installs the driver of the current app worker. Called by the worker entry file.
 *
 * @param userId - Owner of the instance.
 * @param profile - Launch profile.
 * @param appName - Running app.
 * @param requestSocket - Request channel to the main thread.
 */
export function initWorkerDriver(userId: string, profile: string | null, appName: string, requestSocket: RequestSocket): void {
    workerDriverObj = new WorkerDriver(userId, profile, appName, requestSocket);
}

/**
 * Returns the {@link WorkerDriver} of the app instance running in the current worker thread, e.g. to read the user id
 * and launch profile from code that has no access to an activity.
 *
 * @returns The driver; `undefined` (despite the type) outside an app worker thread.
 *
 * @example
 * ```ts
 * import { workerDriver } from '@araminix/platform';
 *
 * const { userId, profile, appName } = workerDriver();
 * ```
 */
export default function workerDriver(): WorkerDriver {
    return workerDriverObj;
}
