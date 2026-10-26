import { deal, err, Ok, ok, StreamCloseCodes, WsCloseCodes } from '@araminix/lib';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import AgentController from '../src/agent/AgentController.js';
import Platform from '../src/Platform.js';
import { AgentInfo, AuthProvider, UserInfo } from '../src/server/AuthProvider.js';
import { ConnectRequest } from '../src/server/ConnectRequest.js';
import Endpoint from '../src/server/Endpoint.js';

describe('Unhandled Rejections and Uncaught Exceptions Defense', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'araminix-test-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('Endpoint: corrupt index.json returns 404 without uncaught exception', async () => {
        const fileId = 'corrupt-file-123';
        const fileDir = path.join(tempDir, fileId);
        fs.mkdirSync(fileDir, { recursive: true });
        fs.writeFileSync(path.join(fileDir, 'index.json'), '{corrupt-json-data');

        const mockAuth: AuthProvider = {
            getInfo: async () => new Ok(new UserInfo('user-1', 'john', 'John Doe', 'rt-1', 'john@example.com', [], { _key: 'u1', name: 'Unit 1', code: 'U1' })) as any,
            auth: async () => ({}) as any,
            googleAuth: async () => ({}) as any,
            destroy: async () => {},
            refreshToken: async () => ({}) as any,
            request2FA: async () => ({}) as any,
            verify2FA: async () => ({}) as any,
            enable2FA: async () => ({}) as any,
            disable2FA: async () => ({}) as any,
            requestUploadUrl: async () => ({}) as any,
            requestDownloadUrl: async () => ({}) as any,
            mobileRequests: async () => ({}) as any,
        };

        const endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            uploadDir: tempDir,
        });
        endpoint.open();
        const address = (endpoint as any).server?.address();
        const port = typeof address === 'object' && address ? address.port : 3000;

        try {
            const res = await fetch(`http://127.0.0.1:${port}/file/${fileId}`, {
                headers: {
                    'x-token': 'valid-token',
                },
            });
            assert.strictEqual(res.status, 404);
        } finally {
            endpoint.close();
        }
    });

    it('Endpoint: ws route handles authProvider throwing without unhandled rejection and closes with code 1011', async () => {
        const mockAuth: AuthProvider = {
            getInfo: async () => {
                throw new Error('Database connection unexpectedly dropped');
            },
            auth: async () => ({}) as any,
            googleAuth: async () => ({}) as any,
            destroy: async () => {},
            refreshToken: async () => ({}) as any,
            request2FA: async () => ({}) as any,
            verify2FA: async () => ({}) as any,
            enable2FA: async () => ({}) as any,
            disable2FA: async () => ({}) as any,
            requestUploadUrl: async () => ({}) as any,
            requestDownloadUrl: async () => ({}) as any,
            mobileRequests: async () => ({}) as any,
        };

        const endpoint = new Endpoint({
            authProvider: mockAuth,
            port: 0,
            uploadDir: tempDir,
        });
        endpoint.open();
        const address = (endpoint as any).server?.address();
        const port = typeof address === 'object' && address ? address.port : 3000;

        const [closePromise, resolveClose] = deal<{ code: number; reason: string }>();

        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws-token/some-token/platform`);
        ws.onclose = (event) => {
            resolveClose({ code: event.code, reason: event.reason });
        };

        try {
            const result = await closePromise;
            assert.strictEqual(result.code, WsCloseCodes.InternalError);
            assert.strictEqual(result.code, 1011);
        } finally {
            endpoint.close();
        }
    });

    it('Platform: custom stream handler exception is caught and closes stream with error', async () => {
        let streamCloseCalled = false;
        let closedCode: any = null;

        const mockStream = {
            args: { test: true },
            write: async () => ok(),
            closeOk: () => {},
            closeErr: () => {
                streamCloseCalled = true;
                closedCode = StreamCloseCodes.Error;
            },
        };

        const mockSocket = {
            incomingStream: async (name: string) => {
                if (name === 'custom/exploding') {
                    if (!streamCloseCalled) {
                        return new Ok(mockStream as any);
                    }
                }
                return err();
            },
        };

        const mockAuth: AuthProvider = {
            getInfo: async () => ({}) as any,
            auth: async () => ({}) as any,
            googleAuth: async () => ({}) as any,
            destroy: async () => {},
            refreshToken: async () => ({}) as any,
            request2FA: async () => ({}) as any,
            verify2FA: async () => ({}) as any,
            enable2FA: async () => ({}) as any,
            disable2FA: async () => ({}) as any,
            requestUploadUrl: async () => ({}) as any,
            requestDownloadUrl: async () => ({}) as any,
            mobileRequests: async () => ({}) as any,
        };

        const platform = new Platform({
            appIndexPath: new URL('file:///d:/dummy/apps.js'),
            agentIndexPath: new URL('file:///d:/dummy/agents.js'),
            authProvider: mockAuth,
            instanceUserLimit: 5,
            onCustomStream: {
                exploding: async () => {
                    throw new Error('Custom stream catastrophic error');
                },
            },
        });

        try {
            platform.processCustomStreams({ id: 'user-1' } as any, mockSocket as any);
            await new Promise((resolve) => setTimeout(resolve, 50));
            assert.strictEqual(streamCloseCalled, true);
            assert.strictEqual(closedCode, StreamCloseCodes.Error);
        } finally {
            platform.stop();
        }
    });

    it('AgentController: incoming post stream with null or invalid args closes stream with error without throwing', async () => {
        let streamCloseErrCount = 0;
        let streamCount = 0;

        const mockStreams = [
            { args: null }, // remote trigger case: null args
            { args: { name: 12345 } }, // invalid name type
            { args: undefined }, // undefined args
        ];

        const [finishPromise, resolveFinish] = deal<void>();

        const mockSocket = {
            waitClose: async () => 'Intentional',
            destroy: () => {},
            incomingStream: async (name: string) => {
                if (name === 'post' && streamCount < mockStreams.length) {
                    const current = mockStreams[streamCount++];
                    const stream = {
                        args: current.args,
                        closeErr: () => {
                            streamCloseErrCount++;
                            if (streamCloseErrCount === mockStreams.length) {
                                resolveFinish();
                            }
                        },
                        closeOk: () => {},
                        write: async () => ok(),
                    };
                    return new Ok(stream as any);
                }
                return err();
            },
        };

        const controller = new AgentController(new URL('file:///d:/dummy/agents.js'));
        const origSet = (controller as any).instances.set;
        (controller as any).instances.set = function (key: any, val: any) {
            val.init = async () => ok();
            return origSet.call(this, key, val);
        };

        const agentInfo = new AgentInfo('agent-1', 'test');
        const mockRequest = {
            info: agentInfo,
            arg: '',
            accept: () => new Ok(mockSocket as any),
            deny: () => ok(),
        } as unknown as ConnectRequest;

        const connectResult = await controller.connect(agentInfo, mockRequest);
        assert.ok(connectResult.isOk());

        await finishPromise;
        assert.strictEqual(streamCloseErrCount, 3);
    });
});
