import { logger } from '@araminix/lib';
import { CookieOptions } from 'express';
import expressWs from 'express-ws';

import { AuthProvider } from '../AuthProvider.js';
import { clientError, validateToken } from './security.js';
import { AuthRateLimiterMiddleware, CustomRequest } from './types.js';

export interface TwoFactorRoutesContext {
    mount: string;
    authProvider: AuthProvider;
    authRateLimiter: AuthRateLimiterMiddleware;
    cookieOptions: CookieOptions;
}

/** Registers `/2fa/request`, `/2fa/enable`, `/2fa/verify` and `/2fa/disable`. */
export function registerTwoFactorRoutes(express: expressWs.Application, ctx: TwoFactorRoutesContext): void {
    express.post(`${ctx.mount}/2fa/request`, validateToken, async (req: CustomRequest, res) => {
        try {
            const result = await ctx.authProvider.request2FA(req.info?.id ?? '');
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
    express.post(`${ctx.mount}/2fa/enable`, validateToken, ctx.authRateLimiter, async (req: CustomRequest, res) => {
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
            const result = await ctx.authProvider.enable2FA(req.info?.id ?? '', secret, code);
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

    express.post(`${ctx.mount}/2fa/verify`, ctx.authRateLimiter, async (req, res) => {
        try {
            const { accountName, code, uuid: uuidCode } = req.body;
            if (!accountName || !code || !uuidCode) {
                res.status(400).send({ message: 'AccountName, code, and uuid are required.' }).end();
                return;
            }
            const result = await ctx.authProvider.verify2FA(accountName, code, uuidCode);
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
                res.cookie('token', verifyResponse, ctx.cookieOptions).status(200).end();
            }
        } catch (error) {
            logger.error('Request failed:', error);
            res.status(500).send({ error: 'Internal server error' }).end();
        }
    });

    express.delete(`${ctx.mount}/2fa/disable`, validateToken, ctx.authRateLimiter, async (req: CustomRequest, res) => {
        try {
            const rawCode = req.body?.code ?? req.query?.code;
            const code = rawCode !== undefined && rawCode !== null ? String(rawCode) : undefined;
            const result = await ctx.authProvider.disable2FA(req.info?.id ?? '', code);
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
