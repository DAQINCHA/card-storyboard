import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildShotUnits,
    unitContentSectionsHtml
} from '../public/js/rundown.js';

test('rundown keeps each note rich-text color while grouping shot cards', () => {
    const { units } = buildShotUnits([
        {
            shotUnitId: 'shot-4',
            action: '【素材】杨梅舞台',
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

    const html = unitContentSectionsHtml(units[0], (entry) => entry.html || entry.text);
    assert.match(html, /准时登场！<br><span style="color:#3b82f6">道具：麦克风<\/span> \/ （同期声：登台打招呼）/);
});
