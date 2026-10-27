import { Err, logger, loop, LoopResult, Ok, Result, Socket, Stream, t } from '@araminix/lib';

import AgentController from './agent/AgentController.js';
import Instance from './executor/Instance.js';
import { AppIndex, AppListing } from './lib/d.js';
import { AuthProvider, ClientInfo, ClientType } from './server/AuthProvider.js';
import Endpoint, { UploadAllowlist } from './server/Endpoint.js';

export interface PlatformConfig {
    appIndexPath: URL;
    agentIndexPath: URL;
    authProvider: AuthProvider;
    instanceUserLimit: number;
    port?: number;
    mount?: string;
    cookieSecret?: string;
    tabLimit?: number;
    uploadDir?: string;
    maxUploadBytes?: number;
    uploadAllowlist?: UploadAllowlist;
    googleClientIds?: string[];
    onCustomStream?: {
        [key: string]: (client: ClientInfo, stream: Stream) => Promise<void>;
    };
}

export type UserInstance = {
    id: string;
    appName: string;
    appTitle: string;
    activityTitle?: string;
    profile: string | null;
    touched: number;
};

export default class Platform {
    private readonly config: PlatformConfig;
    readonly endpoint: Endpoint;
    private appIndex!: AppIndex<any>;
    private agentController: AgentController;
    readonly instances: Map<string, Map<string, Instance>> = new Map();

    constructor(config: PlatformConfig) {
        this.config = config;
        this.endpoint = new Endpoint({
            authProvider: config.authProvider,
            port: config.port,
            mount: config.mount,
            cookieSecret: config.cookieSecret,
            uploadDir: config.uploadDir,
            maxUploadBytes: config.maxUploadBytes,
            uploadAllowlist: config.uploadAllowlist,
            googleClientIds: config.googleClientIds,
        });
        this.agentController = new AgentController(this.config.agentIndexPath);
        this.serve();
    }

    private serve(): void {
        loop(async () => {
            const acquireResult = await this.endpoint.acquire('platform');
            if (acquireResult.isErr()) return LoopResult.Stop;
            const request = acquireResult.unwrap();
            if (request.info.clientType !== ClientType.User) {
                request.deny();
                return LoopResult.Cont;
            }
            const acceptResult = request.accept();
            if (acceptResult.isOk()) {
                const socket = acceptResult.unwrap();
                const runtimeId = (request.info as any).runtimeId;
                this.processInstanceListStream(runtimeId, socket);
                this.processInstanceStream(request.info.id, runtimeId, socket);
                this.processInstanceCloseStream(runtimeId, socket);
                this.processAppsListStream(request.info.id, socket);
                this.processUserInfo(request.info, socket);
                this.processCustomStreams(request.info, socket);
            }
            return LoopResult.Cont;
        });

        loop(async () => {
            const acquireResult = await this.endpoint.acquire('instance');
            if (acquireResult.isErr()) return LoopResult.Stop;
            const request = acquireResult.unwrap();
            if (request.info.clientType !== ClientType.User) {
                request.deny();
                return LoopResult.Cont;
            }
            this.serveInstance((request.info as any).runtimeId, request).catch((err) => {
                logger.error('Unhandled rejection in serveInstance:', err);
            });
            return LoopResult.Cont;
        });

        loop(async () => {
            const acquireResult = await this.endpoint.acquire('agent');
            if (acquireResult.isErr()) return LoopResult.Stop;
            const request = acquireResult.unwrap();
            if (request.info.clientType !== ClientType.Agent) {
                request.deny();
                return LoopResult.Cont;
            }
            this.agentController.connect(request.info as any, request).catch((err) => {
                logger.error('Unhandled rejection in agentController.connect:', err);
            });
            return LoopResult.Cont;
        });
    }

