import { logger, WsCloseCodes } from '@araminix/lib';
import { NextFunction, Request, Response } from 'express';
import { ipKeyGenerator, LegacyStore, rateLimit, Store } from 'express-rate-limit';

import { AuthProvider } from '../AuthProvider.js';
import { AuthRateLimiterMiddleware, CustomRequest, RateLimitConfig } from './types.js';

function isLegacyRateLimitStore(store: Store | LegacyStore): store is LegacyStore {
    return typeof (store as LegacyStore).incr === 'function' && typeof (store as Store).increment !== 'function';
}

/** Wraps an already-initialized store for the secondary IP limiter without triggering a second `store.init()` call. */
function createSharedRateLimitStore(store: Store | LegacyStore): Store | LegacyStore {
    if (isLegacyRateLimitStore(store)) {
        return {
            incr: (key, callback) => store.incr(key, callback),
            decrement: (key) => store.decrement(key),
            resetKey: (key) => store.resetKey(key),
            ...(store.resetAll ? { resetAll: () => store.resetAll!() } : {}),
        };
    }
    return {
        localKeys: store.localKeys,
        prefix: store.prefix,
        ...(store.get ? { get: (key) => store.get!(key) } : {}),
        increment: (key) => store.increment(key),
        decrement: (key) => store.decrement(key),
        resetKey: (key) => store.resetKey(key),
        ...(store.resetAll ? { resetAll: () => store.resetAll!() } : {}),
    };
}

/** Builds the shared authentication rate limiter middleware (or a pass-through when disabled). */
export function createAuthRateLimiter(mount: string, authRateLimit?: RateLimitConfig | boolean): AuthRateLimiterMiddleware {
    if (authRateLimit === false) {
        return (_req: Request, _res: Response, next: NextFunction) => next();
    }

    const customConfig = typeof authRateLimit === 'object' ? authRateLimit : {};
    const { ipLimit: configuredIpLimit, max: legacyMax, limit: configuredLimit, store: configuredStore, ipStore: configuredIpStore, ...rateLimitConfig } = customConfig;
    const windowMs = rateLimitConfig.windowMs ?? 15 * 60 * 1000;
    const accountLimit = configuredLimit ?? legacyMax ?? 100;
    const message = rateLimitConfig.message ?? {
        message: 'Too many authentication attempts, please try again later.',
        error: 'Too many requests',
    };
    const accountKeyedPaths = new Set([`${mount}/auth`, `${mount}/2fa/verify`]);
    const getClientIp = (req: Request): string => {
        const rawIp = req.ip || req.socket?.remoteAddress || '127.0.0.1';
        return ipKeyGenerator(typeof rawIp === 'string' ? rawIp : '127.0.0.1');
    };
    const defaultKeyGenerator = (req: Request): string => {
        const ip = getClientIp(req);
        const normalizedPath = req.path.replace(/\/+$/, '');
        if (!accountKeyedPaths.has(normalizedPath)) {
            return ip;
        }
        const rawAccount = req.body?.accountName ?? req.body?.username ?? req.body?.email ?? req.body?.account;
        const account = typeof rawAccount === 'string' ? rawAccount.trim().toLowerCase() : '';
        return account ? `${ip}:${account}` : ip;
    };
    const accountLimiter = rateLimit({
        standardHeaders: true,
        legacyHeaders: false,
        validate: { xForwardedForHeader: false, default: false },
        ...rateLimitConfig,
        ...(configuredStore ? { store: configuredStore } : {}),
        windowMs,
        limit: accountLimit,
        message,
        keyGenerator: rateLimitConfig.keyGenerator ?? defaultKeyGenerator,
    });
    const effectiveIpLimit = configuredIpLimit !== undefined ? configuredIpLimit : rateLimitConfig.keyGenerator ? 0 : accountLimit * 5;
    if (effectiveIpLimit <= 0) {
        return accountLimiter;
    }

    const resolvedIpStore = configuredIpStore ?? (configuredStore ? createSharedRateLimitStore(configuredStore) : undefined);
    const ipLimiter = rateLimit({
        standardHeaders: true,
        legacyHeaders: false,
        validate: { xForwardedForHeader: false, default: false },
        ...rateLimitConfig,
        ...(resolvedIpStore ? { store: resolvedIpStore } : {}),
        windowMs,
        limit: effectiveIpLimit,
        message,
        keyGenerator: (req: Request) => `ip:${getClientIp(req)}`,
    });
    return (req: Request, res: Response, next: NextFunction) => {
        ipLimiter(req, res, (err?: unknown) => {
            if (err) {
                next(err);
                return;
            }
            accountLimiter(req, res, next);
        });
    };
}

