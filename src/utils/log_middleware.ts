import { LOG_LEVEL, Logger } from '@araminix/lib';
import type { NextFunction, Request, Response } from 'express';

class LogMiddleware extends Logger {
    statusLevel(status: number): LOG_LEVEL {
        if (status >= 200 && status < 300) return LOG_LEVEL.INFO;
        if (status >= 300 && status < 400) return LOG_LEVEL.WARN;
        if (status >= 400 && status < 500) return LOG_LEVEL.ERROR;
        return LOG_LEVEL.DEBUG;
    }

    getStartTime(): [number, number] | number {
        if (typeof process !== 'undefined' && process.hrtime) {
            return process.hrtime();
        } else if (typeof performance !== 'undefined' && performance.now) {
            return performance.now();
        } else {
            return Date.now();
        }
    }

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

export const logMiddleware = new LogMiddleware().get();
