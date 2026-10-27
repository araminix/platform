/**
 * Entry file of agent worker threads (one per connected agent id), started by `AgentInstance.init`.
 *
 * It waits for the `AgentInit` message, imports the agent index, creates the agent of the requested type, answers with an
 * empty message to signal readiness and then serves `AgentPost` requests until its port closes. The process exits with
 * code 1 when the index cannot be loaded or the type does not exist.
 *
 * @module
 */
import { deal, Err, logger, Ok, Result } from '@araminix/lib';
import { parentPort } from 'worker_threads';

import { AgentPost, Data, deserialize } from '../executor/proto.js';
import { RequestSocket, ResponseSocket } from '../lib/worker_socket.js';
import { initAgentWorkerDriver } from './agentWorkerDriver.js';
import { Agent, AgentFactory, AgentIndex } from './d.js';

/** Serves the requests of the main thread for one agent. */
class AgentWorker {
    /** The agent object. */
    private agent: Agent<any>;
    /** Requests from this worker to the main thread. */
    private requestSocket: RequestSocket;
    /** Requests from the main thread to this worker. */
    private responseSocket: ResponseSocket;

    /**
     * @param agent - The agent object.
     * @param requestSocket - Requests to the main thread.
     * @param responseSocket - Requests from the main thread.
     */
    constructor(agent: Agent<any>, requestSocket: RequestSocket, responseSocket: ResponseSocket) {
        this.agent = agent;
        this.requestSocket = requestSocket;
        this.responseSocket = responseSocket;
    }

    /**
     * Answers `AgentPost` requests with the serialised result of {@link Agent.onPost} (a thrown error becomes
     * `Err(message)`) until the port closes, then closes the request socket.
     */
    async run(): Promise<void> {
        while (true) {
            const requestResult = await this.responseSocket.read();
            if (requestResult.isErr()) {
                break;
            }
            const request = requestResult.unwrap();
            switch (true) {
                case request instanceof AgentPost: {
                    const agentPost = request as AgentPost;
                    let response: unknown;
                    try {
                        const result = await this.agent.onPost(agentPost.name, agentPost.data);
                        response = (result as any).serialize();
                    } catch (error) {
                        // A throwing onPost answers this post with an error instead of killing the agent worker.
                        logger.error(`Agent onPost '${agentPost.name}' failed:`, error);
                        response = new Err(error instanceof Error ? error.message : String(error)).serialize();
                    }
                    this.responseSocket.resolve(new Data(response));
                    break;
                }
                default: {
                    this.responseSocket.write(undefined);
                }
            }
        }
        this.requestSocket.close();
    }
}

/** Bootstrap: runs only inside a worker thread. */
if (parentPort) {
    const [promise, resolve] = deal<Result<AgentWorker, Error>>();
    parentPort.on('message', async (init: any) => {
        try {
            const AgentIndexClass = (await import(init.workerIndexPath)).default;
            const agentIndex: AgentIndex = new AgentIndexClass();
            agentIndex.agentTypeList; // init names
            const agentFactory = (agentIndex as any)[`${init.info.agentType}`];
            if (!(agentFactory instanceof AgentFactory)) {
                throw new Error(`Type ${init.info.agentType} is not agentFactory`);
            }
            const requestSocket = new RequestSocket(init.requestPort, deserialize);
            initAgentWorkerDriver(requestSocket);
            const responseSocket = new ResponseSocket(init.responsePort, deserialize);
            const agent = new agentFactory._agentClass(agentIndex, init.info.id);
            const worker = new AgentWorker(agent, requestSocket, responseSocket);
            resolve(new Ok(worker));
        } catch (e) {
            resolve(new Err(e as Error));
            process.exit(1);
        }
    });

    const workerRes = await promise;
    if (workerRes.isOk()) {
        const worker = workerRes.unwrap();
        parentPort.postMessage('');
        await worker.run();
        process.exit(0);
    } else {
        process.exit(1);
    }
}
