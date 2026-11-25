import { logger, loop, LoopResult, Result, Socket, Stream, t } from '@araminix/lib';

import AgentController from '../agent/AgentController.js';
import Instance from '../executor/Instance.js';
import { AppIndex, AppListing } from '../lib/d.js';
import { ClientInfo } from '../server/AuthProvider.js';
import { InstanceManager } from './InstanceManager.js';
import { UserInstance } from './types.js';

/** Returns a copy of the client info whose `settings.two_factor` only contains `enabled`. */
export function sanitizeClientInfo(clientInfo: ClientInfo): ClientInfo {
    if (!clientInfo) return clientInfo;
    const info = clientInfo as any;
    if (info.settings && info.settings.two_factor) {
        const sanitizedSettings = {
            ...info.settings,
            two_factor: {
                enabled: Boolean(info.settings.two_factor.enabled),
            },
        };
        const sanitized = Object.create(Object.getPrototypeOf(clientInfo));
        Object.assign(sanitized, clientInfo, { settings: sanitizedSettings });
        return sanitized;
    }
    return clientInfo;
}

/** Serves `closeInstance` streams: destroys the given instance of this runtime (unknown ids are answered with `Ok`). */
export function processInstanceCloseStream(instanceManager: InstanceManager, runtimeId: string, endpointSocket: Socket): void {
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
            instanceManager.closeInstance(runtimeId, stream.args);
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

/** Serves the `custom/<name>` streams of one `platform` connection with the configured custom handlers. */
export function processCustomStreams(
    onCustomStream: { [key: string]: (client: ClientInfo, stream: Stream) => Promise<void> } | undefined,
    clientInfo: ClientInfo,
    endpointSocket: Socket,
): void {
    if (!onCustomStream) return;
    for (const streamName in onCustomStream) {
        const handler = onCustomStream[streamName];
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

/** Serves `clientInfo` streams of one `platform` connection with 2FA secrets removed. */
export function processUserInfo(clientInfo: ClientInfo, endpointSocket: Socket): void {
    loop(async () => {
        const streamResult = await endpointSocket.incomingStream('clientInfo');
        if (streamResult.isErr()) {
            return LoopResult.Stop;
        }
        const stream = streamResult.unwrap();
        try {
            const sanitizedClientInfo = sanitizeClientInfo(clientInfo);
            const result = await stream.write(sanitizedClientInfo);
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

/** Serves `listInstances` streams. */
export function processInstanceListStream(listUserInstances: (runtimeId: string) => Promise<Array<UserInstance>>, runtimeId: string, endpointSocket: Socket): void {
    loop(async () => {
        const streamResult = await endpointSocket.incomingStream('listInstances');
        if (streamResult.isErr()) {
            return LoopResult.Stop;
        }
        const stream = streamResult.unwrap();
        try {
            const list = await listUserInstances(runtimeId);
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

/** Serves `listApps` streams. */
export function processAppsListStream(listUserApps: (userId: string) => Promise<Result<Array<AppListing>, void>>, userId: string, endpointSocket: Socket): void {
    loop(async () => {
        const streamResult = await endpointSocket.incomingStream('listApps');
        if (streamResult.isErr()) {
            return LoopResult.Stop;
        }
        const stream = streamResult.unwrap();
        try {
            const userAppResult = await listUserApps(userId);
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

/**
 * Serves `createInstance` streams: validates `{ appName, profile }` against the user's app listing, applies
 * `instanceUserLimit` (evicting the least recently touched non-singletons), `maxInstancesPerUser` and `maxInstances`,
 * starts the instance and answers its id. Singleton apps reuse an existing instance. Any failure closes the stream
 * with an error.
 */
export function processInstanceStream(
    instanceManager: InstanceManager,
    getAppIndex: () => AppIndex<any>,
    agentController: AgentController,
    userId: string,
    runtimeId: string,
    endpointSocket: Socket,
): void {
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
        return instanceManager.withCreationLock(userId, async () => {
            let createdInstance: Instance | undefined;
            try {
                if (!startInstanceArg.is(stream.args)) {
                    stream.closeErr();
                    return LoopResult.Cont;
                }
                const { appName, profile } = stream.args;
                const userApps = await getAppIndex().userApps(userId);
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

                if (instanceManager.singletonApps.has(appName)) {
                    const existing = instanceManager.findSingleton(runtimeId, appName);
                    if (existing) {
                        if (existing.userId !== userId || existing.profile !== profile) {
                            stream.closeErr();
                            return LoopResult.Cont;
                        }
                        const writeResult = await stream.write(existing.id);
                        if (writeResult.isErr()) {
                            return LoopResult.Cont;
                        }
                        existing.touch();
                        stream.closeOk();
                        return LoopResult.Cont;
                    }
                }

                const instance = instanceManager.allocateInstance(userId, runtimeId, appName, profile, agentController);
                if (!instance) {
                    stream.closeErr();
                    return LoopResult.Cont;
                }
                createdInstance = instance;

                const instanceInitResult = await instance.init(() => {
                    instanceManager.remove(runtimeId, instance.id);
                });
                if (instanceInitResult.isErr()) {
                    instanceManager.remove(runtimeId, instance.id);
                    instance.destroy();
                    stream.closeErr();
                    return LoopResult.Cont;
                }
                const writeResult = await stream.write(instance.id);
                if (writeResult.isErr()) {
                    instanceManager.remove(runtimeId, instance.id);
                    instance.destroy();
                    return LoopResult.Cont;
                }
                stream.closeOk();
                return LoopResult.Cont;
            } catch (err) {
                logger.error('Error processing createInstance stream:', err);
                if (createdInstance) {
                    instanceManager.remove(runtimeId, createdInstance.id);
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
    });
}
