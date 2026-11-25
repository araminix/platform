import { Err, logger, loop, LoopResult, Ok, Result, Socket } from '@araminix/lib';

import AgentController from './agent/AgentController.js';
import Instance from './executor/Instance.js';
import { AppIndex, AppListing } from './lib/d.js';
import { InstanceManager } from './platform/InstanceManager.js';
import {
    processCustomStreams as handleCustomStreams,
    processInstanceStream as handleInstanceStream,
    processUserInfo as handleUserInfo,
    processAppsListStream,
    processInstanceCloseStream,
    processInstanceListStream,
    sanitizeClientInfo as sanitizeInfo,
} from './platform/streamHandlers.js';
import { DEFAULT_INSTANCE_IDLE_TIMEOUT_MS, DEFAULT_WORKER_REQUEST_TIMEOUT_MS, IDLE_SWEEP_INTERVAL_MS, PlatformConfig, UserInstance } from './platform/types.js';
import { ClientInfo, ClientType } from './server/AuthProvider.js';
import Endpoint from './server/Endpoint.js';

export { PlatformConfig, UserInstance };

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
    /** Manages running app instances, eviction, limits and locks. */
    private readonly instanceManager: InstanceManager;
    /** Running app instances: client runtime id, then instance id. Read-only view for monitoring; do not modify it. */
    readonly instances: Map<string, Map<string, Instance>>;
    /** Periodic check for idle instances, started by {@link Platform.start}. */
    private idleSweepTimer?: NodeJS.Timeout;

    /** Effective {@link PlatformConfig.workerRequestTimeoutMs}. */
    private get workerRequestTimeoutMs(): number {
        return this.config.workerRequestTimeoutMs ?? DEFAULT_WORKER_REQUEST_TIMEOUT_MS;
    }

    /** Number of running app instances across all clients. */
    get totalInstances(): number {
        return this.instanceManager.totalInstances;
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
        this.instanceManager = new InstanceManager(config);
        this.instances = this.instanceManager.instances;
        this.endpoint = new Endpoint({
            authProvider: config.authProvider,
            port: config.port,
            mount: config.mount,
            version: config.version,
            cookieSecret: config.cookieSecret,
            uploadDir: config.uploadDir,
            maxUploadBytes: config.maxUploadBytes,
            uploadAllowlist: config.uploadAllowlist,
            getUploadMetadata: config.getUploadMetadata,
            authorizeFileAccess: config.authorizeFileAccess,
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
                    this.instanceManager.destroyRuntimeInstances(info.runtimeId);
                }
            },
        });
        this.agentController = new AgentController(this.config.agentIndexPath, undefined, this.workerRequestTimeoutMs);
        this.serve();
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
        this.instanceManager.destroyRuntimeInstances(runtimeId);
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
        this.instanceManager.destroyUserInstances(userId, exceptRuntimeId);
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
                processInstanceListStream((rtId) => this.listUserInstances(rtId), runtimeId, socket);
                this.processInstanceStream(request.info.id, runtimeId, socket);
                processInstanceCloseStream(this.instanceManager, runtimeId, socket);
                processAppsListStream((uid) => this.listUserApps(uid), request.info.id, socket);
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

    /**
     * Serves the `custom/<name>` streams of one `platform` connection with the handlers of
     * {@link PlatformConfig.onCustomStream}. Called by the platform for every accepted connection.
     *
     * @param clientInfo - The connected client.
     * @param endpointSocket - The accepted socket.
     */
    processCustomStreams(clientInfo: ClientInfo, endpointSocket: Socket): void {
        handleCustomStreams(this.config.onCustomStream, clientInfo, endpointSocket);
    }

    /** Returns a copy of the client info whose `settings.two_factor` only contains `enabled`. */
    private sanitizeClientInfo(clientInfo: ClientInfo): ClientInfo {
        return sanitizeInfo(clientInfo);
    }

    /**
     * Serves `clientInfo` streams of one `platform` connection: each one receives the client info (with 2FA secrets
     * removed) and is closed. Called by the platform for every accepted connection.
     *
     * @param clientInfo - The connected client.
     * @param endpointSocket - The accepted socket.
     */
    processUserInfo(clientInfo: ClientInfo, endpointSocket: Socket): void {
        handleUserInfo(clientInfo, endpointSocket);
    }

    /** Serves `createInstance` streams for a connected user session. */
    private processInstanceStream(userId: string, runtimeId: string, endpointSocket: Socket): void {
        handleInstanceStream(this.instanceManager, () => this.appIndex, this.agentController, userId, runtimeId, endpointSocket);
    }

    /**
     * Lists the running instances of a client runtime (what the `listInstances` stream returns).
     *
     * @param runtimeId - {@link ClientInfo.runtimeId}.
     * @returns The instances; empty when there are none.
     */
    async listUserInstances(runtimeId: string): Promise<Array<UserInstance>> {
        return this.instanceManager.listUserInstances(runtimeId);
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

    /** Admits an `instance` connection whose `arg` is an instance id of the same runtime, and attaches it to that instance. */
    private async serveInstance(runtimeId: string, request: any): Promise<void> {
        const instance = this.instanceManager.get(runtimeId, request.arg);
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
            this.idleSweepTimer = setInterval(() => this.instanceManager.destroyIdleInstances(idleTimeoutMs), Math.min(IDLE_SWEEP_INTERVAL_MS, idleTimeoutMs));
            this.idleSweepTimer.unref();
        }
    }

    /** Destroys every app instance and agent worker and closes the endpoint (open WebSockets are terminated). */
    stop(): void {
        if (this.idleSweepTimer) {
            clearInterval(this.idleSweepTimer);
            this.idleSweepTimer = undefined;
        }
        this.instanceManager.destroyAll();
        this.agentController?.stop?.();
        this.endpoint.close();
    }
}
