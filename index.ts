/**
 * `@araminix/platform`: actor-based application runtime, HTTP/WebSocket endpoint and agent engine.
 *
 * - {@link Platform} wires everything together; {@link Endpoint} is the HTTP/WebSocket server and {@link AuthProvider}
 *   your authentication back-end.
 * - Apps are written with {@link AppIndex}, {@link App}, {@link Page}, {@link MainPage}, {@link Wizard}, {@link Stage},
 *   {@link Fragment} and {@link panel}, and navigate with actors (see {@link Actor}).
 * - Agents are written with {@link AgentIndex}, {@link AgentFactory} and {@link Agent}.
 * - Everything from `@araminix/lib` (Result, streams, sockets, logger, client) is re-exported.
 *
 * @packageDocumentation
 */
import Fragment from './src/builder/Fragment.js';
import panel from './src/builder/Panel.js';
import Platform, { UserInstance } from './src/Platform.js';
import { ConnectRequest } from './src/server/ConnectRequest.js';
import Endpoint from './src/server/Endpoint.js';

/** `@araminix/lib`: `Result`/`Ok`/`Err`, `t` (io-ts), `loop`, `logger`, `Socket`, `Stream`, `Client`, ... */
export * from '@araminix/lib';
/** Server: `AuthProvider`, `UserInfo`, `AgentInfo`, `ClientType`, `EndpointOptions`, `EndpointController`, ... */
export * from './src/server/index.js';
/** Utilities: `I18nService`, `logMiddleware`, `MinioService`, `MIME_TYPE`, ... */
export * from './src/utils/index.js';
/** App model: `AppIndex`, `App`, `Activity`, `Page`, `MainPage`, `Wizard`, `SetupWizard`, `Stage`, ... */
export * from './src/lib/d.js';
/** Actors: `OpenPage`, `NextPage`, `Close`, `UpdateFragment`, `Nothing`, ... */
export * from './src/lib/actors.js';
/** Worker IPC: `Req`, `Res`, `Rej`, `RequestSocket`, `ResponseSocket`, `typeNameOf`. */
export * from './src/lib/worker_socket.js';
/** Agents: `AgentIndex`, `AgentFactory`, `Agent`, agent errors. */
export * from './src/agent/d.js';
/** Executor: `AppResult`, `workerDriver`. */
export * from './src/executor/index.js';

/** Main classes and functions. */
export { Platform, Endpoint, ConnectRequest, Fragment, panel, UserInstance };
