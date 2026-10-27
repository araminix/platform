import assert from 'node:assert';
import { describe, it } from 'node:test';

import builder from '../src/builder/builder.js';
import Fragment from '../src/builder/Fragment.js';
import { AgentPost, Data, deserialize } from '../src/executor/proto.js';
import { Res, typeNameOf } from '../src/lib/worker_socket.js';

function withRenamedClass<T>(cls: Function, minifiedName: string, run: () => T): T {
    const original = Object.getOwnPropertyDescriptor(cls, 'name')!;
    Object.defineProperty(cls, 'name', { value: minifiedName, configurable: true });
    try {
        return run();
    } finally {
        Object.defineProperty(cls, 'name', original);
    }
}

describe('Minification-safe type names', () => {
    it('keeps worker message wire names when class names are mangled', () => {
        withRenamedClass(AgentPost, 'a', () => {
            const message = new AgentPost('hello', { x: 1 });
            assert.strictEqual(message._type, 'AgentPost');
            const restored = deserialize(JSON.parse(JSON.stringify(message)));
            assert.ok(restored instanceof AgentPost);
            assert.strictEqual(restored.name, 'hello');
        });
        withRenamedClass(Data, 'b', () => {
            assert.ok(deserialize({ ...new Data(42) }) instanceof Data);
        });
    });

    it('uses only a class own typeName, falling back to the class name', () => {
        class CustomRes extends Res {}
        assert.strictEqual(typeNameOf(Res), 'Res');
        assert.strictEqual(typeNameOf(CustomRes), 'CustomRes', 'an undeclared subclass must not inherit its parent typeName');
    });

    it('sends a fragment static typeName to the frontend', async () => {
        class Chart extends Fragment<{ styles?: string[] }> {
            static readonly typeName = 'Chart';
            load(): void {}
        }
        class Table extends Fragment<{ styles?: string[] }> {
            load(): void {}
        }
        const driver: any = { push: async () => {}, trigger: async () => {} };
        const built = await withRenamedClass(Chart, 'c', () =>
            builder.build(driver, () => {
                new Chart({});
                new Table({});
            }),
        );
        assert.deepStrictEqual(
            [...built.fragments.values()].map((fragment) => fragment.type),
            ['Chart', 'Table'],
        );
    });
});
