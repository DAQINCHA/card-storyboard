import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildShotUnits,
    unitCardColumnHtml
} from '../public/js/rundown.js';

test('rundown keeps grouped card content and notes paired without slash separators', () => {
    const { units } = buildShotUnits([
        {
            shotUnitId: 'shot-4',
            action: '【素材】\n杨梅舞台',
            actionHtml: '【素材】<br>杨梅舞台',
            dialogue: '准时登场！\n道具：麦克风',
            dialogueHtml: '准时登场！<br><span style="color:#3b82f6">道具：麦克风</span>'
        },
        {
            shotUnitId: 'shot-4',
            action: '【素材】杨梅舞台',
            dialogue: '（同期声：登台打招呼）',
            dialogueHtml: '（同期声：登台打招呼）'
        }
    ]);

    assert.equal(units.length, 1);
    assert.deepEqual(units[0].noteEntries, [
        {
            text: '准时登场！\n道具：麦克风',
            html: '准时登场！<br><span style="color:#3b82f6">道具：麦克风</span>'
        },
        {
            text: '（同期声：登台打招呼）',
            html: '（同期声：登台打招呼）'
        }
    ]);

    const actionHtml = unitCardColumnHtml(units[0], 'action', (entry) => entry.html || entry.text);
    const noteHtml = unitCardColumnHtml(units[0], 'note', (entry) => entry.html || entry.text);
    assert.match(actionHtml, /<span class="rundown-card-index" aria-hidden="true">1\.<\/span>/);
    assert.match(actionHtml, /【素材】<br>杨梅舞台/);
    assert.match(actionHtml, /<span class="rundown-card-index" aria-hidden="true">2\.<\/span>/);
    assert.match(noteHtml, /<span class="rundown-card-index" aria-hidden="true">1\.<\/span>/);
    assert.match(noteHtml, /准时登场！<br><span style="color:#3b82f6">道具：麦克风<\/span>/);
    assert.match(noteHtml, /<span class="rundown-card-index" aria-hidden="true">2\.<\/span>/);
    assert.match(noteHtml, /（同期声：登台打招呼）/);
    assert.doesNotMatch(actionHtml, / \/ /);
    assert.doesNotMatch(noteHtml, / \/ /);
});
