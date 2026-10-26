import assert from 'node:assert';
import { describe, it } from 'node:test';

import builder from '../src/builder/builder.js';
import Fragment from '../src/builder/Fragment.js';
import panel, { Panel } from '../src/builder/Panel.js';

class MockFragment extends Fragment<{ label: string; styles?: string[] }, string> {
    async load(): Promise<string> {
        return this.input.label;
    }
}

describe('UI Builder & Fragments', () => {
    it('builds nested panels and registers fragments', async () => {
        const mockActivityDriver: any = {
            push: async () => {},
            trigger: async () => {},
        };

        const buildResult = await builder.build(mockActivityDriver, async () => {
            await panel({
                styles: ['flex', 'col'],
                render: async () => {
                    new MockFragment({ label: 'Hello Fragment' });
                },
            });
        });

        assert.ok(buildResult.mainPanel instanceof Panel);
        assert.strictEqual(buildResult.fragments.size, 1);

        const frag = [...buildResult.fragments.values()][0];
        assert.strictEqual(frag.type, 'MockFragment');
        const loadedData = await frag.load();
        assert.strictEqual(loadedData, 'Hello Fragment');

        const tree = buildResult.mainPanel._build();
        assert.strictEqual(tree.type, 'Panel');
        assert.ok(Array.isArray(tree.content));
        assert.strictEqual(tree.content!.length, 1);
    });
});
