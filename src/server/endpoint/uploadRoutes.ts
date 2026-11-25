import { logger, uuid } from '@araminix/lib';
import expressCore, { NextFunction, Response } from 'express';
import expressWs from 'express-ws';
import fs from 'fs';
import multer from 'multer';
import path from 'path';

import { ClientInfo } from '../AuthProvider.js';
import { validateToken } from './security.js';
import { CustomRequest, EndpointOptions, UploadAllowlist, UploadedFileInfo } from './types.js';

/** Shape of the ids that `POST /file` generates; other ids are answered with 404 without touching the disk. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UploadRoutesContext {
    mount: string;
    uploadDir: string;
    maxUploadBytes: number;
    uploadAllowlist?: UploadAllowlist;
    getUploadMetadata?: EndpointOptions['getUploadMetadata'];
    authorizeFileAccess?: EndpointOptions['authorizeFileAccess'];
}

/**
 * Makes an uploaded file name safe to store: keeps the base name, removes slashes, backslashes and control characters,
 * trims it, replaces empty, `.` and `..` names with `upload`, and caps the length at 255 characters.
 */
export function sanitizeFilename(originalName: string): string {
    const base = path
        .basename(originalName)
        .replace(/[/\\]/g, '')
        .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
        .trim();
    const safe = base === '.' || base === '..' || base === '' ? 'upload' : base;
    // index.json is the metadata file of every upload folder; an upload with that name would be overwritten by it.
    const unreserved = safe.toLowerCase() === 'index.json' ? `_${safe}` : safe;
    return unreserved.slice(0, 255);
}

/** Extracts an optional active unit id from `info.activeUnit` (object with `_key` or plain string). */
export function extractUnitId(info?: ClientInfo): string | null {
    const activeUnit = (info as { activeUnit?: { _key?: string } | string } | undefined)?.activeUnit;
    if (typeof activeUnit === 'string') {
        return activeUnit || null;
    }
    if (activeUnit && typeof activeUnit === 'object' && typeof activeUnit._key === 'string') {
        return activeUnit._key || null;
    }
    return null;
}

/** Reads and parses `<uploadDir>/<fileId>/index.json`, ensuring the resolved directory stays inside `uploadDir`. */
export async function readFileMetadata(uploadDir: string, fileId: string): Promise<Record<string, unknown> | null> {
    const resolvedUploadDir = path.resolve(uploadDir);
    const uploadDirPrefix = resolvedUploadDir.endsWith(path.sep) ? resolvedUploadDir : `${resolvedUploadDir}${path.sep}`;
    const resolvedFileDir = path.resolve(resolvedUploadDir, fileId);
    if (!resolvedFileDir.startsWith(uploadDirPrefix)) {
        return null;
    }
    try {
        const raw = await fs.promises.readFile(path.join(resolvedFileDir, 'index.json'), 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        return parsed as Record<string, unknown>;
    } catch (err: any) {
        if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
            logger.error('Failed to read or parse index.json for fileId:', fileId, err);
        }
        return null;
    }
}

/** Runs `authorizeFileAccess` when configured; sends 401/403/500 and returns `false` on denial or failure. */
async function checkFileAccess(
    authorizeFileAccess: EndpointOptions['authorizeFileAccess'],
    req: CustomRequest,
    res: Response,
    fileMeta: Record<string, unknown>,
    fileId: string,
): Promise<boolean> {
    if (!authorizeFileAccess) {
        return true;
    }
    if (!req.info) {
        res.status(401).send({ message: 'Unauthorized' }).end();
        return false;
    }
    try {
        const allowed = await authorizeFileAccess(req.info, fileMeta, fileId);
        if (!allowed) {
            res.status(403).json({ message: 'Forbidden' }).end();
            return false;
        }
        return true;
    } catch (err) {
        logger.error('Error in authorizeFileAccess hook for fileId:', fileId, err);
        res.status(500).json({ error: 'Internal server error' }).end();
        return false;
    }
}

/**
 * Registers the local upload routes: `POST /file` (multipart field `file`), `GET /file/:fileId` (302 to the named URL)
 * and the static `GET /file/:fileId/:name` download, which is sent with `X-Content-Type-Options: nosniff`,
 * `Content-Disposition: attachment` and `Content-Security-Policy: default-src 'none'; sandbox`.
 */
