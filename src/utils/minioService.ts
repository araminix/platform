import * as Minio from 'minio';
import { Err, Ok, Result } from '@araminix/lib';

export enum MIME_TYPE {
    IMAGE = 'image/*',
    JPG = 'image/jpeg',
    PNG = 'image/png',
    PDF = 'application/pdf',
    WORD_DOC = 'application/msword',
    WORD_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    EXCEL_XLS = 'application/vnd.ms-excel',
    EXCEL_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    PPT = 'application/vnd.ms-powerpoint',
    PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    CSV = 'text/csv',
    ZIP = 'application/zip',
    JSON = 'application/json',
    XML = 'application/xml',
    HTML = 'text/html',
    TEXT = 'text/plain',
    AUDIO = 'audio/*',
    VIDEO = 'video/*',
    DRAW_IO = 'application/octet-stream',
    GERBER = 'application/x-gerber',
    ANY = 'application/octet-stream',
}

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

export interface MinioClient {
    endPoint: string;
    port: number;
    accessKey: string;
    secretKey: string;
    useSSL?: boolean;
}

export interface MinioOptions extends MinioClient {
    bucketName: string;
    expiry?: number;
}

export class MinioService {
    private client!: Minio.Client;
    private readonly minioClient: MinioClient;
    private readonly additionalParams: { bucketName: string; expiry: number };
    private isInitialized = false;

    constructor(options: MinioOptions) {
        this.validateOptions(options);
        const { bucketName, expiry = 24 * 60 * 60, ...minioClient } = options;
        this.minioClient = minioClient;
        this.additionalParams = { bucketName, expiry };
    }

    private validateOptions(options: MinioOptions): void {
        if (!options.endPoint) throw new Error('MinIO endPoint is required');
        if (!options.port) throw new Error('MinIO port is required');
        if (!options.accessKey) throw new Error('MinIO accessKey is required');
        if (!options.secretKey) throw new Error('MinIO secretKey is required');
        if (!options.bucketName) throw new Error('MinIO bucketName is required');
    }

    private async init(): Promise<void> {
        if (this.isInitialized) return;
        this.client = new Minio.Client(this.minioClient);
        const exists = await this.client.bucketExists(this.additionalParams.bucketName);
        if (!exists) {
            await this.client.makeBucket(this.additionalParams.bucketName, 'us-east-1');
        }
        this.isInitialized = true;
    }

    private async ensureInitialized(): Promise<void> {
        if (!this.isInitialized) {
            await this.init();
        }
    }

    private setFileExtension(mimetype: MIME_TYPE, fileName: string): string {
        const ext = MimeToExtension[mimetype];
        if (ext && !fileName.endsWith(ext)) {
            return `${fileName}${ext}`;
        }
        return fileName;
    }

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
