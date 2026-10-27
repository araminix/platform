import * as Minio from 'minio';
import { Err, Ok, Result } from '@araminix/lib';

/**
 * MIME types understood by {@link MinioService} and the attachment routes. {@link MimeToExtension} gives the file
 * extension the service appends to object names.
 *
 * @remarks
 * `DRAW_IO` and `ANY` have the same value (`application/octet-stream`), so they are interchangeable at runtime.
 */
export enum MIME_TYPE {
    /** Any image; no extension is appended. */
    IMAGE = 'image/*',
    /** JPEG image (`.jpg`). */
    JPG = 'image/jpeg',
    /** PNG image (`.png`). */
    PNG = 'image/png',
    /** PDF document (`.pdf`). */
    PDF = 'application/pdf',
    /** Legacy Word document (`.doc`). */
    WORD_DOC = 'application/msword',
    /** Word document (`.docx`). */
    WORD_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    /** Legacy Excel workbook (`.xls`). */
    EXCEL_XLS = 'application/vnd.ms-excel',
    /** Excel workbook (`.xlsx`). */
    EXCEL_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    /** Legacy PowerPoint presentation (`.ppt`). */
    PPT = 'application/vnd.ms-powerpoint',
    /** PowerPoint presentation (`.pptx`). */
    PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    /** CSV file (`.csv`). */
    CSV = 'text/csv',
    /** ZIP archive (`.zip`). */
    ZIP = 'application/zip',
    /** JSON document (`.json`). */
    JSON = 'application/json',
    /** XML document (`.xml`). */
    XML = 'application/xml',
    /** HTML document (`.html`). Serve such files as downloads only. */
    HTML = 'text/html',
    /** Plain text (`.txt`). */
    TEXT = 'text/plain',
    /** Any audio; no extension is appended. */
    AUDIO = 'audio/*',
    /** Any video; no extension is appended. */
    VIDEO = 'video/*',
    /** draw.io diagram (binary); no extension is appended. Same value as `ANY`. */
    DRAW_IO = 'application/octet-stream',
    /** Gerber PCB file (`.gbr`). */
    GERBER = 'application/x-gerber',
    /** Any binary file; no extension is appended. */
    ANY = 'application/octet-stream',
}

/**
 * File extension (without dot) for each {@link MIME_TYPE}; `'*'` means "do not append an extension".
 * {@link MinioService.presignedPutObject} and `POST /attachments/upload` use it to build object names.
 */
export const MimeToExtension: Partial<Record<MIME_TYPE, string>> = {
    [MIME_TYPE.GERBER]: 'gbr',
    [MIME_TYPE.IMAGE]: '*',
    [MIME_TYPE.JPG]: 'jpg',
    [MIME_TYPE.PNG]: 'png',
    [MIME_TYPE.PDF]: 'pdf',
    [MIME_TYPE.WORD_DOC]: 'doc',
    [MIME_TYPE.WORD_DOCX]: 'docx',
    [MIME_TYPE.EXCEL_XLS]: 'xls',
    [MIME_TYPE.EXCEL_XLSX]: 'xlsx',
    [MIME_TYPE.PPT]: 'ppt',
    [MIME_TYPE.PPTX]: 'pptx',
    [MIME_TYPE.CSV]: 'csv',
    [MIME_TYPE.ZIP]: 'zip',
    [MIME_TYPE.JSON]: 'json',
    [MIME_TYPE.XML]: 'xml',
    [MIME_TYPE.HTML]: 'html',
    [MIME_TYPE.TEXT]: 'txt',
    [MIME_TYPE.AUDIO]: '*',
    [MIME_TYPE.VIDEO]: '*',
    [MIME_TYPE.DRAW_IO]: '*',
};

/** Connection settings of the MinIO/S3 server (passed to the `minio` client). */
export interface MinioClient {
    /** Host name or IP of the server, without protocol or port (for example `minio.internal`). */
    endPoint: string;
    /** TCP port of the server (for example `9000`). */
    port: number;
    /** Access key id. */
    accessKey: string;
    /** Secret access key. */
    secretKey: string;
    /**
     * Use HTTPS to talk to the server.
     *
     * @defaultValue the `minio` client default (`true`)
     */
    useSSL?: boolean;
    /**
     * Region passed to the client and used when the bucket has to be created.
     *
     * @defaultValue `'us-east-1'` when creating the bucket
     */
    region?: string;
}

