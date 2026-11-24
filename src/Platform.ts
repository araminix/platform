import { Err, logger, loop, LoopResult, Ok, Result, Socket, Stream, t } from '@araminix/lib';
import { ResourceLimits } from 'worker_threads';

import AgentController from './agent/AgentController.js';
import Instance from './executor/Instance.js';
import { countUserInstances, evictOldestRegularInstances, findIdleInstances, findSingletonInstance } from './executor/instancePolicy.js';
import { AppIndex, AppListing } from './lib/d.js';
import { AuthProvider, ClientInfo, ClientType } from './server/AuthProvider.js';
import Endpoint, { EndpointOptions, MinioOptions, RateLimitConfig, UploadAllowlist } from './server/Endpoint.js';

/** Default of {@link PlatformConfig.workerRequestTimeoutMs}: 5 minutes. */
const DEFAULT_WORKER_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
/** Default of {@link PlatformConfig.instanceIdleTimeoutMs}: 15 minutes. */
const DEFAULT_INSTANCE_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
/** How often idle instances are looked for. */
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * Configuration of {@link Platform}. The first group configures the runtime; the rest is forwarded unchanged to the
 * {@link Endpoint} (see {@link EndpointOptions} for details and defaults).
 *
 * @remarks
 * This interface is not re-exported from the package entry point; use `ConstructorParameters<typeof Platform>[0]` if
 * you need to name the type.
 *
 * @example
 * ```ts
 * const config: ConstructorParameters<typeof Platform>[0] = {
 *     appIndexPath: new URL('./apps.js', import.meta.url),
 *     agentIndexPath: new URL('./agents.js', import.meta.url),
 *     authProvider: new MyAuthProvider(),
 *     instanceUserLimit: 5,
 *     maxInstances: 500,
 *     port: 3000,
 *     mount: '/api',
 *     cookieSecret: process.env.COOKIE_SECRET,
 *     allowedOrigins: ['https://app.example.com'],
 *     trustProxy: 1,
 * };
 * ```
 */
