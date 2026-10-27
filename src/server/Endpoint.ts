import { logger, Result, trimSlash, uuid, wrap, WsCloseCodes } from '@araminix/lib';
import axios from 'axios';
import cookieParser from 'cookie-parser';
import expressCore, { CookieOptions, NextFunction, Request, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import expressWs from 'express-ws';
import fs from 'fs';
import type { Server } from 'http';
import multer from 'multer';
import path from 'path';

import { logMiddleware, MIME_TYPE, MimeToExtension, MinioOptions, MinioService } from '../utils/index.js';
import { AuthProvider, ClientInfo, GoogleData } from './AuthProvider.js';
import { ConnectRequest } from './ConnectRequest.js';
import EndpointController, { EndpointControllerOptions } from './EndpointController.js';

/** Re-exported so that `MinioOptions` can be imported together with {@link EndpointOptions}. */
export { MinioOptions };

/** Express request as seen by the platform routes, after the session middleware ran. */
interface CustomRequest extends Request {
    /** Session token from the signed `token` cookie or the `x-token` header. */
    token?: string;
    /** Client resolved from {@link CustomRequest.token} by {@link AuthProvider.getInfo}; unset when the token is invalid. */
    info?: ClientInfo;
    /** File stored by multer on `POST /file`, with the platform-generated `id`. */
    file?: any;
}

/**
 * Resolves a token to a user id. Not used by the platform itself; kept for compatibility with older integrations.
 */
export interface ServerDriver {
    /** Returns the id of the user that owns `token`. */
    getUserId: (token: string) => Promise<Result<string, unknown>>;
}

/**
 * Restricts what `POST /file` accepts. Each list that is set and non-empty must match; rejected files get HTTP 415
 * (`{ error: 'File extension not allowed' }` or `{ error: 'MIME type not allowed' }`) and are not stored.
 *
 * @example
 * ```ts
 * const uploadAllowlist: UploadAllowlist = {
 *     extensions: ['png', 'jpg', '.pdf'],
 *     mimetypes: ['image/png', 'image/jpeg', 'application/pdf'],
 * };
 * ```
 */
export interface UploadAllowlist {
    /**
     * Allowed file extensions, compared case-insensitively with the extension of the sanitized file name; a leading dot is
     * optional.
     *
     * @defaultValue no restriction
     */
    extensions?: string[];
    /**
     * Allowed MIME types, compared case-insensitively and exactly (no wildcards) with the type the client declared for the
     * multipart part. The declared type is not verified against the content.
     *
     * @defaultValue no restriction
     */
    mimetypes?: string[];
}

/**
 * Settings of the authentication rate limiter (`express-rate-limit`).
 *
 * One limiter instance, and therefore one counter store, is shared by `POST /auth`, `POST /gauth`, `PUT /auth/refresh`,
 * `POST /2fa/enable`, `POST /2fa/verify` and `DELETE /2fa/disable` (`POST /2fa/request` is not limited). Requests are
 * counted per key, so the routes draw from the same budget for the same key. The object is also spread into the
 * `express-rate-limit` options, so it can override `standardHeaders` and the other defaults.
 *
 * @example
 * ```ts
 * new Platform({
 *     // ...
 *     authRateLimit: { windowMs: 60_000, limit: 10, keyGenerator: (req) => req.ip ?? 'unknown' },
 * });
 * ```
 */
export interface RateLimitConfig {
    /**
     * Length of the counting window, in milliseconds.
     *
     * @defaultValue `900000` (15 minutes)
     */
    windowMs?: number;
    /**
     * Older name of {@link RateLimitConfig.limit}; used when `limit` is not set.
     *
     * @defaultValue `100`
     */
    max?: number;
    /**
     * Requests allowed per key and window; further requests get HTTP 429.
     *
     * @defaultValue `100`
     */
    limit?: number;
    /**
     * Body of the 429 response.
     *
     * @defaultValue `{ message: 'Too many authentication attempts, please try again later.', error: 'Too many requests' }`
     */
    message?: any;
    /**
     * Computes the counter key of a request.
     *
     * @defaultValue the client IP (`req.ip`, so configure {@link EndpointOptions.trustProxy} behind a proxy), joined with the
     *     account named in the JSON body (`accountName`, `username`, `email`, `account` or `old_token`) when present:
     *     `"<ip>:<account>"`.
     */
    keyGenerator?: (req: Request, res: Response) => string | Promise<string>;
    /**
     * Do not count requests that end with a status below 400.
     *
     * @defaultValue `false`
     */
    skipSuccessfulRequests?: boolean;
}

/**
 * Options of {@link Endpoint}. {@link Platform} forwards the matching fields of {@link PlatformConfig}.
 *
 * @example
 * ```ts
 * const endpoint = new Endpoint({
 *     authProvider: new MyAuthProvider(),
 *     port: 8080,
 *     mount: '/api',
 *     cookieSecret: process.env.COOKIE_SECRET,
 *     allowedOrigins: ['https://app.example.com'],
 *     trustProxy: 1,
 * });
 * ```
 */
export interface EndpointOptions {
    /** Authentication back-end used by every route. */
    authProvider: AuthProvider;
    /**
     * TCP port used by {@link Endpoint.open}.
     *
     * @defaultValue `3000`
     */
    port?: number;
    /**
     * Path prefix for every route; surrounding slashes are trimmed (`'api'`, `'/api'` and `'/api/'` all give `/api`).
     *
     * @defaultValue `''` (routes at the root)
     */
    mount?: string;
    /**
     * Value returned by `GET /version` as `{ version }`. {@link Platform} does not forward a version, so it reports the
     * default.
     *
     * @defaultValue `'0.0.0'`
     */
    version?: string;
    /**
     * Secret used to sign the `token` cookie. Without it a random secret is generated and a warning is logged: sessions then
     * end on every restart and cannot be shared between server instances. Always set it in production.
     *
     * @defaultValue a random UUID per process
     */
    cookieSecret?: string;
    /**
     * Lifetime of the session cookie, in seconds (`maxAge` is `sessionTtl * 1000`). Token expiry itself is up to your
     * {@link AuthProvider}.
     *
     * @defaultValue `86400` (24 hours)
     */
    sessionTtl?: number;
    /**
     * Directory for `POST /file` uploads. When unset, the `/file` routes are not registered. Each upload is stored as
     * `<uploadDir>/<uuid>/<sanitized name>` next to an `index.json` with its metadata.
     *
     * @defaultValue unset (uploads disabled)
     */
    uploadDir?: string | void;
    /**
     * MinIO/S3 settings. When set, `POST /attachments/upload` and `GET /attachments/...` are registered and return presigned
     * URLs. Incomplete options make the constructor throw.
     *
     * @defaultValue unset (attachment routes disabled)
     */
    minio?: MinioOptions | void;
    /**
     * Express cookie options merged over the defaults `{ signed: true, httpOnly: true, secure: true, sameSite: 'lax',
     * path: '/', maxAge: sessionTtl * 1000 }`. The same options are used to clear the cookie on logout. Keep `signed: true`:
     * the session middleware only reads signed cookies. Set `secure: false` only for plain-HTTP development.
     *
     * @defaultValue the defaults above
     */
    cookieOptions?: CookieOptions;
    /**
     * Largest accepted `POST /file` upload, in bytes; larger files get HTTP 413. Only one file per request is accepted.
     *
     * @defaultValue `20971520` (20 MiB)
     */
    maxUploadBytes?: number;
    /**
     * Extension and MIME type restrictions for `POST /file`.
     *
     * @defaultValue unset (any file)
     */
    uploadAllowlist?: UploadAllowlist;
    /**
     * OAuth client ids whose Google access tokens `POST /gauth` accepts (matched against the token's `aud` or `azp`). When
     * unset or empty, `/gauth` answers HTTP 503.
     *
     * @defaultValue unset (Google sign-in disabled)
     */
    googleClientIds?: string[];
    /**
     * Browser origins allowed to open WebSockets (protection against cross-site WebSocket hijacking). Matching ignores case
     * and trailing slashes; `'*'` allows every origin. Requests without an `Origin` header (native and Node.js clients) are
     * always allowed. When unset or empty, every request that carries an `Origin` is refused (fail closed). This option does
     * not add CORS headers to HTTP routes.
     *
     * @defaultValue unset (browsers cannot connect)
     */
    allowedOrigins?: string[];
    /**
     * Rate limit for the authentication routes: `false` disables it, `true` or unset uses the defaults (100 requests per
     * 15 minutes per key), an object customizes it.
     *
     * @defaultValue enabled with the defaults
     */
    authRateLimit?: RateLimitConfig | boolean;
    /**
     * Largest WebSocket message accepted, in bytes (`ws` `maxPayload`); a larger message closes the socket with code 1009.
     *
     * @defaultValue `16777216` (16 MiB)
     */
    maxMessageBytes?: number;
    /**
     * Interval of WebSocket pings, in milliseconds. A socket that has not answered the previous ping is terminated, so
     * half-open connections are detected within about two intervals. `0` or a negative value disables the heartbeat.
     *
     * @defaultValue `30000`
     */
    heartbeatIntervalMs?: number;
    /**
     * Express `trust proxy` setting. Set it (for example to the number of proxy hops) when the server runs behind a reverse
     * proxy, so that `req.ip`, and with it the rate-limit key, is the real client address.
     *
     * @defaultValue unset (Express default: no proxy is trusted)
     */
    trustProxy?: boolean | number | string;
    /**
     * Distinct connections (different `:arg` values) one client runtime may keep on each endpoint name; reconnects do not
     * count. Excess connections are closed with code 1008. `0` disables the cap.
     *
     * @defaultValue `32`
     */
    maxConnectionsPerClient?: number;
    /**
     * Stream requests a connection may have waiting for the application to accept them. `0` disables the cap.
     *
     * @defaultValue `64`
     */
    maxPendingStreams?: number;
}

/** Shape of the ids that `POST /file` generates; other ids are answered with 404 without touching the disk. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// AuthProvider error codes (strings/numbers) are meant for the client; other values may carry internals.
/**
 * Returns `error` when it is a string or number (an error code meant for the client), otherwise `fallback`.
 *
 * @param error - Error value from an {@link AuthProvider} method.
 * @param fallback - Text sent instead of non-primitive errors.
 */
function clientError(error: unknown, fallback: string): string | number {
    return typeof error === 'string' || typeof error === 'number' ? error : fallback;
}

// Axios errors carry the request config, including URLs and Authorization headers with tokens.
/**
 * Reduces an axios error to `{ message, code, status }` so that logs never contain request URLs or `Authorization`
 * headers; other values are returned unchanged.
 */
function loggableError(error: unknown): unknown {
    if (error && typeof error === 'object' && (error as { isAxiosError?: boolean }).isAxiosError) {
        const axiosError = error as { message?: string; code?: string; response?: { status?: number } };
        return { message: axiosError.message, code: axiosError.code, status: axiosError.response?.status };
    }
    return error;
}

/**
 * Route guard for authenticated routes.
 *
 * Answers 401 when the request has no valid session. For cookie-authenticated `POST`, `PUT`, `PATCH` and `DELETE`
 * requests it also requires `Content-Type: application/json` or an `X-Requested-With` / `X-CSRF-Token` header
 * (otherwise 403); browsers cannot send either cross-site without a CORS preflight, which blocks CSRF. Requests
 * authenticated with the `x-token` header are not affected.
 */
function validateToken(req: CustomRequest, res: Response, next: NextFunction): void {
    if (!req.token || !req.info) {
        res.status(401).send({ message: 'Unauthorized' }).end();
        return;
    }

    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase());
    const isCookieAuth = Boolean(req.signedCookies?.token && !req.header('x-token'));

    if (isMutation && isCookieAuth) {
        const contentType = req.headers['content-type'];
        const hasJson = Boolean(req.is('application/json') || (typeof contentType === 'string' && contentType.toLowerCase().includes('application/json')));
        const hasCustomHeader = Boolean(req.header('x-requested-with') || req.header('x-csrf-token'));

        if (!hasJson && !hasCustomHeader) {
            res.status(403)
                .json({
                    error: 'Forbidden: Content-Type: application/json or custom header (e.g. X-Requested-With) required for cookie-authenticated requests',
                    message: 'Forbidden',
                })
                .end();
            return;
        }
    }

    next();
}

