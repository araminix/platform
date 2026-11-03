/**
 * Public part of the executor: the {@link AppResult} type and the {@link workerDriver} accessor.
 *
 * @module
 */
import { AppError, AppResult } from './AppInstance.js';
import workerDriver from './workerDriver.js';

export { AppError, AppResult, workerDriver };