export interface PlatformConfig {
    /**
     * URL of the module whose default export is your {@link AppIndex} subclass, for example
     * `new URL('./apps.js', import.meta.url)`. It is imported by {@link Platform.start} in the main thread and again in every
     * app worker thread, so it must point to runnable JavaScript (the compiled file).
     */
    appIndexPath: URL;
    /** URL of the module whose default export is your {@link AgentIndex} subclass; imported in every agent worker thread. */
    agentIndexPath: URL;
    /** Authentication back-end, passed to the {@link Endpoint}. */
    authProvider: AuthProvider;
    /**
     * Maximum number of app instances one client runtime ({@link ClientInfo.runtimeId}) may run. When a new instance is
     * requested at the limit, the least recently touched non-singleton instances (by last client connection) are
     * destroyed first.
     */
    instanceUserLimit: number;
    /**
     * App names that may have at most one instance per client runtime. A request for an already-running singleton returns
     * its existing instance id; these instances do not count toward {@link PlatformConfig.instanceUserLimit} and are not
     * evicted by it. A request with a different profile is rejected.
     *
     * @defaultValue none
     */
    singletonApps?: string[];
    /**
     * Maximum number of app instances across all clients. At the limit `createInstance` fails (the stream is closed with an
     * error and a warning is logged).
     *
     * @defaultValue unlimited
     */
    maxInstances?: number;
    /**
     * Maximum number of app instances one user ({@link ClientInfo.id}) may hold across all concurrent sessions/devices
     * ({@link ClientInfo.runtimeId}). Because {@link PlatformConfig.instanceUserLimit} applies per session (`runtimeId`),
     * this cap prevents a single user from multiplying worker threads across many concurrent sessions. At the limit,
     * `createInstance` fails (the stream is closed with an error and a warning is logged); reusing an already-running
     * singleton on the same session still succeeds.
     *
     * @defaultValue unlimited
     */
    maxInstancesPerUser?: number;
    /**
     * How long an app instance may stay without a client socket before it is destroyed, in milliseconds. The clock starts
     * when the instance's connection is destroyed (the client closed it, or it stayed without a WebSocket for the
     * connection's `hp`, 5 minutes by default), or when the instance is created and no client connects. Every instance is a
     * worker thread, so without this an abandoned app keeps its memory and timers until the server restarts. Checked once a
     * minute; `0` keeps idle instances forever.
     *
     * @defaultValue `900000` (15 minutes)
     */
    instanceIdleTimeoutMs?: number;
    /**
     * Node.js `resourceLimits` of every app worker thread. Agent workers are not limited.
     *
     * @defaultValue `{ maxOldGenerationSizeMb: 128, stackSizeMb: 4 }`
     */
    resourceLimits?: ResourceLimits;
    /**
     * How long the main thread waits for an app or agent worker to answer one request (a client action, query, load, ... or
     * an agent post), in milliseconds. On timeout the client receives an `Execution` error and a late answer is ignored.
     * `0` waits forever.
     *
     * @defaultValue `300000` (5 minutes)
     */
    workerRequestTimeoutMs?: number;
    /**
     * See {@link EndpointOptions.port}.
     *
     * @defaultValue `3000`
     */
    port?: number;
    /**
     * See {@link EndpointOptions.mount}.
     *
     * @defaultValue `''`
     */
    mount?: string;
    /**
     * Version reported by `GET /version` (for example your application's `package.json` version). See
     * {@link EndpointOptions.version}.
     *
     * @defaultValue `'0.0.0'`
     */
    version?: string;
    /**
     * See {@link EndpointOptions.cookieSecret}. Always set it in production.
     *
     * @defaultValue a random secret per process
     */
    cookieSecret?: string;
    /**
     * Maximum number of activities (tabs) per app instance. Opening one more drops an older activity: the second least
     * recently used one, unless it is the activity being left, so an instance can hold `tabLimit + 1` activities (see
     * {@link OpenPage}).
     *
     * @defaultValue `12`
     */
    tabLimit?: number;
    /**
     * See {@link EndpointOptions.uploadDir}.
     *
     * @defaultValue unset (uploads disabled)
     */
    uploadDir?: string;
    /**
     * See {@link EndpointOptions.maxUploadBytes}.
     *
     * @defaultValue `20971520` (20 MiB)
     */
    maxUploadBytes?: number;
    /**
     * See {@link EndpointOptions.uploadAllowlist}.
     *
     * @defaultValue unset (any file)
     */
    uploadAllowlist?: UploadAllowlist;
    /**
     * See {@link EndpointOptions.googleClientIds}.
     *
     * @defaultValue unset (`/gauth` answers 503)
     */
    googleClientIds?: string[];
    /**
     * See {@link EndpointOptions.allowedOrigins}.
     *
     * @defaultValue unset (browser WebSockets refused)
     */
    allowedOrigins?: string[];
    /**
     * See {@link EndpointOptions.authRateLimit}.
     *
     * @defaultValue 100 requests per 15 minutes per key
     */
    authRateLimit?: RateLimitConfig | boolean;
    /**
     * See {@link EndpointOptions.minio}.
     *
     * @defaultValue unset (attachment routes disabled)
     */
    minio?: MinioOptions;
    /**
     * See {@link EndpointOptions.sessionTtl}.
     *
     * @defaultValue `86400` seconds
     */
    sessionTtl?: number;
    /**
     * See {@link EndpointOptions.cookieOptions}.
     *
     * @defaultValue `{ signed, httpOnly, secure, sameSite: 'lax', path: '/' }`
     */
    cookieOptions?: EndpointOptions['cookieOptions'];
    /**
     * See {@link EndpointOptions.maxMessageBytes}.
     *
     * @defaultValue `16777216` (16 MiB)
     */
    maxMessageBytes?: number;
    /**
     * See {@link EndpointOptions.heartbeatIntervalMs}.
     *
     * @defaultValue `30000`
     */
    heartbeatIntervalMs?: number;
    /**
     * See {@link EndpointOptions.trustProxy}.
     *
     * @defaultValue unset
     */
    trustProxy?: EndpointOptions['trustProxy'];
    /**
     * See {@link EndpointOptions.maxConnectionsPerClient}.
     *
     * @defaultValue `32`
     */
    maxConnectionsPerClient?: number;
    /**
     * See {@link EndpointOptions.maxPendingStreams}.
     *
     * @defaultValue `64`
     */
    maxPendingStreams?: number;
    /**
     * See {@link EndpointOptions.maxBufferedBytes}.
     *
     * @defaultValue unset (`@araminix/lib` default: 4 MiB)
     */
    maxBufferedBytes?: number;
    /**
     * See {@link EndpointOptions.allowUrlTokenWs}.
     *
     * @defaultValue `false`
     */
    allowUrlTokenWs?: boolean;
    /**
     * Handlers for your own streams on the `platform` connection, by name. A client opens a stream named `custom/<name>`;
     * the handler receives the client (as returned by {@link AuthProvider.getInfo}) and the stream, and must close it
     * (`closeOk()` / `closeErr()`). Streams of one name on one connection are handled one after another. A thrown error is
     * logged and the stream is closed with an error.
     *
     * @defaultValue none
     *
     * @example
     * ```ts
     * onCustomStream: {
     *     time: async (client, stream) => {
     *         await stream.write({ now: new Date().toISOString(), user: client.id });
     *         stream.closeOk();
     *     },
     * },
     * // client side (@araminix/lib): (await platformSocket.outgoingStream('custom/time')).unwrap().read()
     * ```
     */
    onCustomStream?: {
        [key: string]: (client: ClientInfo, stream: Stream) => Promise<void>;
    };
}

