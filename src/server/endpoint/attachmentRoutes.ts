import { logger, uuid } from '@araminix/lib';
import { Response } from 'express';
import expressWs from 'express-ws';
import path from 'path';

import { MIME_TYPE, MimeToExtension, MinioOptions, MinioService } from '../../utils/index.js';
import { validateToken } from './security.js';
import { CustomRequest } from './types.js';

function safeDecodeURIComponent(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function hasUnsafePath(raw: string, decoded: string): boolean {
    return raw.includes('..') || raw.startsWith('/') || raw.startsWith('\\') || decoded.includes('..') || decoded.startsWith('/') || decoded.startsWith('\\');
}

/**
 * Registers the MinIO attachment routes. Object keys are always `<userId>/<uuid>[.<ext>]`, generated on the server, and a
 * user can only obtain download URLs below their own `<userId>/` prefix.
 */
export function registerAttachmentRoutes(express: expressWs.Application, mount: string, minio: MinioOptions): void {
    const minioService = new MinioService(minio);

    express.post(`${mount}/attachments/upload`, validateToken, async (req: CustomRequest, res) => {
        try {
            if (!req.info?.id) {
                res.status(401).send({ message: 'Unauthorized' }).end();
                return;
            }

            const { mimetype, fileName } = req.body || {};
            if (!mimetype || typeof mimetype !== 'string' || !fileName || typeof fileName !== 'string') {
                res.status(400).send({ message: 'mimetype and fileName are required strings.' }).end();
                return;
            }

            const decodedFileName = safeDecodeURIComponent(fileName);
            if (hasUnsafePath(fileName, decodedFileName)) {
                res.status(400).send({ message: 'Invalid fileName: path traversal and leading slash are not allowed.' }).end();
                return;
            }

            // Prefer the mimetype's extension: MinioService appends it to any key that doesn't already end with it,
            // so using it here keeps the returned key identical to the object name that gets presigned.
            const mimeExt = MimeToExtension[mimetype as MIME_TYPE];
            let ext = mimeExt && mimeExt !== '*' ? mimeExt : path.extname(fileName).replace(/^\./, '').trim().toLowerCase();
            if (ext && !/^[a-zA-Z0-9]+$/.test(ext)) {
                ext = '';
            }

            const userId = req.info.id;
            const fileId = uuid();
            const key = ext ? `${userId}/${fileId}.${ext}` : `${userId}/${fileId}`;

            const urlResult = await minioService.presignedPutObject(mimetype as MIME_TYPE, key);
            if (urlResult.isErr()) {
                logger.error('Error on Upload Request API: ', urlResult.e);
                res.status(500).send({ error: 'Failed to create upload URL' }).end();
                return;
            }
            const url = urlResult.unwrap();
            res.status(200).json({ url, key, attachmentId: key }).end();
        } catch (error) {
            logger.error('Error on Upload Request API: ', error);
            res.status(500).send({ error: 'Internal server error' }).end();
        }
    });

    const handleGetAttachment = async (req: CustomRequest, res: Response) => {
        try {
            if (!req.info?.id) {
                res.status(401).send({ message: 'Unauthorized' }).end();
                return;
            }

            let attachmentId = '';
            if (req.params.userId && req.params.fileName) {
                attachmentId = `${req.params.userId}/${req.params.fileName}`;
            } else if (req.params.attachmentId) {
                attachmentId = String(req.params.attachmentId);
            }

            if (!attachmentId) {
                res.status(400).send({ message: 'attachmentId is required.' }).end();
                return;
            }

            const decoded = safeDecodeURIComponent(attachmentId);
            if (hasUnsafePath(attachmentId, decoded)) {
                res.status(400).send({ message: 'Invalid attachmentId: path traversal and leading slash are not allowed.' }).end();
                return;
            }

            const userId = req.info.id;
            let objectKey: string;

            if (attachmentId.startsWith(`${userId}/`)) {
                objectKey = attachmentId;
            } else if (!attachmentId.includes('/')) {
                objectKey = `${userId}/${attachmentId}`;
            } else {
                logger.error(`IDOR attempt or unauthorized attachment access denied for user '${userId}': ${attachmentId}`);
                res.status(403).send({ message: 'Forbidden: access to attachment denied.' }).end();
                return;
            }

            if (objectKey === `${userId}/` || objectKey.endsWith('/')) {
                res.status(400).send({ message: 'Invalid attachmentId: file name cannot be empty.' }).end();
                return;
            }

            const fileURLResult = await minioService.presignedGetObject(objectKey);
            if (fileURLResult.isErr()) {
                logger.error('Error on Get File API: ', fileURLResult.e);
                res.status(500).send({ error: 'Failed to create download URL' }).end();
                return;
            }
            const fileURL = fileURLResult.unwrap();
            res.status(200).json({ fileURL }).end();
        } catch (error) {
            logger.error('Error on Get File API: ', error);
            res.status(500).send({ error: 'Internal server error' }).end();
        }
    };

    express.get(`${mount}/attachments/:attachmentId`, validateToken, handleGetAttachment);
    express.get(`${mount}/attachments/:userId/:fileName`, validateToken, handleGetAttachment);
}
