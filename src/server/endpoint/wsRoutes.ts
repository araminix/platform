import { logger, WsCloseCodes } from '@araminix/lib';
import expressWs from 'express-ws';

import { AuthProvider, ClientInfo } from '../AuthProvider.js';
import { checkOrigin, hasCookie } from './security.js';
import { CustomRequest } from './types.js';

export interface WsRoutesContext {
    mount: string;
    allowUrlTokenWs: boolean;
    authProvider: AuthProvider;
    isOriginAllowed: (req: any) => boolean;
    handle: (token: string, info: ClientInfo, endpointName: string, arg: string, ws: any) => Promise<void>;
}

/** Builds the `ws` server options (`maxPayload` and `verifyClient` policy). */
export function createWsOptions(mount: string, maxMessageBytes: number, allowUrlTokenWs: boolean, allowedOrigins?: string[]): any {
    return {
        maxPayload: maxMessageBytes,
        verifyClient: (info: any, cb: (res: boolean, code?: number, message?: string) => void) => {
            const rawUrl = typeof info.req?.url === 'string' ? info.req.url : '';
            const pathname = rawUrl.split('?')[0];
            if (!allowUrlTokenWs && (pathname === `${mount}/ws-token` || pathname.startsWith(`${mount}/ws-token/`))) {
                return cb(false, 404, 'Not Found');
            }
            const origin = info.origin || info.req?.headers?.origin || info.req?.headers?.['sec-websocket-origin'];
            const allowed = checkOrigin(allowedOrigins, origin, hasCookie(info.req));
            if (allowed) {
                return cb(true);
            }
            return cb(false, 403, 'Forbidden');
        },
    };
}

// Detects half-open sockets (clients that vanished without a close frame) so their connections can expire.
/** Pings `ws` every `heartbeatIntervalMs` and terminates it when a ping goes unanswered. */
export function startHeartbeat(ws: any, heartbeatIntervalMs: number): void {
    if (heartbeatIntervalMs <= 0 || typeof ws.ping !== 'function' || typeof ws.on !== 'function') {
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
    }, heartbeatIntervalMs);
    timer.unref?.();
    ws.on('close', () => clearInterval(timer));
}

/**
 * Registers the WebSocket routes. Every route checks the `Origin`, authenticates the client and hands the socket to the
 * named endpoint; failures close the socket with 4403 (origin), 4401 (no session), 4404 (unknown endpoint) or 1011
 * (unexpected error).
 */
export function registerWsRoutes(express: expressWs.Application, ctx: WsRoutesContext): void {
    const handleLegacyUrlTokenRoute = (routeLabel: string, hasArg: boolean) => async (ws: any, req: any) => {
        try {
            if (!ctx.isOriginAllowed(req)) {
                ws.close(WsCloseCodes.Denied);
                return;
            }
            const token = String(req.params.token);
            const endpointName = String(req.params.endpoint);
            const arg = hasArg ? String(req.params.arg ?? '') : '';
            const result = await ctx.authProvider.getInfo(token);
            if (result.isErr()) {
                ws.close(WsCloseCodes.Unauthorized);
                return;
            }
            await ctx.handle(token, result.unwrap(), endpointName, arg, ws);
        } catch (err) {
            logger.error(`Unhandled rejection in ${routeLabel}:`, err);
            try {
                ws.close(WsCloseCodes.InternalError);
            } catch {}
        }
    };

    if (ctx.allowUrlTokenWs) {
        /** @deprecated Use /ws/:endpoint/:arg with cookie or x-token header instead. */
        express.ws(`${ctx.mount}/ws-token/:token/:endpoint/:arg`, handleLegacyUrlTokenRoute('/ws-token/:token/:endpoint/:arg', true));
        /** @deprecated Use /ws/:endpoint with cookie or x-token header instead. */
        express.ws(`${ctx.mount}/ws-token/:token/:endpoint`, handleLegacyUrlTokenRoute('/ws-token/:token/:endpoint', false));
    }

    const handleSessionWsRoute = (routeLabel: string, hasArg: boolean) => async (ws: any, req: CustomRequest) => {
        try {
            if (!ctx.isOriginAllowed(req)) {
                ws.close(WsCloseCodes.Denied);
                return;
            }
            if (!req.info || !req.token) {
                ws.close(WsCloseCodes.Unauthorized);
                return;
            }
            const arg = hasArg ? String(req.params.arg ?? '') : '';
            const endpointName = String(req.params.endpoint);
            await ctx.handle(req.token, req.info, endpointName, arg, ws);
        } catch (err) {
            logger.error(`Unhandled rejection in ${routeLabel}:`, err);
            try {
                ws.close(WsCloseCodes.InternalError);
            } catch {}
        }
    };

    /** Preferred route: authenticated by the session cookie or the `x-token` upgrade header; `arg` is passed to the endpoint. */
    express.ws(`${ctx.mount}/ws/:endpoint/:arg`, handleSessionWsRoute('/ws/:endpoint/:arg', true));
    /** Same as `/ws/:endpoint/:arg` with an empty `arg`. */
    express.ws(`${ctx.mount}/ws/:endpoint`, handleSessionWsRoute('/ws/:endpoint', false));
}