/** One running app instance as listed on the `listInstances` stream. */
export type UserInstance = {
    /** Instance id; connect to `/ws/instance/<id>` to use it. */
    id: string;
    /** App name. */
    appName: string;
    /** App title reported by the app ({@link App.title}). */
    appTitle: string;
    /** Title of the active activity, when known. */
    activityTitle?: string;
    /** Launch profile, or `null`. */
    profile: string | null;
    /** Timestamp (ms) of the last client connection to the instance. */
    touched: number;
};

/**
 * The application server: an {@link Endpoint} plus the app and agent runtimes.
 *
 * It serves three WebSocket endpoints on the endpoint:
 * - `platform` (users): streams `listApps`, `createInstance` (`{ appName, profile }`, answers the new instance id),
 *   `listInstances`, `closeInstance` (instance id), `clientInfo` and `custom/<name>` ({@link PlatformConfig.onCustomStream});
 * - `instance` (users, `/ws/instance/<instance id>`): the user interface of one app instance, which runs in its own worker
 *   thread;
 * - `agent` (agents): connections of agent processes, each served by its own agent worker thread.
 *
 * Clients of the wrong {@link ClientType} are denied. Instances belong to the client runtime
 * ({@link ClientInfo.runtimeId}) that created them.
 *
 * @example
 * ```ts
 * import { Platform } from '@araminix/platform';
 *
 * const platform = new Platform({
 *     appIndexPath: new URL('./apps.js', import.meta.url),
 *     agentIndexPath: new URL('./agents.js', import.meta.url),
 *     authProvider: new MyAuthProvider(),
 *     instanceUserLimit: 5,
 *     port: 3000,
 *     mount: '/api',
 *     cookieSecret: process.env.COOKIE_SECRET,
 *     allowedOrigins: ['https://app.example.com'],
 * });
 *
 * await platform.start();
 * process.on('SIGTERM', () => platform.stop());
 * ```
 */
export default class Platform {
    /** The configuration. */
    private readonly config: PlatformConfig;
    /**
     * The HTTP/WebSocket endpoint. Use it to add Express routes (`platform.endpoint.express`) or your own WebSocket
     * endpoints ({@link Endpoint.acquire} with names other than `platform`, `instance` and `agent`).
     */
    readonly endpoint: Endpoint;
    /** The app index, created by {@link Platform.start}. */
    private appIndex!: AppIndex<any>;
    /** Runs the agent workers. */
    private agentController: AgentController;
    /** Running app instances: client runtime id, then instance id. Read-only view for monitoring; do not modify it. */
    readonly instances: Map<string, Map<string, Instance>> = new Map();
    private readonly singletonApps: ReadonlySet<string>;
    private readonly instanceCreationLocks = new Map<string, Promise<void>>();
    /** Periodic check for idle instances, started by {@link Platform.start}. */
    private idleSweepTimer?: NodeJS.Timeout;

