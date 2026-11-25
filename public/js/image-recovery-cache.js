const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;

function estimateDataUrlBytes(dataUrl) {
    if (typeof dataUrl !== 'string') {
        return 0;
    }
    return dataUrl.length * 2;
}

export function createImageRecoveryCache(options = {}) {
    const maxBytes = Math.max(1024 * 1024, Number(options.maxBytes) || DEFAULT_MAX_CACHE_BYTES);
    const entries = new Map();
    let totalBytes = 0;

    function deleteKey(imageId) {
        const existing = entries.get(imageId);
        if (!existing) {
            return false;
        }
        entries.delete(imageId);
        totalBytes = Math.max(0, totalBytes - existing.bytes);
        return true;
    }

    function evictIfNeeded(protectedId = '') {
        for (const [imageId] of entries) {
            if (totalBytes <= maxBytes) {
                break;
            }
            if (imageId === protectedId && entries.size > 1) {
                continue;
            }
            deleteKey(imageId);
        }
    }

    function set(imageId, dataUrl) {
        const key = typeof imageId === 'string' ? imageId.trim() : '';
        if (!key || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
            return false;
        }
        const bytes = estimateDataUrlBytes(dataUrl);
        if (bytes > maxBytes) {
            return false;
        }
        deleteKey(key);
        entries.set(key, { dataUrl, bytes });
        totalBytes += bytes;
        evictIfNeeded(key);
        return true;
    }

    function get(imageId) {
        const key = typeof imageId === 'string' ? imageId.trim() : '';
        if (!key || !entries.has(key)) {
            return '';
        }
        const entry = entries.get(key);
        // Refresh LRU order on read.
        entries.delete(key);
        entries.set(key, entry);
        return entry.dataUrl;
    }

    function has(imageId) {
        const key = typeof imageId === 'string' ? imageId.trim() : '';
        return Boolean(key && entries.has(key));
    }

    function clear() {
        entries.clear();
        totalBytes = 0;
    }

    return {
        set,
        get,
        has,
        delete: deleteKey,
        clear,
        stats: () => ({ count: entries.size, totalBytes, maxBytes })
    };
}

export function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        if (!blob) {
            reject(new Error('Blob is required'));
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result === 'string' && reader.result.startsWith('data:image/')) {
                resolve(reader.result);
                return;
            }
            reject(new Error('Invalid image data URL'));
        };
        reader.onerror = () => reject(reader.error || new Error('Failed to read image blob'));
        reader.readAsDataURL(blob);
    });
}

export function captureImageElementToDataUrl(imageElement) {
    if (!imageElement || !imageElement.complete || !imageElement.naturalWidth || !imageElement.naturalHeight) {
        return '';
    }
    try {
        const canvas = document.createElement('canvas');
        canvas.width = imageElement.naturalWidth;
        canvas.height = imageElement.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return '';
        }
        ctx.drawImage(imageElement, 0, 0);
        return canvas.toDataURL('image/jpeg', 0.85);
    } catch {
        return '';
    }
}

export async function cacheImageSourceToRecovery(cache, { imageId, imageSrc, imageElement = null } = {}) {
    const key = typeof imageId === 'string' ? imageId.trim() : '';
    if (!cache || !key) {
        return false;
    }
    if (cache.has(key)) {
        return true;
    }
    const src = typeof imageSrc === 'string' ? imageSrc.trim() : '';
    if (src.startsWith('data:image/')) {
        return cache.set(key, src);
    }
    if (src && typeof fetch === 'function') {
        try {
            const response = await fetch(src, { credentials: 'same-origin' });
            if (response.ok) {
                const blob = await response.blob();
                if (blob && blob.type && blob.type.startsWith('image/')) {
                    const dataUrl = await blobToDataUrl(blob);
                    return cache.set(key, dataUrl);
                }
            }
        } catch {
            // Fall through to canvas fallback.
        }
    }
    const fallbackDataUrl = captureImageElementToDataUrl(imageElement);
    if (fallbackDataUrl) {
        return cache.set(key, fallbackDataUrl);
    }
    return false;
}
