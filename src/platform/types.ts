import { Stream } from '@araminix/lib';
import { ResourceLimits } from 'worker_threads';

import { AuthProvider, ClientInfo } from '../server/AuthProvider.js';
import { EndpointOptions, MinioOptions, RateLimitConfig, UploadAllowlist } from '../server/Endpoint.js';

/** Default of {@link PlatformConfig.workerRequestTimeoutMs}: 5 minutes. */
export const DEFAULT_WORKER_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
/** Default of {@link PlatformConfig.outgoingStreamTimeoutMs}: 10 seconds. */
export const DEFAULT_OUTGOING_STREAM_TIMEOUT_MS = 10_000;
/** Default of {@link PlatformConfig.instanceIdleTimeoutMs}: 15 minutes. */
export const DEFAULT_INSTANCE_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
/** How often idle instances are looked for. */
export const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;

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
     * How long an app instance waits for a client to accept and close an outgoing stream (`activityList`, `build`, `push`,
     * `update-<fragmentId>`), in milliseconds. On timeout the stream is closed with an error and the worker request is
     * rejected so a stalled client cannot block the worker IPC channel. `0` waits forever.
     *
     * @defaultValue `10000` (10 seconds)
     */
    outgoingStreamTimeoutMs?: number;
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
     * See {@link EndpointOptions.getUploadMetadata}.
     *
     * @defaultValue unset
     */
    getUploadMetadata?: EndpointOptions['getUploadMetadata'];
    /**
     * See {@link EndpointOptions.authorizeFileAccess}.
     *
     * @defaultValue unset
     */
    authorizeFileAccess?: EndpointOptions['authorizeFileAccess'];
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