    /** Effective {@link PlatformConfig.workerRequestTimeoutMs}. */
    private get workerRequestTimeoutMs(): number {
        return this.config.workerRequestTimeoutMs ?? DEFAULT_WORKER_REQUEST_TIMEOUT_MS;
    }

    /** Number of running app instances across all clients. */
    get totalInstances(): number {
        let total = 0;
        for (const userInstances of this.instances.values()) {
            total += userInstances.size;
        }
        return total;
    }

    /**
     * Creates the endpoint and the agent controller and starts accepting connections on the three endpoints. Nothing listens
     * until {@link Platform.start}.
     *
     * @param config - See {@link PlatformConfig}.
     * @throws Error when `config.minio` is set but incomplete (see {@link Endpoint}).
     */
    constructor(config: PlatformConfig) {
        this.config = config;
        this.singletonApps = new Set(config.singletonApps ?? []);
        this.endpoint = new Endpoint({
            authProvider: config.authProvider,
            port: config.port,
            mount: config.mount,
            version: config.version,
            cookieSecret: config.cookieSecret,
            uploadDir: config.uploadDir,
            maxUploadBytes: config.maxUploadBytes,
            uploadAllowlist: config.uploadAllowlist,
            googleClientIds: config.googleClientIds,
            allowedOrigins: config.allowedOrigins,
            authRateLimit: config.authRateLimit,
            minio: config.minio,
            sessionTtl: config.sessionTtl,
            cookieOptions: config.cookieOptions,
            maxMessageBytes: config.maxMessageBytes,
            heartbeatIntervalMs: config.heartbeatIntervalMs,
            trustProxy: config.trustProxy,
            maxConnectionsPerClient: config.maxConnectionsPerClient,
            maxPendingStreams: config.maxPendingStreams,
            maxBufferedBytes: config.maxBufferedBytes,
            allowUrlTokenWs: config.allowUrlTokenWs,
            onDeauth: (info: ClientInfo) => {
                if (info.clientType === ClientType.User) {
                    this.destroyRuntimeInstances(info.runtimeId);
                }
            },
        });
        this.agentController = new AgentController(this.config.agentIndexPath, undefined, this.workerRequestTimeoutMs);
        this.serve();
    }

