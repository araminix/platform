import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
    AcquireAgent,
    Action,
    AgentList,
    AgentPost,
    AgentTask,
    Close,
    Data,
    deserialize,
    Load,
    NotFound,
    Other,
    Prev,
    Query,
    Refresh,
    Reload,
    SendBuild,
    SendPush,
    SendUpdate,
    Switch,
    UpdateActivityList,
} from '../src/executor/proto.js';
import { UpdateTypes } from '../src/lib/actors.js';

describe('Proto Messages and Deserializer', () => {
    it('deserializes Agent messages', () => {
        const post = new AgentPost('testEvent', { a: 1 });
        const postDeser = deserialize(JSON.parse(JSON.stringify(post)));
        assert.ok(postDeser instanceof AgentPost);
        assert.strictEqual((postDeser as AgentPost).name, 'testEvent');

        const task = new AgentTask('agent-1', 'compute', { x: 5 }, 30);
        const taskDeser = deserialize(JSON.parse(JSON.stringify(task)));
        assert.ok(taskDeser instanceof AgentTask);
        assert.strictEqual((taskDeser as AgentTask).id, 'agent-1');
        assert.strictEqual((taskDeser as AgentTask).hp, 30);

        const list = new AgentList('myType');
        const listDeser = deserialize(JSON.parse(JSON.stringify(list)));
        assert.ok(listDeser instanceof AgentList);
        assert.strictEqual((listDeser as AgentList).type, 'myType');
    });

    it('deserializes UI and instance controls', () => {
        const action = new Action('frag-1', 'click', { btn: 1 });
        const actionDeser = deserialize(JSON.parse(JSON.stringify(action)));
        assert.ok(actionDeser instanceof Action);
        assert.strictEqual((actionDeser as Action).fragmentId, 'frag-1');

        const update = new SendUpdate({
            activityId: 'act-1',
            fragmentId: 'f-1',
            type: UpdateTypes.Patch,
            data: { v: 99 },
        });
        const updateDeser = deserialize(JSON.parse(JSON.stringify(update)));
        assert.ok(updateDeser instanceof SendUpdate);
        assert.strictEqual((updateDeser as SendUpdate).data.type, UpdateTypes.Patch);
    });
});
