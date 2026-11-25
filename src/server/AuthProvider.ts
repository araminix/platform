import { Result } from '@araminix/lib';

import { ClientInfo, GoogleDataType } from './clientInfo.js';

export {
    AgentInfo,
    ClientInfo,
    ClientType,
    GoogleData,
    GoogleDataType,
    SettingCardPreference,
    SettingNotification,
    SettingTablePreference,
    SettingTwoFactor,
    UserInfo,
    UserSetting,
} from './clientInfo.js';

/** A session token issued by the {@link AuthProvider}; opaque to the platform. */
type Token = string;

/**
 * A request received on `POST /mobile/:module/:action` and handed to {@link AuthProvider.mobileRequests}.
 *
 * @typeParam MODULE - Module name taken from the URL.
 * @typeParam ACTION - Action name taken from the URL.
 * @typeParam TData - Type of the JSON body.
 */
export type MobileRequestType<MODULE extends string = string, ACTION extends string = string, TData = unknown> = {
    /** The `:module` path segment. */
    module: MODULE;
    /** The `:action` path segment. */
    action: ACTION;
    /** Id of the authenticated user ({@link ClientInfo.id}). */
    userId: string;
    /** The parsed JSON request body. */
    data: TData;
};

/**
 * Answer of {@link AuthProvider.mobileRequests}. The whole object is sent as the JSON response body and `status` is used as
 * the HTTP status code; any status other than 200 is also logged as an error.
 *
 * @typeParam R - Type of `result`.
 * @typeParam E - Type of `error`.
 */
export type MobileResponseType<R = unknown, E = unknown> = {
    /** HTTP status code of the response. */
    status: number;
    /** Optional human-readable message. */
    message?: string;
    /** Optional error payload (logged when `status !== 200`). */
    error?: E;
    /** Optional result payload. */
    result?: R;
};

/**
 * Your authentication back-end. The {@link Endpoint} delegates every credential, session and 2FA decision to it.
 *
 * Implement it once and pass an instance as `authProvider` to {@link Platform} (or {@link Endpoint}). The endpoint owns the
 * HTTP side (cookies, rate limits, input checks); the provider owns the data (users, sessions, secrets).
 *
 * Error values: when a method returns `Err(e)`, the client receives `{ error: e }` if `e` is a string or number (use short
 * error codes such as `'InvalidCredentials'`), otherwise `{ error: 'Unauthorized' }`. The full error is only logged.
 *
 * @remarks
 * Security responsibilities that stay with the provider:
 * - {@link AuthProvider.enable2FA} must check that `secret` is the secret issued by {@link AuthProvider.request2FA} for
 *   that user and that `code` is valid for it.
 * - {@link AuthProvider.disable2FA} must require a valid `code` (the endpoint forwards it, possibly `undefined`, without
 *   checking it).
 * - {@link AuthProvider.refreshToken} must validate `old_token` itself; the endpoint does not compare it with the cookie.
 * - {@link AuthProvider.getInfo} runs on every authenticated HTTP request and WebSocket upgrade; keep it fast.
 *
 * @example
 * ```ts
 * import { AuthProvider, ClientInfo, Err, GoogleDataType, MobileRequestType, MobileResponseType, Ok, Result } from '@araminix/platform';
 *
 * class MyAuthProvider extends AuthProvider {
 *     async getInfo<TClient extends ClientInfo = ClientInfo, TErr = unknown>(token: string): Promise<Result<TClient, TErr>> {
 *         const info = await sessions.lookup(token); // UserInfo | AgentInfo | undefined
 *         return info ? new Ok(info as unknown as TClient) : new Err('InvalidToken' as TErr);
 *     }
 *
 *     async auth<TAuthData = unknown, TErr = unknown>(data: TAuthData): Promise<Result<string | { twoFactorCode: string; accountName: string }, TErr>> {
 *         const { username, password } = data as { username: string; password: string };
 *         const user = await users.check(username, password);
 *         if (!user) return new Err('InvalidCredentials' as TErr);
 *         if (user.twoFactor) return new Ok({ twoFactorCode: await challenges.create(user.id), accountName: username });
 *         return new Ok(await sessions.create(user));
 *     }
 *
 *     // ...googleAuth, destroy, refreshToken, request2FA, enable2FA, verify2FA, disable2FA,
 *     // requestUploadUrl, requestDownloadUrl and mobileRequests
 * }
 * ```
 */
