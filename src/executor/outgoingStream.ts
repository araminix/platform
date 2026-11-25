import { logger, Socket, Stream, StreamCloseCodes } from '@araminix/lib';

import { Rej, Res, ResponseSocket } from '../lib/worker_socket.js';

/**
 * Forwards a worker request to the client as an outgoing stream and answers the worker with `Res` when the client closed
 * the stream normally, `Rej` otherwise (also when no client is connected or the stream times out).
 */
export async function sendOutgoingStream(userSocket: Socket | undefined, responseSocket: ResponseSocket | undefined, name: string, arg: unknown, timeoutMs: number): Promise<void> {
    if (!userSocket || !responseSocket) {
        responseSocket?.write(new Rej());
        return;
    }

    const TIMEOUT = Symbol('outgoingStreamTimeout');
    let timedOut = false;
    let activeStream: Stream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise =
        timeoutMs > 0
            ? new Promise<typeof TIMEOUT>((resolve) => {
                  timer = setTimeout(() => {
                      timedOut = true;
                      if (activeStream) {
                          try {
                              activeStream.closeErr();
                          } catch {}
                      }
                      resolve(TIMEOUT);
                  }, timeoutMs);
              })
            : undefined;

    try {
        const streamPromise = userSocket.outgoingStream(name, arg);
        if (timeoutPromise) {
            streamPromise
                .then((res) => {
                    if (timedOut && res.isOk()) {
                        try {
                            res.unwrap().closeErr();
                        } catch {}
                    }
                })
                .catch(() => {});
        }

        const streamResult = timeoutPromise ? await Promise.race([streamPromise, timeoutPromise]) : await streamPromise;
        if (timedOut || streamResult === TIMEOUT) {
            logger.warn(`Outgoing stream '${name}' timed out after ${timeoutMs}ms while opening`);
            responseSocket.write(new Rej());
            return;
        }
        if (streamResult.isErr()) {
            responseSocket.write(new Rej());
            return;
        }

        const stream = streamResult.unwrap();
        activeStream = stream;

        const closeCode = timeoutPromise ? await Promise.race([stream.waitClose(), timeoutPromise]) : await stream.waitClose();
        if (timedOut || closeCode === TIMEOUT) {
            logger.warn(`Outgoing stream '${name}' timed out after ${timeoutMs}ms waiting for close`);
            responseSocket.write(new Rej());
            return;
        }
        if (closeCode !== StreamCloseCodes.Normal) {
            responseSocket.write(new Rej());
            return;
        }
        responseSocket.write(new Res());
    } catch (error) {
        logger.error(`Error in outgoing stream '${name}':`, error);
        if (activeStream) {
            try {
                activeStream.closeErr();
            } catch {}
        }
        responseSocket.write(new Rej());
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}
