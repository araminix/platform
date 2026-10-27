import { FileInfo, Result, t } from '@araminix/lib';

/**
 * Runtime codec (io-ts) for the Google profile that `POST /gauth` hands to {@link AuthProvider.googleAuth}.
 *
 * The {@link Endpoint} first checks the access token with Google's `tokeninfo` endpoint (audience or authorized party in
 * `googleClientIds`, verified e-mail), then fetches `userinfo` and only calls `googleAuth` when the payload passes
 * `GoogleData.is(...)`. A payload that fails the check is answered with HTTP 500. Extra properties are allowed and kept.
 *
 * @example
 * ```ts
 * import { GoogleData } from '@araminix/platform';
 *
 * const payload: unknown = await fetchProfile();
 * if (GoogleData.is(payload)) {
 *     console.log(payload.email, payload.given_name);
 * }
 * ```
 */
export const GoogleData = t.type({
    email: t.string,
    given_name: t.string,
    family_name: t.string,
    name: t.string,
    picture: t.string,
});

/**
 * Static type of a verified Google profile ({@link GoogleData}): `email`, `given_name`, `family_name`, `name` and `picture`
 * (all strings).
 */
export type GoogleDataType = t.TypeOf<typeof GoogleData>;
/** A session token issued by the {@link AuthProvider}; opaque to the platform. */
type Token = string;

/**
 * Kind of client behind a session. {@link Platform} serves `User` clients on the `platform` and `instance` endpoints and
 * `Agent` clients on the `agent` endpoint; any other combination is denied.
 */
export enum ClientType {
    /** A machine agent (see {@link AgentInfo}) that connects to the `agent` endpoint. */
    Agent = 'Agent',
    /** A person using a front-end (see {@link UserInfo}) that connects to the `platform` and `instance` endpoints. */
    User = 'User',
}

/**
 * Identity of an authenticated client, as resolved by {@link AuthProvider.getInfo}.
 *
 * The platform only relies on the three abstract fields. Providers normally return a {@link UserInfo} for people and an
 * {@link AgentInfo} for agents; a subclass with extra fields is passed unchanged to `onCustomStream` handlers and, with the
 * 2FA secret removed, to the `clientInfo` stream.
 *
 * @remarks
 * WebSocket connections are keyed by `clientType/runtimeId/arg`: a client that reconnects with the same `runtimeId`
 * resumes its existing connection, and {@link Platform} keeps app instances per `runtimeId`. Use one `runtimeId` per
 * login session (or per device) so that two sessions of the same user do not share connections and instances.
 */
export abstract class ClientInfo {
    /** Kind of client; decides which endpoints accept it. */
    abstract clientType: ClientType;
    /**
     * Stable id of the user or agent. For users it is the `userId` of their app instances, the owner recorded for uploads and
     * the prefix of their MinIO attachment keys; for agents it is the id used by {@link AgentFactory.acquire}.
     */
    abstract id: string;
    /** Id of the client runtime (session or device); see the class remarks. */
    abstract runtimeId: string;
}

/** Per-table UI preferences, keyed by table id. Stored and interpreted by your application; the platform only passes it through. */
export interface SettingTablePreference {
    [key: string]: {
        /** Collapsed direction of the table, or `null`/`undefined` when expanded. */
        collapsed: 'horizontal' | 'vertical' | null | undefined;
        /** Visible columns, in display order. */
        columns: string[];
    };
}

/** Per-card UI preferences, keyed by card id. Passed through unchanged. */
export interface SettingCardPreference {
    [key: string]: {
        /** Collapsed direction of the card, or `null`/`undefined` when expanded. */
        collapsed: 'horizontal' | 'vertical' | null | undefined;
    };
}

/** Notification preferences of a user. Passed through unchanged. */
export interface SettingNotification {
    /** Whether the user receives notifications at all. */
    enabled: boolean;
    /** Channels the user accepts. */
    channels: Array<'app' | 'sms' | 'push' | 'email'>;
    /** Channel used when a notification does not ask for a specific one. */
    default_channel: 'app' | 'sms' | 'push' | 'email';
    /** Push-channel settings. */
    push?: {
        /** Telegram chat id used for push messages. */
        telegram_id: string;
    };
}

/**
 * Two-factor authentication state of a user as stored by your {@link AuthProvider}.
 *
 * Only `enabled` ever leaves the server: {@link UserInfo} drops `code` and `secret` in its constructor and
 * {@link Platform} strips them again before answering the `clientInfo` stream.
 */
export type SettingTwoFactor = {
    /** Whether 2FA is active for the user. */
    enabled: boolean;
    /** Server-side only: a pending verification code or challenge id. Never sent to clients. */
    code?: string | null;
    /** Server-side only: the TOTP secret. Never sent to clients. */
    secret?: string | null;
};

/** Full settings record of a user as stored by your application (including server-only 2FA fields). */
export type UserSetting = {
    /** Notification preferences. */
    notifications: SettingNotification;
    /** Ids of the widgets (apps with `widget: true`) the user placed on the dashboard. */
    widgets: Array<string>;
    /** 2FA state, including server-only fields. */
    two_factor: SettingTwoFactor;
    /** Table layout preferences. */
    table_preferences?: SettingTablePreference;
    /** Card layout preferences. */
    card_preferences?: SettingCardPreference;
};

