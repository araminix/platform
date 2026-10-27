import { logger } from '@araminix/lib';
import { parentPort } from 'worker_threads';

import { initAgentWorkerDriver } from '../agent/agentWorkerDriver.js';
import { App } from '../lib/d.js';
import { Req, RequestSocket, ResponseSocket } from '../lib/worker_socket.js';
import { AppInstance } from './AppInstance.js';
import { Action, Close, Data, deserialize, Load, Other, Prev, Query, Refresh, Reload, Switch } from './proto.js';
import { initWorkerDriver } from './workerDriver.js';

class Worker {
    private requestSocket: RequestSocket;
    private responseSocket: ResponseSocket;
    private userId: string;
    private tabLimit: number;
    private app: AppInstance;

    constructor(requestSocket: RequestSocket, responseSocket: ResponseSocket, app: App<any, any>, userId: string, tabLimit: number) {
        this.requestSocket = requestSocket;
        this.responseSocket = responseSocket;
        this.userId = userId;
        this.tabLimit = tabLimit;
        this.app = new AppInstance(app, this.tabLimit);
    }

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
