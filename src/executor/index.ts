/**
 * Public part of the executor: the {@link AppResult} type and the {@link workerDriver} accessor.
 *
 * @module
 */
import type { ActivityDriver, AppError, AppInstance, AppResult } from './AppInstance.js';
import workerDriver from './workerDriver.js';

export { ActivityDriver, AppError, AppInstance, AppResult, workerDriver };