export function registerUploadRoutes(express: expressWs.Application, ctx: UploadRoutesContext): void {
    const { mount, uploadDir, maxUploadBytes, uploadAllowlist, getUploadMetadata, authorizeFileAccess } = ctx;
    const storage = multer.diskStorage({
        destination: function (_req, file: any, cb) {
            const id = uuid();
            const dir = path.join(uploadDir, id);
            fs.promises
                .mkdir(dir, { recursive: true })
                .then(() => {
                    file.id = id;
                    cb(null, dir);
                })
                .catch((err) => {
                    cb(err instanceof Error ? err : new Error(String(err)), '');
                });
        },
        filename: function (_req, file, cb) {
            file.originalname = sanitizeFilename(file.originalname || '');
            cb(null, file.originalname);
        },
    });

    const fileFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
        if (uploadAllowlist) {
            const { extensions, mimetypes } = uploadAllowlist;
            const safeName = sanitizeFilename(file.originalname || '');
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
        storage,
        limits: {
            fileSize: maxUploadBytes,
            files: 1,
        },
        fileFilter,
    });

    express.post(
        `${mount}/file`,
        validateToken,
        (req: CustomRequest, res: Response, next: NextFunction) => {
            upload.single('file')(req, res, (err: any) => {
                if (err) {
                    if (err instanceof multer.MulterError) {
                        if (err.code === 'LIMIT_FILE_SIZE') {
                            res.status(413).json({ error: `File exceeds maximum allowed size of ${maxUploadBytes} bytes` });
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
        async (req: CustomRequest, res: Response) => {
            const { originalname, size, mimetype, id } = req.file;
            const baseFileInfo: UploadedFileInfo = {
                name: originalname,
                size,
                mimetype,
                id,
                userId: req.info?.id ?? '',
                unitId: extractUnitId(req.info),
            };
            let extraMetadata: Record<string, unknown> = {};
            if (getUploadMetadata) {
                try {
                    const customMeta = await getUploadMetadata(req, baseFileInfo);
                    if (customMeta && typeof customMeta === 'object' && !Array.isArray(customMeta)) {
                        extraMetadata = customMeta;
                    }
                } catch (err) {
                    logger.error('Failed to compute upload metadata:', err);
                    await fs.promises.rm(path.join(uploadDir, id), { recursive: true, force: true }).catch(() => {});
                    res.status(500).json({ error: 'Failed to save file metadata' }).end();
                    return;
                }
            }
            const fileInfo: UploadedFileInfo = {
                ...baseFileInfo,
                ...extraMetadata,
                id: baseFileInfo.id,
                name: baseFileInfo.name,
            };
            const infoPath = path.join(uploadDir, fileInfo.id, 'index.json');
            try {
                await fs.promises.writeFile(infoPath, JSON.stringify(fileInfo));
                res.status(200).json(fileInfo).end();
            } catch (err) {
                logger.error('Failed to write file metadata:', err);
                res.status(500).json({ error: 'Failed to save file metadata' }).end();
            }
        },
    );

    express.get(`${mount}/file/:fileId`, validateToken, async (req: CustomRequest, res: Response) => {
        const fileId = String(req.params.fileId);
        if (!UUID_PATTERN.test(fileId)) {
            res.status(404).end();
            return;
        }
        const info = await readFileMetadata(uploadDir, fileId);
        if (!info || typeof info.name !== 'string') {
            res.status(404).end();
            return;
        }
        if (!(await checkFileAccess(authorizeFileAccess, req, res, info, fileId))) {
            return;
        }
        const safeName = encodeURIComponent(path.basename(info.name));
        if (!safeName) {
            res.status(404).end();
            return;
        }
        res.redirect(302, `${req.baseUrl}${req.path}/${safeName}`);
    });

    const resolvedUploadDir = path.resolve(uploadDir);
    const uploadDirPrefix = resolvedUploadDir.endsWith(path.sep) ? resolvedUploadDir : `${resolvedUploadDir}${path.sep}`;
    express.use(
        `${mount}/file/`,
        validateToken,
        async (req: CustomRequest, res: Response, next: NextFunction) => {
            let decodedPath: string;
            try {
                decodedPath = decodeURIComponent(req.path);
            } catch {
                res.status(404).end();
                return;
            }

            // index.json holds upload metadata (including uploader/unit scope); it is not a downloadable file.
            if (path.basename(req.path).toLowerCase() === 'index.json' || path.basename(decodedPath).toLowerCase() === 'index.json') {
                res.status(404).end();
                return;
            }

            if (decodedPath.includes('\0') || decodedPath.includes('\\')) {
                res.status(404).end();
                return;
            }

            const rawSegments = req.path.split('/').filter((segment) => segment.length > 0);
            const decodedSegments = decodedPath.split('/').filter((segment) => segment.length > 0);
            if (
                decodedSegments.length === 0 ||
                rawSegments.some((segment) => segment === '.' || segment === '..') ||
                decodedSegments.some((segment) => segment === '.' || segment === '..')
            ) {
                res.status(404).end();
                return;
            }

            const fileId = decodedSegments[0];
            const resolvedFileDir = path.resolve(resolvedUploadDir, fileId);
            const resolvedTarget = path.resolve(resolvedUploadDir, ...decodedSegments);
            if (!resolvedFileDir.startsWith(uploadDirPrefix) || !resolvedTarget.startsWith(`${resolvedFileDir}${path.sep}`)) {
                res.status(404).end();
                return;
            }

            if (authorizeFileAccess) {
                const fileMeta = await readFileMetadata(uploadDir, fileId);
                if (!fileMeta) {
                    res.status(404).end();
                    return;
                }
                if (!(await checkFileAccess(authorizeFileAccess, req, res, fileMeta, fileId))) {
                    return;
                }
            }

            next();
        },
        expressCore.static(uploadDir, {
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
