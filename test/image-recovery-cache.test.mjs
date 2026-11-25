import assert from 'node:assert/strict';
import test from 'node:test';

import {
    cacheImageSourceToRecovery,
    createImageRecoveryCache
} from '../public/js/image-recovery-cache.js';

const SAMPLE_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+pK6sAAAAASUVORK5CYII=';

test('image recovery cache stores data URLs, refreshes LRU on get, and evicts oldest when full', () => {
    const largeChunk = 'A'.repeat(300_000); // ~600 KB UTF-16
    const img1 = `data:image/jpeg;base64,${largeChunk}1`;
    const img2 = `data:image/jpeg;base64,${largeChunk}2`;
    const img3 = `data:image/jpeg;base64,${largeChunk}3`;

    const cache = createImageRecoveryCache({ maxBytes: 1_300_000 });
    assert.equal(cache.set('img-1', img1), true);
    assert.equal(cache.set('img-2', img2), true);

    // Touch img-1 so img-2 becomes least recently used.
    assert.equal(cache.get('img-1'), img1);

    // Adding img-3 should evict img-2, keeping img-1 and img-3.
    assert.equal(cache.set('img-3', img3), true);
    assert.equal(cache.has('img-1'), true);
    assert.equal(cache.has('img-2'), false);
    assert.equal(cache.has('img-3'), true);

    // Non-image strings are ignored.
    assert.equal(cache.set('bad', 'https://example.com/a.png'), false);

    cache.clear();
    assert.equal(cache.stats().count, 0);
    assert.equal(cache.stats().totalBytes, 0);
});

test('cacheImageSourceToRecovery caches inline data URLs directly without network calls', async () => {
    const cache = createImageRecoveryCache();
    const ok = await cacheImageSourceToRecovery(cache, {
        imageId: 'shot-img-1',
        imageSrc: SAMPLE_PNG_DATA_URL
    });
    assert.equal(ok, true);
    assert.equal(cache.get('shot-img-1'), SAMPLE_PNG_DATA_URL);
});
