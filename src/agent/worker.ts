import { deal, Err, logger, Ok, Result } from '@araminix/lib';
import { parentPort } from 'worker_threads';

import { AgentPost, Data, deserialize } from '../executor/proto.js';
import { RequestSocket, ResponseSocket } from '../lib/worker_socket.js';
import { initAgentWorkerDriver } from './agentWorkerDriver.js';
import { Agent, AgentFactory, AgentIndex } from './d.js';

class AgentWorker {
    private agent: Agent<any>;
    private requestSocket: RequestSocket;
    private responseSocket: ResponseSocket;

    constructor(agent: Agent<any>, requestSocket: RequestSocket, responseSocket: ResponseSocket) {
        this.agent = agent;
        this.requestSocket = requestSocket;
        this.responseSocket = responseSocket;
    }

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
