import { LOG_LEVEL, Logger } from '@araminix/lib';
import type { NextFunction, Request, Response } from 'express';

class LogMiddleware extends Logger {
    statusLevel(status: number): LOG_LEVEL {
        if (status >= 200 && status < 300) return LOG_LEVEL.INFO;
        if (status >= 300 && status < 400) return LOG_LEVEL.WARN;
        if (status >= 400 && status < 500) return LOG_LEVEL.ERROR;
        return LOG_LEVEL.DEBUG;
    }

    getDuration(): number {
        if (typeof process !== 'undefined' && process.hrtime) {
            const hrtime = process.hrtime();
            return hrtime[0] * 1e3 + hrtime[1] / 1e6;
        } else if (typeof performance !== 'undefined' && performance.now) {
            return performance.now();
        } else {
            return Date.now();
        }
    }

    get(): (req: Request, res: Response, next: NextFunction) => void {
        return (req: Request, res: Response, next: NextFunction): void => {
            const { method, url } = req;
            res.once('finish', () => {
                const duration = `${this.getDuration().toFixed(2)}ms`;
                const log = `[${Logger.getTimestamp()}] ${method}: ${url} ${res.statusCode} ${duration}`;
                this[this.statusLevel(res.statusCode)](log);
            });
            next();
        };
    }
}

export const logMiddleware = new LogMiddleware().get();
