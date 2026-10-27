import { LOG_LEVEL, Logger } from '@araminix/lib';
import type { NextFunction, Request, Response } from 'express';

/**
 * Access logger for Express. It is its own `Logger` instance with the lib's default configuration (level `debug`, text
 * format), so configuring the shared `logger` from `@araminix/lib` does not change the access log.
 */
class LogMiddleware extends Logger {
    /**
     * Maps an HTTP status to a log level: 5xx is `error`, 4xx is `warn`, everything else `info`.
     *
     * @param status - HTTP status code.
     */
    statusLevel(status: number): LOG_LEVEL {
        if (status >= 500) return LOG_LEVEL.ERROR;
        if (status >= 400) return LOG_LEVEL.WARN;
        return LOG_LEVEL.INFO;
    }

    /** Returns a start timestamp from the best available clock (`process.hrtime`, then `performance.now`, then `Date.now`). */
    getStartTime(): [number, number] | number {
        if (typeof process !== 'undefined' && process.hrtime) {
            return process.hrtime();
        } else if (typeof performance !== 'undefined' && performance.now) {
            return performance.now();
        } else {
            return Date.now();
        }
    }

    /**
     * Milliseconds elapsed since `start`, a value returned by {@link LogMiddleware.getStartTime} (or a `bigint` from
     * `process.hrtime.bigint()`); `0` for anything else.
     *
     * @param start - Start timestamp.
     */
    getDuration(start?: [number, number] | number | bigint): number {
        if (typeof start === 'bigint') {
            const end = typeof process !== 'undefined' && process.hrtime && process.hrtime.bigint ? process.hrtime.bigint() : BigInt(Date.now() * 1e6);
            return Number(end - start) / 1e6;
        }
        if (Array.isArray(start) && typeof process !== 'undefined' && process.hrtime) {
            const diff = process.hrtime(start);
            return diff[0] * 1e3 + diff[1] / 1e6;
        }
        if (typeof start === 'number') {
            const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
            return now - start;
        }
        return 0;
    }

    /** Returns the Express middleware function bound to this logger. */
    get(): (req: Request, res: Response, next: NextFunction) => void {
        return (req: Request, res: Response, next: NextFunction): void => {
            const { method, url } = req;
            const start = this.getStartTime();
            res.once('finish', () => {
                const sanitizedUrl = url.replace(/\/ws-token\/[^/?#]+/g, '/ws-token/[REDACTED]');
                const duration = `${this.getDuration(start).toFixed(2)}ms`;
                const log = `${method}: ${sanitizedUrl} ${res.statusCode} ${duration}`;
                this[this.statusLevel(res.statusCode)](log);
            });
            next();
        };
    }
}

/**
 * Express middleware that logs one line per finished response: `METHOD: url status duration`, e.g.
 * `GET: /api/health 200 0.42ms`. 5xx responses are logged as errors, 4xx as warnings, the rest as info. Tokens in
 * deprecated `/ws-token/<token>/...` URLs are replaced by `[REDACTED]`.
 *
 * {@link Endpoint} installs it automatically; export it for your own Express apps.
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { logMiddleware } from '@araminix/platform';
 *
 * const app = express();
 * app.use(logMiddleware);
 * ```
 */
export const logMiddleware = new LogMiddleware().get();
