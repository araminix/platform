# Trace: Defend Against Unhandled Rejections and Uncaught Exceptions

- **Package:** `@araminix/platform`
- **Version Bump:** `1.0.0` -> `1.0.1`
- **Audit Findings Fixed:** Finding #1 (Unhandled rejections crash the server — Critical).

## Changes Made
1. **`src/server/Endpoint.ts`**:
   - Wrapped all 4 async `express-ws` route handlers (`/ws-token/:token/:endpoint/:arg`, `/ws-token/:token/:endpoint`, `/ws/:endpoint/:arg`, `/ws/:endpoint`) in `try/catch`. On error: logs with `logger.error` and closes socket with `WsCloseCodes.InternalError` (1011).
   - In `/file/:fileId` handler, wrapped `JSON.parse` inside `fs.readFile` callback in `try/catch`. Sanitized redirect target filename with `encodeURIComponent(path.basename(info.name))`. Returns 404 on corrupt JSON or missing/invalid file metadata.
2. **`src/Platform.ts`**:
   - Replaced floating `.then()` on `serveInstance` and `agentController.connect` with `.catch(err => logger.error(...))`.
   - Wrapped custom stream execution, user info streaming, instance listing, and app listing in `try/catch` calling `stream.closeErr()` on error.
   - Guarded instance creation in `processInstanceStream` to destroy the instance and clear it from the instance map if initialization or user apps resolution throws.
3. **`src/agent/AgentController.ts`**:
   - Added validation guard on incoming `post` stream `stream.args`:
     `const args = stream.args as { name?: unknown; data?: unknown } | null;`
     `if (!args || typeof args !== 'object' || typeof args.name !== 'string') { stream.closeErr(); return LoopResult.Cont; }`
   - Wrapped post stream handler body in `try/catch`, logging and calling `stream.closeErr()` on failure.
4. **`src/executor/Instance.ts`**:
   - Replaced floating `.then()` calls in `connect()` for stream dispatchers with `.catch(err => logger.error(...))`.
   - Wrapped `processStream` handler execution in `try/catch` and called `stream.closeErr()` on error.
5. **`tests/unhandledRejections.test.ts`**:
   - Added test suite with 4 unit tests covering corrupt `index.json`, `authProvider.getInfo` throwing on WebSocket route (closing with 1011), custom stream exploding handler, and agent sending `null`/invalid `args` to `AgentController`.
   - Used Node 22+ native global `WebSocket` without external dependencies.
