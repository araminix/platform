import { logger, wrap } from '@araminix/lib';
import axios from 'axios';
import { CookieOptions } from 'express';
import expressWs from 'express-ws';

import { AuthProvider, ClientInfo, GoogleData } from '../AuthProvider.js';
import { clientError, loggableError } from './security.js';
import { AuthRateLimiterMiddleware, CustomRequest } from './types.js';

export interface AuthRoutesContext {
    mount: string;
    version: string;
    authProvider: AuthProvider;
    authRateLimiter: AuthRateLimiterMiddleware;
    cookieOptions: CookieOptions;
    googleClientIds?: string[];
    deauth: (info: ClientInfo, token: string) => void;
}

/** Registers `/health`, `/version`, `/auth` (login, logout, refresh) and `/gauth`. */
export function registerAuthRoutes(express: expressWs.Application, ctx: AuthRoutesContext): void {
    express.get(`${ctx.mount}/health`, (_req, res) => {
        res.status(200).send('200!').end();
    });

    express.get(`${ctx.mount}/version`, (_req, res) => {
        res.status(200).json({ version: ctx.version }).end();
    });

    express.post(`${ctx.mount}/auth`, ctx.authRateLimiter, async (req, res) => {
        const result = await ctx.authProvider.auth(req.body);
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
            res.cookie('token', authResponse, ctx.cookieOptions).status(200).end();
        }
    });

    // TODO (D6): Long-term improvement - have frontend send Google ID token and verify using google-auth-library
    express.post(`${ctx.mount}/gauth`, ctx.authRateLimiter, async (req, res) => {
        if (!ctx.googleClientIds || ctx.googleClientIds.length === 0) {
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
        const isAudValid = typeof tokenData.aud === 'string' && ctx.googleClientIds.includes(tokenData.aud);
        const isAzpValid = typeof tokenData.azp === 'string' && ctx.googleClientIds.includes(tokenData.azp);
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
            const authRes = await ctx.authProvider.googleAuth(googleData);
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
            res.cookie('token', response, ctx.cookieOptions).status(200).end();
        } else {
            logger.error('Google Data Read Error: ', googleData);
            res.status(500).end();
        }
    });

    express.delete(`${ctx.mount}/auth`, async (req: CustomRequest, res) => {
        if (req.token && req.info) {
            await ctx.authProvider.destroy(req.token);
            ctx.deauth(req.info, req.token);
        }
        res.clearCookie('token', ctx.cookieOptions).status(200).send({ success: true }).end();
    });

    express.put(`${ctx.mount}/auth/refresh`, ctx.authRateLimiter, async (req, res) => {
        const oldToken = req.body?.old_token;
        if (!oldToken || typeof oldToken !== 'string') {
            res.status(400).send({ message: '"old_token" is required in body.' }).end();
            return;
        }
        const result = await ctx.authProvider.refreshToken(oldToken);
        if (result.isErr()) {
            logger.error('API Auth - Refresh Token Error: ', result.e);
            res.status(401)
                .send({ error: clientError(result.e, 'Unauthorized') })
                .end();
            return;
        }
        const token = result.unwrap();
        res.cookie('token', token, ctx.cookieOptions).status(200).end();
    });
}