/**
 * Settings of {@link MinioService} and of the attachment routes ({@link EndpointOptions.minio}).
 *
 * @example
 * ```ts
 * const minio: MinioOptions = {
 *     endPoint: 'minio.internal',
 *     port: 9000,
 *     useSSL: false,
 *     accessKey: process.env.MINIO_ACCESS_KEY!,
 *     secretKey: process.env.MINIO_SECRET_KEY!,
 *     bucketName: 'attachments',
 *     expiry: 5 * 60,
 * };
 * ```
 */
export interface MinioOptions extends MinioClient {
    /** Bucket that holds all objects; created on first use if it does not exist. */
    bucketName: string;
    /**
     * Validity of presigned URLs, in seconds.
     *
     * @defaultValue `900` (15 minutes)
     */
    expiry?: number;
}

/**
 * Thin, `Result`-returning wrapper around the `minio` client for one bucket.
 *
 * The client and the bucket are set up lazily on the first call (creating the bucket if needed); concurrent first calls
 * share that setup, and a failed setup is retried by the next call. Apart from the constructor, methods never throw:
 * failures come back as `Err`.
 *
 * @example
 * ```ts
 * import { MIME_TYPE, MinioService, uuid } from '@araminix/platform';
 *
 * const storage = new MinioService({ endPoint: 'minio.internal', port: 9000, useSSL: false, accessKey, secretKey, bucketName: 'attachments' });
 *
 * const put = await storage.presignedPutObject(MIME_TYPE.PDF, `${userId}/${uuid()}`); // ".pdf" is appended
 * if (put.isOk()) {
 *     await fetch(put.unwrap(), { method: 'PUT', body: pdfBytes });
 * }
 * const files = await storage.listObjects(`${userId}/`);
 * ```
 */
export class MinioService {
    /** The `minio` client, created on first use. */
    private client!: Minio.Client;
    /** Connection settings. */
    private readonly minioClient: MinioClient;
    /** Bucket name and presign expiry (seconds). */
    private readonly additionalParams: { bucketName: string; expiry: number };
    /** Whether the client and bucket are ready. */
    private isInitialized = false;
    /** Setup in progress, shared by concurrent callers. */
    private initPromise?: Promise<void>;

    /**
     * Validates the options; does not contact the server.
     *
     * @param options - Connection settings, bucket and expiry.
     * @throws Error when `endPoint`, `port`, `accessKey`, `secretKey` or `bucketName` is missing.
     */
    constructor(options: MinioOptions) {
        this.validateOptions(options);
        const { bucketName, expiry = 15 * 60, ...minioClient } = options;
        this.minioClient = minioClient;
        this.additionalParams = { bucketName, expiry };
    }

    /** Validity of presigned URLs, in seconds. */
    get expiry(): number {
        return this.additionalParams.expiry;
    }

    /** Throws when a required option is missing. */
    private validateOptions(options: MinioOptions): void {
        if (!options.endPoint) throw new Error('MinIO endPoint is required');
        if (!options.port) throw new Error('MinIO port is required');
        if (!options.accessKey) throw new Error('MinIO accessKey is required');
        if (!options.secretKey) throw new Error('MinIO secretKey is required');
        if (!options.bucketName) throw new Error('MinIO bucketName is required');
    }

    /** Creates the client and makes sure the bucket exists (once; concurrent callers share the attempt). */
    private async init(): Promise<void> {
        if (this.isInitialized) return;
        // Concurrent first calls share one initialisation instead of racing makeBucket.
        if (!this.initPromise) {
            this.initPromise = (async () => {
                this.client = new Minio.Client(this.minioClient);
                const exists = await this.client.bucketExists(this.additionalParams.bucketName);
                if (!exists) {
                    await this.client.makeBucket(this.additionalParams.bucketName, this.minioClient.region ?? 'us-east-1');
                }
                this.isInitialized = true;
            })();
            this.initPromise.catch(() => {
                this.initPromise = undefined;
            });
        }
        await this.initPromise;
    }

    /** Runs {@link MinioService.init} unless setup already succeeded. */
    private async ensureInitialized(): Promise<void> {
        if (!this.isInitialized) {
            await this.init();
        }
    }