/**
 * HTTP and WebSocket server: authentication, sessions, 2FA, uploads, attachments and named WebSocket endpoints, built on
 * Express 5 and `express-ws`.
 *
 * {@link Platform} creates one and serves the `platform`, `instance` and `agent` endpoints on it; you can also use it on
 * its own. Clients open a WebSocket to `<mount>/ws/<name>` or `<mount>/ws/<name>/<arg>` with the session cookie or an
 * `x-token` header; your code admits them with {@link Endpoint.acquire} and talks to them over `@araminix/lib` streams.
 *
 * Routes (all under `mount`):
 * - `GET /health`, `GET /version` - public, no session lookup.
 * - `POST /auth`, `DELETE /auth`, `PUT /auth/refresh`, `POST /gauth` - login, logout, token refresh, Google sign-in.
 * - `POST /2fa/request`, `POST /2fa/enable`, `POST /2fa/verify`, `DELETE /2fa/disable` - two-factor authentication.
 * - `POST /file`, `GET /file/:fileId`, `GET /file/:fileId/:name` - local uploads (only with `uploadDir`).
 * - `POST /attachments/upload`, `GET /attachments/:attachmentId`, `GET /attachments/:userId/:fileName` - MinIO presigned
 *   URLs (only with `minio`).
 * - `POST /mobile/:module/:action` - forwarded to {@link AuthProvider.mobileRequests}.
 * - `WS /ws/:endpoint[/:arg]` - named endpoints; `WS /ws-token/:token/:endpoint[/:arg]` is deprecated (token in the URL).
 *
 * @remarks
 * Middleware order: cookie parser, JSON body parser, access log ({@link logMiddleware}), session lookup, then the routes
 * above. Routes you add to {@link Endpoint.express} run after the session lookup, so authenticated requests carry the
 * token as `req.token` and the client as `req.info` (untyped).
 *
 * @example
 * ```ts
 * import { Endpoint, loop, LoopResult } from '@araminix/platform';
 *
 * const endpoint = new Endpoint({ authProvider: new MyAuthProvider(), mount: '/api', cookieSecret: process.env.COOKIE_SECRET });
 *
 * endpoint.express.get('/api/me', (req, res) => {
 *     const info = (req as { info?: unknown }).info;
 *     if (!info) return void res.status(401).end();
 *     res.json(info);
 * });
 *
 * loop(async () => {
 *     const next = await endpoint.acquire('echo'); // ws://host:3000/api/ws/echo
 *     if (next.isErr()) return LoopResult.Stop;
 *     const accepted = next.unwrap().accept();
 *     if (accepted.isOk()) serveEcho(accepted.unwrap());
 *     return LoopResult.Cont;
 * });
 *
 * endpoint.open();
 * ```
 */
