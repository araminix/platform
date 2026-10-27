import { Transform } from 'node:stream';
import { spec } from 'node:test/reporters';

export default class CustomReporter extends Transform {
    private specStream: Transform;

    constructor(opts?: any) {
        super({ ...opts, writableObjectMode: true });
        this.specStream = new (spec as any)();
        this.specStream.on('data', (chunk: any) => this.push(chunk));
    }

    _transform(event: any, encoding: BufferEncoding, callback: (error?: Error | null, data?: any) => void): void {
        if (event?.data?.details?.duration_ms !== undefined) {
            event.data.details.duration_ms = Math.round(event.data.details.duration_ms * 100) / 100;
        }
        if (event?.data?.duration_ms !== undefined) {
            event.data.duration_ms = Math.round(event.data.duration_ms * 100) / 100;
        }
        if (event?.type === 'test:diagnostic' && typeof event.data?.message === 'string') {
            const match = event.data.message.match(/^duration_ms\s+([\d.]+)/);
            if (match) {
                const val = parseFloat(match[1]);
                if (!isNaN(val)) {
                    event.data.message = `duration_ms ${(Math.round(val * 100) / 100).toFixed(2)}`;
                }
            }
        }
        this.specStream.write(event, encoding, callback);
    }

    _flush(callback: (error?: Error | null, data?: any) => void): void {
        this.specStream.end(callback);
    }
}