    /** Appends the extension of `mimetype` (see {@link MimeToExtension}) unless `fileName` already ends with it. */
    private setFileExtension(mimetype: MIME_TYPE, fileName: string): string {
        const ext = MimeToExtension[mimetype];
        if (ext && ext !== '*' && !fileName.endsWith(`.${ext}`) && !fileName.endsWith(ext)) {
            return fileName.endsWith('.') ? `${fileName}${ext}` : `${fileName}.${ext}`;
        }
        return fileName;
    }

    /**
     * Creates a presigned `PUT` URL for uploading an object.
     *
     * The extension of `mimetype` is appended to `fileName` unless it already ends with it, so the object name can differ
     * from the name you pass; `POST /attachments/upload` builds keys that already carry the extension.
     *
     * @typeParam E - Error type.
     * @param mimetype - MIME type of the file.
     * @param fileName - Object name (key), for example `<userId>/<uuid>`.
     * @returns The URL (valid for {@link MinioService.expiry} seconds), or the client error.
     */
    async presignedPutObject<E = Error>(mimetype: MIME_TYPE, fileName: string): Promise<Result<string, E>> {
        try {
            await this.ensureInitialized();
            const validName = this.setFileExtension(mimetype, fileName);
            const url = await this.client.presignedPutObject(this.additionalParams.bucketName, validName, this.additionalParams.expiry);
            return new Ok(url);
        } catch (e) {
            return new Err(e as E);
        }
    }

    /**
     * Creates a presigned `GET` URL for downloading an object. The object does not have to exist.
     *
     * @typeParam E - Error type.
     * @param objectName - Object name (key).
     * @returns The URL (valid for {@link MinioService.expiry} seconds), or an error (also for an empty name).
     */
    async presignedGetObject<E = Error>(objectName: string): Promise<Result<string, E>> {
        try {
            await this.ensureInitialized();
            if (!objectName) throw new Error('Object name cannot be empty');
            const url = await this.client.presignedGetObject(this.additionalParams.bucketName, objectName, this.additionalParams.expiry);
            return new Ok(url);
        } catch (e) {
            return new Err(e as E);
        }
    }

    /**
     * Deletes an object.
     *
     * @typeParam E - Error type.
     * @param objectName - Object name (key).
     * @returns `Ok` when the request succeeded, or an error (also for an empty name).
     */
    async deleteObject<E = Error>(objectName: string): Promise<Result<void, E>> {
        try {
            await this.ensureInitialized();
            if (!objectName) throw new Error('Object name cannot be empty');
            await this.client.removeObject(this.additionalParams.bucketName, objectName);
            return new Ok(undefined);
        } catch (e) {
            return new Err(e as E);
        }
    }

    /**
     * Lists object names below a prefix, recursively.
     *
     * @typeParam E - Error type.
     * @param prefix - Key prefix, for example `<userId>/`.
     * @returns All matching object names, or an error.
     */
    async listObjects<E = Error>(prefix: string = ''): Promise<Result<string[], E>> {
        try {
            await this.ensureInitialized();
            const objects: string[] = [];
            const stream = this.client.listObjects(this.additionalParams.bucketName, prefix, true);
            return new Promise<Result<string[], E>>((resolve) => {
                stream.on('data', (obj) => {
                    if (obj.name) objects.push(obj.name);
                });
                stream.on('end', () => resolve(new Ok(objects)));
                stream.on('error', (err) => resolve(new Err(err as unknown as E)));
            });
        } catch (e) {
            return new Err(e as E);
        }
    }

    /**
     * Tells whether an object exists.
     *
     * @typeParam E - Error type.
     * @param objectName - Object name (key).
     * @returns `Ok(true)` or `Ok(false)` (when the server answers `NotFound`), or any other error.
     */
    async objectExists<E = Error>(objectName: string): Promise<Result<boolean, E>> {
        try {
            await this.ensureInitialized();
            if (!objectName) throw new Error('Object name cannot be empty');
            await this.client.statObject(this.additionalParams.bucketName, objectName);
            return new Ok(true);
        } catch (e: any) {
            if (e?.code === 'NotFound') {
                return new Ok(false);
            }
            return new Err(e as E);
        }
    }
}
