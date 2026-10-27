# @araminix/platform

> **Enterprise-grade actor runtime, WebSocket endpoint platform, and multi-threaded agent execution engine.**

[![npm version](https://img.shields.io/badge/version-1.2.0-blue.svg)](https://www.npmjs.com/package/@araminix/platform)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-green.svg)](https://nodejs.org/)

**Araminix Platform** (`@araminix/platform`) is a high-performance backend orchestration engine designed for complex real-time applications. Built on top of [`@araminix/lib`](../araminix-lib), it integrates an enterprise WebSocket & HTTP server, worker-thread agent execution, dynamic component/UI assembly, authentication (with 2FA and Google OAuth), and S3/MinIO cloud storage.

---

## 🌟 Key Features

- ⚡ **Unified WebSocket & HTTP Endpoint**: Built on Express & `express-ws`, providing automatic WebSocket route dispatching, session cookies, Google OAuth, and two-factor authentication (2FA).
- 🧵 **Multi-Threaded Agent Runtime**: Spawns isolated worker processes (`worker_threads`) with type-safe `MessageChannel` IPC, protecting the main thread from CPU-heavy tasks and crashes.
- 🧩 **Dynamic UI Builder & Actor Engine**: Assemble complex interactive interfaces on the fly using `Panel`, `Fragment`, and `Actor` lifecycles.
- 🗄️ **Integrated MinIO / S3 Storage**: Built-in presigned URL generation, file uploads (`multer`), MIME type mapping, and bucket management.
- 🌐 **First-Class Internationalization**: Integrated `I18nService` with type-safe generic dictionary translations and automatic language fallbacks.
- 🛡️ **Zero-Crash Functional Core**: Powered by `@araminix/lib`'s `Result<T, E>` monads and multiplexed streaming channels.

---

## 📐 Architecture

```
                                  +------------------------------------+
                                  |            Platform                |
                                  +-----------------+------------------+
                                                    |
                      +-----------------------------+-----------------------------+
                      |                                                           |
                      v                                                           v
        +----------------------------+                             +----------------------------+
        |         Endpoint           |                             |      AgentController       |
        |  (Express WS + HTTP + 2FA) |                             |     (worker_threads)       |
        +--------------+-------------+                             +--------------+-------------+
                       |                                                          |
        +--------------+-------------+                             +--------------+-------------+
        |    MinIO S3 / Storage      |                             |   WorkerSocket / IPC Port  |
        +----------------------------+                             +----------------------------+
```

---

## 📦 Installation

```bash
# npm
npm install @araminix/platform @araminix/lib

# pnpm
pnpm add @araminix/platform @araminix/lib

# yarn
yarn add @araminix/platform @araminix/lib
```

---

## 🚀 Quick Start

### 1. Initializing the Platform and Endpoint

```typescript
import { AuthProvider, ClientInfo, Ok, Platform, Result } from '@araminix/platform';

// 1. Define custom authentication logic
class CustomAuthProvider extends AuthProvider {
    async getInfo(token: string): Promise<Result<ClientInfo, unknown>> {
        // Retrieve and return client information
        return new Ok({
            id: 'user-100',
            clientType: 'User',
            runtimeId: 'rt-100',
        } as ClientInfo);
    }

    async auth(data: any) {
        /* verify credentials */ return new Ok('token-xyz');
    }
    async googleAuth(data: any) {
        /* Google OAuth */ return new Ok('token-xyz');
    }
    async destroy(token: string) {
        /* session cleanup */
    }
    async refreshToken(token: string) {
        return new Ok('new-token');
    }
    async request2FA(userId: string) {
        return new Ok('otpauth://...');
    }
    async enable2FA(userId: string, secret: string, code: string) {
        return new Ok(true);
    }
    async verify2FA(account: string, code: string, uuid: string) {
        return new Ok(true);
    }
    async disable2FA(userId: string) {
        return new Ok(true);
    }
    async requestUploadUrl(id: string, name: string, mime: string) {
        return new Ok('https://...');
    }
    async requestDownloadUrl(id: string, name: string) {
        return new Ok('https://...');
    }
    async mobileRequests(data: any) {
        return { status: 200, result: 'OK' };
    }
}

// 2. Configure and launch the Platform
const platform = new Platform({
    appIndexPath: new URL('file:///path/to/apps/index.js'),
    agentIndexPath: new URL('file:///path/to/agents/index.js'),
    authProvider: new CustomAuthProvider(),
    instanceUserLimit: 10,
    port: 3000,
    mount: '/api',
});

// Start listening for HTTP & WebSocket connections
await platform.start();
console.log('Araminix Platform running on http://localhost:3000/api');
```

---

### 2. Spawning Multi-Threaded Agents

```typescript
import { AgentController } from '@araminix/platform';

const controller = new AgentController(new URL('file:///path/to/agentWorker.js'));

// Acquire or send tasks to background worker threads
const taskResult = await controller.task('worker-1', {
    action: 'computeAnalytics',
    payload: { range: '30d' },
});

if (taskResult.isOk()) {
    console.log('Agent Response:', taskResult.unwrap());
}
```

---

### 3. Dynamic UI Building with Fragments & Panels

```typescript
import { Fragment, panel } from '@araminix/platform';

class UserProfileFragment extends Fragment {
    build() {
        return {
            type: 'card',
            props: { title: 'User Information' },
        };
    }
}

// Assemble nested reactive panels
const dashboard = panel({ header: 'System Overview' })
    .panel(panel({ header: 'Metrics' }))
    .fragment(new UserProfileFragment())
    .build();
```

---

### 4. Session Security & Cookie Configuration

`Endpoint` issues signed, hardened session cookies by default:

- Default Flags: `HttpOnly: true`, `Secure: true`, `SameSite: 'lax'`, `Path: '/'`, and TTL-based `Max-Age`.
- Customizable via optional `cookieOptions` in `EndpointOptions`:

```typescript
const endpoint = new Endpoint({
    authProvider: new CustomAuthProvider(),
    cookieOptions: {
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
    },
});
```

#### WebSocket Authentication Routes

- **`/ws/:endpoint` (Recommended):**
    - **Browsers:** Cookie-authenticated via `httpOnly` session cookie automatically attached on WebSocket upgrade.
    - **Node Clients / Agents:** Header-authenticated by passing `x-token: <token>` in the HTTP upgrade request headers.
- **`/ws-token/:token/:endpoint` (`@deprecated`):**
    - Maintained for backward compatibility with legacy clients. Tokens in URL paths are automatically redacted in server access logs.

#### Google OAuth Hardening (`/gauth`)

`Endpoint` verifies Google access tokens against Google's `tokeninfo` endpoint prior to retrieving user profile data:

- **Client ID Verification:** `EndpointOptions.googleClientIds` defines allowed OAuth client IDs. Replayed tokens issued to other Google OAuth applications are rejected with HTTP 401 (`Unauthorized`).
- **Verified Email Enforcement:** Rejects tokens unless Google confirms `email_verified === 'true'`.
- **Header-Only Authorization:** Access tokens are passed to `userinfo` strictly via the HTTP `Authorization: Bearer <token>` header rather than query strings.
- **Fail-Closed Protection:** If `googleClientIds` is not configured, `/gauth` requests are refused with HTTP 503 (`Service Unavailable`).
- **HTTP Timeouts:** All external Google API calls enforce an explicit 10-second timeout.

```typescript
const endpoint = new Endpoint({
    authProvider: new CustomAuthProvider(),
    googleClientIds: [
        '1234567890-example.apps.googleusercontent.com',
    ],
});
```

---

### 5. File Upload Security & Stored XSS Mitigation

`Endpoint` and `Platform` provide hardened file upload and static download controls:

- **Upload Size Limits:** Configured via `maxUploadBytes` (default: 20 MB). Oversized files are rejected with HTTP 413 (`Payload Too Large`). Only single-file uploads (`files: 1`) are permitted per request.
- **Allowlist Filtering:** Optional `uploadAllowlist` restricts uploads to specific extensions and/or MIME types. Unauthorized uploads are rejected with HTTP 415 (`Unsupported Media Type`):
    ```typescript
    const platform = new Platform({
        uploadDir: '/var/data/uploads',
        maxUploadBytes: 10 * 1024 * 1024, // 10 MB
        uploadAllowlist: {
            extensions: ['png', 'jpg', 'pdf'],
            mimetypes: ['image/png', 'image/jpeg', 'application/pdf'],
        },
        // ...
    });
    ```
- **Filename Sanitization:** Uploaded filenames are stripped of path traversal sequences (`..`, `/`, `\`), null bytes, and non-printable control characters, with length capped at 255 characters.
- **Stored XSS Defenses:** Static file downloads (`/file/:fileId/:safeName`) enforce defense-in-depth security headers:
    - `X-Content-Type-Options: nosniff`
    - `Content-Disposition: attachment` (forces browser download instead of inline execution)
    - `Content-Security-Policy: default-src 'none'; sandbox` (strips script execution privileges and isolates origin)
    - `dotfiles: 'deny'` and `index: false`

---

## 🛠️ Module Exports

| Submodule            | Purpose                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `Platform`           | Primary orchestrator managing endpoints, apps, and user session lifecycles.                    |
| `Endpoint`           | Express + `express-ws` HTTP/WebSocket server handling auth, sessions, 2FA, and upload streams. |
| `AgentController`    | Spawns and supervises isolated worker threads with `MessageChannel` IPC.                       |
| `Panel` / `Fragment` | Fluent builder API for dynamic UI layout structures.                                           |
| `MinioService`       | Object storage client for S3/MinIO presigned URLs and file lifecycle operations.               |
| `I18nService`        | Type-safe multi-language translation and fallback engine.                                      |

---

## 🧪 Testing

```bash
# Run unit tests
npm test

# Run tests with built-in code coverage report
npm run test:coverage
```

---

## 👤 Author

**Amin Abbasi**

- Organization: [araminix](https://github.com/araminix)
- GitHub: [@abbasi](https://github.com)

---

## 📄 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.
