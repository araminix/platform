import { Result } from '@araminix/lib';

/** Why an activity operation failed inside an app worker (the `E` of {@link AppResult}). */
export enum AppError {
    /** The actor or request does not apply: unknown fragment, action or activity, or an actor of another activity/wizard. */
    WrongAction = 'WrongAction',
    /** The target activity is not the active one. */
    NonActive = 'NonActive',
    /** Reserved; not produced by the runtime. */
    Skipped = 'Skipped',
    /** Reserved; not produced by the runtime. */
    NotFound = 'NotFound',
    /** A message to the main thread failed (no client connected, stream closed with an error, channel closed). */
    Other = 'Other',
}

/**
 * Result of activity operations such as {@link Activity.trigger}, {@link Activity.push} and {@link Fragment.push}: `Ok`
 * or `Err(AppError)`.
 */
export type AppResult = Result<void, AppError>;