export abstract class AuthProvider {
    /**
     * Get information about a user.
     *
     * Resolves a session token to the client that owns it. The {@link Endpoint} calls it for every HTTP request that carries a
     * token (signed `token` cookie first, then the `x-token` header), except `/health` and `/version`, and for every WebSocket
     * upgrade. Return an `Err` for unknown or expired tokens; the request is then treated as unauthenticated.
     *
     * @param token The token of the user.
     *
     * @typeParam TClient - Concrete {@link ClientInfo} subclass you return (usually {@link UserInfo} or {@link AgentInfo}).
     * @typeParam TErr - Error type.
     * @returns `Ok(clientInfo)` for a valid session, `Err(reason)` otherwise.
     */
    abstract getInfo<TClient extends ClientInfo = ClientInfo, TErr = unknown>(token: Token): Promise<Result<TClient, TErr>>;

    /**
     * Authenticate a user.
     *
     * Called by `POST /auth` (rate limited) with the parsed JSON body. Return `Ok(token)` to log the user in: the endpoint sets
     * the token as a signed, `httpOnly` `token` cookie and answers 200 with an empty body. Return
     * `Ok({ twoFactorCode, accountName })` when the account needs a second factor: that object is sent as the JSON body (no
     * cookie) and the client finishes with `POST /2fa/verify`. Return `Err(code)` for bad credentials (HTTP 401).
     *
     * @param data The data of the user.
     *
     * @typeParam TAuthData - Shape of the login body you expect (for example `{ username, password }`). It is not validated
     *     by the endpoint.
     * @typeParam TErr - Error type; use a string code to show it to the client.
     * @returns A session token, a 2FA challenge, or an error.
     */
    abstract auth<TAuthData = unknown, TErr = unknown>(data: TAuthData): Promise<Result<Token | { twoFactorCode: string; accountName: string }, TErr>>;

    /**
     * Authenticate a user using Google.
     *
     * Called by `POST /gauth` only after the access token was verified against Google (`aud` or `azp` in `googleClientIds`,
     * e-mail verified, `tokeninfo` and `userinfo` e-mails equal). Map the Google account to one of your users here. The
     * return value is handled exactly like {@link AuthProvider.auth}.
     *
     * @param data The data of the user.
     *
     * @typeParam TErr - Error type.
     * @returns A session token, a 2FA challenge, or an error.
     */
    abstract googleAuth<TErr = unknown>(data: GoogleDataType): Promise<Result<Token | { twoFactorCode: string; accountName: string }, TErr>>;

    /**
     * Destroy a session.
     *
     * Called by `DELETE /auth` when the request carries a valid session. Invalidate the token here; afterwards the endpoint
     * closes every WebSocket connection that was opened with this token and clears the cookie.
     *
     * @param token The token of the user.
     * @returns Resolves when the session is gone. A rejection reaches Express' error handler (HTTP 500) and the cookie is
     *     not cleared, so prefer resolving.
     */
    abstract destroy(token: string): Promise<void>;

    /**
     * Refresh a token.
     *
     * Called by `PUT /auth/refresh` (rate limited) with `old_token` from the JSON body. The endpoint does not check that
     * `old_token` belongs to the caller, so validate it here and revoke it if you rotate tokens. `Ok(newToken)` is set as the
     * new `token` cookie.
     *
     * @param old_token The old token.
     * @typeParam TErr - Error type.
     * @returns The new session token, or an error (HTTP 401).
     */
    abstract refreshToken<TErr = unknown>(old_token: string): Promise<Result<string, TErr>>;

    /**
     * Request 2FA for a user.
     *
     * Called by `POST /2fa/request` for the authenticated user. Generate a new TOTP secret, store it as *pending* for this
     * user, and return a provisioning URL (usually `otpauth://...`); the client receives `{ url }`. The pending secret is what
     * {@link AuthProvider.enable2FA} must later compare with.
     *
     * @param userId The ID of the user.
     * @typeParam TErr - Error type.
     * @returns The provisioning URL, or an error (HTTP 401).
     */
    abstract request2FA<TErr = unknown>(userId: string): Promise<Result<string, TErr>>;