export default class Endpoint {
    /** Authentication back-end. */
    private authProvider: AuthProvider;
    /** Listening port. */
    private port: number;
    /** Normalized route prefix (`''` or `/name`). */
    private mount: string;
    /** Value of `GET /version`. */
    private version: string;
    /** Cookie signing secret (configured or random). */
    private cookieSecret: string;
    /** Session cookie lifetime in seconds. */
    private sessionTtl: number;
    /** Upload directory, when uploads are enabled. */
    private uploadDir?: string | void;
    /** MinIO settings, when attachments are enabled. */
    private minio?: MinioOptions | void;
    /** Upload size limit in bytes. */
    private maxUploadBytes: number;
    /** Upload restrictions. */
    private uploadAllowlist?: UploadAllowlist;
    /** Accepted Google OAuth client ids. */
    private googleClientIds?: string[];
    /** Browser origins allowed to open WebSockets. */
    private allowedOrigins?: string[];
    /** Rate-limit configuration as given. */
    private authRateLimit?: RateLimitConfig | boolean;
    /** Shared rate-limit middleware of the authentication routes (a pass-through when disabled). */
    private authRateLimiter: any;
    /** WebSocket ping interval in milliseconds (0 = off). */
    private heartbeatIntervalMs: number;
    /** Limits passed to every {@link EndpointController}. */
    private readonly controllerOptions: EndpointControllerOptions;
    /** The `express-ws` instance (gives access to the `ws` server). */
    private readonly wsInstance: expressWs.Instance;
    /**
     * The Express application. Add your own routes and middleware here; they run after the built-in middleware. Use
     * {@link Endpoint.open} rather than `express.listen` so that {@link Endpoint.close} can stop the server.
     */
    readonly express: expressWs.Application;
    /** HTTP server created by {@link Endpoint.open}. */
    private server?: Server;
    /** Unused. */
    private readonly connections: Map<string, unknown> = new Map();
    /** One controller per declared endpoint name. */
    private endpoints: Map<string, EndpointController> = new Map();
    /** Effective cookie options (defaults merged with `cookieOptions`). */
    private COOKIE_OPTIONS: CookieOptions;

    /**
     * Builds the Express application and registers all routes; nothing listens until {@link Endpoint.open}.
     *
     * @param options - See {@link EndpointOptions}; only `authProvider` is required.
     * @throws Error when `minio` is set but misses `endPoint`, `port`, `accessKey`, `secretKey` or `bucketName`.
     */
    constructor({
        authProvider,
        port = 3000,
        mount,
        version,
        cookieSecret,
        sessionTtl = 3600 * 24,
        uploadDir,
        minio = undefined,
        cookieOptions,
        maxUploadBytes = 20 * 1024 * 1024,
        uploadAllowlist,
        googleClientIds,
        allowedOrigins,
        authRateLimit,
        maxMessageBytes = 16 * 1024 * 1024,
        heartbeatIntervalMs = 30000,
        trustProxy,
        maxConnectionsPerClient,
        maxPendingStreams,
    }: EndpointOptions) {
        this.authProvider = authProvider;
        this.port = port;
        this.mount = mount ? `/${trimSlash(mount)}` : '';
        this.version = version ?? '0.0.0';
        if (!cookieSecret) {
            logger.warn('Endpoint: no cookieSecret configured. A random secret is used, so sessions end on restart and cannot be shared between server instances.');
        }
        this.cookieSecret = cookieSecret || uuid();
        this.heartbeatIntervalMs = heartbeatIntervalMs;
        this.controllerOptions = { maxConnectionsPerClient, maxPendingStreams };
        this.sessionTtl = sessionTtl;
        this.uploadDir = uploadDir;
        this.minio = minio;
        this.maxUploadBytes = maxUploadBytes;
        this.uploadAllowlist = uploadAllowlist;
        this.googleClientIds = googleClientIds;
        this.allowedOrigins = allowedOrigins;
        this.authRateLimit = authRateLimit;

        const rateLimitEnabled = this.authRateLimit !== false;
        if (rateLimitEnabled) {
            const customConfig = typeof this.authRateLimit === 'object' ? this.authRateLimit : {};
            this.authRateLimiter = rateLimit({
                windowMs: customConfig.windowMs ?? 15 * 60 * 1000,
                limit: customConfig.limit ?? customConfig.max ?? 100,
                standardHeaders: true,
                legacyHeaders: false,
                validate: { xForwardedForHeader: false, default: false },
                message: customConfig.message ?? {
                    message: 'Too many authentication attempts, please try again later.',
                    error: 'Too many requests',
                },
                keyGenerator:
                    customConfig.keyGenerator ??
                    ((req: Request) => {
                        const rawIp = req.ip || req.socket?.remoteAddress || req.headers['x-forwarded-for'] || '127.0.0.1';
                        const ip = ipKeyGenerator(typeof rawIp === 'string' ? rawIp : Array.isArray(rawIp) ? rawIp[0] : '127.0.0.1');
                        const account = req.body?.accountName || req.body?.username || req.body?.email || req.body?.account || req.body?.old_token || '';
                        return account ? `${ip}:${account}` : ip;
                    }),
                ...customConfig,
            });
        } else {
            this.authRateLimiter = (_req: Request, _res: Response, next: NextFunction) => next();
        }

        this.COOKIE_OPTIONS = {
            signed: true,
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            path: '/',
            maxAge: this.sessionTtl * 1000,
            ...cookieOptions,
        };
        const wsOptions: any = {
            maxPayload: maxMessageBytes,
            verifyClient: (info: any, cb: (res: boolean, code?: number, message?: string) => void) => {
                const origin = info.origin || info.req?.headers?.origin || info.req?.headers?.['sec-websocket-origin'];
                const allowed = this.checkOrigin(origin);
                if (allowed) {
                    return cb(true);
                }
                return cb(false, 403, 'Forbidden');
            },
        };
        this.wsInstance = expressWs(expressCore(), undefined, { wsOptions });
        this.express = this.wsInstance.app;
        if (trustProxy !== undefined) {
            this.express.set('trust proxy', trustProxy);
        }
        this.init();
    }

