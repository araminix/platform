import { AsyncLocalStorage } from 'node:async_hooks';

// Serializes everything that changes an app's activities: requests from the main thread and trigger() calls made
// from timers or callbacks. Calls made while the lock is held (e.g. trigger() awaited inside an action) run directly.
/**
 * Mutex of one app instance (a promise chain) with re-entrancy based on `AsyncLocalStorage`.
 *
 * {@link ActivityLock.run} waits for every earlier task and then runs its task with a "held" token in the async context.
 * A `run` call made from inside a task (directly or in code it awaits) sees the token and runs immediately instead of
 * deadlocking. When the task ends the token is cleared, so callbacks created during the task (timers, event handlers)
 * queue like any other caller from then on.
 *
 * @remarks
 * Known limit: a timer started directly inside a task inherits the token. If it fires while that task is still running,
 * its `run` call executes immediately, inside the task, instead of waiting. Timers started from `afterWake()` are not
 * affected: the runtime calls `afterWake()` through {@link ActivityLock.outside}, so they never carry the token and always
 * queue. Wrap other timer set-ups in `outsideLock()` for the same effect.
 */
export class ActivityLock {
    /** Settles when the last queued task has finished. */
    private tail: Promise<void> = Promise.resolve();
    /** Token of the task that holds the lock in the current async context. */
    private readonly holder: AsyncLocalStorage<{ held: boolean }> = new AsyncLocalStorage();

    /**
     * Runs `task` exclusively, or directly when the caller already holds the lock.
     *
     * @typeParam T - Task result type.
     * @param task - The work to run.
     * @returns The task's result; a rejection is passed through and the lock is released anyway.
     */
    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.holder.getStore()?.held) {
            return task();
        }
        const previous = this.tail;
        let release!: () => void;
        this.tail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        // Timers created inside the task inherit this token; clearing `held` on release makes them queue like any other caller.
        const token = { held: true };
        try {
            return await this.holder.run(token, task);
        } finally {
            token.held = false;
            release();
        }
    }

    /**
     * Runs `callback` without the lock token in its async context, so timers and callbacks it creates queue for the lock.
     *
     * @typeParam T - Callback result type.
     * @param callback - The code to run.
     */
    outside<T>(callback: () => T): T {
        return this.holder.exit(callback);
    }
}
