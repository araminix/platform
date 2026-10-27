import { uuid } from '@araminix/lib';

import builder, { BuildedPart, Part } from './builder.js';
import type { FragmentInterface } from './Fragment.js';

type Header = void | string | (() => Promise<string>) | (() => string);
type Styles = Array<string> | void;

export interface PanelSet {
    header: Header;
    styles: Array<string> | undefined;
    render: () => void | Promise<void>;
}

export class Panel implements Part {
    private id: string = uuid();
    private styles: Array<string>;
    private parts: Part[] = [];

    constructor(styles: Styles) {
        this.styles = styles === undefined ? [] : styles;
    }

    _addFragment(fragment: FragmentInterface): void {
        this.parts.push(fragment);
    }

    _addPanel(panel: Panel): void {
        this.parts.push(panel);
    }

    _build(): BuildedPart {
        return {
            id: this.id,
            type: 'Panel',
            styles: this.styles,
            content: this.parts.map((part) => part._build()),
        };
    }
}

type RenderAsync = () => Promise<void>;
type RenderSync = () => void;

function panel(init: { render: RenderAsync; styles?: Styles } | RenderAsync): Promise<void>;
function panel(init: { render: RenderSync; styles?: Styles } | RenderSync): void;
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

export default panel;
