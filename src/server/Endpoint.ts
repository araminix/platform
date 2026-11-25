import { logger, Result, trimSlash, uuid, WsCloseCodes } from '@araminix/lib';
import cookieParser from 'cookie-parser';
import expressCore, { CookieOptions, Request } from 'express';
import expressWs from 'express-ws';
import type { Server } from 'http';

import { logMiddleware, MinioOptions } from '../utils/index.js';
import { AuthProvider, ClientInfo } from './AuthProvider.js';
import { ConnectRequest } from './ConnectRequest.js';
import { registerAttachmentRoutes } from './endpoint/attachmentRoutes.js';
import { registerAuthRoutes } from './endpoint/authRoutes.js';
import { registerMobileRoutes } from './endpoint/mobileRoutes.js';
import { isOriginAllowed as checkRequestOrigin, createAuthRateLimiter, createSessionMiddleware } from './endpoint/security.js';
import { registerTwoFactorRoutes } from './endpoint/twoFactorRoutes.js';
import { AuthRateLimiterMiddleware, EndpointOptions, RateLimitConfig, ServerDriver, UploadAllowlist, UploadedFileInfo } from './endpoint/types.js';
import { registerUploadRoutes, sanitizeFilename as sanitizeUploadFilename } from './endpoint/uploadRoutes.js';
import { createWsOptions, registerWsRoutes, startHeartbeat as startWsHeartbeat } from './endpoint/wsRoutes.js';
import EndpointController, { EndpointControllerOptions } from './EndpointController.js';

