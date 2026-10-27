import assert from 'node:assert';
import { describe, it } from 'node:test';

import { AppInstance } from '../src/executor/AppInstance.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('AppInstance activity lock', () => {
    it('runs exclusive tasks one at a time, in call order', async () => {
        const app = new AppInstance({} as any, 12);
        const events: string[] = [];
        const task = (name: string, ms: number) =>
            app.exclusive(async () => {
                events.push(`${name}:start`);
                await sleep(ms);
                events.push(`${name}:end`);
            });

        await Promise.all([task('a', 20), task('b', 1)]);
        assert.deepStrictEqual(events, ['a:start', 'a:end', 'b:start', 'b:end']);
    });

    it('runs calls made inside a task directly instead of deadlocking', async () => {
        const app = new AppInstance({} as any, 12);
        const result = await app.exclusive(async () => await app.exclusive(async () => 'inner'));
        assert.strictEqual(result, 'inner');
    });

    it('keeps the lock usable after a task throws', async () => {
        const app = new AppInstance({} as any, 12);
        await assert.rejects(
            app.exclusive(async () => {
                throw new Error('boom');
            }),
        );
        assert.strictEqual(await app.exclusive(async () => 'next'), 'next');
    });

    it('makes a timer started in a finished task wait for the task that holds the lock', async () => {
        const app = new AppInstance({} as any, 12);
        const events: string[] = [];
        let timerDone!: Promise<void>;
        await app.exclusive(async () => {
            timerDone = new Promise((resolve) => {
                setTimeout(() => {
                    app.exclusive(async () => {
                        events.push('timer');
                    }).then(resolve);
                }, 10);
            });
        });
        const holder = app.exclusive(async () => {
            events.push('holder:start');
            await sleep(30);
            events.push('holder:end');
        });

        await Promise.all([holder, timerDone]);
        assert.deepStrictEqual(events, ['holder:start', 'holder:end', 'timer']);
    });

    it('queues timers started through outsideLock even while their own task is still running', async () => {
        const app = new AppInstance({} as any, 12);
        const events: string[] = [];
        let timerDone!: Promise<void>;
        await app.exclusive(async () => {
            app.outsideLock(() => {
                timerDone = new Promise((resolve) => {
                    setTimeout(() => {
                        app.exclusive(async () => {
                            events.push('timer');
                        }).then(resolve);
                    }, 5);
                });
            });
            events.push('task:start');
            await sleep(30);
            events.push('task:end');
        });

        await timerDone;
        assert.deepStrictEqual(events, ['task:start', 'task:end', 'timer']);
    });
});