/**
 * Identity of a person, returned by {@link AuthProvider.getInfo} for front-end sessions.
 *
 * The constructor keeps only `enabled` from `settings.two_factor`, so a 2FA secret or code read from your database can
 * never reach a client through this object.
 *
 * @example
 * ```ts
 * import { Ok, UserInfo } from '@araminix/platform';
 *
 * const info = new UserInfo(user.id, user.username, user.name, sessionId, user.email, user.units, user.units[0], undefined, 'en', undefined, {
 *     notifications: user.settings.notifications,
 *     widgets: user.settings.widgets,
 *     two_factor: { enabled: user.settings.two_factor.enabled },
 * });
 * return new Ok(info);
 * ```
 */
export class UserInfo extends ClientInfo {
    /** User id (see {@link ClientInfo.id}). */
    readonly id: string;
    /** Login name. */
    readonly username: string;
    /** Display name. */
    readonly name: string;
    /** Session or device id (see {@link ClientInfo.runtimeId}). */
    readonly runtimeId: string;
    /** E-mail address. */
    readonly email: string;
    /** Organisational units the user belongs to. */
    readonly units: {
        _key: string;
        name: string;
        code: string;
    }[];
    /** The unit the user currently works in. */
    readonly activeUnit: {
        _key: string;
        name: string;
        code: string;
    };
    /** Profile picture, as returned by `POST /file`. */
    readonly picture?: FileInfo | undefined;
    /** Preferred UI language code. */
    readonly language?: string | undefined;
    /** Optional key of the matching employee record in your system. */
    readonly employeeKey?: string | undefined;
    /** User settings without the 2FA `secret` and `code`. */
    readonly settings?:
        | {
              notifications: SettingNotification;
              widgets: Array<string>;
              two_factor: Omit<SettingTwoFactor, 'secret'>;
          }
        | undefined;
    /** Always {@link ClientType.User}. */
    readonly clientType = ClientType.User;

    /**
     * @param id - User id.
     * @param username - Login name.
     * @param name - Display name.
     * @param runtimeId - Session or device id; see {@link ClientInfo.runtimeId}.
     * @param email - E-mail address.
     * @param units - Units (`{ _key, name, code }`) the user belongs to.
     * @param activeUnit - The unit the user currently works in.
     * @param picture - Optional profile picture.
     * @param language - Optional preferred language code.
     * @param employeeKey - Optional employee record key.
     * @param settings - Optional settings; `two_factor` is reduced to `{ enabled }`.
     */
    constructor(
        id: string,
        username: string,
        name: string,
        runtimeId: string,
        email: string,
        units: {
            _key: string;
            name: string;
            code: string;
        }[],
        activeUnit: {
            _key: string;
            name: string;
            code: string;
        },
        picture?: FileInfo | undefined,
        language?: string | undefined,
        employeeKey?: string | undefined,
        settings?:
            | {
                  notifications: SettingNotification;
                  widgets: Array<string>;
                  two_factor: Omit<SettingTwoFactor, 'secret'>;
              }
            | undefined,
    ) {
        super();
        this.id = id;
        this.username = username;
        this.name = name;
        this.runtimeId = runtimeId;
        this.email = email;
        this.units = units;
        this.activeUnit = activeUnit;
        this.picture = picture;
        this.language = language;
        this.employeeKey = employeeKey;
        if (settings && (settings as any).two_factor) {
            const { secret: _secret, code: _code, enabled } = (settings as any).two_factor;
            this.settings = {
                ...settings,
                two_factor: {
                    enabled: Boolean(enabled),
                },
            };
        } else {
            this.settings = settings;
        }
    }
}

/**
 * Identity of a machine agent, returned by {@link AuthProvider.getInfo} for agent tokens.
 *
 * `agentType` must be the name of an {@link AgentFactory} property on your {@link AgentIndex}; the agent's worker thread
 * fails to start (and the connection is denied) otherwise. `runtimeId` is the agent id.
 *
 * @example
 * ```ts
 * import { AgentInfo, Ok } from '@araminix/platform';
 *
 * // A token that belongs to the label printer "printer-1":
 * return new Ok(new AgentInfo('printer-1', 'printer'));
 * ```
 */
export class AgentInfo extends ClientInfo {
    /** Agent id; unique across all agents. */
    id: string;
    /** Agent type: the name of the {@link AgentFactory} property on the {@link AgentIndex}. */
    agentType: string;
    /** Always {@link ClientType.Agent}. */
    readonly clientType = ClientType.Agent;
    /** Same as {@link AgentInfo.id}. */
    readonly runtimeId: string;

    /**
     * @param id - Agent id (also used as `runtimeId`).
     * @param agentType - Name of the agent type on the {@link AgentIndex}.
     */
    constructor(id: string, agentType: string) {
        super();
        this.id = id;
        this.agentType = agentType;
        this.runtimeId = id;
    }
}

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
     *
     * @example
     * ```ts
     * async mobileRequests<MODULE extends string = string, ACTION extends string = string, R = unknown, E = unknown>(
     *     data: MobileRequestType<MODULE, ACTION>,
     * ): Promise<MobileResponseType<R, E>> {
     *     if (data.module === 'tasks' && data.action === 'list') {
     *         return { status: 200, result: (await tasks.forUser(data.userId)) as R };
     *     }
     *     return { status: 404, message: 'Unknown action' };
     * }
     * ```
     */
    abstract mobileRequests<MODULE extends string = string, ACTION extends string = string, R = unknown, E = unknown>(
        data: MobileRequestType<MODULE, ACTION>,
    ): Promise<MobileResponseType<R, E>>;
}
