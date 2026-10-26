import { FileInfo, Result, t } from '@araminix/lib';

export const GoogleData = t.type({
    email: t.string,
    given_name: t.string,
    family_name: t.string,
    name: t.string,
    picture: t.string,
});

export type GoogleDataType = t.TypeOf<typeof GoogleData>;
type Token = string;

export enum ClientType {
    Agent = 'Agent',
    User = 'User',
}

export abstract class ClientInfo {
    abstract clientType: ClientType;
    abstract id: string;
    abstract runtimeId: string;
}

export interface SettingTablePreference {
    [key: string]: {
        collapsed: 'horizontal' | 'vertical' | null | undefined;
        columns: string[];
    };
}

export interface SettingCardPreference {
    [key: string]: {
        collapsed: 'horizontal' | 'vertical' | null | undefined;
    };
}

export interface SettingNotification {
    enabled: boolean;
    channels: Array<'app' | 'sms' | 'push' | 'email'>;
    default_channel: 'app' | 'sms' | 'push' | 'email';
    push?: {
        telegram_id: string;
    };
}

export type SettingTwoFactor = {
    enabled: boolean;
    code?: string | null;
    secret?: string | null;
};

export type UserSetting = {
    notifications: SettingNotification;
    widgets: Array<string>;
    two_factor: SettingTwoFactor;
    table_preferences?: SettingTablePreference;
    card_preferences?: SettingCardPreference;
};

export class UserInfo extends ClientInfo {
    readonly id: string;
    readonly username: string;
    readonly name: string;
    readonly runtimeId: string;
    readonly email: string;
    readonly units: {
        _key: string;
        name: string;
        code: string;
    }[];
    readonly activeUnit: {
        _key: string;
        name: string;
        code: string;
    };
    readonly picture?: FileInfo | undefined;
    readonly language?: string | undefined;
    readonly employeeKey?: string | undefined;
    readonly settings?:
        | {
              notifications: SettingNotification;
              widgets: Array<string>;
              two_factor: Omit<SettingTwoFactor, 'secret'>;
          }
        | undefined;
    readonly clientType = ClientType.User;

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
        this.settings = settings;
    }
}

export class AgentInfo extends ClientInfo {
    id: string;
    agentType: string;
    readonly clientType = ClientType.Agent;
    readonly runtimeId: string;

    constructor(id: string, agentType: string) {
        super();
        this.id = id;
        this.agentType = agentType;
        this.runtimeId = id;
    }
}

export type MobileRequestType<MODULE extends string = string, ACTION extends string = string, TData = unknown> = {
    module: MODULE;
    action: ACTION;
    userId: string;
    data: TData;
};

export type MobileResponseType<R = unknown, E = unknown> = {
    status: number;
    message?: string;
    error?: E;
    result?: R;
};

export abstract class AuthProvider {
    abstract getInfo<TClient extends ClientInfo = ClientInfo, TErr = unknown>(token: Token): Promise<Result<TClient, TErr>>;
    abstract auth<TAuthData = unknown, TErr = unknown>(data: TAuthData): Promise<Result<Token | { twoFactorCode: string; accountName: string }, TErr>>;
    abstract googleAuth<TErr = unknown>(data: GoogleDataType): Promise<Result<Token | { twoFactorCode: string; accountName: string }, TErr>>;
    abstract destroy(token: string): Promise<void>;
    abstract refreshToken<TErr = unknown>(old_token: string): Promise<Result<string, TErr>>;
    abstract request2FA<TErr = unknown>(userId: string): Promise<Result<string, TErr>>;
    abstract enable2FA<TErr = unknown>(userId: string, secret: string, code: string): Promise<Result<boolean, TErr>>;
    abstract verify2FA<TErr = unknown>(accountName: string, code: string, uuid: string): Promise<Result<Token | boolean, TErr>>;
    abstract disable2FA<TErr = unknown>(userId: string): Promise<Result<boolean, TErr>>;
    abstract requestUploadUrl<TErr = unknown>(attachmentId: string, fileName: string, mimeType: string): Promise<Result<string, TErr>>;
    abstract requestDownloadUrl<TErr = unknown>(attachmentId: string, fileName: string): Promise<Result<string, TErr>>;
    abstract mobileRequests<MODULE extends string = string, ACTION extends string = string, R = unknown, E = unknown>(
        data: MobileRequestType<MODULE, ACTION>,
    ): Promise<MobileResponseType<R, E>>;
}
