# Trace: Upload Limits, Allowlist Filtering, Filename Sanitization, and Stored XSS Hardening

- **Package:** `@araminix/platform`
- **Version Bump:** `1.1.0` -> `1.2.0`
- **Audit Findings Fixed:** Finding #3 (Stored XSS through uploads; no upload limits).

## Changes Made
1. `src/server/Endpoint.ts`:
   - Exported `UploadAllowlist` interface: `{ extensions?: string[]; mimetypes?: string[] }`.
   - Added `maxUploadBytes?: number` and `uploadAllowlist?: UploadAllowlist` to `EndpointOptions`.
   - Added `sanitizeFilename(name: string): string` helper to strip directory traversal (`..`, `/`, `\`), control characters (`[\x00-\x1f\x7f-\x9f]`), whitespace, and cap length at 255 characters (falling back to `'upload'` on empty/dot inputs).
   - Configured `multer` with `limits: { fileSize: this.maxUploadBytes, files: 1 }` (default 20 MB).
   - Configured `fileFilter` to validate extensions and MIME types against configured `uploadAllowlist`, rejecting unauthorized uploads with HTTP 415 (`Unsupported Media Type`).
   - Wrapped `upload.single('file')` in route middleware to return HTTP 413 on file size limit exceeded, HTTP 415 on allowlist rejections, and HTTP 400 on missing or malformed uploads.
   - Guarded `fs.writeFile` in `POST /file` with error logging and HTTP 500 response on disk write failures.
   - Hardened `expressCore.static(this.uploadDir!)` with:
     - `index: false` (disables directory index listing)
     - `dotfiles: 'deny'` (denies access to hidden/dot files)
     - `setHeaders`: sets `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` (prevents inline script execution), and `Content-Security-Policy: default-src 'none'; sandbox`.
2. `src/Platform.ts`:
   - Imported `UploadAllowlist`.
   - Added optional `maxUploadBytes?: number` and `uploadAllowlist?: UploadAllowlist` to `PlatformConfig`.
   - Forwarded `maxUploadBytes` and `uploadAllowlist` to `new Endpoint({...})`.
3. `src/server/index.ts`:
   - Re-exported `* from './Endpoint.js'` (exposing `UploadAllowlist`).
4. `tests/uploadSecurity.test.ts`:
   - Added comprehensive integration test suite (11 tests) verifying:
     - Rejection of unauthenticated upload requests with 401.
     - Upload of valid files within size limit and safe metadata storage.
     - Rejection of oversized uploads with HTTP 413 Payload Too Large.
     - Rejection of disallowed extensions with HTTP 415 Unsupported Media Type.
     - Rejection of disallowed MIME types with HTTP 415 Unsupported Media Type.
     - Successful upload when extension and MIME match allowlist.
     - Filename sanitization stripping traversal sequences, control characters, and capping length.
     - Rejection of requests missing file field with HTTP 400.
     - Static file download headers (`nosniff`, `attachment`, CSP `sandbox`).
     - Access denial on dotfiles (`.env`).
     - Backward compatibility for `/file/:fileId` 302 redirect.
5. `package.json`:
   - Bumped version to `1.2.0`.
   - Registered `dist/tests/uploadSecurity.test.js` in `test` and `test:coverage` scripts.
6. `README.md`:
   - Updated version badge to `1.2.0`.
   - Documented upload security controls, `maxUploadBytes`, `uploadAllowlist`, and Stored XSS defense headers.
