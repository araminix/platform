/**
 * Entry file of app worker threads (one per app instance), started by `Instance.init`.
 *
 * It waits for the `WorkerInit` message, imports the app index, finds the app by name, installs the worker and agent
 * drivers, reports the app title to the main thread and then serves requests until its channel closes.
 *
 * @module
 */
import { logger } from '@araminix/lib';
import { parentPort } from 'worker_threads';

import { initAgentWorkerDriver } from '../agent/agentWorkerDriver.js';
import { App } from '../lib/d.js';
import { Req, RequestSocket, ResponseSocket } from '../lib/worker_socket.js';
import { AppInstance } from './AppInstance.js';
import { Action, Close, Data, deserialize, Load, Other, Prev, Query, Refresh, Reload, Switch } from './proto.js';
import { initWorkerDriver } from './workerDriver.js';

/** Serves the main thread's requests for one app instance. */
class Worker {
    /** Requests to the main thread. */
    private requestSocket: RequestSocket;
    /** Requests from the main thread. */
    private responseSocket: ResponseSocket;
    /** Owner of the instance. */
    private userId: string;
    /** Activity limit. */
    private tabLimit: number;
    /** The running app. */
    private app: AppInstance;

    /**
     * @param requestSocket - Requests to the main thread.
     * @param responseSocket - Requests from the main thread.
     * @param app - The app to run.
     * @param userId - Owner of the instance.
     * @param tabLimit - Activity limit.
     */
    constructor(requestSocket: RequestSocket, responseSocket: ResponseSocket, app: App<any, any>, userId: string, tabLimit: number) {
        this.requestSocket = requestSocket;
        this.responseSocket = responseSocket;
        this.userId = userId;
        this.tabLimit = tabLimit;
        this.app = new AppInstance(app, this.tabLimit);
    }

    /**
     * Opens the main page, then handles requests one at a time under the app lock until the channel closes. An exception in
     * app code fails that request with {@link Other} and the instance keeps serving.
     */
    async run(): Promise<void> {
        await this.app.exclusive(() => this.app.init());
        while (true) {
            const result = await this.responseSocket.read();
            if (result.isErr()) {
                break;
            }
            const request = result.unwrap();
            if (request === undefined) {
                break;
            }
            try {
                // Requests share the app lock with trigger() calls from timers, so they never interleave.
                await this.app.exclusive(() => this.handle(request));
            } catch (error) {
                // An exception in app code fails this request only; the instance keeps serving.
                logger.error(`App worker failed to handle ${request?._type}:`, error);
                this.responseSocket.reject(new Other(error instanceof Error ? error.message : String(error)));
            }
        }
    }

    /** Dispatches one request to the {@link AppInstance} and answers it. */
    private async handle(request: Req): Promise<void> {
        switch (true) {
            case request instanceof Reload: {
                const res = await this.app.reload();
                if (res?.isOk()) {
                    this.responseSocket.resolve();
                    break;
                }
                this.responseSocket.reject();
                break;
            }
            case request instanceof Switch: {
                const switchActive = request as Switch;
                const res = await this.app.switch(switchActive.activityId);
                if (res?.isOk()) {
                    this.responseSocket.resolve();
                    break;
                }
                this.responseSocket.reject();
                break;
            }
            case request instanceof Close: {
                const close = request as Close;
                const res = await this.app.userClose(close.activityId);
                if (res?.isOk()) {
                    this.responseSocket.resolve();
                    break;
                }
                this.responseSocket.reject();
                break;
            }
            case request instanceof Prev: {
                const prev = request as Prev;
                const res = await this.app.prev(prev.activityId);
                if (res?.isOk()) {
                    this.responseSocket.resolve();
                    break;
                }
                this.responseSocket.reject();
                break;
            }
            case request instanceof Load: {
                const res = await this.app.load();
                if (res?.isOk()) {
                    this.responseSocket.resolve();
                    break;
                }
                this.responseSocket.reject();
                break;
            }
            case request instanceof Refresh: {
                const refresh = request as Refresh;
                const res = await this.app.refresh(refresh.activityId);
                if (res?.isOk()) {
                    this.responseSocket.resolve();
                    break;
                }
                this.responseSocket.reject();
                break;
            }
            case request instanceof Action: {
                const action = request as Action;
                const res = await this.app.action(action.fragmentId, action.name, action.data);
                if (res?.isOk()) {
                    this.responseSocket.resolve();
                    break;
                }
                this.responseSocket.reject();
                break;
            }
            case request instanceof Query: {
                const query = request as Query;
                const res = await this.app.query(query.fragmentId, query.name, query.data);
                if (res?.isOk()) {
                    this.responseSocket.resolve(new Data((res as any).v));
                    break;
                }
                this.responseSocket.reject();
                break;
            }
            default:
                this.responseSocket.write(undefined);
        }
    }
}

/** Bootstrap: runs only inside a worker thread. */
if (parentPort) {
    const init = await new Promise<any>((res, rej) => {
        let resolved = false;
        parentPort!.on('message', (workerInit: any) => {
            if (resolved) return;
            resolved = true;
            res({
                responseSocket: new ResponseSocket(workerInit.responsePort, deserialize),
                requestSocket: new RequestSocket(workerInit.requestPort, deserialize),
                appName: workerInit.appName,
                profile: workerInit.profile,
                userId: workerInit.userId,
                appIndexPath: workerInit.appIndexPath,
                tabLimit: workerInit.tabLimit,
            });
        });
        parentPort!.on('close', (e: unknown) => {
            if (resolved) return;
            resolved = true;
            rej(e);
        });
    });

    const AppIndexClass = (await import(init.appIndexPath)).default;
    initWorkerDriver(init.userId, init.profile, init.appName, init.requestSocket);
    initAgentWorkerDriver(init.requestSocket);
    const appIndex = new AppIndexClass();
    appIndex.appList;
    const app = (appIndex as any)[`${init.appName}`];
    if (!app || !(app instanceof App)) {
        throw new Error(`App ${init.appName} not found in :\n`, appIndex);
    }
    const worker = new Worker(init.requestSocket, init.responseSocket, app, init.userId, init.tabLimit);
    parentPort.postMessage(typeof app.title === 'string' ? app.title : await app.title());
    await worker.run();
    process.exit(0);
}
