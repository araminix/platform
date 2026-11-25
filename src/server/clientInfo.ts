import { FileInfo, t } from '@araminix/lib';

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
