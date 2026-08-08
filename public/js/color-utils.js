export const DEFAULT_TEXT_COLOR_TOKEN = '__default_text_color__';
export const DEFAULT_SCENE_HEADER_COLOR = '#64748b';
export const WHITE_TEXT_MIN_CONTRAST = 3.8;

export const TEXT_COLOR_OPTIONS = [
    { value: DEFAULT_TEXT_COLOR_TOKEN, label: '默认色', swatch: 'var(--text-main)' },
    { value: '#334155', label: '深灰' },
    { value: '#3b82f6', label: '蓝色' },
    { value: '#4f46e5', label: '靛蓝' },
    { value: '#be123c', label: '玫红' },
    { value: '#b45309', label: '橙棕' },
    { value: '#166534', label: '绿色' },
    { value: '#0f766e', label: '青绿' }
];

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function toHexChannel(value) {
    return value.toString(16).padStart(2, '0');
}

function rgbToHex(r, g, b) {
    return `#${toHexChannel(r)}${toHexChannel(g)}${toHexChannel(b)}`;
}

function hslToHex(h, s, l) {
    const normalizedHue = ((h % 360) + 360) % 360;
    const normalizedSaturation = clamp(s, 0, 100) / 100;
    const normalizedLightness = clamp(l, 0, 100) / 100;

    const chroma = (1 - Math.abs((2 * normalizedLightness) - 1)) * normalizedSaturation;
    const x = chroma * (1 - Math.abs(((normalizedHue / 60) % 2) - 1));
    const match = normalizedLightness - (chroma / 2);

    let red = 0;
    let green = 0;
    let blue = 0;

    if (normalizedHue < 60) {
        red = chroma;
        green = x;
    } else if (normalizedHue < 120) {
        red = x;
        green = chroma;
    } else if (normalizedHue < 180) {
        green = chroma;
        blue = x;
    } else if (normalizedHue < 240) {
        green = x;
        blue = chroma;
    } else if (normalizedHue < 300) {
        red = x;
        blue = chroma;
    } else {
        red = chroma;
        blue = x;
    }

    return rgbToHex(
        Math.round((red + match) * 255),
        Math.round((green + match) * 255),
        Math.round((blue + match) * 255)
    );
}

function rgbToHsl(r, g, b) {
    const red = clamp(r, 0, 255) / 255;
    const green = clamp(g, 0, 255) / 255;
    const blue = clamp(b, 0, 255) / 255;

    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    const lightness = (max + min) / 2;

    if (delta === 0) {
        return { h: 0, s: 0, l: Math.round(lightness * 100) };
    }

    const saturation = delta / (1 - Math.abs((2 * lightness) - 1));
    let hue;

    if (max === red) {
        hue = 60 * (((green - blue) / delta) % 6);
    } else if (max === green) {
        hue = 60 * (((blue - red) / delta) + 2);
    } else {
        hue = 60 * (((red - green) / delta) + 4);
    }

    if (hue < 0) {
        hue += 360;
    }

    return {
        h: Math.round(hue),
        s: Math.round(saturation * 100),
        l: Math.round(lightness * 100)
    };
}

function parseHexColor(hex) {
    if (typeof hex !== 'string') {
        return null;
    }

    let normalized = hex.trim();
    if (normalized.startsWith('#')) {
        normalized = normalized.slice(1);
    }

    if (normalized.length === 3) {
        normalized = normalized.split('').map((char) => char + char).join('');
    }

    if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
        return null;
    }

    return {
        r: parseInt(normalized.slice(0, 2), 16),
        g: parseInt(normalized.slice(2, 4), 16),
        b: parseInt(normalized.slice(4, 6), 16)
    };
}

function getRelativeLuminance(hex) {
    const rgb = parseHexColor(hex);
    if (!rgb) {
        return null;
    }

    const toLinear = (channel) => {
        const normalized = channel / 255;
        if (normalized <= 0.03928) {
            return normalized / 12.92;
        }
        return ((normalized + 0.055) / 1.055) ** 2.4;
    };

    const red = toLinear(rgb.r);
    const green = toLinear(rgb.g);
    const blue = toLinear(rgb.b);
    return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function getContrastRatio(hexA, hexB) {
    const luminanceA = getRelativeLuminance(hexA);
    const luminanceB = getRelativeLuminance(hexB);
    if (luminanceA === null || luminanceB === null) {
        return null;
    }

    const brighter = Math.max(luminanceA, luminanceB);
    const darker = Math.min(luminanceA, luminanceB);
    return (brighter + 0.05) / (darker + 0.05);
}

export function ensureWhiteTextReadableHex(inputHex, minContrast = WHITE_TEXT_MIN_CONTRAST) {
    const parsed = parseHexColor(inputHex);
    if (!parsed) {
        return inputHex;
    }

    const normalizedHex = rgbToHex(parsed.r, parsed.g, parsed.b);
    const currentContrast = getContrastRatio(normalizedHex, '#ffffff');
    if (currentContrast !== null && currentContrast >= minContrast) {
        return normalizedHex;
    }

    const hsl = rgbToHsl(parsed.r, parsed.g, parsed.b);
    let lightness = hsl.l;
    let safeHex = normalizedHex;

    while (lightness > 8) {
        lightness -= 1;
        const candidate = hslToHex(hsl.h, hsl.s, lightness);
        safeHex = candidate;
        const contrast = getContrastRatio(candidate, '#ffffff');
        if (contrast !== null && contrast >= minContrast) {
            return candidate;
        }
    }

    return safeHex;
}

export function buildPresetSceneColorRows() {
    const colorRows = [
        ['#e81f1f', '#8f740d', '#29b52c', '#1b89ad', '#a334da'],
        ['#cf0d0d', '#b55f12', '#2d7e49', '#1848cf', '#7d18b3'],
        ['#d65800', '#6f3b12', '#085f17', DEFAULT_SCENE_HEADER_COLOR, '#000000']
    ];

    return colorRows.map((row) => row.map((hex) => ensureWhiteTextReadableHex(hex)));
}
