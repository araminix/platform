import { AsyncLocalStorage } from 'node:async_hooks';

import type { ActivityDriver } from '../executor/ActivityInstance.js';
import type { Actor } from '../lib/actors.js';
import type { FragmentInterface } from './Fragment.js';
import { Panel } from './Panel.js';

/**
 * Handler of a fragment action (see {@link Fragment.onAction}): receives the data sent by the client and returns the
 * {@link Actor} to apply.
 *
 * @typeParam D - Type of the action data.
 */
export type OnAction<D = unknown> = (data: D) => Promise<Actor> | Actor;
/**
 * Handler of a fragment query (see {@link Fragment.onQuery}): receives the data sent by the client and returns the value
 * sent back.
 *
 * @typeParam D - Type of the query data.
 * @typeParam R - Type of the answer.
 */
export type Response<D = unknown, R = unknown> = (data: D) => Promise<R> | R;

/** A node of the UI tree: a {@link Panel} or a fragment. */
export interface Part {
    /** Serialises the node for the client. */
    _build(): BuildedPart;
}

/**
 * Wire format of the UI tree sent on the `build` stream: panels (`type: 'Panel'`, with `content`) and fragments (`type`
 * = the fragment's type name, see {@link typeNameOf}).
 */
export type BuildedPart = {
    /** Node id; for fragments, the id the client uses for actions, queries and updates. */
    id: string;
    /** `'Panel'` or the fragment's type name. */
    type: string;
    /** Style names chosen by the app; their meaning is defined by the front-end. */
    styles?: Array<string>;
    /** Children of a panel, in creation order. */
    content?: Array<BuildedPart>;
};

/** State of one render: the fragments created so far and the stack of open panels. */
type BuildState = {
    fragments: Map<string, FragmentInterface>;
    mainPanel?: Panel;
    panelStack: Panel[];
    activityFragmentDriver?: ActivityDriver;
};

/**
 * Collects the panels and fragments created while an activity renders. Each {@link Builder.build} call runs the render
 * function in its own async context, so overlapping renders (for example a timer-triggered refresh) never mix their
 * fragments.
 */
class Builder {
    // Every build() gets its own async context, so renders that overlap (e.g. a timer-triggered refresh) cannot mix fragments.
    /** Holds the state of the build running in the current async context. */
    private storage: AsyncLocalStorage<BuildState> = new AsyncLocalStorage();
    /** State used outside of any build (panels and fragments created there are lost or fail). */
    private fallback: BuildState = { fragments: new Map(), panelStack: [] };

    /** State of the build running in the current async context. */
    private get state(): BuildState {
        return this.storage.getStore() ?? this.fallback;
    }

    /** Adds `panel` to the current panel (or makes it the root) and makes it the current panel. */
    pushPanel(panel: Panel): void {
        const state = this.state;
        if (!state.mainPanel) {
            state.mainPanel = panel;
        } else {
            state.panelStack[state.panelStack.length - 1]._addPanel(panel);
        }
        state.panelStack.push(panel);
    }

    /**
     * Adds a fragment to the current panel and registers it for actions and queries.
     *
     * @returns The driver of the activity being rendered.
     * @throws TypeError when called outside of a render (there is no current panel).
     */
    addFragment(fragmentBuilderDriver: FragmentInterface): ActivityDriver {
        const state = this.state;
        state.panelStack[state.panelStack.length - 1]._addFragment(fragmentBuilderDriver);
        state.fragments.set(fragmentBuilderDriver.id, fragmentBuilderDriver);
        return state.activityFragmentDriver!;
    }

    /** Closes the current panel. */
    popPanel(): void {
        this.state.panelStack.pop();
    }

    /**
     * Runs `render` in a fresh build context with a root panel.
     *
     * @param fragmentDriver - Driver of the activity being rendered; fragments use it for `push` and `trigger`.
     * @param render - The activity's render function.
     * @returns The fragments by id and the root panel.
     */
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

/** The process-wide builder used by {@link panel} and {@link Fragment}. */
const builder = new Builder();
export default builder;
