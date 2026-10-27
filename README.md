# @araminix/platform

> **Actor-based application runtime, WebSocket endpoint platform and multi-threaded agent engine for Node.js.**

[![npm version](https://img.shields.io/badge/npm-2.2.1-blue.svg)](https://www.npmjs.com/package/@araminix/platform)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-green.svg)](https://nodejs.org/)

`@araminix/platform` is the server side of the Araminix stack. You write your applications as TypeScript classes (apps, pages, wizards and UI fragments) and the platform runs every opened app in its own worker thread, streams the UI tree and its updates to the front-end over the multiplexed WebSocket streams of [`@araminix/lib`](https://github.com/araminix/lib), and routes commands between your apps and external agent processes such as devices or services. A hardened HTTP endpoint provides login, sessions, two-factor authentication, Google sign-in, file uploads and S3/MinIO attachments.

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
    - [1. Authentication provider](#1-authentication-provider)
    - [2. Agents](#2-agents)
    - [3. Apps](#3-apps)
    - [4. Server](#4-server)
    - [5. Connect a client](#5-connect-a-client)
- [Architecture](#architecture)
    - [Threads and isolation](#threads-and-isolation)
    - [Endpoints and streams](#endpoints-and-streams)
    - [Request flow](#request-flow)
- [Guides](#guides)
    - [Writing an AuthProvider](#writing-an-authprovider)
    - [Apps, pages and fragments](#apps-pages-and-fragments)
    - [Panels and layout](#panels-and-layout)
    - [The actor model](#the-actor-model)
    - [Wizards and stages](#wizards-and-stages)
    - [Agents and agent tasks](#agents-and-agent-tasks)
    - [Custom streams and endpoints](#custom-streams-and-endpoints)
    - [Uploads and MinIO attachments](#uploads-and-minio-attachments)
    - [Internationalisation](#internationalisation)
    - [Logging](#logging)
    - [Deploying securely](#deploying-securely)
- [HTTP and WebSocket route reference](#http-and-websocket-route-reference)
- [Configuration reference](#configuration-reference)
    - [PlatformConfig fields](#platformconfig-fields)
    - [EndpointOptions fields](#endpointoptions-fields)
    - [EndpointControllerOptions fields](#endpointcontrolleroptions-fields)
    - [MinioOptions fields](#miniooptions-fields)
    - [RateLimitConfig fields](#ratelimitconfig-fields)
    - [UploadAllowlist fields](#uploadallowlist-fields)
- [API reference](#api-reference)
    - [Platform and server](#platform-and-server): [`Platform`](#platform), [`PlatformConfig`](#platformconfig), [`UserInstance`](#userinstance), [`Endpoint`](#endpoint), [`EndpointOptions`](#endpointoptions), [`EndpointController`](#endpointcontroller), [`EndpointControllerOptions`](#endpointcontrolleroptions), [`ConnectRequest`](#connectrequest), [`AcceptError`](#accepterror), [`UploadAllowlist`](#uploadallowlist), [`RateLimitConfig`](#ratelimitconfig), [`ServerDriver`](#serverdriver)
    - [Authentication and identity](#authentication-and-identity): [`AuthProvider`](#authprovider), [`ClientInfo`](#clientinfo), [`UserInfo`](#userinfo), [`AgentInfo`](#agentinfo), [`ClientType`](#clienttype), [`GoogleData`](#googledata), [`GoogleDataType`](#googledatatype), [`MobileRequestType`](#mobilerequesttype), [`MobileResponseType`](#mobileresponsetype), [`UserSetting`](#usersetting), [`SettingTwoFactor`](#settingtwofactor), [`SettingNotification`](#settingnotification), [`SettingTablePreference`](#settingtablepreference), [`SettingCardPreference`](#settingcardpreference)
    - [App model](#app-model): [`AppIndex`](#appindex), [`AppEntry`](#appentry), [`AppListing`](#applisting), [`App`](#app), [`Activity`](#activity), [`Page`](#page), [`MainPage`](#mainpage), [`Wizard`](#wizard), [`SetupWizard`](#setupwizard), [`Stage`](#stage), [`PhantomAgentIndex`](#phantomagentindex), [`PhantomAppIndex`](#phantomappindex), [`PhantomApp`](#phantomapp), [`PhantomPage`](#phantompage), [`phantomApp`](#phantomapp-constant), [`phantomPage`](#phantompage-constant)
    - [UI builder](#ui-builder): [`Fragment`](#fragment), [`panel()`](#panel)
    - [Actors](#actors): [`Actor`](#actor), [`OpenPage`](#openpage), [`NextPage`](#nextpage), [`ReplacePage`](#replacepage), [`PopPage`](#poppage), [`Close`](#close), [`Prev`](#prev), [`Destroy`](#destroy), [`Refresh`](#refresh), [`Reload`](#reload), [`Nothing`](#nothing), [`WizardDetached`](#wizarddetached), [`WizardAttached`](#wizardattached), [`WizardPop`](#wizardpop), [`WizardNext`](#wizardnext), [`WizardNextReplace`](#wizardnextreplace), [`WizardDone`](#wizarddone), [`UpdateFragment`](#updatefragment), [`UpdateTypes`](#updatetypes), [`ReloadFragment`](#reloadfragment)
    - [Agents](#agents): [`AgentIndex`](#agentindex), [`AgentFactory`](#agentfactory), [`Agent`](#agent), [`AgentErrorType`](#agenterrortype), [`ExecutionAgentError`](#executionagenterror), [`CommunicationAgentError`](#communicationagenterror)
    - [Executor](#executor): [`AppResult`](#appresult), [`workerDriver()`](#workerdriver)
    - [Worker IPC](#worker-ipc): [`MessageRole`](#messagerole), [`typeNameOf()`](#typenameof), [`Req`](#req), [`Res`](#res), [`Rej`](#rej), [`RequestSocket`](#requestsocket), [`ResponseSocket`](#responsesocket)
    - [Utilities](#utilities): [`I18nService`](#i18nservice), [`Translations`](#translations), [`logMiddleware`](#logmiddleware), [`MinioService`](#minioservice), [`MinioOptions`](#miniooptions), [`MinioClient`](#minioclient), [`MIME_TYPE`](#mime_type), [`MimeToExtension`](#mimetoextension)
    - [Re-exports from @araminix/lib](#re-exports-from-araminixlib)
- [Close codes and error enums](#close-codes-and-error-enums)
- [Migration notes](#migration-notes)
    - [2.2.0](#220)
    - [2.0.0](#200)
- [Testing](#testing)
- [Related packages](#related-packages)
- [License](#license)

## Features

- **One worker thread per app instance.** Every app a user opens runs in its own `worker_threads` worker with memory limits, request timeouts and a forced termination after a grace period. A crash or an endless loop in one app cannot take the server down.
- **Actor-based UI runtime.** Pages never touch the UI directly. They return actors such as [`$open`](#page), [`$next`](#page), [`$close`](#page) or [`$patch`](#fragment), and the runtime applies them under a per-instance lock, so actions, timers and requests never interleave.
- **Server-driven UI.** [`Fragment`](#fragment)s and [`panel()`](#panel)s build a UI tree that is streamed to the front-end, together with targeted fragment updates, queries and pushes.
- **Wizards.** Multi-step flows ([`Wizard`](#wizard), [`Stage`](#stage)) that run in a new tab, in place of the current page or as a pop-up and hand a typed result back to the page that started them.
- **Agents.** External processes connect as agents, each served by its own worker thread. Apps send them tasks and agents post messages back ([`Agent`](#agent), [`AgentFactory`](#agentfactory)).
- **Hardened endpoint.** Signed `httpOnly` session cookies, `x-token` header authentication, a CSRF guard for cookie requests, origin checks for WebSockets, rate-limited authentication routes, verified Google sign-in and 2FA hooks ([`Endpoint`](#endpoint), [`AuthProvider`](#authprovider)).
- **Files.** Local uploads with size limits, allow-lists, sanitized names and download headers against stored XSS; presigned S3/MinIO URLs with per-user keys ([`MinioService`](#minioservice)).
- **Robust connections.** WebSocket heartbeats, message size limits, per-client connection caps, pending-stream caps, resumable connections and minification-safe wire names ([`typeNameOf()`](#typenameof)).
- **No exceptions in the API.** Fallible operations return `Result` values from `@araminix/lib`; error codes reach clients, error objects only reach the log.

## Requirements

- **Node.js 22 or later.** The package is ESM only (`"type": "module"` with an `exports` map), so load it with `import`. TypeScript projects need a module resolution that understands `exports` (`NodeNext` or `Bundler`).
- **`@araminix/lib` in your application.** The platform imports `@araminix/lib` at runtime, but the `package.json` of version 2.2.0 lists it only as a development dependency (2.1.1). Install it yourself next to the platform. Keep exactly one copy in your dependency tree (check with `npm ls @araminix/lib`): `Result`, stream and connection objects are checked with `instanceof` across both packages. The platform is built and tested against `@araminix/lib` 2.1.1, and its sources also type-check against `@araminix/lib` 3.1.
- **Optional:** an S3-compatible server (MinIO) for attachments, and a TLS-terminating reverse proxy in production.

## Installation

```bash
# npm
npm install @araminix/platform @araminix/lib

# pnpm
pnpm add @araminix/platform @araminix/lib

# yarn
yarn add @araminix/platform @araminix/lib
```

Everything from `@araminix/lib` is re-exported, so application code can import `Ok`, `Err`, `Result`, `loop`, `logger` and friends from `@araminix/platform` directly.

## Quick start

A complete server with one app, one page, one fragment and one agent type. The project layout is:

```text
src/
  auth.ts     your AuthProvider
  agents.ts   default export: your AgentIndex
  apps.ts     default export: your AppIndex
  server.ts   creates and starts the Platform
```

The app and agent index modules are loaded by URL, in the main thread and again in every worker thread, so they must be standalone ES modules with a default export.

### 1. Authentication provider

An [`AuthProvider`](#authprovider) maps credentials to session tokens and tokens to a [`ClientInfo`](#clientinfo). This demo keeps sessions in memory and turns off the features it does not need by answering them with an error code.

```ts
// src/auth.ts
import { AuthProvider, ClientInfo, Err, GoogleDataType, MobileRequestType, MobileResponseType, Ok, Result, UserInfo } from '@araminix/platform';
import { randomUUID } from 'node:crypto';

type Login = string | { twoFactorCode: string; accountName: string };

/** Demo provider: one user, sessions in memory, no 2FA. Replace the bodies with calls to your user store. */
export class DemoAuthProvider extends AuthProvider {
    private readonly sessions = new Map<string, UserInfo>();

    async getInfo<TClient extends ClientInfo = ClientInfo, TErr = unknown>(token: string): Promise<Result<TClient, TErr>> {
        const info = this.sessions.get(token);
        return info ? new Ok(info as unknown as TClient) : new Err('InvalidToken' as TErr);
    }

    async auth<TAuthData = unknown, TErr = unknown>(data: TAuthData): Promise<Result<Login, TErr>> {
        const { username, password } = (data ?? {}) as { username?: string; password?: string };
        if (username !== 'demo' || !password || password !== process.env.DEMO_PASSWORD) {
            return new Err('InvalidCredentials' as TErr);
        }
        const token = randomUUID();
        // runtimeId = token: every login session gets its own WebSocket connections and app instances.
        this.sessions.set(token, new UserInfo('user-1', 'demo', 'Demo User', token, 'demo@example.com', [], { _key: 'main', name: 'Main', code: 'MAIN' }));
        return new Ok(token);
    }

    async destroy(token: string): Promise<void> {
        this.sessions.delete(token);
    }

    async refreshToken<TErr = unknown>(old_token: string): Promise<Result<string, TErr>> {
        const info = this.sessions.get(old_token);
        if (!info) {
            return new Err('InvalidToken' as TErr);
        }
        this.sessions.delete(old_token);
        const token = randomUUID();
        this.sessions.set(token, info);
        return new Ok(token);
    }

    // Features this demo does not offer answer with an error code (HTTP 401 { error: 'NotSupported' }).
    async googleAuth<TErr = unknown>(_data: GoogleDataType): Promise<Result<Login, TErr>> {
        return new Err('NotSupported' as TErr);
    }

    async request2FA<TErr = unknown>(_userId: string): Promise<Result<string, TErr>> {
        return new Err('NotSupported' as TErr);
    }

    async enable2FA<TErr = unknown>(_userId: string, _secret: string, _code: string): Promise<Result<boolean, TErr>> {
        return new Err('NotSupported' as TErr);
    }

    async verify2FA<TErr = unknown>(_accountName: string, _code: string, _uuid: string): Promise<Result<string | boolean, TErr>> {
        return new Err('NotSupported' as TErr);
    }

    async disable2FA<TErr = unknown>(_userId: string, _code?: string): Promise<Result<boolean, TErr>> {
        return new Err('NotSupported' as TErr);
    }

    async requestUploadUrl<TErr = unknown>(_attachmentId: string, _fileName: string, _mimeType: string): Promise<Result<string, TErr>> {
        return new Err('NotSupported' as TErr);
    }

    async requestDownloadUrl<TErr = unknown>(_attachmentId: string, _fileName: string): Promise<Result<string, TErr>> {
        return new Err('NotSupported' as TErr);
    }

    async mobileRequests<MODULE extends string = string, ACTION extends string = string, R = unknown, E = unknown>(
        data: MobileRequestType<MODULE, ACTION>,
    ): Promise<MobileResponseType<R, E>> {
        return { status: 404, message: `Unknown mobile action ${data.module}/${data.action}` };
    }
}
```

The abstract methods are generic, so implementations keep the generic signature and cast their concrete values (`as unknown as TClient`, `as TErr`).

### 2. Agents

An [`AgentIndex`](#agentindex) declares the agent types. Each [`AgentFactory`](#agentfactory) property is one type; its property name (`printer`) is the `agentType` of the [`AgentInfo`](#agentinfo) your provider returns for the agent's token.

```ts
// src/agents.ts
import { Agent, AgentFactory, AgentIndex, Err, Ok, Result } from '@araminix/platform';

/** A label printer process that connects to /ws/agent with an AgentInfo of type "printer". */
export class Printer extends Agent<DemoAgents> {
    /** Used by apps: sends the task "print" to the printer process and returns the job id it answers. */
    async print(text: string) {
        return this.task<{ text: string }, number>('print', { text });
    }

    /** Messages the printer process posts (runs in this agent's worker thread). */
    async onPost<TData = unknown, R = unknown, E = unknown>(name: string, data: TData): Promise<Result<R, E>> {
        if (name === 'status') {
            console.log(`printer ${this.id}:`, data);
            return new Ok(true as R);
        }
        return new Err(`Unknown message ${name}` as E);
    }
}

/** Default export loaded from agentIndexPath. The property name is the agent type. */
export default class DemoAgents extends AgentIndex {
    printer = new AgentFactory<DemoAgents, Printer>(this, Printer);
}
```

### 3. Apps

An [`AppIndex`](#appindex) declares the apps; every [`App`](#app) has a [`MainPage`](#mainpage) that renders [`Fragment`](#fragment)s inside [`panel()`](#panel)s. The fragment below is the server half of a front-end component called `Counter`.

```ts
// src/apps.ts
import { App, AppIndex, Fragment, MainPage, Ok, panel, Result } from '@araminix/platform';

import DemoAgents from './agents.js';

type CounterInput = { label: string; styles?: string[] };
type CounterData = { label: string; count: number };

/** Server half of the front-end component "Counter". */
export class Counter extends Fragment<CounterInput, CounterData> {
    static readonly typeName = 'Counter';
    private count = 0;

    constructor(input: CounterInput) {
        super(input);
        this.onAction('load', () => this.$reload()); // the component asks for its data when it mounts
        this.onAction('increment', () => {
            this.count++;
            return this.$patch({ count: this.count });
        });
    }

    load(): CounterData {
        return { label: this.input.label, count: this.count };
    }
}

class HomePage extends MainPage<void, HelloApp> {
    title(): string {
        return 'Home';
    }

    protected async render(): Promise<void> {
        panel({
            styles: ['column'],
            render: () => {
                new Counter({ label: 'Clicks' });
            },
        });
    }
}

class HelloApp extends App<void, DemoApps> {
    readonly title = 'Hello';
    category = 'Demo';
    main = new HomePage(this);
    setupWizard = undefined;

    protected async _getSettings(_userId: string, _profile: string | null): Promise<Result<void, unknown>> {
        return new Ok(undefined);
    }

    protected async _getUnits(_userId: string): Promise<Result<string[], unknown>> {
        return new Ok([]);
    }
}

/** Default export loaded from appIndexPath. The property name ("hello") is the app name. */
export default class DemoApps extends AppIndex<DemoAgents> {
    agents = new DemoAgents();
    hello = new HelloApp(this);

    protected async _getUserApps(_userId: string) {
        return new Ok([{ name: 'hello', title: 'Hello', profiles: [null] }]);
    }
}
```

### 4. Server

```ts
// src/server.ts
import { Platform } from '@araminix/platform';

import { DemoAuthProvider } from './auth.js';

const platform = new Platform({
    appIndexPath: new URL('./apps.js', import.meta.url),
    agentIndexPath: new URL('./agents.js', import.meta.url),
    authProvider: new DemoAuthProvider(),
    instanceUserLimit: 5,
    port: 3000,
    mount: '/api',
    cookieSecret: process.env.COOKIE_SECRET,
    allowedOrigins: ['http://localhost:5173'],
    cookieOptions: { secure: process.env.NODE_ENV === 'production' },
});

await platform.start();
console.log('Platform listening on http://localhost:3000/api');

process.on('SIGTERM', () => platform.stop());
```

Compile and run it (`tsc && COOKIE_SECRET=... DEMO_PASSWORD=... node dist/server.js`). The `appIndexPath` and `agentIndexPath` URLs point to the compiled `.js` files next to `server.js`.

### 5. Connect a client

Browsers log in with `POST /api/auth` and then connect with the session cookie; Node.js clients send a token in the `x-token` header. The [`Client`](https://github.com/araminix/lib#client) of `@araminix/lib` does both. This Node.js client lists the apps, starts one and renders its UI:

```ts
import { Client, loop, LoopResult, Socket } from '@araminix/lib';

declare const token: string;

// A Node.js client authenticated with the x-token header (browsers use the session cookie instead).
const client = new Client({ host: 'http://localhost:3000', wsHost: 'ws://localhost:3000', mount: '/api', token });

// Ask on a stream and read one answer. Pass null when a stream takes no arguments.
async function ask<T>(socket: Socket, name: string, args: unknown = null): Promise<T> {
    const stream = (await socket.outgoingStream(name, args)).unwrap();
    return (await stream.read<T>()).unwrap();
}

const platform = (await client.connect('platform')).unwrap();
console.log(await ask(platform, 'listApps')); // [{ category: 'Demo', apps: [{ name: 'hello', ... }] }]
const instanceId = await ask<string>(platform, 'createInstance', { appName: 'hello', profile: null });

const instance = (await client.connect('instance', instanceId)).unwrap();
// The server pushes UI to the client on streams it opens; accept them and close them when handled.
for (const name of ['activityList', 'build', 'push']) {
    loop(async () => {
        const stream = await instance.incomingStream(name);
        if (stream.isErr()) return LoopResult.Stop;
        console.log(name, JSON.stringify(stream.unwrap().args));
        stream.unwrap().closeOk();
        return LoopResult.Cont;
    });
}

console.log(await ask(instance, 'load')); // { ok: true } after "activityList" and "build" arrived
```

The `build` stream carries the UI tree: a root `Panel` containing the `column` panel, which contains a node `{ id, type: 'Counter' }`. The front-end mounts its `Counter` component, sends the action `load` (`{ fragmentId: id, name: 'load', data: null }` on the `action` stream) and receives `{ data: { label: 'Clicks', count: 0 }, type: 'Full' }` on the stream `update-<id>`.

## Architecture

```text
   Browser / mobile app                                    Agent process (device, service)
   @araminix/lib Client, session cookie                    @araminix/lib Client, x-token
        |  HTTP /api/*     |  WS /api/ws/platform              |  WS /api/ws/agent
        |                  |  WS /api/ws/instance/<id>         |
+-------v------------------v-----------------------------------v-----------------------+
| Main thread                                                                          |
|                                                                                      |
|  Endpoint (Express 5 + express-ws)                                                   |
|    session middleware -> AuthProvider.getInfo()                                      |
|    /auth /gauth /2fa/* /file /attachments/* /mobile/*                                |
|    EndpointController per endpoint name: "platform" | "instance" | "agent" | yours   |
|                                                                                      |
|  Platform                                                                            |
|    "platform": listApps, createInstance, listInstances, closeInstance, clientInfo,   |
|                custom/<name>                    (AppIndex instance for listings)     |
|    "instance": Instance (one per app instance)  "agent": AgentController             |
|                                                          AgentInstance (one per id)  |
+--------------|---------------------------------------------------|-------------------+
               | 2 MessageChannels (Req / Res / Rej)               | 2 MessageChannels
+--------------v----------------+                    +-------------v-----------------+
| App worker thread             |                    | Agent worker thread           |
|   AppIndex (own instance)     |   AgentTask,       |   AgentIndex (own instance)   |
|   AppInstance: lock, tabs     |   AgentList,       |   Agent.onPost()              |
|   Activities, panels,         |   AcquireAgent     |                               |
|   fragments, actors           | --- via main ----> |                               |
+-------------------------------+                    +-------------------------------+
```

### Threads and isolation

- **Main thread.** Only networking and routing: the [`Endpoint`](#endpoint), the accept loops of [`Platform`](#platform), one `Instance` per running app instance and one `AgentInstance` per connected agent. It also holds one [`AppIndex`](#appindex) to answer app listings. No page or fragment code runs here.
- **App worker threads.** `createInstance` starts a worker that imports `appIndexPath` itself, finds the app by name and runs it. All activities of that instance live in the worker. Requests from the client (`load`, `action`, `query`, ...) and [`trigger()`](#activity) calls from timers are serialised by a per-instance lock. Workers get `resourceLimits` (default 128 MB old generation, 4 MB stack); when an instance is destroyed its worker has 500 ms to exit before it is terminated.
- **Agent worker threads.** Each connected agent id gets a worker that imports `agentIndexPath` and creates the [`Agent`](#agent) of the requested type. It has 5 seconds to start; otherwise the connection is denied.
- **Messages between threads** are structured-clone copies of protocol classes ([`Req`](#req), [`Res`](#res), [`Rej`](#rej)) with request ids. The main thread waits at most `workerRequestTimeoutMs` (5 minutes) for a worker's answer and ignores late answers. Nothing is shared between threads: an app worker has its own copy of every module, including your own singletons.

Because instances and agents live in the memory of one process, a deployment with several server processes needs sticky sessions (a client must always reach the process that holds its instances), and agents can only be reached by apps running in the same process.

### Endpoints and streams

[`Platform`](#platform) serves three named WebSocket endpoints. Clients connect to `<mount>/ws/<name>` or `<mount>/ws/<name>/<arg>` and then open streams by name. Streams that a client opens are answered by the server; streams that the server opens must be accepted by the client (`incomingStream(name)`) and closed with `closeOk()` once handled.

| Endpoint   | URL                          | Client                   | Client opens                                                                                  | Server opens                                           |
| ---------- | ---------------------------- | ------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `platform` | `/ws/platform`               | `User`                   | `listApps`, `createInstance`, `listInstances`, `closeInstance`, `clientInfo`, `custom/<name>` | -                                                      |
| `instance` | `/ws/instance/<instance id>` | `User`, same `runtimeId` | `load`, `reload`, `prev`, `close`, `switch`, `refresh`, `action`, `query`                     | `activityList`, `build`, `push`, `update-<fragmentId>` |
| `agent`    | `/ws/agent`                  | `Agent`                  | `post`                                                                                        | `<task name>`, `ping`                                  |

Stream details:

| Stream                                         | Arguments                                      | Answer                                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `listApps`                                     | `null`                                         | [`AppListing`](#applisting)`[]`                                                                                                    |
| `createInstance`                               | `{ appName: string, profile: string \| null }` | the new instance id; the stream is closed with an error when the app or profile is not allowed, a limit is hit or the worker fails |
| `listInstances`                                | `null`                                         | [`UserInstance`](#userinstance)`[]` of the caller's runtime                                                                        |
| `closeInstance`                                | instance id                                    | no data, the stream is closed normally (also for unknown ids)                                                                      |
| `clientInfo`                                   | `null`                                         | the caller's [`ClientInfo`](#clientinfo); `settings.two_factor` is reduced to `{ enabled }`                                        |
| `custom/<name>`                                | anything                                       | whatever your [`onCustomStream`](#custom-streams-and-endpoints) handler writes                                                     |
| `load`                                         | `null`                                         | `{ ok: true }` after the active activity's build was sent                                                                          |
| `reload`, `prev`, `close`, `switch`, `refresh` | activity id                                    | `{ ok: true }` or `{ ok: false, e }`                                                                                               |
| `action`                                       | `{ fragmentId, name, data }`                   | `{ ok: true }` or `{ ok: false, e }`                                                                                               |
| `query`                                        | `{ fragmentId, name, data }`                   | `{ ok: true, v: answer }` or `{ ok: false, e }`                                                                                    |
| `activityList` (server)                        | `[{ id, title, active, main, prev }]`          | close it with `closeOk()`                                                                                                          |
| `build` (server)                               | `{ isPop, hasPrev, activityId, build }`        | close it with `closeOk()`                                                                                                          |
| `push` (server)                                | data passed to [`push()`](#activity)           | close it with `closeOk()`                                                                                                          |
| `update-<fragmentId>` (server)                 | `{ data, type: 'Full' \| 'Patch' }`            | close it with `closeOk()`                                                                                                          |
| `post` (agent)                                 | `{ name, data }`                               | the serialised `Result` returned by [`Agent.onPost`](#agent)                                                                       |
| `<task>` (server to agent)                     | task data                                      | the agent writes a serialised `Result` (`{ ok: true, v }` or `{ ok: false, e }`)                                                   |

On the instance streams, `e` is `'Format'` when the arguments have the wrong shape and `'Execution'` when the worker rejected the request or did not answer in time.

Pass `null` (not `undefined`) as the arguments of streams that take none: a stream request without arguments is not accepted by the server.

### Request flow

1. **Login.** `POST /api/auth` calls [`AuthProvider.auth`](#authprovider). A string result becomes a signed `httpOnly` `token` cookie; an object result is a 2FA challenge returned as JSON.
2. **Platform connection.** The browser opens `/api/ws/platform`. The session middleware resolves the cookie (or `x-token`) with [`AuthProvider.getInfo`](#authprovider), the `Origin` is checked against `allowedOrigins`, and the platform's accept loop admits `User` clients.
3. **App list.** `listApps` asks [`AppIndex._getUserApps`](#appindex) which apps the user may open and returns them grouped by category.
4. **Start an instance.** `createInstance { appName, profile }` checks the request against the same list, evicts the client's least recently used instance when `instanceUserLimit` is reached, checks `maxInstances`, and starts a worker. The worker imports the app index, reports the app title, and the stream answers the instance id.
5. **Instance connection.** The browser opens `/api/ws/instance/<id>`; only the runtime that created the instance is admitted.
6. **First render.** `load` reaches the worker. The main page runs `title()` (sent on `activityList`), `beforeRender()` and `render()`; the UI tree is sent on `build`; once the client has closed that stream, `afterWake()` runs and `load` answers `{ ok: true }`.
7. **Interaction.** `action { fragmentId, name, data }` runs the fragment's handler. The returned actor is applied: `$patch` and `$update` send `update-<fragmentId>`, `$open` or `$next` render another page, and so on.
8. **Agents.** A page calls `printer.print()`. The worker sends `AgentTask` to the main thread, the `AgentController` opens the stream `print` on the printer's connection, and the printer's answer travels back to the page as a `Result`.

The worker's messages to the client are sent one at a time and each one waits until the client has closed its stream, so a client must keep accepting the server-opened streams; an unaccepted stream request is dropped after 10 seconds.

## Guides

### Writing an AuthProvider

[`AuthProvider`](#authprovider) is the only class you must implement to run a server. The [`Endpoint`](#endpoint) owns the HTTP mechanics (cookies, rate limits, input checks); the provider owns users, sessions and secrets.

**Identities.** [`getInfo`](#authprovider) returns a [`UserInfo`](#userinfo) for people and an [`AgentInfo`](#agentinfo) for agents. The `runtimeId` of a client is the key of its WebSocket connections and app instances: give every login session its own `runtimeId` (the token, or a session id) so that two browsers of the same user do not share instances. For agents, `runtimeId` is the agent id.

**Login.** [`auth`](#authprovider) receives the JSON body of `POST /auth`. Return `Ok(token)` to log the user in, `Ok({ twoFactorCode, accountName })` to ask for a second factor, or `Err(code)` to refuse. String and number errors are sent to the client as `{ error: code }`; any other error value is replaced by `'Unauthorized'` and only logged.

**Two-factor authentication.** The flow and the provider's responsibilities:

| Step               | Route                 | Provider method                      | What the provider must do                                                                                                                                    |
| ------------------ | --------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Start enrolment    | `POST /2fa/request`   | `request2FA(userId)`                 | Generate a TOTP secret, store it as _pending_ for the user, return an `otpauth://` URL.                                                                      |
| Confirm enrolment  | `POST /2fa/enable`    | `enable2FA(userId, secret, code)`    | **Check that `secret` equals the pending secret issued to this user** (never trust a client-chosen secret) and that `code` is valid for it, then enable 2FA. |
| Login with 2FA     | `POST /auth`          | `auth(data)`                         | For a 2FA account, return `{ twoFactorCode, accountName }` instead of a token (the challenge id goes into `twoFactorCode`).                                  |
| Complete the login | `POST /2fa/verify`    | `verify2FA(accountName, code, uuid)` | Verify the challenge and the code; return the session token.                                                                                                 |
| Turn 2FA off       | `DELETE /2fa/disable` | `disable2FA(userId, code?)`          | **Require a valid current code.** The endpoint passes `code` from the body or query string unchecked, possibly `undefined`.                                  |

```ts
async enable2FA<TErr = unknown>(userId: string, secret: string, code: string): Promise<Result<boolean, TErr>> {
    const pending = await twoFactor.pendingSecret(userId); // issued by request2FA
    if (!pending || pending !== secret || !totp.verify(pending, code)) {
        return new Err('Invalid2FACode' as TErr);
    }
    await twoFactor.activate(userId, pending);
    return new Ok(true);
}

async disable2FA<TErr = unknown>(userId: string, code?: string): Promise<Result<boolean, TErr>> {
    const secret = await twoFactor.activeSecret(userId);
    if (!secret || !code || !totp.verify(secret, code)) {
        return new Err('Invalid2FACode' as TErr);
    }
    await twoFactor.deactivate(userId);
    return new Ok(true);
}
```

**Other duties.** [`refreshToken`](#authprovider) receives `old_token` from the request body and must validate it itself (the endpoint does not compare it with the cookie). [`destroy`](#authprovider) invalidates a session on logout; the endpoint then closes every WebSocket opened with that token. [`getInfo`](#authprovider) runs on every authenticated request and WebSocket upgrade, so cache it. [`requestUploadUrl`](#authprovider) and [`requestDownloadUrl`](#authprovider) are not called by the built-in routes. [`mobileRequests`](#authprovider) handles `POST /mobile/:module/:action`.

**Never put secrets into [`ClientInfo`](#clientinfo).** [`UserInfo`](#userinfo) drops `settings.two_factor.secret` and `code`, and the `clientInfo` stream strips them again, but other fields of your own subclass are passed to clients as they are.

### Apps, pages and fragments

The building blocks, from the outside in:

- [`AppIndex`](#appindex): the default export of `appIndexPath`. Every own property that holds an [`App`](#app) with a `main` page is an app, named after the property. [`_getUserApps`](#appindex) decides which apps (and profiles) a user may open.
- [`App`](#app): metadata (`title`, `category`, `description`, `hidden`, `widget`, `multiInstance`), the entry page `main`, and page templates as properties so that pages can reach each other through `this.app`.
- [`Page`](#page) and [`MainPage`](#mainpage): one screen. The objects you declare are templates; every time a page is opened the runtime creates a fresh instance with `new YourPage(app)` and the given context, so keep the `(app)` constructor.
- [`Fragment`](#fragment): the server half of a front-end component, created with `new` inside `render()`.

The lifecycle of an activity (page or stage):

1. `title(ctx)`: the tab title, sent with the activity list.
2. `beforeRender()`: return `this.$nothing()` to continue, or another actor to redirect.
3. `render()`: create panels and fragments; the result is sent on the `build` stream.
4. `afterWake()`: start timers and subscriptions; return a cleanup function. The cleanup runs when the activity stops being active, is closed, reloaded or refreshed.

A page with a context, a query and a timer:

```ts
import { Fragment, Page, panel } from '@araminix/platform';

type Order = { id: string; status: string; lines: { sku: string; qty: number }[] };

class OrderView extends Fragment<{ orderId: string; styles?: string[] }, Order> {
    static readonly typeName = 'OrderView';

    constructor(input: { orderId: string; styles?: string[] }) {
        super(input);
        this.onAction('load', () => this.$reload());
        this.onAction<{ status: string }>('setStatus', async ({ status }) => {
            await orders.setStatus(this.input.orderId, status);
            return this.$patch({ status });
        });
        this.onQuery<{ prefix: string }, string[]>('skus', ({ prefix }) => catalog.search(prefix));
    }

    async load(): Promise<Order> {
        return orders.get(this.input.orderId);
    }
}

class OrderPage extends Page<{ id: string }, ShopApp> {
    title(ctx: { id: string }) {
        return `Order ${ctx.id}`;
    }

    protected async render(): Promise<void> {
        panel(() => {
            new OrderView({ orderId: this.ctx.id });
        });
    }

    protected afterWake() {
        // Timers started here wait for the app lock, so they never interleave with an action.
        const timer = setInterval(() => this.trigger(this.$reload()), 60_000);
        return () => clearInterval(timer);
    }
}
```

Things to know:

- **Fragment data.** The runtime does not call `load()` during `render()`. It runs when the fragment applies [`$reload()`](#fragment); the usual pattern is a `load` action that the component sends when it mounts (as above), or `this.trigger(this.$reload())` from a timer.
- **Type names.** The front-end picks a component by the fragment's type name. Declare `static readonly typeName` on every fragment if your server code is bundled or minified; otherwise the mangled class name is sent.
- **Pushes.** [`push(data)`](#activity) sends arbitrary data on the instance's `push` stream, whether or not the activity is active.
- **Outside events.** Use [`trigger(actor)`](#activity) (on an activity or a fragment) to apply an actor from a timer or a callback; it waits for the app lock.
- **User data.** `this.userId`, `this.profile`, [`App.getSettings()`](#app) and [`workerDriver()`](#workerdriver) tell you whose instance is running.
- **Validation.** Action and query data come from the client unchecked; validate it (for example with the `t` codecs re-exported from `@araminix/lib`).

### Panels and layout

[`panel()`](#panel) creates a layout container inside the panel that is currently rendering. Fragments and panels created inside its `render` function become its children, in creation order. `styles` are names your front-end interprets.

```ts
protected async render(): Promise<void> {
    panel({
        styles: ['row'],
        render: () => {
            panel({ styles: ['column', 'wide'], render: () => new OrdersTable({ status: 'open' }) });
            panel({ styles: ['column'], render: () => new OrderSummary({}) });
        },
    });

    // An async content function returns a promise: await it before creating siblings.
    await panel(async () => {
        const stats = await loadStats();
        new StatCard({ label: 'Open orders', value: stats.open });
    });
}
```

The tree arrives on the `build` stream as `BuildedPart` nodes: `{ id, type: 'Panel', styles, content: [...] }` for panels and `{ id, type: '<typeName>', styles }` for fragments. Panels and fragments must be created while `render()` runs; a fragment constructed anywhere else throws a `TypeError`.

### The actor model

Activities return actors and the runtime carries them out inside the app's worker thread, under the app lock. Return them from fragment actions and [`beforeRender()`](#activity), return them from wizard callbacks, or apply them later with [`trigger()`](#activity).

| Helper                                  | Called on                    | Actor                                                                                               | Effect                                                                                   |
| --------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `page.$open(ctx)`                       | the target [`Page`](#page)   | [`OpenPage`](#openpage)                                                                             | Open the page as a new activity (tab).                                                   |
| `page.$next(ctx)`                       | the target page              | [`NextPage`](#nextpage)                                                                             | Show the page in the current activity; the client can go back (`prev`).                  |
| `page.$replace(ctx)`                    | the target page              | [`ReplacePage`](#replacepage)                                                                       | Show the page in the current activity without "back".                                    |
| `page.$pop(ctx)`                        | the target page              | [`PopPage`](#poppage)                                                                               | Show the page as a pop-up (`isPop: true`); closing it returns to the opener.             |
| `this.$close()`                         | a page                       | [`Close`](#close)                                                                                   | Close this activity; closing the last one ends the instance.                             |
| `this.$destroy()`                       | a page or stage              | [`Destroy`](#destroy)                                                                               | End the whole app instance.                                                              |
| `this.$refresh(ctx)`                    | any activity                 | [`Refresh`](#refresh)                                                                               | Rebuild this activity with a new context (title, `beforeRender`, `render`, `afterWake`). |
| `this.$reload()`                        | any activity                 | [`Reload`](#reload)                                                                                 | Re-render the active activity (`render`, `afterWake`).                                   |
| `this.$nothing()`                       | activity, fragment           | [`Nothing`](#nothing)                                                                               | No change.                                                                               |
| `this.$update(data)` / `$patch(data)`   | a fragment                   | [`UpdateFragment`](#updatefragment)                                                                 | Send a full replacement or a partial change to the component (`update-<fragmentId>`).    |
| `this.$reload()`                        | a fragment                   | [`ReloadFragment`](#reloadfragment)                                                                 | Run `load()` again and send the result as a full update.                                 |
| `wizard.$detached / $attached / $pop`   | a [`Wizard`](#wizard)        | [`WizardDetached`](#wizarddetached), [`WizardAttached`](#wizardattached), [`WizardPop`](#wizardpop) | Run a wizard (see [Wizards and stages](#wizards-and-stages)).                            |
| `stage.$next(ctx)` / `$nextReplace`     | the target [`Stage`](#stage) | [`WizardNext`](#wizardnext), [`WizardNextReplace`](#wizardnextreplace)                              | Move to another stage of the same wizard.                                                |
| `this.$ok(v)` / `$err(e)` / `$cancel()` | a stage                      | [`WizardDone`](#wizarddone)                                                                         | Finish the wizard.                                                                       |
| `this.$back()`                          | a stage                      | [`Prev`](#prev)                                                                                     | Previous stage, or cancel on the first stage of an attached or pop-up wizard.            |

Rules of thumb:

- Navigation helpers (`$open`, `$next`, `$replace`, `$pop`, `$next` of stages) are called on the **target**: `this.app.details.$open({ id })`.
- Most actors only work while their activity is the active one; otherwise the result is `Err(AppError.NonActive)`. An actor that does not belong to the activity (another activity's [`Close`](#close), a stage of another wizard) gives `Err(AppError.WrongAction)`. See [`AppResult`](#appresult).
- Fragment updates are only sent while the activity is active.
- An app keeps at most about `tabLimit` activities (default 12). Opening one more drops the second least recently used activity unless it is the one being left, so an instance can briefly hold `tabLimit + 1` activities.
- Returning [`$nothing()`](#nothing) from a fragment action wakes the active activity again, which calls `afterWake()` once more without running the cleanup it returned before. Keep `afterWake()` idempotent, or return a different actor from such actions.

### Wizards and stages

A [`Wizard`](#wizard) is a multi-step flow made of [`Stage`](#stage)s that produces a typed result. The stages are activities, so they render fragments like pages do, but they navigate with wizard actors.

```ts
import { Actor, MainPage, Stage, Wizard } from '@araminix/platform';

import { Button, Form } from './ui.js';

type Task = { title: string; due: string };

class TitleStage extends Stage<Partial<Task>, Task, NewTaskWizard> {
    protected async render(): Promise<void> {
        new Form<{ title: string }>({ fields: ['title'], onSubmit: ({ title }) => this.wizard.due.$next({ ...this.ctx, title }) });
        new Button({ label: 'Cancel', onClick: () => this.$cancel() });
    }
}

class DueStage extends Stage<Partial<Task>, Task, NewTaskWizard> {
    protected async render(): Promise<void> {
        new Form<{ due: string }>({ fields: ['due'], onSubmit: ({ due }) => this.$ok({ title: this.ctx.title ?? '', due }) });
        new Button({ label: 'Back', onClick: () => this.$back() });
    }
}

export class NewTaskWizard extends Wizard<Partial<Task>, Task, HomePage> {
    protected main = new TitleStage(this);
    readonly due = new DueStage(this);

    title(): string {
        return 'New task';
    }
}

export class HomePage extends MainPage<void, TasksApp> {
    readonly newTask = new NewTaskWizard(this);
    private tasks: Task[] = [];

    title(): string {
        return 'Tasks';
    }

    protected async render(): Promise<void> {
        new Button({
            label: 'New task',
            onClick: () =>
                this.newTask.$attached({}, (result): Actor => {
                    if (result?.isOk()) {
                        this.tasks.push(result.unwrap());
                        return this.$reload();
                    }
                    return this.$nothing();
                }),
        });
    }
}
```

`Button` and `Form` are ordinary fragments whose actions call a callback from their input:

```ts
type ButtonInput = { label: string; onClick: () => Actor | Promise<Actor>; styles?: string[] };

export class Button extends Fragment<ButtonInput, { label: string }> {
    static readonly typeName = 'Button';

    constructor(input: ButtonInput) {
        super(input);
        this.onAction('click', () => this.input.onClick());
    }

    load() {
        return { label: this.input.label };
    }
}
```

How a wizard runs and finishes:

| Start                       | Where it runs                       | When it finishes                                                                          |
| --------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `wizard.$detached(ctx, on)` | in a new activity (tab)             | `on(result)` is called (its return value is ignored) and the wizard's activity closes.    |
| `wizard.$attached(ctx, on)` | in place of the current activity    | the original activity comes back and the actor returned by `on(result)` is applied to it. |
| `wizard.$pop(ctx, on)`      | as a pop-up of the current activity | like `$attached`.                                                                         |

`result` is `Ok(output)` after `$ok(output)`, `Err(error)` after `$err(error)`, and `undefined` after `$cancel()`, after the user closes the wizard, or after `$back()` on the first stage of an attached or pop-up wizard. `$next` keeps the current stage for `$back()`; `$nextReplace` does not.

A [`SetupWizard`](#setupwizard) is a wizard that edits an app's settings (it starts from the current settings or `null`). Assign it to [`App.setupWizard`](#app) and start it yourself, for example `this.app.setupWizard.$detached(null, saveSettings)`; the runtime does not start it automatically.

### Agents and agent tasks

Agents are external processes (label printers, scales, background services) that connect to the `agent` endpoint. The pieces:

1. Your [`AuthProvider.getInfo`](#authprovider) returns `new AgentInfo(id, agentType)` for an agent's token.
2. [`AgentIndex`](#agentindex) (the default export of `agentIndexPath`, and also assigned to [`AppIndex.agents`](#appindex)) declares the types with [`AgentFactory`](#agentfactory) properties.
3. [`Agent`](#agent) subclasses wrap [`task()`](#agent) in public methods for apps, and handle the agent's messages in [`onPost()`](#agent).

Apps acquire an agent by id and call it. The code runs in the app worker, here in the action of a fragment that received the agent index through its input:

```ts
import { Fragment } from '@araminix/platform';

import DemoAgents from './agents.js';

type PrintInput = { agents: DemoAgents; styles?: string[] };

export class PrintButton extends Fragment<PrintInput, { lastJob?: number; error?: string }> {
    static readonly typeName = 'PrintButton';

    constructor(input: PrintInput) {
        super(input);
        this.onAction<{ text: string }>('print', async ({ text }) => {
            const printer = await this.input.agents.printer.acquire('printer-1');
            if (printer.isErr()) {
                return this.$update({ error: 'Printer offline' });
            }
            const job = await printer.unwrap().print(text);
            if (job.isErr()) {
                // job.e.type is AgentErrorType.Execution (the printer answered with an error)
                // or AgentErrorType.Communication (not connected, no answer within 60 seconds, ...)
                return this.$update({ error: job.e.type });
            }
            return this.$update({ lastJob: job.unwrap() });
        });
    }

    load() {
        return {};
    }
}

// In a page's render(): new PrintButton({ agents: this.app.index.agents });
```

The agent process uses the [`AgentClient`](https://github.com/araminix/lib#agentclient) of `@araminix/lib`:

```ts
import { Client, loop, LoopResult, Ok } from '@araminix/lib';

const client = new Client({ host: 'https://example.com', wsHost: 'wss://example.com', mount: '/api', token: AGENT_TOKEN });
const connected = await client.connectAgent();
if (connected.isErr()) throw new Error(`cannot connect: ${connected.e}`);
const agent = connected.unwrap();

// Serve the "print" task sent by Printer.print() (Agent.task on the server).
loop(async () => {
    const task = await agent.onTask<{ text: string }, number, string>('print');
    if (task.isErr()) return LoopResult.Stop;
    const [args, reply] = task.unwrap();
    reply(new Ok(await printLabel(args.text)));
    return LoopResult.Cont;
});

// Post a message; Printer.onPost('status', data) answers it.
const answer = await agent.post('status', { paper: 'low' });
```

Behaviour worth knowing:

- [`acquire(id)`](#agentfactory) succeeds only while an agent with that id and type is connected; [`list()`](#agentfactory) returns the connected ids of a type. Both work only inside worker threads.
- A task waits up to 60 seconds for the agent's answer. The agent must answer with a serialised `Result` (`AgentClient.onTask` does that).
- While an agent is connected the platform sends it a `ping` task every 30 seconds; agents may ignore it.
- The agent's worker survives reconnects; it is stopped when the agent closes its connection on purpose (`agent.destroy()`), when the worker fails or on [`Platform.stop()`](#platform). A reconnect with a different `agentType` for the same id replaces the worker.
- A thrown error in `onPost` is answered with `Err(message)` and the worker keeps running.

### Custom streams and endpoints

**Custom streams on the platform connection.** [`onCustomStream`](#platformconfig) registers handlers for streams named `custom/<name>` on the `platform` endpoint. The handler receives the client (as returned by `getInfo`) and the stream, and must close the stream. Streams of one name on one connection are handled one after another; a thrown error is logged and closes the stream with an error.

```ts
const platform = new Platform({
    // ...
    onCustomStream: {
        time: async (client, stream) => {
            await stream.write({ now: new Date().toISOString(), user: client.id });
            stream.closeOk();
        },
    },
});

// Client: (await (await platformSocket.outgoingStream('custom/time', null)).unwrap().read()).unwrap()
```

**Your own endpoints.** [`platform.endpoint.acquire(name)`](#endpoint) admits clients of any other endpoint name (`/ws/chat`, `/ws/chat/<arg>`). Run exactly one accept loop per name: a second pending `acquire` for the same name ends the first with `Err`.

```ts
import { ClientType, loop, LoopResult, Socket } from '@araminix/platform';

loop(async () => {
    const next = await platform.endpoint.acquire('chat'); // clients connect to /api/ws/chat
    if (next.isErr()) return LoopResult.Stop;
    const request = next.unwrap();
    if (request.info.clientType !== ClientType.User) {
        request.deny();
        return LoopResult.Cont;
    }
    const accepted = request.accept();
    if (accepted.isOk()) {
        const socket: Socket = accepted.unwrap();
        loop(async () => {
            const stream = await socket.incomingStream<{ text: string }>('say');
            if (stream.isErr()) return LoopResult.Stop;
            await stream.unwrap().write({ echo: stream.unwrap().args.text, from: request.info.id });
            stream.unwrap().closeOk();
            return LoopResult.Cont;
        });
    }
    return LoopResult.Cont;
});
```

**Extra HTTP routes.** Add them to [`platform.endpoint.express`](#endpoint). They run after the built-in middleware, so an authenticated request carries `req.info` (the client) and `req.token`:

```ts
platform.endpoint.express.get('/api/me', (req, res) => {
    const info = (req as { info?: unknown }).info;
    if (!info) return void res.status(401).end();
    res.json(info);
});
```

### Uploads and MinIO attachments

**Local uploads** are enabled with `uploadDir`:

- `POST /file` takes one multipart file in the field `file` (at most `maxUploadBytes`, default 20 MiB, otherwise 413). An optional [`uploadAllowlist`](#uploadallowlist) restricts extensions and MIME types (otherwise 415).
- The file is stored as `<uploadDir>/<uuid>/<sanitized name>` next to an `index.json`; the response is `{ name, size, mimetype, id, userId }` (the `FileInfo` type of `@araminix/lib`).
- `GET /file/<id>` redirects to `GET /file/<id>/<name>`, which serves the file with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`.
- Downloads require a session but are not limited to the uploader: any authenticated user who knows the id can download the file.
- Cookie-authenticated uploads need an `X-Requested-With` (or `X-CSRF-Token`) header; the `@araminix/lib` client sends it.

```ts
const platform = new Platform({
    // ...
    uploadDir: '/var/lib/araminix/uploads',
    maxUploadBytes: 10 * 1024 * 1024,
    uploadAllowlist: { extensions: ['png', 'jpg', 'pdf'], mimetypes: ['image/png', 'image/jpeg', 'application/pdf'] },
});
```

**MinIO/S3 attachments** are enabled with `minio` (see [`MinioOptions`](#miniooptions)). The server never sees the file content; it hands out presigned URLs:

1. `POST /attachments/upload` with `{ mimetype, fileName }` answers `{ url, key, attachmentId }`. The key is `<userId>/<uuid>.<ext>`, generated on the server (the extension comes from the MIME type, or from `fileName`).
2. The client uploads with `PUT url` before the URL expires (`expiry`, default 15 minutes).
3. `GET /attachments/<attachmentId>` (or `/attachments/<userId>/<file>`) answers `{ fileURL }`, a presigned download URL. Keys outside the caller's own `<userId>/` prefix are refused with 403.

[`MinioService`](#minioservice) can also be used directly:

```ts
import { MIME_TYPE, MinioService, uuid } from '@araminix/platform';

const minio = new MinioService({ endPoint: 'minio.internal', port: 9000, useSSL: false, accessKey, secretKey, bucketName: 'attachments' });
const put = await minio.presignedPutObject(MIME_TYPE.PDF, `${userId}/${uuid()}`); // ".pdf" is appended
const files = await minio.listObjects(`${userId}/`);
```

### Internationalisation

[`I18nService`](#i18nservice) is a small, type-safe dictionary. Missing languages or keys fall back to the key and log a warning.

```ts
import { I18nService } from '@araminix/platform';

type Lang = 'en' | 'de';
type Text = 'tasks' | 'save';

const i18n = new I18nService<Lang, Text>('en');
i18n.loadTranslations({
    en: { tasks: 'Tasks', save: 'Save' },
    de: { tasks: 'Aufgaben', save: 'Speichern' },
});

i18n.t('save'); // 'Save'
i18n.t('save', 'de'); // 'Speichern'
```

[`AppIndex`](#appindex) declares a protected `i18n` field of this type, but the platform never assigns it: create the service in your index (each worker has its own copy) and choose the language per user, for example from [`UserInfo.language`](#userinfo).

### Logging

The platform logs through the shared `logger` of `@araminix/lib`. Configure it once at start-up:

```ts
import { LOG_LEVEL, logger } from '@araminix/platform';

logger.configure({ level: LOG_LEVEL.INFO, format: 'json' });
logger.initStore({ directory: '/var/log/araminix', level: LOG_LEVEL.WARN, filePrefix: 'platform' });
```

Worker threads have their own module instances, so configure the logger in your app and agent index modules too if you need the same settings there.

HTTP access lines come from [`logMiddleware`](#logmiddleware): `METHOD: url status duration`, logged as `error` for 5xx, `warn` for 4xx and `info` otherwise. It is a separate logger instance with the default configuration, so `logger.configure()` does not change it. Tokens in deprecated `/ws-token/<token>` URLs are redacted, and error responses only contain the string or number codes of your provider; error objects (which may carry URLs or `Authorization` headers) are logged in reduced form.

### Deploying securely

A checklist for production:

- **`cookieSecret`**: set a long random secret, identical on every server process. Without it a random one is generated (with a warning) and all sessions end on restart.
- **HTTPS and cookies**: the session cookie defaults to `{ signed: true, httpOnly: true, secure: true, sameSite: 'lax', path: '/' }`. Keep `secure: true` behind HTTPS (browsers drop secure cookies on plain HTTP, so only relax it for local development via `cookieOptions`) and keep `signed: true` (the server only reads signed cookies). `sessionTtl` sets the cookie lifetime (24 hours); token expiry is up to your provider.
- **`allowedOrigins`**: list the exact origins of your front-ends. Without it every browser WebSocket is refused (fail closed); clients without an `Origin` header (Node.js, mobile apps) are always allowed. Avoid `'*'`.
- **CORS**: the endpoint does not emit CORS headers. Serve the front-end and the API from the same origin (for example through a reverse proxy).
- **`trustProxy`**: behind a reverse proxy, set it (for example to `1`) so that `req.ip`, and therefore the rate-limit key, is the real client address.
- **Rate limits**: `authRateLimit` (default 100 requests per 15 minutes per IP and account) covers `/auth`, `/gauth`, `/auth/refresh`, `/2fa/enable`, `/2fa/verify` and `/2fa/disable`, which share one counter store. `/2fa/request` is not limited.
- **Google sign-in**: `/gauth` answers 503 until `googleClientIds` is set. Tokens are verified against Google (audience, verified e-mail, matching profile) with 10-second timeouts.
- **CSRF**: cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` requests to protected routes need `Content-Type: application/json` or an `X-Requested-With`/`X-CSRF-Token` header (403 otherwise). `DELETE /auth` (logout) is not guarded.
- **Tokens in URLs**: do not use the deprecated `/ws-token/<token>/...` routes; they put tokens into URLs that proxies may log.
- **Limits and timeouts**: `maxMessageBytes` (16 MiB), `heartbeatIntervalMs` (30 s), `maxConnectionsPerClient` (32 per endpoint), `maxPendingStreams` (64), `instanceUserLimit`, `maxInstances`, `resourceLimits` (128 MB / 4 MB per app worker), `workerRequestTimeoutMs` (5 minutes), `maxUploadBytes` (20 MiB) and `tabLimit` (12). Size them for your load.
- **Uploads**: set an `uploadAllowlist`, keep `uploadDir` outside any static web root, and remember that `/file` downloads are not restricted to the uploader.
- **Scaling**: instances and agent workers live in one process. Use sticky sessions, a shared `cookieSecret`, shared upload storage, and connect agents to the process that runs the apps that use them.

```ts
const platform = new Platform({
    appIndexPath: new URL('./apps.js', import.meta.url),
    agentIndexPath: new URL('./agents.js', import.meta.url),
    authProvider: new MyAuthProvider(),
    instanceUserLimit: 5,
    maxInstances: 500,
    mount: '/api',
    cookieSecret: process.env.COOKIE_SECRET,
    allowedOrigins: ['https://app.example.com'],
    trustProxy: 1,
    googleClientIds: [process.env.GOOGLE_CLIENT_ID!],
    authRateLimit: { windowMs: 15 * 60 * 1000, limit: 20 },
    uploadDir: '/var/lib/araminix/uploads',
    uploadAllowlist: { extensions: ['png', 'jpg', 'pdf'] },
    resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
    workerRequestTimeoutMs: 60_000,
});
```

## HTTP and WebSocket route reference

All paths are relative to `mount`. "Session" means a valid signed `token` cookie or `x-token` header, resolved with [`AuthProvider.getInfo`](#authprovider) (401 otherwise). "CSRF" means that cookie-authenticated requests also need `Content-Type: application/json` or an `X-Requested-With`/`X-CSRF-Token` header (403 otherwise). "Limited" routes share the [authentication rate limiter](#ratelimitconfig) (429 when exceeded).

| Method   | Path                                | Auth          | Limited | Request                                 | Success                                                       | Errors                                          |
| -------- | ----------------------------------- | ------------- | ------- | --------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------- |
| `GET`    | `/health`                           | none          | no      | -                                       | 200 `200!` (text)                                             | -                                               |
| `GET`    | `/version`                          | none          | no      | -                                       | 200 `{ version }`                                             | -                                               |
| `POST`   | `/auth`                             | none          | yes     | JSON credentials (passed to `auth`)     | 200 + `token` cookie, or 200 `{ twoFactorCode, accountName }` | 401 `{ error }`, 429                            |
| `DELETE` | `/auth`                             | optional      | no      | -                                       | 200 `{ success: true }`, cookie cleared                       | -                                               |
| `PUT`    | `/auth/refresh`                     | none          | yes     | `{ old_token }`                         | 200 + new `token` cookie                                      | 400, 401 `{ error }`, 429                       |
| `POST`   | `/gauth`                            | none          | yes     | `{ access_token }`                      | 200 + `token` cookie, or 200 `{ twoFactorCode, accountName }` | 503 (not configured), 422, 401, 500, 429        |
| `POST`   | `/2fa/request`                      | session, CSRF | no      | -                                       | 200 `{ url }`                                                 | 401, 403, 500                                   |
| `POST`   | `/2fa/enable`                       | session, CSRF | yes     | `{ code, secret }`                      | 200 `{ success }`                                             | 400, 401, 403, 429, 500                         |
| `POST`   | `/2fa/verify`                       | none          | yes     | `{ accountName, code, uuid }`           | 200 + `token` cookie, or 200 `{ success }`                    | 400, 401, 429, 500                              |
| `DELETE` | `/2fa/disable`                      | session, CSRF | yes     | `code` in the JSON body or query string | 200 `{ success }`                                             | 401, 403, 429, 500                              |
| `POST`   | `/file`                             | session, CSRF | no      | multipart, one file in field `file`     | 200 `{ name, size, mimetype, id, userId }`                    | 400, 401, 403, 413, 415, 500                    |
| `GET`    | `/file/:fileId`                     | session       | no      | -                                       | 302 to `/file/:fileId/:name`                                  | 401, 404                                        |
| `GET`    | `/file/:fileId/:name`               | session       | no      | -                                       | 200 file (`attachment`, `nosniff`, sandbox CSP)               | 401, 404                                        |
| `POST`   | `/attachments/upload`               | session, CSRF | no      | `{ mimetype, fileName }`                | 200 `{ url, key, attachmentId }`                              | 400, 401, 403, 500                              |
| `GET`    | `/attachments/:attachmentId`        | session       | no      | -                                       | 200 `{ fileURL }`                                             | 400, 401, 403, 500                              |
| `GET`    | `/attachments/:userId/:fileName`    | session       | no      | -                                       | 200 `{ fileURL }`                                             | 400, 401, 403, 500                              |
| `POST`   | `/mobile/:module/:action`           | session, CSRF | no      | JSON body (passed to `mobileRequests`)  | `status` and body from `mobileRequests`                       | 401, 403, 500                                   |
| `WS`     | `/ws/:endpoint`                     | session       | no      | upgrade                                 | connection admitted by the endpoint's consumer                | see [close codes](#close-codes-and-error-enums) |
| `WS`     | `/ws/:endpoint/:arg`                | session       | no      | upgrade                                 | same, with `arg`                                              | see [close codes](#close-codes-and-error-enums) |
| `WS`     | `/ws-token/:token/:endpoint[/:arg]` | token in URL  | no      | upgrade                                 | **Deprecated**, same as `/ws/...`                             | see [close codes](#close-codes-and-error-enums) |

The `/file` routes exist only with `uploadDir`, the `/attachments` routes only with `minio`. `/health` and `/version` never call `getInfo`. `/version` reports `EndpointOptions.version`, which [`Platform`](#platform) does not set (`0.0.0`).

## Configuration reference

### PlatformConfig fields

Options of [`Platform`](#platform). Fields below `tabLimit` are forwarded to the [`Endpoint`](#endpoint) unchanged.

| Option                    | Type                                                                        | Default                                           | Description                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `appIndexPath`            | `URL`                                                                       | required                                          | Module whose default export is your [`AppIndex`](#appindex); imported in the main thread and in every app worker. |
| `agentIndexPath`          | `URL`                                                                       | required                                          | Module whose default export is your [`AgentIndex`](#agentindex); imported in every agent worker.                  |
| `authProvider`            | [`AuthProvider`](#authprovider)                                             | required                                          | Authentication back-end.                                                                                          |
| `instanceUserLimit`       | `number`                                                                    | required                                          | App instances per client runtime; at the limit the least recently touched instances are destroyed first.          |
| `maxInstances`            | `number`                                                                    | unlimited                                         | App instances across all clients; `createInstance` fails at the limit.                                            |
| `resourceLimits`          | `ResourceLimits` (`worker_threads`)                                         | `{ maxOldGenerationSizeMb: 128, stackSizeMb: 4 }` | Limits of every app worker (agent workers are not limited).                                                       |
| `workerRequestTimeoutMs`  | `number`                                                                    | `300000`                                          | How long the main thread waits for a worker's answer (ms); `0` waits forever.                                     |
| `tabLimit`                | `number`                                                                    | `12`                                              | Activities per app instance (see [the actor model](#the-actor-model)).                                            |
| `onCustomStream`          | `{ [name: string]: (client: ClientInfo, stream: Stream) => Promise<void> }` | none                                              | Handlers for `custom/<name>` streams on the `platform` endpoint.                                                  |
| `port`                    | `number`                                                                    | `3000`                                            | See [`EndpointOptions`](#endpointoptions-fields).                                                                 |
| `mount`                   | `string`                                                                    | `''`                                              | Route prefix.                                                                                                     |
| `cookieSecret`            | `string`                                                                    | random per process                                | Cookie signing secret.                                                                                            |
| `sessionTtl`              | `number` (seconds)                                                          | `86400`                                           | Session cookie lifetime.                                                                                          |
| `cookieOptions`           | `CookieOptions` (Express)                                                   | secure defaults                                   | Merged over the cookie defaults.                                                                                  |
| `uploadDir`               | `string`                                                                    | unset                                             | Enables `/file`.                                                                                                  |
| `maxUploadBytes`          | `number`                                                                    | `20971520`                                        | Upload size limit.                                                                                                |
| `uploadAllowlist`         | [`UploadAllowlist`](#uploadallowlist)                                       | unset                                             | Upload restrictions.                                                                                              |
| `minio`                   | [`MinioOptions`](#miniooptions)                                             | unset                                             | Enables `/attachments`.                                                                                           |
| `googleClientIds`         | `string[]`                                                                  | unset                                             | Enables `/gauth`.                                                                                                 |
| `allowedOrigins`          | `string[]`                                                                  | unset                                             | Browser origins allowed to open WebSockets.                                                                       |
| `authRateLimit`           | [`RateLimitConfig`](#ratelimitconfig) \| `boolean`                          | enabled                                           | Authentication rate limit.                                                                                        |
| `maxMessageBytes`         | `number`                                                                    | `16777216`                                        | WebSocket message size limit.                                                                                     |
| `heartbeatIntervalMs`     | `number`                                                                    | `30000`                                           | WebSocket ping interval.                                                                                          |
| `trustProxy`              | `boolean \| number \| string`                                               | unset                                             | Express `trust proxy`.                                                                                            |
| `maxConnectionsPerClient` | `number`                                                                    | `32`                                              | Connections per client runtime and endpoint.                                                                      |
| `maxPendingStreams`       | `number`                                                                    | `64`                                              | Unaccepted stream requests per connection.                                                                        |

### EndpointOptions fields

Options of [`Endpoint`](#endpoint).

| Option                    | Type                                               | Default                                                                              | Description                                                                                                                                         |
| ------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authProvider`            | [`AuthProvider`](#authprovider)                    | required                                                                             | Authentication back-end used by every route.                                                                                                        |
| `port`                    | `number`                                           | `3000`                                                                               | Port used by `open()`.                                                                                                                              |
| `mount`                   | `string`                                           | `''`                                                                                 | Route prefix; surrounding slashes are trimmed (`'api'` and `'/api/'` give `/api`).                                                                  |
| `version`                 | `string`                                           | `'0.0.0'`                                                                            | Returned by `GET /version`.                                                                                                                         |
| `cookieSecret`            | `string`                                           | random UUID, with a warning                                                          | Signs the `token` cookie. Sessions do not survive restarts without a fixed secret.                                                                  |
| `sessionTtl`              | `number` (seconds)                                 | `86400`                                                                              | Cookie `maxAge` is `sessionTtl * 1000`.                                                                                                             |
| `cookieOptions`           | `CookieOptions`                                    | `{ signed: true, httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge }` | Merged over the defaults; also used to clear the cookie. Keep `signed: true`.                                                                       |
| `uploadDir`               | `string`                                           | unset                                                                                | Enables the `/file` routes.                                                                                                                         |
| `maxUploadBytes`          | `number`                                           | `20971520` (20 MiB)                                                                  | Largest upload; larger files get 413. One file per request.                                                                                         |
| `uploadAllowlist`         | [`UploadAllowlist`](#uploadallowlist)              | unset                                                                                | Allowed extensions and MIME types (415 otherwise).                                                                                                  |
| `minio`                   | [`MinioOptions`](#miniooptions)                    | unset                                                                                | Enables the `/attachments` routes; incomplete options make the constructor throw.                                                                   |
| `googleClientIds`         | `string[]`                                         | unset                                                                                | OAuth client ids accepted by `/gauth` (`aud` or `azp`); unset or empty answers 503.                                                                 |
| `allowedOrigins`          | `string[]`                                         | unset                                                                                | Origins allowed to open WebSockets; case and trailing slashes are ignored, `'*'` allows all, no `Origin` is always allowed, unset refuses browsers. |
| `authRateLimit`           | [`RateLimitConfig`](#ratelimitconfig) \| `boolean` | enabled: 100 per 15 minutes                                                          | `false` disables the limiter, `true` uses the defaults.                                                                                             |
| `maxMessageBytes`         | `number`                                           | `16777216` (16 MiB)                                                                  | WebSocket `maxPayload`; larger messages close the socket with 1009.                                                                                 |
| `heartbeatIntervalMs`     | `number`                                           | `30000`                                                                              | Ping interval; sockets that miss a pong are terminated; `0` disables.                                                                               |
| `trustProxy`              | `boolean \| number \| string`                      | unset                                                                                | Express `trust proxy` setting.                                                                                                                      |
| `maxConnectionsPerClient` | `number`                                           | `32`                                                                                 | Distinct `arg` connections per client runtime and endpoint name; more are closed with 1008. `0` disables.                                           |
| `maxPendingStreams`       | `number`                                           | `64`                                                                                 | Stream requests per connection waiting to be accepted. `0` disables.                                                                                |

### EndpointControllerOptions fields

Limits of one [`EndpointController`](#endpointcontroller); [`Endpoint`](#endpoint) fills them from its options.

| Option                    | Type     | Default | Description                                                      |
| ------------------------- | -------- | ------- | ---------------------------------------------------------------- |
| `maxConnectionsPerClient` | `number` | `32`    | Distinct connections one client may hold; `0` disables the cap.  |
| `maxPendingStreams`       | `number` | `64`    | Unaccepted stream requests per connection; `0` disables the cap. |

### MinioOptions fields

Options of [`MinioService`](#minioservice) and `EndpointOptions.minio` ([`MinioOptions`](#miniooptions) extends [`MinioClient`](#minioclient)).

| Option       | Type      | Default                           | Description                                              |
| ------------ | --------- | --------------------------------- | -------------------------------------------------------- |
| `endPoint`   | `string`  | required                          | Host name or IP, without protocol or port.               |
| `port`       | `number`  | required                          | Port, for example `9000`.                                |
| `accessKey`  | `string`  | required                          | Access key id.                                           |
| `secretKey`  | `string`  | required                          | Secret access key.                                       |
| `bucketName` | `string`  | required                          | Bucket for all objects; created on first use if missing. |
| `useSSL`     | `boolean` | `true` (`minio` client default)   | Talk to the server over HTTPS.                           |
| `region`     | `string`  | `'us-east-1'` for bucket creation | Region of the client and of a new bucket.                |
| `expiry`     | `number`  | `900` (15 minutes)                | Validity of presigned URLs, in seconds.                  |

### RateLimitConfig fields

Settings of the authentication limiter ([`RateLimitConfig`](#ratelimitconfig)). The object is also spread into the `express-rate-limit` options, so other options of that package can be overridden too.

| Option                   | Type                                      | Default                                                                                                     | Description                                        |
| ------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `windowMs`               | `number`                                  | `900000` (15 minutes)                                                                                       | Counting window in milliseconds.                   |
| `limit`                  | `number`                                  | `100`                                                                                                       | Requests per key and window.                       |
| `max`                    | `number`                                  | `100`                                                                                                       | Older name of `limit`, used when `limit` is unset. |
| `message`                | `any`                                     | `{ message: 'Too many authentication attempts, please try again later.', error: 'Too many requests' }`      | Body of the 429 response.                          |
| `keyGenerator`           | `(req, res) => string \| Promise<string>` | client IP, plus `:<account>` when the body has `accountName`, `username`, `email`, `account` or `old_token` | Counter key.                                       |
| `skipSuccessfulRequests` | `boolean`                                 | `false`                                                                                                     | Do not count responses below 400.                  |

### UploadAllowlist fields

| Option       | Type       | Default        | Description                                                                                 |
| ------------ | ---------- | -------------- | ------------------------------------------------------------------------------------------- |
| `extensions` | `string[]` | no restriction | Allowed extensions of the sanitized file name, case-insensitive, leading dot optional.      |
| `mimetypes`  | `string[]` | no restriction | Allowed MIME types as declared by the client, case-insensitive, exact match (no wildcards). |

## API reference

Every public symbol of the package, grouped by module. Signatures are simplified; the TSDoc comments in the sources carry the full details.

### Platform and server

#### Platform

Source: [src/Platform.ts](src/Platform.ts)

```ts
declare class Platform {
    constructor(config: PlatformConfig);
    readonly endpoint: Endpoint;
    readonly instances: Map<string, Map<string, Instance>>; // runtimeId -> instance id -> instance
    get totalInstances(): number;
    start(): Promise<void>;
    stop(): void;
    listUserInstances(runtimeId: string): Promise<UserInstance[]>;
    listUserApps(userId: string): Promise<Result<AppListing[], void>>;
    processCustomStreams(clientInfo: ClientInfo, endpointSocket: Socket): void;
    processUserInfo(clientInfo: ClientInfo, endpointSocket: Socket): void;
}
```

The application server. The constructor creates the [`Endpoint`](#endpoint) and the agent controller and starts the accept loops of the `platform`, `instance` and `agent` endpoints (see [Endpoints and streams](#endpoints-and-streams)); it throws when `minio` is incomplete. `start()` imports the app index and starts listening (it rejects when the index cannot be loaded). `stop()` destroys every instance and agent worker and closes the endpoint.

- `endpoint`: add Express routes or your own WebSocket endpoints here.
- `instances` / `totalInstances`: running instances, for monitoring (do not modify the map).
- `listUserInstances(runtimeId)` and `listUserApps(userId)`: what the `listInstances` and `listApps` streams return.
- `processCustomStreams` and `processUserInfo`: called for every accepted `platform` connection; you do not call them yourself.

See the [Quick start](#4-server) for an example.

#### PlatformConfig

Source: [src/Platform.ts](src/Platform.ts)

The constructor options of [`Platform`](#platform); all fields are listed under [PlatformConfig fields](#platformconfig-fields). The interface is not re-exported by name from the package entry point; use `ConstructorParameters<typeof Platform>[0]` to refer to it.

#### UserInstance

Source: [src/Platform.ts](src/Platform.ts)

```ts
type UserInstance = { id: string; appName: string; appTitle: string; activityTitle?: string; profile: string | null; touched: number };
```

One running app instance as listed on the `listInstances` stream: its id (connect to `/ws/instance/<id>`), app name and title, the title of the active activity, the launch profile and the time of the last client connection (ms).

#### Endpoint

Source: [src/server/Endpoint.ts](src/server/Endpoint.ts)

```ts
declare class Endpoint {
    constructor(options: EndpointOptions);
    readonly express: expressWs.Application;
    declare(name: string): void;
    acquire(name: string): Promise<Result<ConnectRequest, void>>;
    open(): void;
    close(): void;
}
```

HTTP and WebSocket server built on Express 5 and `express-ws`. The constructor registers the middleware (cookie parser, JSON body parser, [`logMiddleware`](#logmiddleware), session lookup) and every route of the [route reference](#http-and-websocket-route-reference); it throws when `minio` is incomplete.

- `express`: the Express app; routes you add run after the session lookup (`req.info`, `req.token`).
- `declare(name)`: registers a WebSocket endpoint name; connections to undeclared names are closed with 4404. `acquire` declares implicitly.
- `acquire(name)`: resolves with the next [`ConnectRequest`](#connectrequest) for `name`. Only one call per name may be pending; a second one ends the first with `Err`.
- `open()`: listens on `port` (does nothing when already open; a busy port surfaces as an uncaught `error` event).
- `close()`: terminates all WebSockets and stops listening; the endpoint cannot be reopened.

```ts
import { Endpoint, loop, LoopResult } from '@araminix/platform';

const endpoint = new Endpoint({ authProvider: new MyAuthProvider(), mount: '/api', cookieSecret: process.env.COOKIE_SECRET });
loop(async () => {
    const next = await endpoint.acquire('echo');
    if (next.isErr()) return LoopResult.Stop;
    const socket = next.unwrap().accept();
    if (socket.isOk()) serveEcho(socket.unwrap());
    return LoopResult.Cont;
});
endpoint.open();
```

#### EndpointOptions

Source: [src/server/Endpoint.ts](src/server/Endpoint.ts)

Options of [`Endpoint`](#endpoint); see [EndpointOptions fields](#endpointoptions-fields).

#### EndpointController

Source: [src/server/EndpointController.ts](src/server/EndpointController.ts)

```ts
declare class EndpointController {
    constructor(options?: EndpointControllerOptions);
    acquire(): Promise<Result<ConnectRequest, void>>;
    connect(ws: WebSocket, token: string, info: ClientInfo, arg: string): Promise<void>;
    deauthUser<INFO extends ClientInfo>(info: INFO, token: string): void;
}
```

The admission queue of one endpoint name, created by [`Endpoint.declare`](#endpoint). Connections are identified by `clientType/runtimeId/arg`: a new identity is queued as a [`ConnectRequest`](#connectrequest), a known one (a reconnect within the lib's 5-minute resume window) replaces the previous WebSocket and keeps its streams. New identities beyond `maxConnectionsPerClient` are closed with 1008. `deauthUser` destroys the client's connections opened with a token (used on logout). Applications normally use [`Endpoint.acquire`](#endpoint) instead.

#### EndpointControllerOptions

Source: [src/server/EndpointController.ts](src/server/EndpointController.ts)

Limits of an [`EndpointController`](#endpointcontroller); see [EndpointControllerOptions fields](#endpointcontrolleroptions-fields).

#### ConnectRequest

Source: [src/server/ConnectRequest.ts](src/server/ConnectRequest.ts)

```ts
declare class ConnectRequest {
    readonly info: ClientInfo;
    readonly arg: string;
    accept(): Result<Socket, AcceptError>;
    deny(): Result<void, AcceptError>;
}
```

A client waiting to be admitted to an endpoint. Decide exactly once: `accept()` returns the multiplexed `Socket` of `@araminix/lib`; `deny()` closes the client's WebSocket with 4403. `arg` is the optional `:arg` path segment (`''` when absent). See [Custom streams and endpoints](#custom-streams-and-endpoints).

#### AcceptError

Source: [src/server/ConnectRequest.ts](src/server/ConnectRequest.ts)

```ts
enum AcceptError {
    Write = 'Write',
    Staled = 'Staled',
}
```

`Write`: the accept message could not be sent (the client is gone). `Staled`: the [`ConnectRequest`](#connectrequest) was already decided.

#### UploadAllowlist

Source: [src/server/Endpoint.ts](src/server/Endpoint.ts)

```ts
interface UploadAllowlist {
    extensions?: string[];
    mimetypes?: string[];
}
```

Restricts `POST /file`; see [UploadAllowlist fields](#uploadallowlist-fields).

#### RateLimitConfig

Source: [src/server/Endpoint.ts](src/server/Endpoint.ts)

```ts
interface RateLimitConfig {
    windowMs?: number;
    max?: number;
    limit?: number;
    message?: any;
    keyGenerator?: (req: Request, res: Response) => string | Promise<string>;
    skipSuccessfulRequests?: boolean;
}
```

Settings of the authentication rate limiter; see [RateLimitConfig fields](#ratelimitconfig-fields).

#### ServerDriver

Source: [src/server/Endpoint.ts](src/server/Endpoint.ts)

```ts
interface ServerDriver {
    getUserId: (token: string) => Promise<Result<string, unknown>>;
}
```

Not used by the platform itself; kept for compatibility with older integrations.

### Authentication and identity

#### AuthProvider

Source: [src/server/AuthProvider.ts](src/server/AuthProvider.ts)

```ts
declare abstract class AuthProvider {
    getInfo<TClient extends ClientInfo = ClientInfo, TErr = unknown>(token: string): Promise<Result<TClient, TErr>>;
    auth<TAuthData = unknown, TErr = unknown>(data: TAuthData): Promise<Result<string | { twoFactorCode: string; accountName: string }, TErr>>;
    googleAuth<TErr = unknown>(data: GoogleDataType): Promise<Result<string | { twoFactorCode: string; accountName: string }, TErr>>;
    destroy(token: string): Promise<void>;
    refreshToken<TErr = unknown>(old_token: string): Promise<Result<string, TErr>>;
    request2FA<TErr = unknown>(userId: string): Promise<Result<string, TErr>>;
    enable2FA<TErr = unknown>(userId: string, secret: string, code: string): Promise<Result<boolean, TErr>>;
    verify2FA<TErr = unknown>(accountName: string, code: string, uuid: string): Promise<Result<string | boolean, TErr>>;
    disable2FA<TErr = unknown>(userId: string, code?: string): Promise<Result<boolean, TErr>>;
    requestUploadUrl<TErr = unknown>(attachmentId: string, fileName: string, mimeType: string): Promise<Result<string, TErr>>;
    requestDownloadUrl<TErr = unknown>(attachmentId: string, fileName: string): Promise<Result<string, TErr>>;
    mobileRequests<MODULE extends string = string, ACTION extends string = string, R = unknown, E = unknown>(
        data: MobileRequestType<MODULE, ACTION>,
    ): Promise<MobileResponseType<R, E>>;
}
```

Your authentication back-end (all methods are abstract).

| Method               | Called by                                         | Contract                                                                                                    |
| -------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `getInfo`            | every authenticated request and WebSocket upgrade | Resolve a token to a [`ClientInfo`](#clientinfo), or `Err` for unknown tokens.                              |
| `auth`               | `POST /auth`                                      | `Ok(token)` logs in (cookie), `Ok({ twoFactorCode, accountName })` asks for 2FA, `Err(code)` refuses (401). |
| `googleAuth`         | `POST /gauth`                                     | Same as `auth`, for a verified Google profile.                                                              |
| `destroy`            | `DELETE /auth`                                    | Invalidate the session; its WebSockets are closed afterwards.                                               |
| `refreshToken`       | `PUT /auth/refresh`                               | Validate `old_token` yourself and return a new token.                                                       |
| `request2FA`         | `POST /2fa/request`                               | Issue and store a pending TOTP secret; return its provisioning URL.                                         |
| `enable2FA`          | `POST /2fa/enable`                                | Must check that `secret` is the issued pending secret and that `code` is valid.                             |
| `verify2FA`          | `POST /2fa/verify`                                | Complete a 2FA login: `Ok(token)` sets the cookie, `Ok(boolean)` answers `{ success }`.                     |
| `disable2FA`         | `DELETE /2fa/disable`                             | Must require a valid `code`; the endpoint does not check it.                                                |
| `requestUploadUrl`   | not called by built-in routes                     | For your own use.                                                                                           |
| `requestDownloadUrl` | not called by built-in routes                     | For your own use.                                                                                           |
| `mobileRequests`     | `POST /mobile/:module/:action`                    | Return `{ status, ... }`; the object is the response body.                                                  |

String and number errors are sent to clients as `{ error }`; other error values become `'Unauthorized'`. See [Writing an AuthProvider](#writing-an-authprovider) and the [Quick start](#1-authentication-provider).

#### ClientInfo

Source: [src/server/AuthProvider.ts](src/server/AuthProvider.ts)

```ts
declare abstract class ClientInfo {
    abstract clientType: ClientType;
    abstract id: string;
    abstract runtimeId: string;
}
```

The identity of an authenticated client. `id` is the user or agent id (the `userId` of app instances and the owner prefix of attachments); `runtimeId` identifies one client runtime (login session or device) and keys its connections and instances. Use [`UserInfo`](#userinfo) or [`AgentInfo`](#agentinfo), or a subclass with extra fields.

#### UserInfo

Source: [src/server/AuthProvider.ts](src/server/AuthProvider.ts)

```ts
declare class UserInfo extends ClientInfo {
    constructor(
        id: string,
        username: string,
        name: string,
        runtimeId: string,
        email: string,
        units: { _key: string; name: string; code: string }[],
        activeUnit: { _key: string; name: string; code: string },
        picture?: FileInfo,
        language?: string,
        employeeKey?: string,
        settings?: { notifications: SettingNotification; widgets: string[]; two_factor: Omit<SettingTwoFactor, 'secret'> },
    );
    readonly clientType: ClientType.User;
}
```

A person. All constructor arguments become read-only fields. `settings.two_factor` is reduced to `{ enabled }`, so a secret or code from your database never reaches a client.

```ts
return new Ok(new UserInfo(user.id, user.username, user.name, sessionId, user.email, user.units, user.units[0], undefined, user.language));
```

#### AgentInfo

Source: [src/server/AuthProvider.ts](src/server/AuthProvider.ts)

```ts
declare class AgentInfo extends ClientInfo {
    constructor(id: string, agentType: string);
    readonly clientType: ClientType.Agent;
}
```

A machine agent. `agentType` must name an [`AgentFactory`](#agentfactory) property of your [`AgentIndex`](#agentindex); `runtimeId` equals `id`.

```ts
return new Ok(new AgentInfo('printer-1', 'printer'));
```

#### ClientType

Source: [src/server/AuthProvider.ts](src/server/AuthProvider.ts)

```ts
enum ClientType {
    Agent = 'Agent',
    User = 'User',
}
```

`User` clients may use the `platform` and `instance` endpoints, `Agent` clients the `agent` endpoint.

#### GoogleData

Source: [src/server/AuthProvider.ts](src/server/AuthProvider.ts)

```ts
const GoogleData: t.TypeC<{ email: t.StringC; given_name: t.StringC; family_name: t.StringC; name: t.StringC; picture: t.StringC }>;
```

io-ts codec of the Google profile passed to `googleAuth`. A verified profile that does not match it is answered with 500.

#### GoogleDataType

Source: [src/server/AuthProvider.ts](src/server/AuthProvider.ts)

```ts
type GoogleDataType = { email: string; given_name: string; family_name: string; name: string; picture: string };
```

The static type of [`GoogleData`](#googledata).

#### MobileRequestType

Source: [src/server/AuthProvider.ts](src/server/AuthProvider.ts)

```ts
type MobileRequestType<MODULE extends string = string, ACTION extends string = string, TData = unknown> = { module: MODULE; action: ACTION; userId: string; data: TData };
```

The request of `POST /mobile/:module/:action`: the two path segments, the caller's user id and the JSON body.

#### MobileResponseType

Source: [src/server/AuthProvider.ts](src/server/AuthProvider.ts)

```ts
type MobileResponseType<R = unknown, E = unknown> = { status: number; message?: string; error?: E; result?: R };
```

The answer of [`mobileRequests`](#authprovider): `status` is the HTTP status, the whole object is the JSON body; non-200 answers are logged as errors.

#### UserSetting

Source: [src/server/AuthProvider.ts](src/server/AuthProvider.ts)

```ts
type UserSetting = {
    notifications: SettingNotification;
    widgets: string[];
    two_factor: SettingTwoFactor;
    table_preferences?: SettingTablePreference;
    card_preferences?: SettingCardPreference;
};
```

A full settings record as stored by your application. Only part of it (without the 2FA secret) belongs into [`UserInfo`](#userinfo).

#### SettingTwoFactor

Source: [src/server/AuthProvider.ts](src/server/AuthProvider.ts)

```ts
type SettingTwoFactor = { enabled: boolean; code?: string | null; secret?: string | null };
```

2FA state. `code` and `secret` are server-side only and are removed before anything reaches a client.

#### SettingNotification

Source: [src/server/AuthProvider.ts](src/server/AuthProvider.ts)

```ts
interface SettingNotification {
    enabled: boolean;
    channels: Array<'app' | 'sms' | 'push' | 'email'>;
    default_channel: 'app' | 'sms' | 'push' | 'email';
    push?: { telegram_id: string };
}
```

Notification preferences, passed through unchanged.

#### SettingTablePreference

Source: [src/server/AuthProvider.ts](src/server/AuthProvider.ts)

```ts
interface SettingTablePreference {
    [tableId: string]: { collapsed: 'horizontal' | 'vertical' | null | undefined; columns: string[] };
}
```

Per-table layout preferences, passed through unchanged.

#### SettingCardPreference

Source: [src/server/AuthProvider.ts](src/server/AuthProvider.ts)

```ts
interface SettingCardPreference {
    [cardId: string]: { collapsed: 'horizontal' | 'vertical' | null | undefined };
}
```

Per-card layout preferences, passed through unchanged.

### App model

#### AppIndex

Source: [src/lib/d.ts](src/lib/d.ts)

```ts
declare abstract class AppIndex<AGENT_INDEX extends AgentIndex = AgentIndex> {
    constructor();
    protected i18n: I18nService<any, any>;
    abstract agents: AGENT_INDEX;
    get appList(): Array<{ appName: string; app: App<any, any> }>;
    userApps<TErr = unknown>(userId: string): Promise<Result<AppListing[], TErr>>;
    protected abstract _getUserApps(userId: string): Promise<Result<Array<{ name: string; profiles: Array<string | null>; title: string }>, unknown>>;
}
```

The root of your application and the default export of `appIndexPath` (constructed with no arguments, once in the main thread and once per app worker). Own properties holding an [`App`](#app) with a `main` page are apps, named after the property; `appList` discovers them (and names the agent factories of `agents`). `_getUserApps(userId)` returns the apps a user may open with their title and profiles (`[null]` for no profile); it runs for every `listApps` and `createInstance` request. `userApps` merges it with the declared apps into [`AppListing`](#applisting)s. `i18n` is declared for your use and never set by the platform.

```ts
export default class MyApps extends AppIndex<MyAgents> {
    agents = new MyAgents();
    tasks = new TasksApp(this);

    protected async _getUserApps(userId: string) {
        return new Ok(await db.appsOfUser(userId)); // [{ name: 'tasks', title: 'Tasks', profiles: [null] }]
    }
}
```

#### AppEntry

Source: [src/lib/d.ts](src/lib/d.ts)

```ts
type AppEntry = {
    name: string;
    title: string;
    category: string;
    hidden: boolean;
    widget: boolean;
    multiInstance: boolean;
    description: string;
    profiles: Array<string | null>;
};
```

One app in a listing. `title` and `profiles` come from `_getUserApps`; the other fields from the [`App`](#app).

#### AppListing

Source: [src/lib/d.ts](src/lib/d.ts)

```ts
type AppListing = { category: string; apps: AppEntry[] };
```

The apps of one category, as returned by the `listApps` stream.

#### App

Source: [src/lib/d.ts](src/lib/d.ts)

```ts
declare abstract class App<SETTINGS = unknown, APP_INDEX extends AppIndex<any> = AppIndex<any>> {
    constructor(index: APP_INDEX);
    readonly index: APP_INDEX;
    name: string; // set from the property name
    abstract readonly title: string | (() => Promise<string>);
    description: string; // ''
    category: string; // 'Other'
    hidden: boolean; // false
    widget: boolean; // false
    multiInstance: boolean; // false
    abstract main: MainPage<any, App<SETTINGS, APP_INDEX>> | void;
    abstract setupWizard: SetupWizard<SETTINGS, App<SETTINGS, APP_INDEX>> | void;
    protected get profile(): string | null;
    dispatch(action: string, args: unknown): (void | MainPage<any, App<SETTINGS, APP_INDEX>>)[];
    getSettings<TErr = unknown>(): Promise<Result<SETTINGS, TErr>>;
    getUnits<TErr = unknown>(): Promise<Result<string[], TErr>>;
    protected abstract _getSettings(userId: string, profile: string | null): Promise<Result<SETTINGS, unknown>>;
    protected abstract _getUnits(userId: string): Promise<Result<string[], unknown>>;
}
```

One application. `title` becomes the instance's `appTitle`; `description`, `category`, `hidden`, `widget` and `multiInstance` are passed to the front-end in listings (the platform does not enforce `hidden` or `multiInstance`). `main` is the entry page; apps without one are ignored. `setupWizard` is optional and never started automatically. `profile` is the launch profile inside the app's worker. `getSettings()` and `getUnits()` call your `_getSettings(userId, profile)` and `_getUnits(userId)` for the running instance. `dispatch` is a routing hook for subclasses that the runtime does not call. Example in the [Quick start](#3-apps).

#### Activity

Source: [src/lib/d.ts](src/lib/d.ts)

```ts
declare abstract class Activity<CONTEXT = unknown> {
    protected ctx: CONTEXT;
    abstract title(ctx: CONTEXT): Promise<string> | string;
    protected get userId(): string;
    protected beforeRender(): Promise<Actor> | Actor;
    protected afterWake(): (() => void) | void;
    protected abstract render(): Promise<void>;
    protected $nothing(): Nothing;
    protected $refresh(ctx: CONTEXT): Refresh<CONTEXT>;
    protected $reload(): Reload;
    push<TData = unknown>(data: TData): Promise<AppResult>;
    trigger(actor: Actor): Promise<AppResult>;
}
```

The base of [`Page`](#page) and [`Stage`](#stage). Lifecycle: `title(ctx)`, `beforeRender()`, `render()`, `afterWake()` (see [Apps, pages and fragments](#apps-pages-and-fragments)).

- `ctx`: the context the activity was opened (or last refreshed) with.
- `beforeRender()`: return `$nothing()` (default) to continue or another actor to redirect.
- `afterWake()`: start timers; return a cleanup. It runs outside the app lock, so timers started here queue for the lock.
- `push(data)`: send data on the `push` stream; `Ok` once the client closed the stream.
- `trigger(actor)`: apply an actor from a timer or callback, under the app lock; most actors return `Err(AppError.NonActive)` when the activity is not active.
- `_init()` / `_init2()` (not shown) are internal hooks of the runtime.

#### Page

Source: [src/lib/d.ts](src/lib/d.ts)

```ts
declare abstract class Page<CONTEXT = unknown, APP extends App<any, any> = App<any, any>> extends Activity<CONTEXT> {
    constructor(app: APP);
    app: APP;
    protected get profile(): string | null;
    $open(ctx: CONTEXT): OpenPage<CONTEXT>;
    $next(ctx: CONTEXT): NextPage<CONTEXT>;
    $replace(ctx: CONTEXT): ReplacePage<CONTEXT>;
    $pop(ctx: CONTEXT): PopPage<CONTEXT>;
    protected $close(): Close<CONTEXT>;
    protected $destroy(): Destroy;
}
```

A screen of an [`App`](#app). Declare templates as app properties and navigate by calling the `$` helpers on the **target** page (see [The actor model](#the-actor-model)). Subclasses must keep the `(app)` constructor: the runtime creates fresh instances with `new YourPage(this.app)`.

```ts
class TaskPage extends Page<{ id: string }, TasksApp> {
    title(ctx: { id: string }) {
        return `Task ${ctx.id}`;
    }

    protected async render(): Promise<void> {
        panel(() => {
            new TaskDetails({ id: this.ctx.id });
            new Button({ label: 'Edit', onClick: () => this.app.editTask.$next({ id: this.ctx.id }) });
            new Button({ label: 'Close', onClick: () => this.$close() });
        });
    }
}
```

#### MainPage

Source: [src/lib/d.ts](src/lib/d.ts)

```ts
declare abstract class MainPage<CONTEXT = unknown, APP extends App<any, any> = App<any, any>> extends Page<CONTEXT | void, APP> {}
```

The entry page of an app ([`App.main`](#app)). It is opened with an `undefined` context when an instance starts. Example in the [Quick start](#3-apps).

#### Wizard

Source: [src/lib/d.ts](src/lib/d.ts)

```ts
declare abstract class Wizard<CONTEXT = unknown, OUTPUT = unknown, PAGE extends Page<any, any> = Page<any, any>> {
    constructor(page: PAGE);
    readonly page: PAGE;
    protected abstract main: Stage<CONTEXT, OUTPUT, Wizard<CONTEXT, OUTPUT, PAGE>>;
    abstract title(ctx: CONTEXT): Promise<string> | string;
    $detached<R = unknown>(ctx: CONTEXT, on?: (result: Result<OUTPUT, unknown> | undefined) => Promise<R> | R): WizardDetached<CONTEXT, OUTPUT, this, R>;
    $attached(ctx: CONTEXT, on?: (result: Result<OUTPUT, unknown> | undefined) => Promise<Actor> | Actor): WizardAttached<CONTEXT, OUTPUT, this>;
    $pop(ctx: CONTEXT, on?: (result: Result<OUTPUT, unknown> | undefined) => Promise<Actor> | Actor): WizardPop<CONTEXT, OUTPUT, this>;
}
```

A multi-step flow of [`Stage`](#stage)s producing an `OUTPUT`. Declare it as a property of the page that starts it; `main` is the first stage and `title` is the default stage title. See [Wizards and stages](#wizards-and-stages).

#### SetupWizard

Source: [src/lib/d.ts](src/lib/d.ts)

```ts
declare abstract class SetupWizard<SETTINGS = unknown, APP extends App<SETTINGS, any> = App<SETTINGS, any>> extends Wizard<SETTINGS | null, SETTINGS, PhantomPage<APP>> {
    constructor(app: APP);
    abstract main: Stage<SETTINGS | null, SETTINGS, SetupWizard<SETTINGS, APP>>;
    title(ctx: SETTINGS | null): Promise<string>; // "Setup <app title> "
}
```

A [`Wizard`](#wizard) that edits an app's settings, constructed with the app and owned by a [`PhantomPage`](#phantompage). Assign it to [`App.setupWizard`](#app) and start it yourself.

```ts
class TasksSetup extends SetupWizard<TaskSettings, TasksApp> {
    main = new TasksSetupStage(this);
}
// in TasksApp: setupWizard = new TasksSetup(this);
```

#### Stage

Source: [src/lib/d.ts](src/lib/d.ts)

```ts
declare abstract class Stage<CONTEXT = unknown, OUTPUT = unknown, WIZARD extends Wizard<any, OUTPUT, any> = Wizard<any, OUTPUT, any>> extends Activity<CONTEXT> {
    constructor(wizard: WIZARD);
    readonly wizard: WIZARD;
    get index(): any; // the app index
    title(ctx: CONTEXT): Promise<string>; // the wizard's title by default
    $next(ctx: CONTEXT): WizardNext<CONTEXT, OUTPUT, WIZARD>;
    $nextReplace(ctx: CONTEXT): WizardNextReplace<CONTEXT, OUTPUT, WIZARD>;
    protected $ok(v: OUTPUT): WizardDone<OUTPUT, unknown>;
    protected $err<E = unknown>(e: E): WizardDone<OUTPUT, E>;
    protected $cancel(): WizardDone<OUTPUT, unknown>;
    protected $back(): Prev<CONTEXT>;
    protected $destroy(): Destroy;
}
```

One step of a [`Wizard`](#wizard). `$next` and `$nextReplace` are called on the target stage (of the same wizard); `$ok`, `$err` and `$cancel` finish the wizard; `$back` returns to the previous stage. Subclasses must keep the `(wizard)` constructor. Page actors (`$next`, `$replace` of pages) are rejected inside a wizard. See [Wizards and stages](#wizards-and-stages).

#### PhantomAgentIndex

Source: [src/lib/d.ts](src/lib/d.ts)

```ts
declare class PhantomAgentIndex extends AgentIndex {}
```

An empty [`AgentIndex`](#agentindex), used by [`PhantomAppIndex`](#phantomappindex).

#### PhantomAppIndex

Source: [src/lib/d.ts](src/lib/d.ts)

```ts
declare class PhantomAppIndex extends AppIndex<PhantomAgentIndex> {}
```

A placeholder [`AppIndex`](#appindex) that offers no apps (`_getUserApps` fails).

#### PhantomApp

Source: [src/lib/d.ts](src/lib/d.ts)

```ts
declare class PhantomApp extends App<void, PhantomAppIndex> {}
```

A placeholder [`App`](#app) without pages, title `''`.

#### PhantomPage

Source: [src/lib/d.ts](src/lib/d.ts)

```ts
declare class PhantomPage<APP extends App<any, any> = App<any, any>> extends Page<any, APP> {}
```

A page that renders nothing. [`SetupWizard`](#setupwizard) uses one as its owner page.

#### phantomApp (constant)

Source: [src/lib/d.ts](src/lib/d.ts)

```ts
const phantomApp: PhantomApp;
```

A shared [`PhantomApp`](#phantomapp) instance.

#### phantomPage (constant)

Source: [src/lib/d.ts](src/lib/d.ts)

```ts
const phantomPage: PhantomPage<PhantomApp>;
```

A shared [`PhantomPage`](#phantompage) of [`phantomApp`](#phantomapp-constant).

### UI builder

#### Fragment

Source: [src/builder/Fragment.ts](src/builder/Fragment.ts)

```ts
declare abstract class Fragment<I extends { styles?: string[] | undefined }, O = unknown> {
    static readonly typeName?: string;
    constructor(input: I);
    readonly input: I;
    readonly id: string;
    abstract load(): Promise<O> | O;
    protected afterLoad(): (() => void) | void;
    protected onAction<TActionData = unknown>(name: string, on: (data: TActionData) => Promise<Actor> | Actor): void;
    protected onQuery<TQueryData = unknown, TQueryResponse = unknown>(name: string, on: (data: TQueryData) => Promise<TQueryResponse> | TQueryResponse): void;
    protected resetActions(): void;
    protected resetRequests(): void;
    protected $reload(): ReloadFragment;
    protected $update<TData = unknown>(data: TData): UpdateFragment<TData>;
    protected $patch<TData = unknown>(data: TData): UpdateFragment<TData>;
    protected $nothing(): Nothing;
    push<TData = unknown>(data: TData): Promise<AppResult>;
    trigger(actor: Actor): Promise<AppResult>;
}
```

The server half of a front-end component. Construct it inside `render()` (otherwise the constructor throws a `TypeError`); it registers itself in the current panel.

- `typeName`: the component type sent to the client (falls back to the class name, which minifiers rename).
- `id`: random id; the client addresses actions, queries and updates with it.
- `load()`: produces the component's data; runs when the fragment applies `$reload()`, not during `render()`.
- `afterLoad()`: runs after every `load()`; its cleanup runs before the next load and when the activity is suspended.
- `onAction(name, handler)`: handles `{ fragmentId, name, data }` from the `action` stream and returns an [`Actor`](#actor).
- `onQuery(name, handler)`: answers `{ fragmentId, name, data }` from the `query` stream with a value.
- `$update` / `$patch` / `$reload` / `$nothing`: fragment actors ([`UpdateFragment`](#updatefragment), [`ReloadFragment`](#reloadfragment), [`Nothing`](#nothing)).
- `push` / `trigger`: same as on [`Activity`](#activity).

Example in the [Quick start](#3-apps) and in [Apps, pages and fragments](#apps-pages-and-fragments).

#### panel()

Source: [src/builder/Panel.ts](src/builder/Panel.ts)

```ts
declare function panel(init: { render: () => Promise<void>; styles?: string[] | void } | (() => Promise<void>)): Promise<void>;
declare function panel(init: { render: () => void; styles?: string[] | void } | (() => void)): void;
```

Creates a layout container inside the panel being rendered (or at the root of the activity) and runs `render` to fill it. With an async `render` it returns a promise; await it before creating siblings. Errors thrown by `render` propagate. Call it only from an activity's `render()`. See [Panels and layout](#panels-and-layout).

### Actors

All actor classes live in [src/lib/actors.ts](src/lib/actors.ts). You normally create them with the `$` helpers rather than with `new`.

#### Actor

```ts
interface Actor {}
```

The marker interface of everything an action, `beforeRender` or wizard callback may return. See [The actor model](#the-actor-model).

#### OpenPage

```ts
declare class OpenPage<C = unknown, P extends Page<C, any> = Page<C, any>> implements Actor {
    constructor(page: P, ctx: C);
    readonly page: P;
    readonly ctx: C;
}
```

Created by [`page.$open(ctx)`](#page): opens the page as a new activity (tab), subject to `tabLimit`.

#### NextPage

```ts
declare class NextPage<C = unknown, P extends Page<C, any> = Page<C, any>> implements Actor {
    constructor(page: P, ctx: C);
    readonly page: P;
    readonly ctx: C;
}
```

Created by [`page.$next(ctx)`](#page): shows the page in the current activity and keeps the current page for "back" (`hasPrev: true`).

#### ReplacePage

```ts
declare class ReplacePage<C = unknown, P extends Page<C, any> = Page<C, any>> implements Actor {
    constructor(page: P, ctx: C);
    readonly page: P;
    readonly ctx: C;
}
```

Created by [`page.$replace(ctx)`](#page): replaces the current page without "back".

#### PopPage

```ts
declare class PopPage<C = unknown, P extends Page<C, any> = Page<C, any>> implements Actor {
    constructor(page: P, ctx: C);
    readonly page: P;
    readonly ctx: C;
}
```

Created by [`page.$pop(ctx)`](#page): shows the page as a pop-up (`isPop: true`); when the user closes it, the opener comes back.

#### Close

```ts
declare class Close<C = unknown> implements Actor {
    constructor(activity: Activity<C>);
    readonly activity: Activity<C>;
}
```

Created by `this.$close()` on a [`Page`](#page): closes this activity; closing the last activity ends the instance. In a stage it cancels the wizard.

#### Prev

```ts
declare class Prev<C = unknown> implements Actor {
    constructor(activity: Activity<C>);
    readonly activity: Activity<C>;
}
```

Created by `this.$back()` on a [`Stage`](#stage): previous stage, or cancel on the first stage of an attached or pop-up wizard (rejected on the first stage of a detached wizard).

#### Destroy

```ts
declare class Destroy<SETTINGS = unknown> implements Actor {
    constructor(app: App<SETTINGS, any>);
    readonly app: App<SETTINGS, any>;
}
```

Created by `this.$destroy()`: ends the whole app instance (worker stopped, instance removed, client socket closed).

#### Refresh

```ts
declare class Refresh<C = unknown> implements Actor {
    constructor(activity: Activity<C>, ctx: C);
    readonly activity: Activity<C>;
    readonly ctx: C;
}
```

Created by `this.$refresh(ctx)` on an [`Activity`](#activity): rebuilds that activity with a new context (cleanup, `title`, `beforeRender`, `render`, `afterWake`).

#### Reload

```ts
declare class Reload implements Actor {}
```

Created by `this.$reload()` on an [`Activity`](#activity): re-renders the active activity with its current context (cleanup, `render`, `afterWake`).

#### Nothing

```ts
declare class Nothing implements Actor {}
```

Created by `$nothing()`: no change. From `beforeRender()` it lets rendering continue. Returned from a fragment action it wakes the active activity again (see the note in [The actor model](#the-actor-model)).

#### WizardDetached

```ts
declare class WizardDetached<C = unknown, O = unknown, W extends Wizard<C, O, any> = Wizard<C, O, any>, R = unknown> implements Actor {
    constructor(mainStage: Stage<C, O, W>, ctx: C, on?: (result: Result<O, unknown> | undefined) => Promise<R> | R);
    readonly mainStage: Stage<C, O, W>;
    readonly ctx: C;
    readonly on?: (result: Result<O, unknown> | undefined) => Promise<R> | R;
}
```

Created by [`wizard.$detached(ctx, on)`](#wizard): runs the wizard in a new activity; `on` receives the result.

#### WizardAttached

```ts
declare class WizardAttached<C = unknown, O = unknown, W extends Wizard<C, O, any> = Wizard<C, O, any>> implements Actor {
    constructor(mainStage: Stage<C, O, W>, ctx: C, on?: (result: Result<O, unknown> | undefined) => Promise<Actor> | Actor);
    readonly mainStage: Stage<C, O, W>;
    readonly ctx: C;
    readonly on?: (result: Result<O, unknown> | undefined) => Promise<Actor> | Actor;
}
```

Created by [`wizard.$attached(ctx, on)`](#wizard): runs the wizard in place of the current activity and applies the actor returned by `on` to it afterwards.

#### WizardPop

```ts
declare class WizardPop<C = unknown, O = unknown, W extends Wizard<C, O, any> = Wizard<C, O, any>> implements Actor {
    constructor(mainStage: Stage<C, O, W>, ctx: C, on?: (result: Result<O, unknown> | undefined) => Promise<Actor> | Actor);
    readonly mainStage: Stage<C, O, W>;
    readonly ctx: C;
    readonly on?: (result: Result<O, unknown> | undefined) => Promise<Actor> | Actor;
}
```

Created by [`wizard.$pop(ctx, on)`](#wizard): like [`WizardAttached`](#wizardattached), shown as a pop-up.

#### WizardNext

```ts
declare class WizardNext<C = unknown, O = unknown, W extends Wizard<any, O, any> = Wizard<any, O, any>> implements Actor {
    constructor(stage: Stage<C, O, W>, ctx: C);
    readonly stage: Stage<C, O, W>;
    readonly ctx: C;
}
```

Created by [`stage.$next(ctx)`](#stage): moves to that stage of the same wizard and keeps the current one for `$back()`.

#### WizardNextReplace

```ts
declare class WizardNextReplace<C = unknown, O = unknown, W extends Wizard<any, O, any> = Wizard<any, O, any>> implements Actor {
    constructor(stage: Stage<C, O, W>, ctx: C);
    readonly stage: Stage<C, O, W>;
    readonly ctx: C;
}
```

Created by [`stage.$nextReplace(ctx)`](#stage): moves to that stage, replacing the current one.

#### WizardDone

```ts
declare class WizardDone<O = unknown, E = unknown> implements Actor {
    constructor(wizard: Wizard<any, O, any>, result: Result<O, E> | undefined);
    readonly wizard: Wizard<any, O, any>;
    readonly result: Result<O, E> | undefined;
}
```

Created by `$ok(v)`, `$err(e)` and `$cancel()` on a [`Stage`](#stage): finishes the wizard with `Ok(v)`, `Err(e)` or `undefined`.

#### UpdateFragment

```ts
declare class UpdateFragment<D = unknown> implements Actor {
    constructor(fragmentId: string, type: UpdateTypes, data: D);
    readonly fragmentId: string;
    readonly type: UpdateTypes;
    readonly data: D;
}
```

Created by [`$update(data)`](#fragment) (`Full`) and [`$patch(data)`](#fragment) (`Patch`): sends `{ data, type }` on `update-<fragmentId>` while the activity is active.

#### UpdateTypes

```ts
enum UpdateTypes {
    Full = 'Full',
    Patch = 'Patch',
}
```

`Full` replaces the fragment's data, `Patch` is a partial change to merge (the merge happens in your front-end).

#### ReloadFragment

```ts
declare class ReloadFragment implements Actor {
    constructor(fragmentId: string);
    readonly fragmentId: string;
}
```

Created by [`$reload()`](#fragment) on a fragment: runs the previous `afterLoad` cleanup, `load()` and `afterLoad()`, then sends the data as a `Full` update.

### Agents

#### AgentIndex

Source: [src/agent/d.ts](src/agent/d.ts)

```ts
declare abstract class AgentIndex {
    get agentTypeList(): Array<[string, AgentFactory<any, any>]>;
}
```

Declares the agent types: each own [`AgentFactory`](#agentfactory) property is one type, named after the property. It is the default export of `agentIndexPath` (constructed with no arguments in every agent worker) and should also be assigned to [`AppIndex.agents`](#appindex). Example in the [Quick start](#2-agents).

#### AgentFactory

Source: [src/agent/d.ts](src/agent/d.ts)

```ts
declare class AgentFactory<INDEX extends AgentIndex = AgentIndex, AGENT extends Agent<INDEX> = Agent<INDEX>> {
    constructor(index: INDEX, _agentClass: new (index: INDEX, id: string) => AGENT);
    readonly _agentClass: new (index: INDEX, id: string) => AGENT;
    name: string; // set from the property name
    acquire(id: string): Promise<Result<AGENT, void>>;
    list(): Promise<Result<string[], void>>;
}
```

One agent type. `acquire(id)` returns an agent object bound to a connected agent of this type (`Err` when none is connected); `list()` returns the connected ids. Both work only inside app and agent worker threads. Pass the type arguments explicitly when creating it inside the index: `new AgentFactory<MyAgents, Printer>(this, Printer)`.

#### Agent

Source: [src/agent/d.ts](src/agent/d.ts)

```ts
declare abstract class Agent<INDEX extends AgentIndex = AgentIndex> {
    constructor(index: INDEX, id: string);
    protected readonly index: INDEX;
    readonly id: string;
    protected task<TData = unknown, R = unknown, E = unknown>(name: string, data: TData): Promise<Result<R, AgentError>>;
    abstract onPost<TData = unknown, R = unknown, E = unknown>(name: string, data: TData): Promise<Result<R, E>>;
}
```

The server-side representative of an agent process. In the agent's own worker, `onPost(name, data)` answers the messages the process posts (a thrown error becomes `Err(message)`). In app workers, objects returned by [`acquire`](#agentfactory) send tasks with `task(name, data)`: the result is `Ok(value)`, `Err(`[`ExecutionAgentError`](#executionagenterror)`)` or `Err(`[`CommunicationAgentError`](#communicationagenterror)`)` (60-second timeout). Keep the `(index, id)` constructor. Example in the [Quick start](#2-agents) and in [Agents and agent tasks](#agents-and-agent-tasks).

#### AgentErrorType

Source: [src/agent/d.ts](src/agent/d.ts)

```ts
enum AgentErrorType {
    Communication = 'Communication',
    Execution = 'Execution',
}
```

The `type` of the errors returned by [`Agent.task`](#agent).

#### ExecutionAgentError

Source: [src/agent/d.ts](src/agent/d.ts)

```ts
declare class ExecutionAgentError<E = unknown> {
    constructor(e: E);
    readonly e: E;
    readonly type: AgentErrorType.Execution;
}
```

The agent received the task and answered with `Err(e)`.

#### CommunicationAgentError

Source: [src/agent/d.ts](src/agent/d.ts)

```ts
declare class CommunicationAgentError {
    readonly type: AgentErrorType.Communication;
}
```

The task got no usable answer: the agent is not connected, the stream failed, the 60-second timeout expired or the answer was not a serialised `Result`.

### Executor

#### AppResult

Source: [src/executor/AppInstance.ts](src/executor/AppInstance.ts)

```ts
type AppResult = Result<void, AppError>;
// AppError (not exported by name): 'WrongAction' | 'NonActive' | 'Skipped' | 'NotFound' | 'Other'
```

The result of [`push`](#activity), [`trigger`](#activity) and other activity operations. `WrongAction`: the actor or request does not apply (unknown fragment or action, an actor of another activity or wizard). `NonActive`: the activity is not the active one. `Other`: the message to the main thread failed (no client connected, stream closed with an error). `Skipped` and `NotFound` are reserved.

#### workerDriver()

Source: [src/executor/workerDriver.ts](src/executor/workerDriver.ts)

```ts
declare function workerDriver(): WorkerDriver; // { userId: string; profile: string | null; appName: string; request(...); destroy() }
```

Facts about the app instance running in the current worker thread, for code that has no access to an activity. Returns `undefined` (despite its type) outside an app worker.

```ts
import { workerDriver } from '@araminix/platform';

const { userId, profile, appName } = workerDriver();
```

### Worker IPC

The building blocks of the thread protocol, exported for advanced use (for example your own worker channels). Source: [src/lib/worker_socket.ts](src/lib/worker_socket.ts).

#### MessageRole

```ts
enum MessageRole {
    Request = 0,
    Resolve = 1,
    Reject = 2,
}
```

The role of a message on a worker port.

#### typeNameOf()

```ts
declare function typeNameOf(typeClass: { readonly name: string; readonly typeName?: string }): string;
```

Returns a class's own `static typeName`, or its class name. Messages are tagged with it and fragments send it to the front-end, so declare `static typeName` on every class whose name must survive minification. A subclass without its own `typeName` uses its class name, not its parent's.

```ts
class Chart extends Fragment<{ styles?: string[] }> {
    static readonly typeName = 'Chart';
    load() {}
}
typeNameOf(Chart); // 'Chart', even when a minifier renames the class
```

#### Req

```ts
declare abstract class Req {
    readonly _type: string;
    readonly _role: MessageRole.Request;
    _rid?: number;
}
```

Base class of requests. Subclasses should declare `static typeName`.

#### Res

```ts
declare class Res {
    static readonly typeName: string; // 'Res'
    readonly _type: string;
    readonly _role: MessageRole.Resolve;
    _rid?: number;
}
```

A successful reply; subclass it to carry data.

#### Rej

```ts
declare class Rej {
    static readonly typeName: string; // 'Rej'
    readonly _type: string;
    readonly _role: MessageRole.Reject;
    _rid?: number;
}
```

A failed reply; also sent automatically when a reply cannot be posted.

#### RequestSocket

```ts
declare class RequestSocket {
    constructor(port: MessagePort, deserialize: (data: unknown) => Req | Res | Rej | undefined, timeoutMs?: number);
    get active(): boolean;
    writeRead<TReq extends Req = Req, TRes extends Res = Res, TRej extends Rej = Rej>(input: TReq, timeoutMs?: number): Promise<Result<TRes, TRej | undefined>>;
    close(): void;
}
```

Sends one request at a time (calls queue in order) and waits for its reply. Every request gets a fresh id, so a late reply to a timed-out request is ignored. `writeRead` returns `Ok` for a [`Res`](#res), `Err(rej)` for a [`Rej`](#rej) and `Err(undefined)` on timeout, a closed port or an unexpected message. `timeoutMs` `0` waits forever.

#### ResponseSocket

```ts
declare class ResponseSocket {
    constructor(port: MessagePort, deserialize: (data: unknown) => Req | Res | Rej | undefined);
    get active(): boolean;
    read<TReq extends Req = Req>(): Promise<Result<TReq, undefined>>;
    resolve<TRes extends Res = Res, TErr = unknown>(response?: TRes): Result<void, TErr>;
    reject<TRej extends Rej = Rej, TErr = unknown>(response?: TRej): Result<void, TErr>;
    write<T = unknown>(response: Res | Rej | undefined): Result<void, T>;
    close(): void;
}
```

Reads requests in arrival order. Answer each request exactly once (`resolve`, `reject` or `write`) before reading the next: the reply carries the id of the request read last.

```ts
import { MessageChannel } from 'node:worker_threads';

class Ping extends Req {
    static readonly typeName = 'Ping';
}
const deserialize = (data: any) => (data?._type === 'Ping' ? new Ping() : data?._type === 'Res' ? new Res() : data?._type === 'Rej' ? new Rej() : undefined);

const { port1, port2 } = new MessageChannel();
const requests = new RequestSocket(port1, deserialize, 5_000);
const responses = new ResponseSocket(port2, deserialize);

const reply = requests.writeRead(new Ping());
await responses.read();
responses.resolve();
console.log((await reply).isOk()); // true
```

### Utilities

#### I18nService

Source: [src/utils/i18n.ts](src/utils/i18n.ts)

```ts
declare class I18nService<LANGUAGE extends string | number, TEXT extends string> {
    constructor(language: LANGUAGE);
    loadTranslations(allTranslations: Translations<LANGUAGE, TEXT>): void;
    setLanguage(language: LANGUAGE): void;
    getCurrentLanguage(): LANGUAGE;
    t(text: TEXT, lang?: LANGUAGE): string;
}
```

Type-safe translations. `loadTranslations` adds or replaces languages (it throws when a present language has no dictionary); `t` falls back to the key with a warning. See [Internationalisation](#internationalisation).

#### Translations

Source: [src/utils/i18n.ts](src/utils/i18n.ts)

```ts
type Translations<LANGUAGE extends string | number, TEXT extends string> = { [L in LANGUAGE]?: { [K in TEXT]: string } };
```

Dictionaries by language; every present language must translate every key.

#### logMiddleware

Source: [src/utils/log_middleware.ts](src/utils/log_middleware.ts)

```ts
const logMiddleware: (req: Request, res: Response, next: NextFunction) => void;
```

Express access log: one line per finished response, levels by status, `/ws-token/<token>` redacted. [`Endpoint`](#endpoint) installs it; you can use it in other Express apps (`app.use(logMiddleware)`). See [Logging](#logging).

#### MinioService

Source: [src/utils/minioService.ts](src/utils/minioService.ts)

```ts
declare class MinioService {
    constructor(options: MinioOptions);
    get expiry(): number;
    presignedPutObject<E = Error>(mimetype: MIME_TYPE, fileName: string): Promise<Result<string, E>>;
    presignedGetObject<E = Error>(objectName: string): Promise<Result<string, E>>;
    deleteObject<E = Error>(objectName: string): Promise<Result<void, E>>;
    listObjects<E = Error>(prefix?: string): Promise<Result<string[], E>>;
    objectExists<E = Error>(objectName: string): Promise<Result<boolean, E>>;
}
```

A `Result`-returning wrapper around the `minio` client for one bucket. The constructor validates the options (and throws when one is missing); the client and bucket are set up lazily on the first call. `presignedPutObject` appends the MIME type's extension (see [`MimeToExtension`](#mimetoextension)) unless the name already ends with it. URLs are valid for `expiry` seconds. See [Uploads and MinIO attachments](#uploads-and-minio-attachments).

#### MinioOptions

Source: [src/utils/minioService.ts](src/utils/minioService.ts)

```ts
interface MinioOptions extends MinioClient {
    bucketName: string;
    expiry?: number;
}
```

Options of [`MinioService`](#minioservice) and `EndpointOptions.minio`; see [MinioOptions fields](#miniooptions-fields).

#### MinioClient

Source: [src/utils/minioService.ts](src/utils/minioService.ts)

```ts
interface MinioClient {
    endPoint: string;
    port: number;
    accessKey: string;
    secretKey: string;
    useSSL?: boolean;
    region?: string;
}
```

Connection settings of the MinIO/S3 server.

#### MIME_TYPE

Source: [src/utils/minioService.ts](src/utils/minioService.ts)

```ts
enum MIME_TYPE {
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
```

MIME types known to [`MinioService`](#minioservice). `DRAW_IO` and `ANY` share one value.

#### MimeToExtension

Source: [src/utils/minioService.ts](src/utils/minioService.ts)

```ts
const MimeToExtension: Partial<Record<MIME_TYPE, string>>;
```

The extension appended for each [`MIME_TYPE`](#mime_type) (`jpg`, `png`, `pdf`, `docx`, ..., `gbr`); `'*'` (images, audio, video, binary) means no extension.

### Re-exports from @araminix/lib

`@araminix/platform` re-exports the whole public API of [`@araminix/lib`](https://github.com/araminix/lib#readme), including `Result`, `Ok`, `Err`, `ok`, `err`, `R`, `deal`, `t` (io-ts), `loop`, `LoopResult`, `once`, `wrap`, `wrapSync`, `sleep`, `uuid`, `trimSlash`, `Defined`, `logger`, `Logger`, `LOG_LEVEL`, `Socket`, `Stream`, `StreamErr`, `InitStreamErr`, `StreamCloseCodes`, `Connection`, `WsCloseCodes`, `CloseCodes`, `Client`, `AgentClient`, `ConnectFail`, `FileInfo` and `Message`. See the [`@araminix/lib` README](https://github.com/araminix/lib#readme) for their documentation.

## Close codes and error enums

**WebSocket close codes** seen by clients (the lib's [`WsCloseCodes`](https://github.com/araminix/lib#wsclosecodes) plus standard codes):

| Code | Name                   | When                                                                                                                                                      |
| ---- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4000 | `Normal`               | The server destroyed the connection, for example when the instance was closed or destroyed, or after a logout with `@araminix/lib` before 3.1.            |
| 4401 | `Unauthorized`         | No valid session at the upgrade (or an invalid token on `/ws-token/...`); with `@araminix/lib` 3.1 or later also after a logout.                          |
| 4403 | `Denied`               | The consumer denied the request (for example a `User` on the `agent` endpoint, or an unknown instance id), or the `Origin` check failed inside the route. |
| 4404 | `NotFound`             | No endpoint with that name was declared.                                                                                                                  |
| 4409 | `ConcurrentConnection` | The same connection (`clientType/runtimeId/arg`) was opened again elsewhere; the older socket is closed.                                                  |
| 1008 | policy violation       | `Too many connections`: the client runtime exceeds `maxConnectionsPerClient` on this endpoint.                                                            |
| 1009 | message too big        | A message exceeded `maxMessageBytes`.                                                                                                                     |
| 1011 | internal error         | An unexpected error while handling the upgrade.                                                                                                           |

A disallowed browser `Origin` is refused during the handshake with HTTP 403, before any WebSocket exists. When a client closes its own WebSocket with 4000 the server ends the connection for good; after other closes (network drops) the connection waits up to 5 minutes for the client to resume it.

**Error enums**:

| Enum                                      | Values                                                     | Meaning                                                |
| ----------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| [`AcceptError`](#accepterror)             | `Write`, `Staled`                                          | Failure of `ConnectRequest.accept()` / `deny()`.       |
| `AppError` (in [`AppResult`](#appresult)) | `WrongAction`, `NonActive`, `Skipped`, `NotFound`, `Other` | Failure of an activity operation inside an app worker. |
| [`AgentErrorType`](#agenterrortype)       | `Communication`, `Execution`                               | Kind of [`Agent.task`](#agent) failure.                |
| instance stream errors                    | `'Format'`, `'Execution'`                                  | `e` of `{ ok: false, e }` on the `instance` streams.   |
| [`ClientType`](#clienttype)               | `User`, `Agent`                                            | Kind of client.                                        |
| [`UpdateTypes`](#updatetypes)             | `Full`, `Patch`                                            | Kind of fragment update.                               |
| [`MessageRole`](#messagerole)             | `Request`, `Resolve`, `Reject`                             | Role of a worker message.                              |

**HTTP errors** are JSON objects: `{ error }` for authentication failures (your provider's code or `'Unauthorized'`), `{ message }` for missing or invalid input, and `{ error: 'Internal server error' }` for unexpected exceptions.

## Migration notes

### 2.2.0

- **Minification-safe type names.** Worker messages are tagged with [`typeNameOf()`](#typenameof) instead of the raw class name, and every protocol class declares `static typeName`. Fragments send `typeNameOf(fragmentClass)` to the front-end.
- **What to do** if you bundle or minify your server code: add `static readonly typeName = '<ComponentName>'` to every [`Fragment`](#fragment) subclass, and to your own [`Req`](#req)/[`Res`](#res)/[`Rej`](#rej) subclasses if you use [`RequestSocket`](#requestsocket)/[`ResponseSocket`](#responsesocket) directly; match on `typeNameOf(Class)` in your deserializers. A subclass does not inherit its parent's `typeName`.
- Without minification nothing changes: the class name is still used when `typeName` is absent.
- Keep `@araminix/platform` itself external to your bundle. It starts its workers from `./worker.js` files next to its own modules.

### 2.0.0

- **Node.js 22 or later** is required (`engines.node >= 22`), as for `@araminix/lib` 2.x, which uses the native `WebSocket`.
- **`@araminix/lib` is provided by your application.** 2.0.0 declared it as a peer dependency (`^1.3.0 || ^2.0.0`); since 2.1.2 the `package.json` lists it only as a development dependency (2.1.1). Install it explicitly and keep a single copy.
- **`@araminix/lib` 3.x**: the platform's sources type-check against lib 3.1, and the platform only calls `unwrap()` after checking `isOk()`/`isErr()`. Lib 3 makes `Err.unwrap()` always throw an `Error`; review your own code if it relied on catching the raw error value.
- Behaviour changes since 1.x that you may notice: WebSocket messages are capped at 16 MiB and sockets are pinged every 30 seconds (1.10); error objects are no longer echoed to clients, only string and number codes (1.10); `/2fa/enable` and `/2fa/disable` share the authentication rate limit (1.10); a client may hold at most 32 connections per endpoint (2.1.0); activity changes of an instance are serialised by a lock (2.1.1).

## Testing

```bash
pnpm install
pnpm build            # tsc -> dist/ (sources and tests)
pnpm test             # node:test over dist/tests/**/*.test.js
pnpm test:coverage    # the same with Node's built-in coverage
pnpm format:check     # prettier
```

The tests are plain `node:test` suites compiled together with the sources. They cover the endpoint security (cookies, origins, CSRF, rate limits, Google verification, uploads, attachments), the worker IPC (timeouts, request ids, unclonable replies), agent workers, the per-instance lock, the builder, minification-safe names and the platform's instance limits.

## Related packages

- [`@araminix/lib`](https://github.com/araminix/lib): the client and the shared protocol (streams, sockets, `Result`, logger). Its [README](https://github.com/araminix/lib#readme) documents the client side of everything above.
- Source and issues: [github.com/araminix/platform](https://github.com/araminix/platform).

## License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

Copyright (c) 2026 Amin Abbasi.