    /** Applies the {@link EndpointOptions.allowedOrigins} policy to an `Origin` header value (absent origin = allowed). */
    private checkOrigin(origin?: string): boolean {
        if (!origin) {
            return true;
        }
        if (!this.allowedOrigins || this.allowedOrigins.length === 0) {
            return false;
        }
        if (this.allowedOrigins.includes('*')) {
            return true;
        }
        const normalized = origin.trim().toLowerCase().replace(/\/+$/, '');
        return this.allowedOrigins.some((allowed) => {
            return allowed.trim().toLowerCase().replace(/\/+$/, '') === normalized;
        });
    }

    /** Applies {@link Endpoint.checkOrigin} to the `Origin` (or `Sec-WebSocket-Origin`) header of a request. */
    private isOriginAllowed(req: Request | any): boolean {
        const origin = req.headers?.origin || req.headers?.['sec-websocket-origin'];
        return this.checkOrigin(origin);
    }

    /** Installs the middleware and the routes, in order. */
    private init(): expressWs.Application {
        this.express.use(cookieParser(this.cookieSecret));
        this.express.use(expressCore.json());
        this.express.use(logMiddleware);
        this.initMiddleware();
        this.initWs();
        this.initAuth();
        if (this.uploadDir) {
            this.initMulter(this.uploadDir);
        }
        if (this.minio) {
            this.initMinio(this.minio);
        }
        this.init2FA();
        this.initMobileRequests();
        return this.express;
    }

    /**
     * Registers a WebSocket endpoint name. Clients that connect to an undeclared name are closed with code 4404
     * (`WsCloseCodes.NotFound`). {@link Endpoint.acquire} declares its name implicitly; calling `declare` early lets clients
     * connect (and queue) before the first `acquire`.
     *
     * @param name - Endpoint name, the `:endpoint` path segment.
     */
    declare(name: string): void {
        if (!this.endpoints.has(name)) {
            const endpointController = new EndpointController(this.controllerOptions);
            this.endpoints.set(name, endpointController);
        }
    }

    /**
     * Waits for the next client that connects to `name` (declaring the name if needed).
     *
     * Only one `acquire` per name may be pending: a second call resolves the first with `Err`. With {@link Platform} the names
     * `platform`, `instance` and `agent` are already consumed; use other names for your own endpoints.
     *
     * @param name - Endpoint name.
     * @returns The next {@link ConnectRequest}, or `Err(undefined)` when superseded by another `acquire(name)`.
     *
     * @example
     * ```ts
     * const next = await endpoint.acquire('chat');
     * if (next.isOk()) {
     *     const request = next.unwrap();
     *     const socket = request.accept();
     * }
     * ```
     */
    acquire(name: string): Promise<Result<ConnectRequest, void>> {
        logger.trace(`Endpoint - acquire name: ${name}`);
        this.declare(name);
        return this.endpoints.get(name)!.acquire();
    }

    /** Hands an authenticated WebSocket to the controller of `endpointName` (or closes it with 4404) and starts its heartbeat. */
    private async handle(token: string, info: ClientInfo, endpointName: string, arg: string, ws: any): Promise<void> {
        const endpoint = this.endpoints.get(endpointName);
        if (!endpoint) {
            ws.close(WsCloseCodes.NotFound);
            return;
        }
        this.startHeartbeat(ws);
        await endpoint.connect(ws, token, info, arg);
    }

    // Detects half-open sockets (clients that vanished without a close frame) so their connections can expire.
    /** Pings `ws` every `heartbeatIntervalMs` and terminates it when a ping goes unanswered. */
    private startHeartbeat(ws: any): void {
        if (this.heartbeatIntervalMs <= 0 || typeof ws.ping !== 'function' || typeof ws.on !== 'function') {
            return;
        }
        let alive = true;
        ws.on('pong', () => {
            alive = true;
        });
        const timer = setInterval(() => {
            if (!alive) {
                ws.terminate();
                return;
            }
            alive = false;
            try {
                ws.ping();
            } catch {
                // the close handler clears the timer
            }
        }, this.heartbeatIntervalMs);
        timer.unref?.();
        ws.on('close', () => clearInterval(timer));
    }

    /** Destroys every WebSocket connection of `info` that was opened with `token`, on all endpoints. */
    private deauth(info: ClientInfo, token: string): void {
        this.endpoints.forEach((endpoint) => {
            endpoint.deauthUser(info, token);
        });
    }

    /**
     * Session middleware: reads the token from the signed `token` cookie (preferred) or the `x-token` header and resolves it
     * with {@link AuthProvider.getInfo} into `req.token` / `req.info`. Skipped for `/health` and `/version`.
     */
    private initMiddleware(): void {
        this.express.use(async (req: CustomRequest, _res: Response, next: NextFunction) => {
            if (req.path === `${this.mount}/health` || req.path === `${this.mount}/version`) {
                return next();
            }
            const cookieToken = req.signedCookies?.token;
            const headerToken = req.header('x-token');
            req.token = cookieToken ? cookieToken : headerToken ? headerToken : undefined;
            if (req.token) {
                const result = await this.authProvider.getInfo(req.token);
                if (result.isOk()) {
                    req.info = result.unwrap();
                }
            }
            return next();
        });
    }

