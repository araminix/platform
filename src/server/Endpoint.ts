import { logger, Result, trimSlash, uuid, wrap, WsCloseCodes } from '@araminix/lib';
import axios from 'axios';
import cookieParser from 'cookie-parser';
import expressCore, { CookieOptions, NextFunction, Request, Response } from 'express';
import expressWs from 'express-ws';
import fs from 'fs';
import type { Server } from 'http';
import multer from 'multer';
import path from 'path';

import { logMiddleware, MinioOptions, MinioService } from '../utils/index.js';
import { AuthProvider, ClientInfo, GoogleData } from './AuthProvider.js';
import { ConnectRequest } from './ConnectRequest.js';
import EndpointController from './EndpointController.js';

interface CustomRequest extends Request {
    token?: string;
    info?: ClientInfo;
    file?: any;
}

export interface ServerDriver {
    getUserId: (token: string) => Promise<Result<string, unknown>>;
}

export interface UploadAllowlist {
    extensions?: string[];
    mimetypes?: string[];
}

export interface EndpointOptions {
    authProvider: AuthProvider;
    port?: number;
    mount?: string;
    version?: string;
    cookieSecret?: string;
    sessionTtl?: number;
    uploadDir?: string | void;
    minio?: MinioOptions | void;
    cookieOptions?: CookieOptions;
    maxUploadBytes?: number;
    uploadAllowlist?: UploadAllowlist;
    googleClientIds?: string[];
    allowedOrigins?: string[];
}

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

export default class Endpoint {
    private authProvider: AuthProvider;
    private port: number;
    private mount: string;
    private version: string;
    private cookieSecret: string;
    private sessionTtl: number;
    private uploadDir?: string | void;
    private minio?: MinioOptions | void;
    private maxUploadBytes: number;
    private uploadAllowlist?: UploadAllowlist;
    private googleClientIds?: string[];
    private allowedOrigins?: string[];
    readonly express: expressWs.Application;
    private server?: Server;
    private readonly connections: Map<string, unknown> = new Map();
    private endpoints: Map<string, EndpointController> = new Map();
    private COOKIE_OPTIONS: CookieOptions;

