import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectHistory } from '../public/js/history.js';

test('project history supports undo, redo, deep cloning, and clearing redo branch on new edits', () => {
    const history = createProjectHistory({ maxDepth: 10 });
    const initial = { name: '项目A', shots: [{ shotUnitId: 'u1', action: '开场' }], rundown: { version: 1, days: [] } };
    history.reset(initial);

    assert.equal(history.canUndo('editor'), false);
    assert.equal(history.canRedo('editor'), false);

    // Mutating caller object after reset must not corrupt stored snapshot.
    initial.name = '被外部篡改';

    const step1 = { name: '项目A', shots: [{ shotUnitId: 'u1', action: '开场' }, { shotUnitId: 'u2', action: '' }], rundown: { version: 1, days: [] } };
    assert.equal(history.record(step1, { label: '添加分镜', view: 'editor', immediate: true }), true);
    // Recording an identical snapshot is a no-op.
    assert.equal(history.record(step1, { label: '重复无变化', view: 'editor', immediate: true }), false);

    const step2 = { name: '项目B', shots: step1.shots, rundown: { version: 1, days: [] } };
    history.record(step2, { label: '修改项目名', view: 'editor', immediate: true });

    const undone1 = history.undo('editor');
    assert.equal(undone1.label, '修改项目名');
    assert.equal(undone1.snapshot.name, '项目A');
    assert.equal(undone1.snapshot.shots.length, 2);

    const undone2 = history.undo('editor');
    assert.equal(undone2.label, '添加分镜');
    assert.equal(undone2.snapshot.name, '项目A');
    assert.equal(undone2.snapshot.shots.length, 1);
    assert.equal(history.undo('editor'), null);

    const redone1 = history.redo('editor');
    assert.equal(redone1.label, '添加分镜');
    assert.equal(redone1.snapshot.shots.length, 2);

    // Recording a new change clears the redo stack.
    history.record({ name: '项目C', shots: step1.shots, rundown: { version: 1, days: [] } }, { label: '新分支', view: 'editor', immediate: true });
    assert.equal(history.canRedo('editor'), false);
    assert.equal(history.redo('editor'), null);
});

test('project history coalesces rapid edits with the same mergeKey and respects seal()', () => {
    let clock = 1000;
    const history = createProjectHistory({ maxDepth: 10, mergeWindowMs: 650, now: () => clock });
    history.reset({ name: 'A', shots: [] });

    history.record({ name: 'AB', shots: [] }, { label: '修改项目名', view: 'editor', mergeKey: 'project-name', immediate: false });
    clock += 200;
    history.record({ name: 'ABC', shots: [] }, { label: '修改项目名', view: 'editor', mergeKey: 'project-name', immediate: false });
    clock += 200;
    history.record({ name: 'ABCD', shots: [] }, { label: '修改项目名', view: 'editor', mergeKey: 'project-name', immediate: false });

    assert.equal(history.getState('editor').pastLength, 1);

    // Sealing splits the next edit into a new history entry.
    history.seal();
    clock += 100;
    history.record({ name: 'ABCDE', shots: [] }, { label: '修改项目名', view: 'editor', mergeKey: 'project-name', immediate: false });
    assert.equal(history.getState('editor').pastLength, 2);

    const undone1 = history.undo('editor');
    assert.equal(undone1.snapshot.name, 'ABCD');
    const undone2 = history.undo('editor');
    assert.equal(undone2.snapshot.name, 'A');
});

test('project history collapses merged edits back to base state if user types back to original value', () => {
    let clock = 1000;
    const history = createProjectHistory({ mergeWindowMs: 650, now: () => clock });
    history.reset({ name: '原名', shots: [] });

    history.record({ name: '原名1', shots: [] }, { label: '修改项目名', view: 'editor', mergeKey: 'project-name', immediate: false });
    assert.equal(history.canUndo('editor'), true);

    clock += 150;
    history.record({ name: '原名', shots: [] }, { label: '修改项目名', view: 'editor', mergeKey: 'project-name', immediate: false });
    assert.equal(history.canUndo('editor'), false);
});

test('project history transactions combine batch mutations into a single undoable step', () => {
    const history = createProjectHistory();
    const state = { shots: [{ id: 1 }] };
    history.reset(state);

    history.runTransaction(
        { label: '添加 5 个分镜', view: 'editor' },
        () => {
            for (let i = 2; i <= 6; i += 1) {
                state.shots.push({ id: i });
                history.record(state, { label: '添加分镜', view: 'editor', immediate: true });
            }
        },
        () => state
    );

    assert.equal(history.getState('editor').pastLength, 1);
    const undone = history.undo('editor');
    assert.equal(undone.label, '添加 5 个分镜');
    assert.equal(undone.snapshot.shots.length, 1);
});

test('rundown view boundary prevents blindly undoing storyboard edits while preserving cross-view rundown restore', () => {
    const history = createProjectHistory();
    const s0 = { shots: [{ shotUnitId: 'u1' }], rundown: { version: 1, days: [{ id: 'd1', items: [{ id: 'i1', type: 'shot', shotUnitId: 'u1' }] }] } };
    const s1 = { shots: [], rundown: { version: 1, days: [{ id: 'd1', items: [] }] } };
    const s2 = { shots: [], rundown: { version: 1, days: [{ id: 'd1', items: [] }, { id: 'd2', items: [] }] } };

    history.reset(s0);
    history.record(s1, { label: '删除分镜', view: 'editor', immediate: true });

    // Entering rundown with no rundown edits yet: cannot undo storyboard edits from rundown view.
    assert.equal(history.canUndo('rundown'), false);
    assert.equal(history.undo('rundown'), null);

    // Making a rundown edit enables undo within rundown view.
    history.record(s2, { label: '添加拍摄日', view: 'rundown', immediate: true });
    assert.equal(history.canUndo('rundown'), true);

    const undoneRundown = history.undo('rundown');
    assert.equal(undoneRundown.label, '添加拍摄日');
    assert.equal(undoneRundown.view, 'rundown');
    assert.equal(undoneRundown.snapshot.rundown.days.length, 1);

    // Further undo in rundown view stops at the storyboard boundary.
    assert.equal(history.canUndo('rundown'), false);
    assert.equal(history.canRedo('rundown'), true);

    // Switching back to editor view allows undoing the storyboard deletion and restores its rundown schedule too.
    assert.equal(history.canUndo('editor'), true);
    const undoneStoryboard = history.undo('editor');
    assert.equal(undoneStoryboard.label, '删除分镜');
    assert.equal(undoneStoryboard.snapshot.shots.length, 1);
    assert.equal(undoneStoryboard.snapshot.rundown.days[0].items.length, 1);
});

test('project history enforces maxDepth limit', () => {
    const history = createProjectHistory({ maxDepth: 3 });
    history.reset({ count: 0 });
    for (let i = 1; i <= 5; i += 1) {
        history.record({ count: i }, { label: `步 ${i}`, view: 'editor', immediate: true });
    }
    assert.equal(history.getState('editor').pastLength, 3);
    assert.equal(history.undo('editor').snapshot.count, 4);
    assert.equal(history.undo('editor').snapshot.count, 3);
    assert.equal(history.undo('editor').snapshot.count, 2);
    assert.equal(history.undo('editor'), null);
});