    private processInstanceCloseStream(runtimeId: string, endpointSocket: Socket): void {
        loop(async () => {
            const streamResult = await endpointSocket.incomingStream('closeInstance');
            if (streamResult.isErr()) {
                return LoopResult.Stop;
            }
            const stream = streamResult.unwrap();
            try {
                if (typeof stream.args !== 'string') {
                    stream.closeErr();
                    return LoopResult.Cont;
                }
                const instanceId = stream.args;
                const userInstances = this.instances.get(runtimeId);
                if (!userInstances) {
                    stream.closeOk();
                    return LoopResult.Cont;
                }
                const instance = userInstances.get(instanceId);
                if (!instance) {
                    stream.closeOk();
                    return LoopResult.Cont;
                }
                instance.destroy();
                stream.closeOk();
                return LoopResult.Cont;
            } catch (err) {
                logger.error('Error processing closeInstance stream:', err);
                try {
                    stream.closeErr();
                } catch {}
                return LoopResult.Cont;
            }
        });
    }

    processCustomStreams(clientInfo: ClientInfo, endpointSocket: Socket): void {
        if (!this.config.onCustomStream) return;
        for (const streamName in this.config.onCustomStream) {
            const handler = this.config.onCustomStream[streamName];
            loop(async () => {
                const streamResult = await endpointSocket.incomingStream(`custom/${streamName}`);
                if (streamResult.isErr()) {
                    return LoopResult.Stop;
                }
                const stream = streamResult.unwrap();
                try {
                    await handler(clientInfo, stream);
                } catch (err) {
                    logger.error(`Error processing custom stream '${streamName}':`, err);
                    try {
                        stream.closeErr();
                    } catch {}
                }
                return LoopResult.Cont;
            });
        }
    }

    processUserInfo(clientInfo: ClientInfo, endpointSocket: Socket): void {
        loop(async () => {
            const streamResult = await endpointSocket.incomingStream('clientInfo');
            if (streamResult.isErr()) {
                return LoopResult.Stop;
            }
            const stream = streamResult.unwrap();
            try {
                const result = await stream.write(clientInfo);
                if (result.isErr()) {
                    stream.closeErr();
                } else {
                    stream.closeOk();
                }
            } catch (err) {
                logger.error('Error processing clientInfo stream:', err);
                try {
                    stream.closeErr();
                } catch {}
            }
            return LoopResult.Cont;
        });
    }

    async listUserInstances(runtimeId: string): Promise<Array<UserInstance>> {
        const userInstances = this.instances.get(runtimeId);
        if (!userInstances) {
            return [];
        }
        return [...userInstances.entries()].map(([id, instance]) => ({
            id,
            appTitle: instance.appTitle,
            appName: instance.appName,
            activityTitle: instance.activityTitle,
            profile: instance.profile,
            touched: instance.touched,
        }));
    }

    async listUserApps(userId: string): Promise<Result<Array<AppListing>, void>> {
        const userAppResult = await this.appIndex.userApps(userId);
        if (userAppResult.isErr()) {
            return new Err(undefined);
        }
        return new Ok(userAppResult.unwrap());
    }

    private processInstanceListStream(runtimeId: string, endpointSocket: Socket): void {
        loop(async () => {
            const streamResult = await endpointSocket.incomingStream('listInstances');
            if (streamResult.isErr()) {
                return LoopResult.Stop;
            }
            const stream = streamResult.unwrap();
            try {
                const list = await this.listUserInstances(runtimeId);
                await stream.write(list);
                stream.closeOk();
            } catch (err) {
                logger.error('Error processing listInstances stream:', err);
                try {
                    stream.closeErr();
                } catch {}
            }
            return LoopResult.Cont;
        });
    }