    constructor({
        authProvider,
        port = 3000,
        mount,
        version,
        cookieSecret = uuid(),
        sessionTtl = 3600 * 24,
        uploadDir,
        minio = undefined,
        cookieOptions,
        maxUploadBytes = 20 * 1024 * 1024,
        uploadAllowlist,
        googleClientIds,
        allowedOrigins,
    }: EndpointOptions) {
        this.authProvider = authProvider;
        this.port = port;
        this.mount = mount ? `/${trimSlash(mount)}` : '';
        this.version = version ?? '0.0.0';
        this.cookieSecret = cookieSecret;
        this.sessionTtl = sessionTtl;
        this.uploadDir = uploadDir;
        this.minio = minio;
        this.maxUploadBytes = maxUploadBytes;
        this.uploadAllowlist = uploadAllowlist;
        this.googleClientIds = googleClientIds;
        this.allowedOrigins = allowedOrigins;
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
            verifyClient: (info: any, cb: (res: boolean, code?: number, message?: string) => void) => {
                const origin = info.origin || info.req?.headers?.origin || info.req?.headers?.['sec-websocket-origin'];
                const allowed = this.checkOrigin(origin);
                if (allowed) {
                    return cb(true);
                }
                return cb(false, 403, 'Forbidden');
            },
        };
        this.express = expressWs(expressCore(), undefined, { wsOptions }).app;
        this.init();
    }

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

    private isOriginAllowed(req: Request | any): boolean {
        const origin = req.headers?.origin || req.headers?.['sec-websocket-origin'];
        return this.checkOrigin(origin);
    }

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

    declare(name: string): void {
        if (!this.endpoints.has(name)) {
            const endpointController = new EndpointController();
            this.endpoints.set(name, endpointController);
        }
    }

    acquire(name: string): Promise<Result<ConnectRequest, void>> {
        logger.trace(`Endpoint - acquire name: ${name}`);
        this.declare(name);
        return this.endpoints.get(name)!.acquire();
    }

    private async handle(token: string, info: ClientInfo, endpointName: string, arg: string, ws: any): Promise<void> {
        const endpoint = this.endpoints.get(endpointName);
        if (!endpoint) {
            ws.close(WsCloseCodes.NotFound);
            return;
        }
        await endpoint.connect(ws, token, info, arg);
    }

    private deauth(info: ClientInfo, token: string): void {
        this.endpoints.forEach((endpoint) => {
            endpoint.deauthUser(info, token);
        });
    }

    private initMiddleware(): void {
        this.express.use(async (req: CustomRequest, _res: Response, next: NextFunction) => {
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

    private initAuth(): void {
        this.express.get(`${this.mount}/health`, (_req, res) => {
            res.status(200).send('200!').end();
        });

        this.express.get(`${this.mount}/version`, (_req, res) => {
            res.status(200).json({ version: this.version }).end();
        });

        this.express.post(`${this.mount}/auth`, async (req, res) => {
            const result = await this.authProvider.auth(req.body);
            if (result.isErr()) {
                logger.error('API Auth - Login Error: ', result.e);
                res.status(401).send({ error: result.e }).end();
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
        this.express.post(`${this.mount}/gauth`, async (req, res) => {
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
                logger.error('Google Auth Token Info Error: ', tokenInfoResult.e);
                res.status(401).send({ error: tokenInfoResult.e }).end();
                return;
            }
            const tokenInfoResponse = tokenInfoResult.unwrap();
            if (tokenInfoResponse.status !== 200 || !tokenInfoResponse.data) {
                logger.error('Google Auth Token Info Status not 200: ', tokenInfoResponse.data);
                res.status(401).send({ error: tokenInfoResponse.data }).end();
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
                logger.error('Google Auth API Error: ', userInfoResult.e);
                res.status(401).send({ error: userInfoResult.e }).end();
                return;
            }
            const authResponse = userInfoResult.unwrap();
            if (authResponse.status !== 200) {
                logger.error('Google Auth Status not 200: ', authResponse.data);
                res.status(401).send({ error: authResponse.data }).end();
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
                    res.status(401).send({ error: authRes.e }).end();
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

        this.express.put(`${this.mount}/auth/refresh`, async (req, res) => {
            const result = await this.authProvider.refreshToken(req.body.old_token);
            if (result.isErr()) {
                logger.error('API Auth - Refresh Token Error: ', result.e);
                res.status(401).send({ error: result.e }).end();
                return;
            }
            const token = result.unwrap();
            res.cookie('token', token, this.COOKIE_OPTIONS).status(200).end();
        });
    }

    private sanitizeFilename(originalName: string): string {
        const base = path
            .basename(originalName)
            .replace(/[/\\]/g, '')
            .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
            .trim();
        const safe = base === '.' || base === '..' || base === '' ? 'upload' : base;
        return safe.slice(0, 255);
    }

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

    private init2FA(): void {
        this.express.post(`${this.mount}/2fa/request`, validateToken, async (req: CustomRequest, res) => {
            try {
                const result = await this.authProvider.request2FA(req.info?.id ?? '');
                if (!result.isOk()) {
                    logger.error('API Auth - 2FA Request Error: ', result.e);
                    res.status(401).send({ error: result.e }).end();
                    return;
                }
                res.status(200).send({ url: result.v }).end();
            } catch (error) {
                res.status(500).send({ error }).end();
            }
        });

        this.express.post(`${this.mount}/2fa/enable`, validateToken, async (req: CustomRequest, res) => {
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
                    res.status(401).send({ error: result.e }).end();
                    return;
                }
                res.status(200).send({ success: result.v }).end();
            } catch (error) {
                res.status(500).send({ error }).end();
            }
        });

        this.express.post(`${this.mount}/2fa/verify`, async (req, res) => {
            try {
                const { accountName, code, uuid: uuidCode } = req.body;
                if (!accountName || !code || !uuidCode) {
                    res.status(400).send({ message: 'AccountName, code, and uuid are required.' }).end();
                    return;
                }
                const result = await this.authProvider.verify2FA(accountName, code, uuidCode);
                if (result.isErr()) {
                    logger.error('API Auth - 2FA Verify Error: ', result.e);
                    res.status(401).send({ error: result.e }).end();
                    return;
                }
                const verifyResponse = result.unwrap();
                if (typeof verifyResponse === 'boolean') {
                    res.status(200).send({ success: verifyResponse }).end();
                } else {
                    res.cookie('token', verifyResponse, this.COOKIE_OPTIONS).status(200).end();
                }
            } catch (error) {
                res.status(500).send({ error }).end();
            }
        });

        this.express.delete(`${this.mount}/2fa/disable`, validateToken, async (req: CustomRequest, res) => {
            try {
                const result = await this.authProvider.disable2FA(req.info?.id ?? '');
                if (result.isErr()) {
                    logger.error('API Auth - 2FA Disable Error: ', result.e);
                    res.status(401).send({ error: result.e }).end();
                    return;
                }
                res.status(200).send({ success: result.unwrap() }).end();
            } catch (error) {
                res.status(500).send({ error }).end();
            }
        });
    }

    private initMinio(minio: MinioOptions): void {
        const minioService = new MinioService(minio);
        this.express.post(`${this.mount}/attachments/upload`, validateToken, async (req: CustomRequest, res) => {
            const { attachmentId, mimetype, fileName } = req.body;
            if (!attachmentId || !mimetype || !fileName) {
                res.status(400).send({ message: 'attachmentId, mimetype, and fileName are required.' }).end();
                return;
            }
            const minioFileName = `${req.info?.id}/${fileName}`;
            const urlResult = await minioService.presignedPutObject(mimetype, minioFileName);
            if (urlResult.isErr()) {
                logger.error('Error on Upload Request API: ', urlResult.e);
                res.status(500).send(urlResult.e).end();
                return;
            }
            const url = urlResult.unwrap();
            res.status(200).json({ url }).end();
        });

        this.express.get(`${this.mount}/attachments/:attachmentId`, validateToken, async (req, res) => {
            try {
                const attachmentId = String(req.params.attachmentId);
                const fileURL = await minioService.presignedGetObject(attachmentId);
                res.status(200).json({ fileURL }).end();
            } catch (error) {
                logger.error('Error on Get File API: ', error);
                res.status(500).send(error).end();
            }
        });
    }

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
                res.status(500).send({ error }).end();
            }
        });
    }

    open(): void {
        if (!this.server) {
            this.server = this.express.listen(this.port);
        }
    }

    close(): void {
        if (this.server) {
            this.server.close();
        }
    }
}
