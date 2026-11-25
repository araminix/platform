import { Result } from '@araminix/lib';
import { CookieOptions, NextFunction, Request, Response } from 'express';
import { LegacyStore, Store } from 'express-rate-limit';

import { MinioOptions } from '../../utils/index.js';
import { AuthProvider, ClientInfo } from '../AuthProvider.js';

/** Re-exported so that `MinioOptions` can be imported together with {@link EndpointOptions}. */
export { MinioOptions };

/** Express request as seen by the platform routes, after the session middleware ran. */
export interface CustomRequest extends Request {
    /** Session token from the signed `token` cookie or the `x-token` header. */
    token?: string;
    /** Client resolved from {@link CustomRequest.token} by {@link AuthProvider.getInfo}; unset when the token is invalid. */
    info?: ClientInfo;
    /** File stored by multer on `POST /file`, with the platform-generated `id`. */
    file?: any;
}

/** Metadata recorded in `index.json` and returned by `POST /file`. */
export interface UploadedFileInfo {
    name: string;
    size: number;
    mimetype: string;
    id: string;
    userId: string;
    unitId?: string | null;
    [key: string]: unknown;
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
     * Per-IP request ceiling across all authentication routes in the window, enforced alongside the per-account
     * limiter so an IP cannot bypass limits by randomizing `accountName`. Ignored if a custom {@link keyGenerator} is
     * supplied without explicitly setting `ipLimit`. `0` disables the secondary IP-only ceiling.
     *
     * @defaultValue `5 * (limit ?? max ?? 100)`
     */
    ipLimit?: number;
    /**
     * Body of the 429 response.
     *
     * @defaultValue `{ message: 'Too many authentication attempts, please try again later.', error: 'Too many requests' }`
     */
    message?: any;
    /**
     * Computes the counter key of a request.
     *
     * @defaultValue the normalized client IP (`req.ip`, so configure {@link EndpointOptions.trustProxy} behind a proxy);
     *     on `POST /auth` and `POST /2fa/verify`, joined with the normalized account named in the JSON body (`accountName`,
     *     `username`, `email` or `account`) when present: `"<ip>:<account>"`. `PUT /auth/refresh` and other routes key
     *     strictly on the client IP.
     */
    keyGenerator?: (req: Request, res: Response) => string | Promise<string>;
    /**
     * Do not count requests that end with a status below 400.
     *
     * @defaultValue `false`
     */
    skipSuccessfulRequests?: boolean;
    /**
     * Custom `express-rate-limit` store (for example a Redis-backed store for horizontally scaled deployments). When the
     * secondary IP-only ceiling ({@link RateLimitConfig.ipLimit}) is active and {@link RateLimitConfig.ipStore} is not
     * supplied, the IP ceiling shares this store under an `ip:` key prefix without calling `store.init` a second time.
     *
     * @defaultValue in-memory store (`MemoryStore`)
     */
    store?: Store | LegacyStore;
    /**
     * Optional separate `express-rate-limit` store for the secondary IP-only ceiling limiter
     * ({@link RateLimitConfig.ipLimit}). When omitted, {@link RateLimitConfig.store} is reused (or a separate
     * `MemoryStore` when no `store` is supplied).
     *
     * @defaultValue reuses {@link RateLimitConfig.store}, or a separate `MemoryStore`
     */
    ipStore?: Store | LegacyStore;
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
     * Optional hook invoked by `POST /file` before writing `index.json`. Returned key/value pairs are merged into the stored
     * metadata (and HTTP response body), allowing applications to attach or override tenant/unit scope or visibility fields.
     *
     * @defaultValue unset (metadata records `name`, `size`, `mimetype`, `id`, `userId`, and `unitId` derived from `req.info.activeUnit`)
     */
    getUploadMetadata?: (req: Request & { token?: string; info?: ClientInfo }, fileInfo: UploadedFileInfo) => Record<string, unknown> | Promise<Record<string, unknown>>;
    /**
     * Optional authorization guard enforced on both `GET /file/:fileId` and static `GET /file/:fileId/:name` downloads.
     * Receives the authenticated client (`info`), the parsed `index.json` metadata (`fileMeta`), and `fileId`. Returning
     * `false` denies the request with HTTP 403; missing or corrupt metadata returns HTTP 404.
     *
     * @defaultValue unset (any authenticated user may download local uploads)
     */
    authorizeFileAccess?: (info: ClientInfo, fileMeta: Record<string, unknown>, fileId: string) => boolean | Promise<boolean>;
    /**
     * OAuth client ids whose Google access tokens `POST /gauth` accepts (matched against the token's `aud` or `azp`). When
     * unset or empty, `/gauth` answers HTTP 503.
     *
     * @defaultValue unset (Google sign-in disabled)
     */
    googleClientIds?: string[];
    /**
     * Browser origins allowed to open WebSockets (protection against cross-site WebSocket hijacking). Matching ignores case
     * and trailing slashes; `'*'` allows every origin. Requests without an `Origin` header are allowed only for non-cookie
     * clients (for example `x-token` header upgrades used by agents); when `allowedOrigins` is configured, cookie-bearing
     * WebSocket upgrades without an `Origin` header are rejected. When unset or empty, every request that carries an `Origin`
     * is refused (fail closed). This option does not add CORS headers to HTTP routes.
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
    /**
     * Maximum bytes buffered on a connection's WebSocket (`ws.bufferedAmount`) before outgoing writes are rejected by
     * `@araminix/lib` backpressure. `0` disables backpressure checks; when unset, `@araminix/lib` uses its default (4 MiB).
     *
     * @defaultValue unset (`@araminix/lib` default: `4194304` / 4 MiB)
     */
    maxBufferedBytes?: number;
    /**
     * Enables the deprecated `/ws-token/:token/:endpoint[/:arg]` routes that pass session tokens in the URL path.
     * Disabled by default because tokens in URLs leak into access logs, proxy logs and browser history.
     *
     * @defaultValue `false`
     */
    allowUrlTokenWs?: boolean;
    /**
     * Hook invoked after `DELETE /auth` closes a session's WebSocket connections. {@link Platform} uses this to
     * immediately destroy running worker instances belonging to `info.runtimeId`.
     *
     * @defaultValue unset
     */
    onDeauth?: (info: ClientInfo, token: string) => void;
}

/** Shared middleware handler type used for the authentication rate limiter. */
export type AuthRateLimiterMiddleware = (req: Request, res: Response, next: NextFunction) => void;
