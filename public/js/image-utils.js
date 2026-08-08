const UPLOAD_IMAGE_MAX_LONG_EDGE = 640;
const UPLOAD_IMAGE_OUTPUT_MIME = 'image/jpeg';
const UPLOAD_IMAGE_OUTPUT_QUALITY = 0.72;

export function convertImageSrcToPngBlob(imageSrc) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            const width = image.naturalWidth || image.width;
            const height = image.naturalHeight || image.height;
            if (!width || !height) {
                reject(new Error('Image dimensions unavailable'));
                return;
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                reject(new Error('Canvas context unavailable'));
                return;
            }

            ctx.drawImage(image, 0, 0, width, height);
            canvas.toBlob((blob) => {
                if (blob) {
                    resolve(blob);
                } else {
                    reject(new Error('PNG conversion failed'));
                }
            }, 'image/png');
        };
        image.onerror = () => reject(new Error('Image decode failed'));
        image.src = imageSrc;
    });
}

export async function copyImageSrcToClipboard(imageSrc) {
    if (!imageSrc) {
        return false;
    }
    if (!window.isSecureContext) {
        return false;
    }
    if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function' || typeof window.ClipboardItem !== 'function') {
        return false;
    }

    const pngBlobPromise = (async () => {
        const response = await fetch(imageSrc);
        if (!response.ok) {
            throw new Error(`Fetch image failed: ${response.status}`);
        }
        const blob = await response.blob();
        if (blob.type === 'image/png') {
            return blob;
        }
        return convertImageSrcToPngBlob(imageSrc);
    })();

    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlobPromise })]);
    return true;
}

export function computeUploadImageSize(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return { width: 1, height: 1 };
    }

    const longestEdge = Math.max(width, height);
    if (longestEdge <= UPLOAD_IMAGE_MAX_LONG_EDGE) {
        return {
            width: Math.round(width),
            height: Math.round(height)
        };
    }

    const scale = UPLOAD_IMAGE_MAX_LONG_EDGE / longestEdge;
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale))
    };
}

function loadImageElementFromFile(file) {
    return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Image decode failed'));
        };
        image.src = objectUrl;
    });
}

export async function compressUploadImageToDataUrl(file) {
    const image = await loadImageElementFromFile(file);
    const targetSize = computeUploadImageSize(image.naturalWidth, image.naturalHeight);

    const canvas = document.createElement('canvas');
    canvas.width = targetSize.width;
    canvas.height = targetSize.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('Canvas context unavailable');
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(image, 0, 0, targetSize.width, targetSize.height);

    return canvas.toDataURL(UPLOAD_IMAGE_OUTPUT_MIME, UPLOAD_IMAGE_OUTPUT_QUALITY);
}