    /**
     * Enable 2FA for a user.
     *
     * SECURITY REQUIREMENT:
     * The AuthProvider implementation MUST verify that the provided `secret` matches the one
     * generated and issued by the server during `request2FA` for this `userId`, rather than
     * trusting an arbitrary secret supplied by the client.
     *
     * Called by `POST /2fa/enable` (authenticated, rate limited) with `secret` and `code` from the JSON body; both are required
     * (HTTP 400 otherwise). Also verify that `code` is a valid TOTP code for that secret before you enable 2FA.
     *
     * @param userId - Id of the authenticated user.
     * @param secret - Secret sent back by the client; must equal the pending secret issued by {@link AuthProvider.request2FA}.
     * @param code - Current TOTP code generated from `secret`.
     * @typeParam TErr - Error type.
     * @returns `Ok(true)` when 2FA is now enabled (sent as `{ success: true }`), or an error (HTTP 401).
     */
    abstract enable2FA<TErr = unknown>(userId: string, secret: string, code: string): Promise<Result<boolean, TErr>>;

    /**
     * Verify 2FA for a user.
     *
     * Called by `POST /2fa/verify` (public, rate limited) to complete a login that {@link AuthProvider.auth} answered with a
     * 2FA challenge. All three body fields are required (HTTP 400 otherwise). Return `Ok(token)` to log the user in (cookie
     * set, empty body) or `Ok(boolean)` to answer `{ success }` without a session.
     *
     * @param accountName The account name.
     * @param code The verification code.
     * @param uuid The UUID of the user.
     * @typeParam TErr - Error type.
     * @returns A session token, a boolean, or an error (HTTP 401).
     */
    abstract verify2FA<TErr = unknown>(accountName: string, code: string, uuid: string): Promise<Result<Token | boolean, TErr>>;

    /**
     * Disable 2FA for a user.
     *
     * SECURITY REQUIREMENT:
     * The implementation MUST require a valid TOTP `code` and reject the call when it is missing or wrong. The endpoint
     * (`DELETE /2fa/disable`, authenticated and rate limited) reads `code` from the JSON body or the query string and passes it
     * through unchecked, so without this check a stolen session could turn 2FA off.
     *
     * @param userId The ID of the user.
     * @param code Optional TOTP verification code to verify user authorization before disabling 2FA.
     * @typeParam TErr - Error type.
     * @returns `Ok(true)` when 2FA is disabled (sent as `{ success: true }`), or an error (HTTP 401).
     */
    abstract disable2FA<TErr = unknown>(userId: string, code?: string): Promise<Result<boolean, TErr>>;

    /**
     * Request an upload URL.
     *
     * Not called by the built-in routes (MinIO uploads are handled by `POST /attachments/upload` through
     * {@link MinioService}); implement it for your own code or return an `Err`.
     *
     * @param attachmentId The attachment ID.
     * @param fileName The file name.
     * @param mimeType The mime type.
     * @typeParam TErr - Error type.
     * @returns A URL the client can upload to.
     */
    abstract requestUploadUrl<TErr = unknown>(attachmentId: string, fileName: string, mimeType: string): Promise<Result<string, TErr>>;

    /**
     * Request a download URL.
     *
     * Not called by the built-in routes (see {@link AuthProvider.requestUploadUrl}).
     *
     * @param attachmentId The attachment ID.
     * @param fileName The file name.
     * @typeParam TErr - Error type.
     * @returns A URL the client can download from.
     */
    abstract requestDownloadUrl<TErr = unknown>(attachmentId: string, fileName: string): Promise<Result<string, TErr>>;

    /**
     * Process mobile requests. This method is used to process requests from the mobile application.
     *
     * Called by `POST /mobile/:module/:action` for authenticated users (cookie requests must send JSON or an
     * `X-Requested-With`/`X-CSRF-Token` header). The returned object becomes the JSON response and its `status` the HTTP status.
     * A thrown error is answered with HTTP 500.
     *
     * @param data The mobile request data.
     * @typeParam MODULE - Module names you support.
     * @typeParam ACTION - Action names you support.
     * @typeParam R - Result payload type.
     * @typeParam E - Error payload type.
     * @returns The response to send.
     */
    abstract mobileRequests<MODULE extends string = string, ACTION extends string = string, R = unknown, E = unknown>(
        data: MobileRequestType<MODULE, ACTION>,
    ): Promise<MobileResponseType<R, E>>;
}