    /**
     * Registers the WebSocket routes. Every route checks the `Origin`, authenticates the client and hands the socket to the
     * named endpoint; failures close the socket with 4403 (origin), 4401 (no session), 4404 (unknown endpoint) or 1011
     * (unexpected error).
     */
    private initWs(): void {
        /**
         * @deprecated Use /ws/:endpoint/:arg with cookie or x-token header instead.
         */
        this.express.ws(`${this.mount}/ws-token/:token/:endpoint/:arg`, async (ws, req: any) => {
            try {
                if (!this.isOriginAllowed(req)) {
                    ws.close(WsCloseCodes.Denied);
                    return;
                }
                const token = String(req.params.token);
                const endpointName = String(req.params.endpoint);
                const arg = String(req.params.arg ?? '');
                const result = await this.authProvider.getInfo(token);
                if (result.isErr()) {
                    ws.close(WsCloseCodes.Unauthorized);
                    return;
                }
                const clientInfo = result.unwrap();
                await this.handle(token, clientInfo, endpointName, arg, ws);
            } catch (err) {
                logger.error('Unhandled rejection in /ws-token/:token/:endpoint/:arg:', err);
                try {
                    ws.close(WsCloseCodes.InternalError);
                } catch {}
            }
        });

        /**
         * @deprecated Use /ws/:endpoint with cookie or x-token header instead.
         */
        this.express.ws(`${this.mount}/ws-token/:token/:endpoint`, async (ws, req: any) => {
            try {
                if (!this.isOriginAllowed(req)) {
                    ws.close(WsCloseCodes.Denied);
                    return;
                }
                const token = String(req.params.token);
                const endpointName = String(req.params.endpoint);
                const arg = '';
                const result = await this.authProvider.getInfo(token);
                if (result.isErr()) {
                    ws.close(WsCloseCodes.Unauthorized);
                    return;
                }
                const info = result.unwrap();
                await this.handle(token, info, endpointName, arg, ws);
            } catch (err) {
                logger.error('Unhandled rejection in /ws-token/:token/:endpoint:', err);
                try {
                    ws.close(WsCloseCodes.InternalError);
                } catch {}
            }
        });

        /** Preferred route: authenticated by the session cookie or the `x-token` upgrade header; `arg` is passed to the endpoint. */
        this.express.ws(`${this.mount}/ws/:endpoint/:arg`, async (ws, req: CustomRequest) => {
            try {
                if (!this.isOriginAllowed(req)) {
                    ws.close(WsCloseCodes.Denied);
                    return;
                }
                if (!req.info || !req.token) {
                    ws.close(WsCloseCodes.Unauthorized);
                    return;
                }
                const arg = String(req.params.arg ?? '');
                const endpointName = String(req.params.endpoint);
                await this.handle(req.token, req.info, endpointName, arg, ws);
            } catch (err) {
                logger.error('Unhandled rejection in /ws/:endpoint/:arg:', err);
                try {
                    ws.close(WsCloseCodes.InternalError);
                } catch {}
            }
        });

        /** Same as `/ws/:endpoint/:arg` with an empty `arg`. */
        this.express.ws(`${this.mount}/ws/:endpoint`, async (ws, req: CustomRequest) => {
            try {
                if (!this.isOriginAllowed(req)) {
                    ws.close(WsCloseCodes.Denied);
                    return;
                }
                if (!req.info || !req.token) {
                    ws.close(WsCloseCodes.Unauthorized);
                    return;
                }
                const arg = '';
                const endpointName = String(req.params.endpoint);
                await this.handle(req.token, req.info, endpointName, arg, ws);
            } catch (err) {
                logger.error('Unhandled rejection in /ws/:endpoint:', err);
                try {
                    ws.close(WsCloseCodes.InternalError);
                } catch {}
            }
        });
    }

