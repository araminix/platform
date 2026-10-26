import type { ActivityDriver } from '../executor/ActivityInstance.js';
import type { Actor } from '../lib/actors.js';
import type { FragmentInterface } from './Fragment.js';
import { Panel } from './Panel.js';

export type OnAction<D = unknown> = (data: D) => Promise<Actor> | Actor;
export type Response<D = unknown, R = unknown> = (data: D) => Promise<R> | R;

export interface Part {
    _build(): BuildedPart;
}

export type BuildedPart = {
    id: string;
    type: string;
    styles?: Array<string>;
    content?: Array<BuildedPart>;
};

class Builder {
    private fragments: Map<string, FragmentInterface> = new Map();
    private mainPanel?: Panel = undefined;
    private panelStack: Panel[] = [];
    private activityFragmentDriver?: ActivityDriver;

    pushPanel(panel: Panel): void {
        if (!this.mainPanel) {
            this.mainPanel = panel;
        } else {
            this.panelStack[this.panelStack.length - 1]._addPanel(panel);
        }
        this.panelStack.push(panel);
    }

    addFragment(fragmentBuilderDriver: FragmentInterface): ActivityDriver {
        this.panelStack[this.panelStack.length - 1]._addFragment(fragmentBuilderDriver);
        this.fragments.set(fragmentBuilderDriver.id, fragmentBuilderDriver);
        return this.activityFragmentDriver!;
    }

    popPanel(): void {
        this.panelStack.pop();
    }

    async build(
        fragmentDriver: ActivityDriver,
        render: () => void | Promise<void>,
    ): Promise<{
        fragments: Map<string, FragmentInterface>;
        mainPanel: Panel;
    }> {
        this.activityFragmentDriver = fragmentDriver;
        this.fragments = new Map();
        this.mainPanel = new Panel(undefined);
        this.panelStack = [this.mainPanel];

        await render();

        const result = {
            fragments: this.fragments,
            mainPanel: this.mainPanel,
        };
        this.fragments = new Map();
        this.mainPanel = undefined;
        this.activityFragmentDriver = undefined;
        this.panelStack = [];
        return result;
    }
}

const builder = new Builder();
export default builder;
