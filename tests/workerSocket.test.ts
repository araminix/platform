import assert from 'node:assert';
import { describe, it } from 'node:test';
import { MessageChannel } from 'worker_threads';

import { MessageRole, Rej, Req, RequestSocket, Res, ResponseSocket } from '../src/lib/worker_socket.js';

class CustomReq extends Req {
    payload: string;
    constructor(payload: string) {
        super();
        this.payload = payload;
    }
}

class CustomRes extends Res {
    answer: number;
    constructor(answer: number) {
        super();
        this.answer = answer;
    }
}

function deserialize(data: any): Req | Res | Rej | undefined {
    if (!data) return undefined;
    if (data._type === 'CustomReq') return new CustomReq(data.payload);
    if (data._type === 'CustomRes') return new CustomRes(data.answer);
    if (data._type === 'Res') return new Res();
    if (data._type === 'Rej') return new Rej();
    return undefined;
}

describe('WorkerSocket', () => {
    it('communicates over MessageChannel', async () => {
        const channel = new MessageChannel();
        const reqSocket = new RequestSocket(channel.port1, deserialize);
        const resSocket = new ResponseSocket(channel.port2, deserialize);

        const serverPromise = (async () => {
            const readRes = await resSocket.read();
            assert.ok(readRes.isOk());
            const req = readRes.unwrap();
            assert.ok(req instanceof CustomReq);
            assert.strictEqual((req as CustomReq).payload, 'ping');
            resSocket.resolve(new CustomRes(42));
        })();

        const clientRes = await reqSocket.writeRead<CustomReq, CustomRes>(new CustomReq('ping'));
        assert.ok(clientRes.isOk());
        assert.strictEqual(clientRes.unwrap().answer, 42);

        await serverPromise;
        reqSocket.close();
        resSocket.close();
    });
});
