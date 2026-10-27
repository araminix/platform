import { AsyncLocalStorage } from 'node:async_hooks';

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

type BuildState = {
    fragments: Map<string, FragmentInterface>;
    mainPanel?: Panel;
    panelStack: Panel[];
    activityFragmentDriver?: ActivityDriver;
};

class Builder {
    // Every build() gets its own async context, so renders that overlap (e.g. a timer-triggered refresh) cannot mix fragments.
    private storage: AsyncLocalStorage<BuildState> = new AsyncLocalStorage();
    private fallback: BuildState = { fragments: new Map(), panelStack: [] };

    private get state(): BuildState {
        return this.storage.getStore() ?? this.fallback;
    }

    pushPanel(panel: Panel): void {
        const state = this.state;
        if (!state.mainPanel) {
            state.mainPanel = panel;
        } else {
            state.panelStack[state.panelStack.length - 1]._addPanel(panel);
        }
        state.panelStack.push(panel);
    }

    addFragment(fragmentBuilderDriver: FragmentInterface): ActivityDriver {
        const state = this.state;
        state.panelStack[state.panelStack.length - 1]._addFragment(fragmentBuilderDriver);
        state.fragments.set(fragmentBuilderDriver.id, fragmentBuilderDriver);
        return state.activityFragmentDriver!;
    }

    popPanel(): void {
        this.state.panelStack.pop();
    }

    async build(
        fragmentDriver: ActivityDriver,
        render: () => void | Promise<void>,
    ): Promise<{
        fragments: Map<string, FragmentInterface>;
        mainPanel: Panel;
    }> {
        const mainPanel = new Panel(undefined);
        const state: BuildState = {
            fragments: new Map(),
            mainPanel,
            panelStack: [mainPanel],
            activityFragmentDriver: fragmentDriver,
        };
        await this.storage.run(state, render);
        return {
            fragments: state.fragments,
            mainPanel,
        };
    }
}

const builder = new Builder();
export default builder;