export { EndpointOptions, MinioOptions, RateLimitConfig, ServerDriver, UploadAllowlist, UploadedFileInfo };

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
 * - `WS /ws/:endpoint[/:arg]` - named endpoints; deprecated `WS /ws-token/:token/:endpoint[/:arg]` is disabled by default unless {@link EndpointOptions.allowUrlTokenWs} is set.
 *
 * @remarks
 * Middleware order: cookie parser, JSON body parser, access log ({@link logMiddleware}), session lookup, then the routes
 * above. Routes you add to {@link Endpoint.express} run after the session lookup, so authenticated requests carry the
 * token as `req.token` and the client as `req.info` (untyped).
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
    /** Optional hook to enrich or override `POST /file` metadata in `index.json`. */
    private getUploadMetadata?: EndpointOptions['getUploadMetadata'];
    /** Optional authorization callback enforced on local `/file` downloads. */
    private authorizeFileAccess?: EndpointOptions['authorizeFileAccess'];
    /** Accepted Google OAuth client ids. */
    private googleClientIds?: string[];
    /** Browser origins allowed to open WebSockets. */
    private allowedOrigins?: string[];
    /** Whether deprecated `/ws-token/...` routes are registered. */
    private readonly allowUrlTokenWs: boolean;
    /** Hook called after `DELETE /auth` closes the session's WebSocket connections. */
    private onDeauth?: (info: ClientInfo, token: string) => void;
    /** Shared rate-limit middleware of the authentication routes (a pass-through when disabled). */
    private authRateLimiter: AuthRateLimiterMiddleware;
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
        getUploadMetadata,
        authorizeFileAccess,
        googleClientIds,
        allowedOrigins,
        authRateLimit,
        maxMessageBytes = 16 * 1024 * 1024,
        heartbeatIntervalMs = 30000,
        trustProxy,
        maxConnectionsPerClient,
        maxPendingStreams,
        maxBufferedBytes,
        allowUrlTokenWs = false,
        onDeauth,
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
        this.controllerOptions = { maxConnectionsPerClient, maxPendingStreams, maxBufferedBytes };
        this.sessionTtl = sessionTtl;
        this.uploadDir = uploadDir;
        this.minio = minio;
        this.maxUploadBytes = maxUploadBytes;
        this.uploadAllowlist = uploadAllowlist;
        this.getUploadMetadata = getUploadMetadata;
        this.authorizeFileAccess = authorizeFileAccess;
        this.googleClientIds = googleClientIds;
        this.allowedOrigins = allowedOrigins;
        this.allowUrlTokenWs = allowUrlTokenWs;
        this.onDeauth = onDeauth;
        if (this.allowUrlTokenWs) {
            logger.warn('Endpoint: allowUrlTokenWs is enabled. Deprecated /ws-token/... routes expose session tokens in URLs and should only be used temporarily for migration.');
        }

        this.authRateLimiter = createAuthRateLimiter(this.mount, authRateLimit);
        this.COOKIE_OPTIONS = {
            signed: true,
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            path: '/',
            maxAge: this.sessionTtl * 1000,
            ...cookieOptions,
        };

        const wsOptions = createWsOptions(this.mount, maxMessageBytes, this.allowUrlTokenWs, this.allowedOrigins);
        this.wsInstance = expressWs(expressCore(), undefined, { wsOptions });
        this.express = this.wsInstance.app;
        if (trustProxy !== undefined) {
            this.express.set('trust proxy', trustProxy);
        }
        this.init();
    }

    /** Applies the configured origin policy to the `Origin` (or `Sec-WebSocket-Origin`) header of a request. */
    private isOriginAllowed(req: Request | any): boolean {
        return checkRequestOrigin(this.allowedOrigins, req);
    }

    /** Sanitizes an uploaded filename; delegates to the upload module helper. */
    private sanitizeFilename(originalName: string): string {
        return sanitizeUploadFilename(originalName);
    }

    /** Pings `ws` every `heartbeatIntervalMs` and terminates it when a ping goes unanswered. */
    private startHeartbeat(ws: any): void {
        startWsHeartbeat(ws, this.heartbeatIntervalMs);
    }

    /** Installs the middleware and the routes, in order. */
    private init(): expressWs.Application {
        this.express.use(cookieParser(this.cookieSecret));
        this.express.use(expressCore.json());
        this.express.use(logMiddleware);
        this.express.use(createSessionMiddleware(this.mount, this.authProvider));

        registerWsRoutes(this.express, {
            mount: this.mount,
            allowUrlTokenWs: this.allowUrlTokenWs,
            authProvider: this.authProvider,
            isOriginAllowed: (req) => this.isOriginAllowed(req),
            handle: (token, info, endpointName, arg, ws) => this.handle(token, info, endpointName, arg, ws),
        });

        registerAuthRoutes(this.express, {
            mount: this.mount,
            version: this.version,
            authProvider: this.authProvider,
            authRateLimiter: this.authRateLimiter,
            cookieOptions: this.COOKIE_OPTIONS,
            googleClientIds: this.googleClientIds,
            deauth: (info, token) => this.deauth(info, token),
        });

        if (this.uploadDir) {
            registerUploadRoutes(this.express, {
                mount: this.mount,
                uploadDir: this.uploadDir,
                maxUploadBytes: this.maxUploadBytes,
                uploadAllowlist: this.uploadAllowlist,
                getUploadMetadata: this.getUploadMetadata,
                authorizeFileAccess: this.authorizeFileAccess,
            });
        }

        if (this.minio) {
            registerAttachmentRoutes(this.express, this.mount, this.minio);
        }

        registerTwoFactorRoutes(this.express, {
            mount: this.mount,
            authProvider: this.authProvider,
            authRateLimiter: this.authRateLimiter,
            cookieOptions: this.COOKIE_OPTIONS,
        });

        registerMobileRoutes(this.express, this.mount, this.authProvider);
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

    /** Destroys every WebSocket connection of `info` that was opened with `token`, on all endpoints, and invokes `onDeauth`. */
    private deauth(info: ClientInfo, token: string): void {
        this.endpoints.forEach((endpoint) => {
            endpoint.deauthUser(info, token);
        });
        if (this.onDeauth) {
            try {
                this.onDeauth(info, token);
            } catch (err) {
                logger.error('Error in Endpoint onDeauth hook:', err);
            }
        }
    }

    /**
     * Destroys (with `CloseCodes.Unauthorized`) every user WebSocket connection belonging to `runtimeId` across all
     * declared endpoints. When `token` is provided, only connections opened with that token are closed.
     *
     * @param runtimeId - {@link ClientInfo.runtimeId} of the session to revoke.
     * @param token - Optional session token filter.
     */
    deauthSession(runtimeId: string, token?: string): void {
        this.endpoints.forEach((endpoint) => {
            endpoint.deauthSession(runtimeId, token);
        });
    }

    /**
     * Destroys (with `CloseCodes.Unauthorized`) every user WebSocket connection belonging to `userId` across all
     * declared endpoints, optionally sparing `exceptRuntimeId`.
     *
     * @param userId - {@link ClientInfo.id} of the user to revoke.
     * @param exceptRuntimeId - Optional {@link ClientInfo.runtimeId} to keep connected.
     */
    deauthByUserId(userId: string, exceptRuntimeId?: string): void {
        this.endpoints.forEach((endpoint) => {
            endpoint.deauthByUserId(userId, exceptRuntimeId);
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
     * resolved. A later {@link Endpoint.open} starts listening again.
     */
    close(): void {
        // server.close() only stops new connections; open WebSockets would keep it (and the process) alive.
        this.wsInstance.getWss().clients.forEach((client) => client.terminate());
        if (this.server) {
            this.server.close();
            this.server = undefined;
        }
    }
}
