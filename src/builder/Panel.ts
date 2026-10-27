import { uuid } from '@araminix/lib';

import builder, { BuildedPart, Part } from './builder.js';
import type { FragmentInterface } from './Fragment.js';

/** Panel header: a text, or a function producing it. */
type Header = void | string | (() => Promise<string>) | (() => string);
/** Style names of a panel. */
type Styles = Array<string> | void;

/** Declarative description of a panel (header, styles, render function). Not used by {@link panel} itself. */
export interface PanelSet {
    /** Header text or a function producing it. */
    header: Header;
    /** Style names. */
    styles: Array<string> | undefined;
    /** Creates the panel's content. */
    render: () => void | Promise<void>;
}

/** A layout container in the UI tree. Created by {@link panel}; serialised as `{ id, type: 'Panel', styles, content }`. */
export class Panel implements Part {
    /** Random id. */
    private id: string = uuid();
    /** Style names. */
    private styles: Array<string>;
    /** Child panels and fragments, in creation order. */
    private parts: Part[] = [];

    /** @param styles - Style names, or `undefined` for none. */
    constructor(styles: Styles) {
        this.styles = styles === undefined ? [] : styles;
    }

    /** Appends a fragment. */
    _addFragment(fragment: FragmentInterface): void {
        this.parts.push(fragment);
    }

    /** Appends a child panel. */
    _addPanel(panel: Panel): void {
        this.parts.push(panel);
    }

    /** Serialises the panel and its children. */
    _build(): BuildedPart {
        return {
            id: this.id,
            type: 'Panel',
            styles: this.styles,
            content: this.parts.map((part) => part._build()),
        };
    }
}

/** Asynchronous panel content function. */
type RenderAsync = () => Promise<void>;
/** Synchronous panel content function. */
type RenderSync = () => void;

/**
 * Creates a panel whose content is built by an async function. Await the returned promise before creating sibling
 * panels or fragments, so that they are not placed inside this panel.
 *
 * @param init - The content function, or `{ render, styles }`.
 * @returns A promise that settles when `render` has finished (and rejects with its error).
 *
 * @example
 * ```ts
 * await panel({ styles: ['row'], render: async () => {
 *     const stats = await loadStats();
 *     new StatCard({ label: 'Open', value: stats.open });
 * } });
 * ```
 */
function panel(init: { render: RenderAsync; styles?: Styles } | RenderAsync): Promise<void>;
/**
 * Creates a panel (a layout container) inside the panel that is currently rendering, or at the root of the activity, and
 * runs `render` to fill it: fragments and panels created inside `render` become its children. Call it only from an
 * activity's `render()`.
 *
 * @param init - The content function, or `{ render, styles }` where `styles` are style names for the front-end.
 * @throws Whatever `render` throws (the panel is closed first).
 *
 * @example
 * ```ts
 * protected async render(): Promise<void> {
 *     panel({ styles: ['column'], render: () => {
 *         new Title({ text: 'Orders' });
 *         panel(() => {
 *             new OrdersTable({ status: 'open' });
 *         });
 *     } });
 * }
 * ```
 */
function panel(init: { render: RenderSync; styles?: Styles } | RenderSync): void;
/** Implementation of both overloads. */
function panel(init: { render: RenderAsync | RenderSync; styles?: Styles } | RenderAsync | RenderSync): Promise<void> | void {
    const render = typeof init === 'function' ? init : init.render;
    const styles = typeof init !== 'function' ? init.styles : undefined;
    const p = new Panel(styles);
    builder.pushPanel(p);

    try {
        const result: unknown = render();
        if (result instanceof Promise) {
            return result.then(
                () => {
                    builder.popPanel();
                },
                (error: unknown) => {
                    builder.popPanel();
                    throw error;
                },
            );
        }
        builder.popPanel();
    } catch (e) {
        builder.popPanel();
        throw e;
    }
}

/** See {@link panel}. Exported from the package as `panel`. */
export default panel;
