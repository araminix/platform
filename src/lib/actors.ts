import type { Result } from '@araminix/lib';

import type { Activity, App, Page, Stage, Wizard } from './d.js';

export interface Actor {}

export class Close<C = unknown> implements Actor {
    readonly activity: Activity<C>;
    constructor(activity: Activity<C>) {
        this.activity = activity;
    }
}

export class Prev<C = unknown> implements Actor {
    readonly activity: Activity<C>;
    constructor(activity: Activity<C>) {
        this.activity = activity;
    }
}

export class Destroy<SETTINGS = unknown> implements Actor {
    readonly app: App<SETTINGS, any>;
    constructor(app: App<SETTINGS, any>) {
        this.app = app;
    }
}

export class WizardDetached<C = unknown, O = unknown, W extends Wizard<C, O, any> = Wizard<C, O, any>, R = unknown> implements Actor {
    readonly mainStage: Stage<C, O, W>;
    readonly ctx: C;
    readonly on?: ((result: Result<O, unknown> | undefined) => Promise<R> | R) | undefined;

    constructor(mainStage: Stage<C, O, W>, ctx: C, on?: ((result: Result<O, unknown> | undefined) => Promise<R> | R) | undefined) {
        this.mainStage = mainStage;
        this.ctx = ctx;
        this.on = on;
    }
}

export class WizardAttached<C = unknown, O = unknown, W extends Wizard<C, O, any> = Wizard<C, O, any>> implements Actor {
    readonly mainStage: Stage<C, O, W>;
    readonly ctx: C;
    readonly on?: ((result: Result<O, unknown> | undefined) => Promise<Actor> | Actor) | undefined;

    constructor(mainStage: Stage<C, O, W>, ctx: C, on?: ((result: Result<O, unknown> | undefined) => Promise<Actor> | Actor) | undefined) {
        this.mainStage = mainStage;
        this.ctx = ctx;
        this.on = on;
    }
}

export class WizardPop<C = unknown, O = unknown, W extends Wizard<C, O, any> = Wizard<C, O, any>> implements Actor {
    readonly mainStage: Stage<C, O, W>;
    readonly ctx: C;
    readonly on?: ((result: Result<O, unknown> | undefined) => Promise<Actor> | Actor) | undefined;

    constructor(mainStage: Stage<C, O, W>, ctx: C, on?: ((result: Result<O, unknown> | undefined) => Promise<Actor> | Actor) | undefined) {
        this.mainStage = mainStage;
        this.ctx = ctx;
        this.on = on;
    }
}

export class WizardDone<O = unknown, E = unknown> implements Actor {
    readonly wizard: Wizard<any, O, any>;
    readonly result: Result<O, E> | undefined;

    constructor(wizard: Wizard<any, O, any>, result: Result<O, E> | undefined) {
        this.wizard = wizard;
        this.result = result;
    }
}

export class WizardNext<C = unknown, O = unknown, W extends Wizard<any, O, any> = Wizard<any, O, any>> implements Actor {
    readonly stage: Stage<C, O, W>;
    readonly ctx: C;

    constructor(stage: Stage<C, O, W>, ctx: C) {
        this.stage = stage;
        this.ctx = ctx;
    }
}

export class WizardNextReplace<C = unknown, O = unknown, W extends Wizard<any, O, any> = Wizard<any, O, any>> implements Actor {
    readonly stage: Stage<C, O, W>;
    readonly ctx: C;

    constructor(stage: Stage<C, O, W>, ctx: C) {
        this.stage = stage;
        this.ctx = ctx;
    }
}

export class OpenPage<C = unknown, P extends Page<C, any> = Page<C, any>> implements Actor {
    readonly page: P;
    readonly ctx: C;

    constructor(page: P, ctx: C) {
        this.page = page;
        this.ctx = ctx;
    }
}

export class PopPage<C = unknown, P extends Page<C, any> = Page<C, any>> implements Actor {
    readonly page: P;
    readonly ctx: C;

    constructor(page: P, ctx: C) {
        this.page = page;
        this.ctx = ctx;
    }
}

export class NextPage<C = unknown, P extends Page<C, any> = Page<C, any>> implements Actor {
    readonly page: P;
    readonly ctx: C;

    constructor(page: P, ctx: C) {
        this.page = page;
        this.ctx = ctx;
    }
}

export class ReplacePage<C = unknown, P extends Page<C, any> = Page<C, any>> implements Actor {
    readonly page: P;
    readonly ctx: C;

    constructor(page: P, ctx: C) {
        this.page = page;
        this.ctx = ctx;
    }
}

export class Refresh<C = unknown> implements Actor {
    readonly activity: Activity<C>;
    readonly ctx: C;

    constructor(activity: Activity<C>, ctx: C) {
        this.activity = activity;
        this.ctx = ctx;
    }
}

export class Reload implements Actor {
    constructor() {}
}

export enum UpdateTypes {
    Full = 'Full',
    Patch = 'Patch',
}

export class UpdateFragment<D = unknown> implements Actor {
    readonly fragmentId: string;
    readonly type: UpdateTypes;
    readonly data: D;

    constructor(fragmentId: string, type: UpdateTypes, data: D) {
        this.fragmentId = fragmentId;
        this.type = type;
        this.data = data;
    }
}

export class ReloadFragment implements Actor {
    readonly fragmentId: string;

    constructor(fragmentId: string) {
        this.fragmentId = fragmentId;
    }
}

export class Nothing implements Actor {}
