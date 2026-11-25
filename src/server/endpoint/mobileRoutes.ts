import { logger } from '@araminix/lib';
import expressWs from 'express-ws';

import { AuthProvider } from '../AuthProvider.js';
import { validateToken } from './security.js';
import { CustomRequest } from './types.js';

/** Registers `POST /mobile/:module/:action`, which forwards to {@link AuthProvider.mobileRequests}. */
export function registerMobileRoutes(express: expressWs.Application, mount: string, authProvider: AuthProvider): void {
    express.post(`${mount}/mobile/:module/:action`, validateToken, async (req: CustomRequest, res) => {
        try {
            const moduleName = String(req.params.module);
            const action = String(req.params.action);
            if (!moduleName || !action) {
                res.status(400).send({ error: 'Module and action are both required.' }).end();
                return;
            }
            const result = await authProvider.mobileRequests({
                module: moduleName,
                action,
                userId: req.info?.id ?? '',
                data: req.body,
            });
            if (result.status !== 200) {
                logger.error('API Auth - Mobile Request Error: ', result.error);
            }
            res.status(result.status).send(result).end();
        } catch (error) {
            logger.error('Request failed:', error);
            res.status(500).send({ error: 'Internal server error' }).end();
        }
    });
}