/** Returns `true` when the request carries a `Cookie` header or a parsed signed `token` cookie. */
export function hasCookie(req?: Request | any): boolean {
    if (!req) {
        return false;
    }
    if (req.signedCookies?.token) {
        return true;
    }
    const cookieHeader = req.headers?.cookie;
    if (typeof cookieHeader === 'string') {
        return cookieHeader.trim().length > 0;
    }
    if (Array.isArray(cookieHeader)) {
        return cookieHeader.some((value) => typeof value === 'string' && value.trim().length > 0);
    }
    return false;
}

/**
 * Applies the {@link EndpointOptions.allowedOrigins} policy to an `Origin` header value. Absent `Origin` is allowed
 * only for non-cookie requests; when `hasCookie` is `true` and `allowedOrigins` is configured, absent `Origin` is
 * rejected.
 */
export function checkOrigin(allowedOrigins: string[] | undefined, origin?: string, requestHasCookie = false): boolean {
    if (!origin) {
        if (requestHasCookie && allowedOrigins && allowedOrigins.length > 0) {
            return false;
        }
        return true;
    }
    if (!allowedOrigins || allowedOrigins.length === 0) {
        return false;
    }
    if (allowedOrigins.includes('*')) {
        return true;
    }
    const normalized = origin.trim().toLowerCase().replace(/\/+$/, '');
    return allowedOrigins.some((allowed) => {
        return allowed.trim().toLowerCase().replace(/\/+$/, '') === normalized;
    });
}

/** Applies {@link checkOrigin} to the `Origin` (or `Sec-WebSocket-Origin`) header of a request. */
export function isOriginAllowed(allowedOrigins: string[] | undefined, req: Request | any): boolean {
    const origin = req.headers?.origin || req.headers?.['sec-websocket-origin'];
    return checkOrigin(allowedOrigins, origin, hasCookie(req));
}

// AuthProvider error codes (strings/numbers) are meant for the client; other values may carry internals.
/**
 * Returns `error` when it is a string or number (an error code meant for the client), otherwise `fallback`.
 *
 * @param error - Error value from an {@link AuthProvider} method.
 * @param fallback - Text sent instead of non-primitive errors.
 */
export function clientError(error: unknown, fallback: string): string | number {
    return typeof error === 'string' || typeof error === 'number' ? error : fallback;
}

// Axios errors carry the request config, including URLs and Authorization headers with tokens.
/**
 * Reduces an axios error to `{ message, code, status }` so that logs never contain request URLs or `Authorization`
 * headers; other values are returned unchanged.
 */
export function loggableError(error: unknown): unknown {
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
export function validateToken(req: CustomRequest, res: Response, next: NextFunction): void {
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
 * Session middleware: reads the token from the signed `token` cookie (preferred) or the `x-token` header and resolves it
 * with {@link AuthProvider.getInfo} into `req.token` / `req.info`. Skipped for `/health` and `/version`.
 */
export function createSessionMiddleware(mount: string, authProvider: AuthProvider) {
    return async (req: CustomRequest, _res: Response, next: NextFunction) => {
        if (req.path === `${mount}/health` || req.path === `${mount}/version`) {
            return next();
        }
        const cookieToken = req.signedCookies?.token;
        const headerToken = req.header('x-token');
        req.token = cookieToken ? cookieToken : headerToken ? headerToken : undefined;
        if (req.token) {
            try {
                const result = await authProvider.getInfo(req.token);
                if (result.isOk()) {
                    req.info = result.unwrap();
                }
            } catch (err) {
                logger.error('Session lookup failed in authProvider.getInfo:', err);
                const ws = (req as any).ws;
                if (ws && typeof ws.close === 'function') {
                    try {
                        ws.close(WsCloseCodes.InternalError);
                    } catch {}
                    return;
                }
                return next(err);
            }
        }
        return next();
    };
}