    /** Registers `/health`, `/version`, `/auth` (login, logout, refresh) and `/gauth`. */
    private initAuth(): void {
        this.express.get(`${this.mount}/health`, (_req, res) => {
            res.status(200).send('200!').end();
        });

        this.express.get(`${this.mount}/version`, (_req, res) => {
            res.status(200).json({ version: this.version }).end();
        });

        this.express.post(`${this.mount}/auth`, this.authRateLimiter, async (req, res) => {
            const result = await this.authProvider.auth(req.body);
            if (result.isErr()) {
                logger.error('API Auth - Login Error: ', result.e);
                res.status(401)
                    .send({ error: clientError(result.e, 'Unauthorized') })
                    .end();
                return;
            }
            const authResponse = result.unwrap();
            if (typeof authResponse === 'object') {
                res.status(200).send(authResponse).end();
            } else {
                res.cookie('token', authResponse, this.COOKIE_OPTIONS).status(200).end();
            }
        });

        // TODO (D6): Long-term improvement - have frontend send Google ID token and verify using google-auth-library
        this.express.post(`${this.mount}/gauth`, this.authRateLimiter, async (req, res) => {
            if (!this.googleClientIds || this.googleClientIds.length === 0) {
                logger.error('Google Auth Error: "googleClientIds" is not configured on Endpoint.');
                res.status(503).send({ message: 'Google authentication is not configured on this server.' }).end();
                return;
            }

            const access_token = req.body?.access_token;
            if (!access_token || typeof access_token !== 'string') {
                logger.error('Google Auth Validation Error: "access_token" is required in body.');
                res.status(422).send({ message: '"access_token" is required in body.' }).end();
                return;
            }

            const tokenInfoResult = await wrap<any>(
                axios.get(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(access_token)}`, {
                    timeout: 10000,
                }),
            );
            if (tokenInfoResult.isErr()) {
                logger.error('Google Auth Token Info Error: ', loggableError(tokenInfoResult.e));
                res.status(401).send({ error: 'Invalid Google token' }).end();
                return;
            }
            const tokenInfoResponse = tokenInfoResult.unwrap();
            if (tokenInfoResponse.status !== 200 || !tokenInfoResponse.data) {
                logger.error('Google Auth Token Info Status not 200: ', tokenInfoResponse.data);
                res.status(401).send({ error: 'Invalid Google token' }).end();
                return;
            }

            const tokenData = tokenInfoResponse.data;
            const isAudValid = typeof tokenData.aud === 'string' && this.googleClientIds.includes(tokenData.aud);
            const isAzpValid = typeof tokenData.azp === 'string' && this.googleClientIds.includes(tokenData.azp);
            const isClientAuthorized = isAudValid || isAzpValid;
            const isEmailVerified = tokenData.email_verified === 'true' || tokenData.email_verified === true;

            if (!isClientAuthorized || !isEmailVerified) {
                logger.error('Google Auth Token Verification Failed: token not issued for configured client or email not verified.', {
                    aud: tokenData.aud,
                    azp: tokenData.azp,
                    email_verified: tokenData.email_verified,
                });
                res.status(401).send({ error: 'Unauthorized Google token: client ID mismatch or email not verified.' }).end();
                return;
            }

            const userInfoResult = await wrap<any>(
                axios.get('https://www.googleapis.com/oauth2/v1/userinfo', {
                    headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' },
                    timeout: 10000,
                }),
            );
            if (userInfoResult.isErr()) {
                logger.error('Google Auth API Error: ', loggableError(userInfoResult.e));
                res.status(401).send({ error: 'Invalid Google token' }).end();
                return;
            }
            const authResponse = userInfoResult.unwrap();
            if (authResponse.status !== 200) {
                logger.error('Google Auth Status not 200: ', authResponse.data);
                res.status(401).send({ error: 'Invalid Google token' }).end();
                return;
            }
            const googleData = authResponse.data;
            if ((googleData as any)?.verified_email === false) {
                logger.error('Google Auth UserInfo Verification Error: email is not verified.', googleData);
                res.status(401).send({ error: 'Google email is not verified.' }).end();
                return;
            }
            if (tokenData.email && googleData?.email && tokenData.email.toLowerCase() !== googleData.email.toLowerCase()) {
                logger.error('Google Auth Verification Error: tokeninfo email does not match userinfo email.', {
                    tokenEmail: tokenData.email,
                    userEmail: googleData.email,
                });
                res.status(401).send({ error: 'Google token email does not match userinfo.' }).end();
                return;
            }

            if (GoogleData.is(googleData)) {
                const authRes = await this.authProvider.googleAuth(googleData);
                if (authRes.isErr()) {
                    logger.error('Google Auth Provider Error: ', authRes.e);
                    res.status(401)
                        .send({ error: clientError(authRes.e, 'Unauthorized') })
                        .end();
                    return;
                }
                const response = authRes.unwrap();
                if (typeof response === 'object') {
                    res.status(200).send(response).end();
                    return;
                }
                res.cookie('token', response, this.COOKIE_OPTIONS).status(200).end();
            } else {
                logger.error('Google Data Read Error: ', googleData);
                res.status(500).end();
            }
        });

        this.express.delete(`${this.mount}/auth`, async (req: CustomRequest, res) => {
            if (req.token && req.info) {
                await this.authProvider.destroy(req.token);
                this.deauth(req.info, req.token);
            }
            res.clearCookie('token', this.COOKIE_OPTIONS).status(200).send({ success: true }).end();
        });

        this.express.put(`${this.mount}/auth/refresh`, this.authRateLimiter, async (req, res) => {
            const oldToken = req.body?.old_token;
            if (!oldToken || typeof oldToken !== 'string') {
                res.status(400).send({ message: '"old_token" is required in body.' }).end();
                return;
            }
            const result = await this.authProvider.refreshToken(oldToken);
            if (result.isErr()) {
                logger.error('API Auth - Refresh Token Error: ', result.e);
                res.status(401)
                    .send({ error: clientError(result.e, 'Unauthorized') })
                    .end();
                return;
            }
            const token = result.unwrap();
            res.cookie('token', token, this.COOKIE_OPTIONS).status(200).end();
        });
    }

    /**
     * Makes an uploaded file name safe to store: keeps the base name, removes slashes, backslashes and control characters,
     * trims it, replaces empty, `.` and `..` names with `upload`, and caps the length at 255 characters.
     */
    private sanitizeFilename(originalName: string): string {
        const base = path
            .basename(originalName)
            .replace(/[/\\]/g, '')
            .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
            .trim();
        const safe = base === '.' || base === '..' || base === '' ? 'upload' : base;
        return safe.slice(0, 255);
    }

    /**
     * Registers the local upload routes: `POST /file` (multipart field `file`), `GET /file/:fileId` (302 to the named URL)
     * and the static `GET /file/:fileId/:name` download, which is sent with `X-Content-Type-Options: nosniff`,
     * `Content-Disposition: attachment` and `Content-Security-Policy: default-src 'none'; sandbox`.
     */
    private initMulter(uploadDir: string): void {
        const sanitize = (name: string) => this.sanitizeFilename(name);
        const storage = multer.diskStorage({
            destination: function (_req, file: any, cb) {
                const id = uuid();
                const dir = path.join(uploadDir, id);
                fs.mkdirSync(dir, { recursive: true });
                file.id = id;
                cb(null, dir);
            },
            filename: function (_req, file, cb) {
                file.originalname = sanitize(file.originalname || '');
                cb(null, file.originalname);
            },
        });

        const fileFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
            if (this.uploadAllowlist) {
                const { extensions, mimetypes } = this.uploadAllowlist;
                const safeName = sanitize(file.originalname || '');
                const ext = path.extname(safeName).toLowerCase().replace(/^\./, '');
                const mime = (file.mimetype || '').toLowerCase();

                if (extensions && extensions.length > 0) {
                    const normalizedExts = extensions.map((e) => e.toLowerCase().replace(/^\./, ''));
                    if (!normalizedExts.includes(ext)) {
                        const err = new Error('File extension not allowed');
                        (err as any).statusCode = 415;
                        cb(err);
                        return;
                    }
                }

                if (mimetypes && mimetypes.length > 0) {
                    const normalizedMimes = mimetypes.map((m) => m.toLowerCase());
                    if (!normalizedMimes.includes(mime)) {
                        const err = new Error('MIME type not allowed');
                        (err as any).statusCode = 415;
                        cb(err);
                        return;
                    }
                }
            }
            cb(null, true);
        };

        const upload = multer({
            storage: storage,
            limits: {
                fileSize: this.maxUploadBytes,
                files: 1,
            },
            fileFilter,
        });

        this.express.post(
            `${this.mount}/file`,
            validateToken,
            (req: CustomRequest, res: Response, next: NextFunction) => {
                upload.single('file')(req, res, (err: any) => {
                    if (err) {
                        if (err instanceof multer.MulterError) {
                            if (err.code === 'LIMIT_FILE_SIZE') {
                                res.status(413).json({ error: `File exceeds maximum allowed size of ${this.maxUploadBytes} bytes` });
                                return;
                            }
                            res.status(400).json({ error: err.message });
                            return;
                        }
                        const status = err.statusCode || 400;
                        res.status(status).json({ error: err.message || 'Upload error' });
                        return;
                    }
                    if (!req.file) {
                        res.status(400).json({ error: 'No file uploaded' });
                        return;
                    }
                    next();
                });
            },
            (req: CustomRequest, res) => {
                const { originalname, size, mimetype, id } = req.file;
                const fileInfo = {
                    name: originalname,
                    size,
                    mimetype,
                    id,
                    userId: req.info?.id ?? '',
                };
                const infoPath = path.join(uploadDir, fileInfo.id, 'index.json');
                fs.writeFile(infoPath, JSON.stringify(fileInfo), (err) => {
                    if (err) {
                        logger.error('Failed to write file metadata:', err);
                        res.status(500).json({ error: 'Failed to save file metadata' }).end();
                        return;
                    }
                    res.status(200).json(fileInfo).end();
                });
            },
        );

        this.express.get(`${this.mount}/file/:fileId`, validateToken, (req, res) => {
            const fileId = String(req.params.fileId);
            if (!UUID_PATTERN.test(fileId)) {
                res.status(404).end();
                return;
            }
            const dir = path.join(uploadDir, fileId);
            fs.readFile(path.join(dir, 'index.json'), (err, data) => {
                if (err) {
                    res.status(404).end();
                } else {
                    try {
                        const info = JSON.parse(data.toString());
                        if (!info || typeof info.name !== 'string') {
                            res.status(404).end();
                            return;
                        }
                        const safeName = encodeURIComponent(path.basename(info.name));
                        if (!safeName) {
                            res.status(404).end();
                            return;
                        }
                        res.redirect(302, `${req.baseUrl}${req.path}/${safeName}`);
                    } catch (parseErr) {
                        logger.error('Corrupt index.json for fileId:', fileId, parseErr);
                        res.status(404).end();
                    }
                }
            });
        });

        this.express.use(
            `${this.mount}/file/`,
            validateToken,
            expressCore.static(this.uploadDir!, {
                index: false,
                dotfiles: 'deny',
                setHeaders: (res) => {
                    res.setHeader('X-Content-Type-Options', 'nosniff');
                    res.setHeader('Content-Disposition', 'attachment');
                    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
                },
            }),
        );
    }

    /** Registers `/2fa/request`, `/2fa/enable`, `/2fa/verify` and `/2fa/disable`. */
    private init2FA(): void {
        this.express.post(`${this.mount}/2fa/request`, validateToken, async (req: CustomRequest, res) => {
            try {
                const result = await this.authProvider.request2FA(req.info?.id ?? '');
                if (!result.isOk()) {
                    logger.error('API Auth - 2FA Request Error: ', result.e);
                    res.status(401)
                        .send({ error: clientError(result.e, 'Unauthorized') })
                        .end();
                    return;
                }
                res.status(200).send({ url: result.v }).end();
            } catch (error) {
                logger.error('Request failed:', error);
                res.status(500).send({ error: 'Internal server error' }).end();
            }
        });

        /**
         * Enables 2FA for the authenticated user.
         *
         * SECURITY REQUIREMENT:
         * The AuthProvider implementation MUST verify that the `secret` in the request body
         * matches the secret that the server issued in `request2FA` for this user, rather than
         * blindly accepting an arbitrary secret provided by the client.
         */
        this.express.post(`${this.mount}/2fa/enable`, validateToken, this.authRateLimiter, async (req: CustomRequest, res) => {
            try {
                const { code, secret } = req.body;
                if (!code) {
                    res.status(400).send({ message: '2FA code is required' }).end();
                    return;
                }
                if (!secret) {
                    res.status(400).send({ message: '2FA secret is required' }).end();
                    return;
                }
                const result = await this.authProvider.enable2FA(req.info?.id ?? '', secret, code);
                if (!result.isOk()) {
                    logger.error('API Auth - 2FA Enable Error: ', result.e);
                    res.status(401)
                        .send({ error: clientError(result.e, 'Unauthorized') })
                        .end();
                    return;
                }
                res.status(200).send({ success: result.v }).end();
            } catch (error) {
                logger.error('Request failed:', error);
                res.status(500).send({ error: 'Internal server error' }).end();
            }
        });

        this.express.post(`${this.mount}/2fa/verify`, this.authRateLimiter, async (req, res) => {
            try {
                const { accountName, code, uuid: uuidCode } = req.body;
                if (!accountName || !code || !uuidCode) {
                    res.status(400).send({ message: 'AccountName, code, and uuid are required.' }).end();
                    return;
                }
                const result = await this.authProvider.verify2FA(accountName, code, uuidCode);
                if (result.isErr()) {
                    logger.error('API Auth - 2FA Verify Error: ', result.e);
                    res.status(401)
                        .send({ error: clientError(result.e, 'Unauthorized') })
                        .end();
                    return;
                }
                const verifyResponse = result.unwrap();
                if (typeof verifyResponse === 'boolean') {
                    res.status(200).send({ success: verifyResponse }).end();
                } else {
                    res.cookie('token', verifyResponse, this.COOKIE_OPTIONS).status(200).end();
                }
            } catch (error) {
                logger.error('Request failed:', error);
                res.status(500).send({ error: 'Internal server error' }).end();
            }
        });

        this.express.delete(`${this.mount}/2fa/disable`, validateToken, this.authRateLimiter, async (req: CustomRequest, res) => {
            try {
                const rawCode = req.body?.code ?? req.query?.code;
                const code = rawCode !== undefined && rawCode !== null ? String(rawCode) : undefined;
                const result = await this.authProvider.disable2FA(req.info?.id ?? '', code);
                if (result.isErr()) {
                    logger.error('API Auth - 2FA Disable Error: ', result.e);
                    res.status(401)
                        .send({ error: clientError(result.e, 'Unauthorized') })
                        .end();
                    return;
                }
                res.status(200).send({ success: result.unwrap() }).end();
            } catch (error) {
                logger.error('Request failed:', error);
                res.status(500).send({ error: 'Internal server error' }).end();
            }
        });
    }

    /**
     * Registers the MinIO attachment routes. Object keys are always `<userId>/<uuid>[.<ext>]`, generated on the server, and a
     * user can only obtain download URLs below their own `<userId>/` prefix.
     */
    private initMinio(minio: MinioOptions): void {
        const minioService = new MinioService(minio);

        this.express.post(`${this.mount}/attachments/upload`, validateToken, async (req: CustomRequest, res) => {
            try {
                if (!req.info?.id) {
                    res.status(401).send({ message: 'Unauthorized' }).end();
                    return;
                }

                const { mimetype, fileName } = req.body || {};
                if (!mimetype || typeof mimetype !== 'string' || !fileName || typeof fileName !== 'string') {
                    res.status(400).send({ message: 'mimetype and fileName are required strings.' }).end();
                    return;
                }

                const decodedFileName = (() => {
                    try {
                        return decodeURIComponent(fileName);
                    } catch {
                        return fileName;
                    }
                })();

                if (
                    fileName.includes('..') ||
                    fileName.startsWith('/') ||
                    fileName.startsWith('\\') ||
                    decodedFileName.includes('..') ||
                    decodedFileName.startsWith('/') ||
                    decodedFileName.startsWith('\\')
                ) {
                    res.status(400).send({ message: 'Invalid fileName: path traversal and leading slash are not allowed.' }).end();
                    return;
                }

                // Prefer the mimetype's extension: MinioService appends it to any key that doesn't already end with it,
                // so using it here keeps the returned key identical to the object name that gets presigned.
                const mimeExt = MimeToExtension[mimetype as MIME_TYPE];
                let ext = mimeExt && mimeExt !== '*' ? mimeExt : path.extname(fileName).replace(/^\./, '').trim().toLowerCase();
                if (ext && !/^[a-zA-Z0-9]+$/.test(ext)) {
                    ext = '';
                }

                const userId = req.info.id;
                const fileId = uuid();
                const key = ext ? `${userId}/${fileId}.${ext}` : `${userId}/${fileId}`;

                const urlResult = await minioService.presignedPutObject(mimetype as MIME_TYPE, key);
                if (urlResult.isErr()) {
                    logger.error('Error on Upload Request API: ', urlResult.e);
                    res.status(500).send({ error: 'Failed to create upload URL' }).end();
                    return;
                }
                const url = urlResult.unwrap();
                res.status(200).json({ url, key, attachmentId: key }).end();
            } catch (error) {
                logger.error('Error on Upload Request API: ', error);
                res.status(500).send({ error: 'Internal server error' }).end();
            }
        });

        const handleGetAttachment = async (req: CustomRequest, res: Response) => {
            try {
                if (!req.info?.id) {
                    res.status(401).send({ message: 'Unauthorized' }).end();
                    return;
                }

                let attachmentId = '';
                if (req.params.userId && req.params.fileName) {
                    attachmentId = `${req.params.userId}/${req.params.fileName}`;
                } else if (req.params.attachmentId) {
                    attachmentId = String(req.params.attachmentId);
                }

                if (!attachmentId) {
                    res.status(400).send({ message: 'attachmentId is required.' }).end();
                    return;
                }

                const decoded = (() => {
                    try {
                        return decodeURIComponent(attachmentId);
                    } catch {
                        return attachmentId;
                    }
                })();

                if (
                    attachmentId.includes('..') ||
                    attachmentId.startsWith('/') ||
                    attachmentId.startsWith('\\') ||
                    decoded.includes('..') ||
                    decoded.startsWith('/') ||
                    decoded.startsWith('\\')
                ) {
                    res.status(400).send({ message: 'Invalid attachmentId: path traversal and leading slash are not allowed.' }).end();
                    return;
                }

                const userId = req.info.id;
                let objectKey: string;

                if (attachmentId.startsWith(`${userId}/`)) {
                    objectKey = attachmentId;
                } else if (!attachmentId.includes('/')) {
                    objectKey = `${userId}/${attachmentId}`;
                } else {
                    logger.error(`IDOR attempt or unauthorized attachment access denied for user '${userId}': ${attachmentId}`);
                    res.status(403).send({ message: 'Forbidden: access to attachment denied.' }).end();
                    return;
                }

                if (objectKey === `${userId}/` || objectKey.endsWith('/')) {
                    res.status(400).send({ message: 'Invalid attachmentId: file name cannot be empty.' }).end();
                    return;
                }

                const fileURLResult = await minioService.presignedGetObject(objectKey);
                if (fileURLResult.isErr()) {
                    logger.error('Error on Get File API: ', fileURLResult.e);
                    res.status(500).send({ error: 'Failed to create download URL' }).end();
                    return;
                }
                const fileURL = fileURLResult.unwrap();
                res.status(200).json({ fileURL }).end();
            } catch (error) {
                logger.error('Error on Get File API: ', error);
                res.status(500).send({ error: 'Internal server error' }).end();
            }
        };

        this.express.get(`${this.mount}/attachments/:attachmentId`, validateToken, handleGetAttachment);
        this.express.get(`${this.mount}/attachments/:userId/:fileName`, validateToken, handleGetAttachment);
    }

    /** Registers `POST /mobile/:module/:action`, which forwards to {@link AuthProvider.mobileRequests}. */
    private initMobileRequests(): void {
        this.express.post(`${this.mount}/mobile/:module/:action`, validateToken, async (req: CustomRequest, res) => {
            try {
                const moduleName = String(req.params.module);
                const action = String(req.params.action);
                if (!moduleName || !action) {
                    res.status(400).send({ error: 'Module and action are both required.' }).end();
                    return;
                }
                const result = await this.authProvider.mobileRequests({
                    module: moduleName,
                    action: action,
                    userId: req.info?.id ?? '',
                    data: req.body,
                });
                if (result.status !== 200) {
                    logger.error('API Auth - Mobile Request Error: ', result.error);
                }
                res.status(result.status).send(result).end();
            } catch (error) {
                logger.error('Request failed:', error);
                res.status(500).send({ error: 'Internal server error' }).end();
            }
        });
    }

    /**
     * Starts listening on {@link EndpointOptions.port}. Calling it again while open does nothing.
     *
     * @remarks
     * The call does not wait for the socket to be bound and installs no `error` listener on the HTTP server, so a port that
     * is already in use surfaces as an uncaught `error` event.
     */
    open(): void {
        if (!this.server) {
            this.server = this.express.listen(this.port);
        }
    }

    /**
     * Terminates every open WebSocket and stops accepting HTTP connections. Pending {@link Endpoint.acquire} calls are not
     * resolved, and the endpoint cannot be reopened after `close()`.
     */
    close(): void {
        // server.close() only stops new connections; open WebSockets would keep it (and the process) alive.
        this.wsInstance.getWss().clients.forEach((client) => client.terminate());
        if (this.server) {
            this.server.close();
        }
    }
}