    private async withInstanceCreationLock<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.instanceCreationLocks.get(lockKey);
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.instanceCreationLocks.set(lockKey, current);
        await previous;
        try {
            return await operation();
        } finally {
            release();
            if (this.instanceCreationLocks.get(lockKey) === current) {
                this.instanceCreationLocks.delete(lockKey);
            }
        }
    }

    /** Destroys all running app instances belonging to `runtimeId` and removes the runtime entry. */
    private destroyRuntimeInstances(runtimeId: string): void {
        const userInstances = this.instances.get(runtimeId);
        if (!userInstances) {
            return;
        }
        this.instances.delete(runtimeId);
        for (const instance of [...userInstances.values()]) {
            instance.destroy();
        }
    }

    /** Destroys all running app instances belonging to `userId` across all runtimes, optionally sparing `exceptRuntimeId`. */
    private destroyUserInstances(userId: string, exceptRuntimeId?: string): void {
        for (const [runtimeId, userInstances] of [...this.instances.entries()]) {
            if (exceptRuntimeId !== undefined && runtimeId === exceptRuntimeId) {
                continue;
            }
            for (const [instanceId, instance] of [...userInstances.entries()]) {
                if (instance.userId === userId) {
                    userInstances.delete(instanceId);
                    instance.destroy();
                }
            }
            if (userInstances.size === 0) {
                this.instances.delete(runtimeId);
            }
        }
    }

    /**
     * Immediately closes WebSocket connections and destroys all running app instances belonging to a single session
     * ({@link ClientInfo.runtimeId}), without affecting other sessions (devices) of the same user.
     *
     * @param runtimeId - {@link ClientInfo.runtimeId} of the session to revoke.
     * @param token - Optional session token filter for WebSocket revocation; when omitted, all sockets of `runtimeId` are closed.
     */
    deauthSession(runtimeId: string, token?: string): void {
        this.endpoint.deauthSession(runtimeId, token);
        this.destroyRuntimeInstances(runtimeId);
    }

    /**
     * Immediately closes all WebSocket connections and destroys all running app instances belonging to `userId` across
     * all sessions/devices (optionally keeping `exceptRuntimeId` alive, for example the current device after a password
     * change).
     *
     * @param userId - {@link ClientInfo.id} of the user to revoke.
     * @param exceptRuntimeId - Optional {@link ClientInfo.runtimeId} to keep connected and running.
     */
    deauthUser(userId: string, exceptRuntimeId?: string): void {
        this.endpoint.deauthByUserId(userId, exceptRuntimeId);
        this.destroyUserInstances(userId, exceptRuntimeId);
    }

    /** Starts the accept loops of the `platform`, `instance` and `agent` endpoints. */
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

    /** Serves `closeInstance` streams: destroys the given instance of this runtime (unknown ids are answered with `Ok`). */
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
                userInstances.delete(instanceId);
                if (userInstances.size === 0) {
                    this.instances.delete(runtimeId);
                }
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

    /**
     * Serves the `custom/<name>` streams of one `platform` connection with the handlers of
     * {@link PlatformConfig.onCustomStream}. Called by the platform for every accepted connection.
     *
     * @param clientInfo - The connected client.
     * @param endpointSocket - The accepted socket.
     */
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

    /** Returns a copy of the client info whose `settings.two_factor` only contains `enabled`. */
    private sanitizeClientInfo(clientInfo: ClientInfo): ClientInfo {
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

    /**
     * Serves `clientInfo` streams of one `platform` connection: each one receives the client info (with 2FA secrets
     * removed) and is closed. Called by the platform for every accepted connection.
     *
     * @param clientInfo - The connected client.
     * @param endpointSocket - The accepted socket.
     */
    processUserInfo(clientInfo: ClientInfo, endpointSocket: Socket): void {
        loop(async () => {
            const streamResult = await endpointSocket.incomingStream('clientInfo');
            if (streamResult.isErr()) {
                return LoopResult.Stop;
            }
            const stream = streamResult.unwrap();
            try {
                const sanitizedClientInfo = this.sanitizeClientInfo(clientInfo);
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

    /**
     * Lists the running instances of a client runtime (what the `listInstances` stream returns).
     *
     * @param runtimeId - {@link ClientInfo.runtimeId}.
     * @returns The instances; empty when there are none.
     */
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

    /**
     * Lists the apps a user may launch (what the `listApps` stream returns), via {@link AppIndex.userApps}. Requires
     * {@link Platform.start}.
     *
     * @param userId - {@link ClientInfo.id}.
     * @returns The listing, or `Err` when `_getUserApps` failed.
     */
    async listUserApps(userId: string): Promise<Result<Array<AppListing>, void>> {
        const userAppResult = await this.appIndex.userApps(userId);
        if (userAppResult.isErr()) {
            return new Err(undefined);
        }
        return new Ok(userAppResult.unwrap());
    }

    /** Serves `listInstances` streams. */
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

    /**
     * Serves `createInstance` streams: validates `{ appName, profile }` against the user's app listing, applies
     * `instanceUserLimit` (evicting the least recently touched non-singletons), `maxInstancesPerUser` and `maxInstances`,
     * starts the instance and answers its id. Singleton apps reuse an existing instance. Any failure closes the stream
     * with an error.
     */
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
            return this.withInstanceCreationLock(userId, async () => {
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
                    if (!this.instances.has(runtimeId)) {
                        this.instances.set(runtimeId, new Map());
                    }
                    const instances = this.instances.get(runtimeId)!;
                    const isSingleton = this.singletonApps.has(appName);
                    if (isSingleton) {
                        const existing = findSingletonInstance(instances.values(), appName);
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
                    } else {
                        evictOldestRegularInstances(instances, this.config.instanceUserLimit, this.singletonApps);
                    }

                    if (this.config.maxInstancesPerUser !== undefined) {
                        const userTotal = countUserInstances(this.instances, userId);
                        if (userTotal >= this.config.maxInstancesPerUser) {
                            if (instances.size === 0) {
                                this.instances.delete(runtimeId);
                            }
                            logger.warn(`Per-user instance limit reached for user '${userId}' (${userTotal}/${this.config.maxInstancesPerUser}). Rejecting createInstance.`);
                            stream.closeErr();
                            return LoopResult.Cont;
                        }
                    }

                    if (this.config.maxInstances !== undefined && this.totalInstances >= this.config.maxInstances) {
                        if (instances.size === 0) {
                            this.instances.delete(runtimeId);
                        }
                        logger.warn(`Global instance limit reached (${this.totalInstances}/${this.config.maxInstances}). Rejecting createInstance.`);
                        stream.closeErr();
                        return LoopResult.Cont;
                    }

                    const instance = new Instance(
                        userId,
                        appName,
                        profile,
                        this.config.appIndexPath,
                        this.config.tabLimit ?? 12,
                        this.agentController,
                        this.config.resourceLimits,
                        undefined,
                        this.workerRequestTimeoutMs,
                    );
                    createdInstance = instance;
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
                        instances.delete(instance.id);
                        if (instances.size === 0) {
                            this.instances.delete(runtimeId);
                        }
                        instance.destroy();
                        return LoopResult.Cont;
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
        });
    }

    /** Serves `listApps` streams. */
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

    /** Admits an `instance` connection whose `arg` is an instance id of the same runtime, and attaches it to that instance. */
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

    /**
     * Imports the app index ({@link PlatformConfig.appIndexPath}), creates it and starts listening.
     *
     * @returns Resolves once the index is loaded and `listen` was called (the port may not be bound yet).
     * @throws Rejects when the app index module cannot be imported or its default export cannot be constructed.
     */
    async start(): Promise<void> {
        const AppIndexClass = (await import(this.config.appIndexPath.href)).default;
        this.appIndex = new AppIndexClass();
        this.endpoint.open();
        const idleTimeoutMs = this.config.instanceIdleTimeoutMs ?? DEFAULT_INSTANCE_IDLE_TIMEOUT_MS;
        if (idleTimeoutMs > 0 && !this.idleSweepTimer) {
            this.idleSweepTimer = setInterval(() => this.destroyIdleInstances(idleTimeoutMs), Math.min(IDLE_SWEEP_INTERVAL_MS, idleTimeoutMs));
            this.idleSweepTimer.unref();
        }
    }

    /** Destroys the instances that have had no client socket for `idleTimeoutMs` ({@link PlatformConfig.instanceIdleTimeoutMs}). */
    private destroyIdleInstances(idleTimeoutMs: number): void {
        const now = Date.now();
        for (const [runtimeId, userInstances] of [...this.instances]) {
            for (const instance of findIdleInstances(userInstances.values(), now, idleTimeoutMs)) {
                const idleMinutes = Math.round((now - (instance.idleSince ?? now)) / 60000);
                logger.info(`Destroying idle app instance ${instance.id} (${instance.appName}): no client for ${idleMinutes} min.`);
                userInstances.delete(instance.id);
                instance.destroy();
            }
            if (userInstances.size === 0) {
                this.instances.delete(runtimeId);
            }
        }
    }

    /** Destroys every app instance and agent worker and closes the endpoint (open WebSockets are terminated). */
    stop(): void {
        if (this.idleSweepTimer) {
            clearInterval(this.idleSweepTimer);
            this.idleSweepTimer = undefined;
        }
        for (const userInstances of this.instances.values()) {
            for (const instance of [...userInstances.values()]) {
                instance.destroy();
            }
        }
        this.instances.clear();
        this.agentController?.stop?.();
        this.endpoint.close();
    }
}