    private processInstanceStream(userId: string, runtimeId: string, endpointSocket: Socket): void {
        const startInstanceArg = t.type({
            appName: t.string,
            profile: t.union([t.string, t.null]),
        });
        loop(async () => {
            const streamResult = await endpointSocket.incomingStream('createInstance');
            if (streamResult.isErr()) {
                return LoopResult.Stop;
            }
            const stream = streamResult.unwrap();
            let createdInstance: Instance | undefined;
            try {
                if (!startInstanceArg.is(stream.args)) {
                    stream.closeErr();
                    return LoopResult.Cont;
                }
                const appName = stream.args.appName;
                const profile = stream.args.profile;
                const userApps = await this.appIndex.userApps(userId);
                if (userApps.isErr()) {
                    stream.closeErr();
                    return LoopResult.Cont;
                }
                const appSearch = userApps.unwrap().find((listing) => {
                    const app = listing.apps.find((a) => a.name === appName && a.profiles.includes(profile));
                    return app !== undefined;
                });
                if (appSearch === undefined) {
                    stream.closeErr();
                    return LoopResult.Cont;
                }
                const instance = new Instance(userId, appName, profile, this.config.appIndexPath, this.config.tabLimit ?? 12, this.agentController);
                createdInstance = instance;
                if (!this.instances.has(runtimeId)) {
                    this.instances.set(runtimeId, new Map());
                }
                const instances = this.instances.get(runtimeId)!;
                if (instances.size === this.config.instanceUserLimit) {
                    const first = instances.entries().next().value;
                    first?.[1].destroy();
                }
                instances.set(instance.id, instance);
                const instanceInitResult = await instance.init(() => {
                    const insts = this.instances.get(runtimeId);
                    if (insts) {
                        insts.delete(instance.id);
                        if (insts.size === 0) {
                            this.instances.delete(runtimeId);
                        }
                    }
                });
                if (instanceInitResult.isErr()) {
                    instances.delete(instance.id);
                    if (instances.size === 0) {
                        this.instances.delete(runtimeId);
                    }
                    instance.destroy();
                    stream.closeErr();
                    return LoopResult.Cont;
                }
                const writeResult = await stream.write(instance.id);
                if (writeResult.isErr()) {
                    instance.destroy();
                }
                stream.closeOk();
                return LoopResult.Cont;
            } catch (err) {
                logger.error('Error processing createInstance stream:', err);
                if (createdInstance) {
                    const insts = this.instances.get(runtimeId);
                    if (insts) {
                        insts.delete(createdInstance.id);
                        if (insts.size === 0) {
                            this.instances.delete(runtimeId);
                        }
                    }
                    try {
                        createdInstance.destroy();
                    } catch {}
                }
                try {
                    stream.closeErr();
                } catch {}
                return LoopResult.Cont;
            }
        });
    }

    private processAppsListStream(userId: string, endpointSocket: Socket): void {
        loop(async () => {
            const streamResult = await endpointSocket.incomingStream('listApps');
            if (streamResult.isErr()) {
                return LoopResult.Stop;
            }
            const stream = streamResult.unwrap();
            try {
                const userAppResult = await this.listUserApps(userId);
                if (userAppResult.isErr()) {
                    stream.closeErr();
                    return LoopResult.Cont;
                }
                await stream.write(userAppResult.unwrap());
                stream.closeOk();
            } catch (err) {
                logger.error('Error processing listApps stream:', err);
                try {
                    stream.closeErr();
                } catch {}
            }
            return LoopResult.Cont;
        });
    }

    private async serveInstance(runtimeId: string, request: any): Promise<void> {
        const instanceId = request.arg;
        const userInstances = this.instances.get(runtimeId);
        if (!userInstances) {
            request.deny();
            return;
        }
        const instance = userInstances.get(instanceId);
        if (!instance) {
            request.deny();
            return;
        }
        const acceptResult = request.accept();
        if (acceptResult.isOk()) {
            instance.connect(acceptResult.unwrap());
        }
    }

    async start(): Promise<void> {
        const AppIndexClass = (await import(this.config.appIndexPath.href)).default;
        this.appIndex = new AppIndexClass();
        this.endpoint.open();
    }

    stop(): void {
        this.instances.forEach((userInstances) => {
            userInstances.forEach((instance) => {
                instance.destroy();
            });
        });
        this.instances.clear();
        this.endpoint.close();
    }
}
