import { Ok } from '@araminix/lib';

import { AuthProvider, UserInfo } from '../../src/server/AuthProvider.js';

/** Creates a mock {@link AuthProvider} with sensible defaults and optional per-method overrides. */
export function createMockAuth(overrides: Partial<AuthProvider> = {}): AuthProvider {
    return {
        getInfo: async (token: string) => {
            if (token === 'valid-token') {
                return new Ok(new UserInfo('user-1', 'john', 'John Doe', 'rt-1', 'john@example.com', [], { _key: 'u1', name: 'Unit 1', code: 'U1' }));
            }
            return { isErr: () => true, isOk: () => false, unwrap: () => null } as any;
        },
        auth: async () => new Ok('valid-token'),
        googleAuth: async () => new Ok('valid-token'),
        destroy: async () => {},
        refreshToken: async () => new Ok('valid-token'),
        request2FA: async () => ({}) as any,
        verify2FA: async () => new Ok('valid-token'),
        enable2FA: async () => ({}) as any,
        disable2FA: async () => ({}) as any,
        requestUploadUrl: async () => ({}) as any,
        requestDownloadUrl: async () => ({}) as any,
        mobileRequests: async () => ({ status: 200 }) as any,
        ...overrides,
    };
}
