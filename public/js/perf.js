const PERF_QUERY_PARAM = 'perfProfile';
const PERF_STORAGE_KEY = 'storyboard:perf-profile';
const perfQueryValue = new URLSearchParams(window.location.search).get(PERF_QUERY_PARAM);
const perfEnabledFromQuery = perfQueryValue === '1';
const perfDisabledFromQuery = perfQueryValue === '0';
const perfEnabledFromStorage = localStorage.getItem(PERF_STORAGE_KEY) === '1';

export const perfState = {
    enabled: perfDisabledFromQuery ? false : (perfEnabledFromQuery || perfEnabledFromStorage),
    stats: new Map()
};

export function perfNow() {
    if (window.performance && typeof window.performance.now === 'function') {
        return window.performance.now();
    }
    return Date.now();
}

function resolvePerfMeta(metaOrFactory) {
    if (typeof metaOrFactory === 'function') {
        try {
            return metaOrFactory();
        } catch {
            return { metaError: true };
        }
    }
    return metaOrFactory || null;
}

export function perfRecord(name, durationMs, metaOrFactory = null) {
    if (!perfState.enabled || !Number.isFinite(durationMs)) {
        return;
    }

    const existing = perfState.stats.get(name) || {
        count: 0,
        total: 0,
        min: Number.POSITIVE_INFINITY,
        max: 0,
        last: 0,
        lastMeta: null
    };

    existing.count += 1;
    existing.total += durationMs;
    existing.min = Math.min(existing.min, durationMs);
    existing.max = Math.max(existing.max, durationMs);
    existing.last = durationMs;
    existing.lastMeta = resolvePerfMeta(metaOrFactory);
    perfState.stats.set(name, existing);

    if (durationMs >= 16) {
        if (existing.lastMeta) {
            console.log(`[perf] ${name}: ${durationMs.toFixed(2)}ms`, existing.lastMeta);
        } else {
            console.log(`[perf] ${name}: ${durationMs.toFixed(2)}ms`);
        }
    }
}

export function perfMeasureSync(name, fn, metaOrFactory = null) {
    const startedAt = perfNow();
    try {
        return fn();
    } finally {
        perfRecord(name, perfNow() - startedAt, metaOrFactory);
    }
}

export async function perfMeasureAsync(name, fn, metaOrFactory = null) {
    const startedAt = perfNow();
    try {
        return await fn();
    } finally {
        perfRecord(name, perfNow() - startedAt, metaOrFactory);
    }
}

export function printPerfReport() {
    const rows = Array.from(perfState.stats.entries()).map(([name, stat]) => {
        const avg = stat.count > 0 ? (stat.total / stat.count) : 0;
        return {
            name,
            count: stat.count,
            avgMs: Number(avg.toFixed(2)),
            maxMs: Number(stat.max.toFixed(2)),
            minMs: Number((Number.isFinite(stat.min) ? stat.min : 0).toFixed(2)),
            lastMs: Number(stat.last.toFixed(2)),
            lastMeta: stat.lastMeta ? JSON.stringify(stat.lastMeta) : ''
        };
    }).sort((a, b) => b.avgMs - a.avgMs);

    console.table(rows);
    return rows;
}

window.storyboardPerf = {
    enable() {
        perfState.enabled = true;
        localStorage.setItem(PERF_STORAGE_KEY, '1');
        console.info('[perf] enabled');
    },
    disable() {
        perfState.enabled = false;
        localStorage.removeItem(PERF_STORAGE_KEY);
        console.info('[perf] disabled');
    },
    reset() {
        perfState.stats.clear();
        console.info('[perf] stats reset');
    },
    report() {
        return printPerfReport();
    },
    status() {
        return {
            enabled: perfState.enabled,
            queryValue: perfQueryValue,
            samples: perfState.stats.size
        };
    }
};

if (perfState.enabled) {
    console.info('[perf] profiling enabled (query ?perfProfile=1, disable with ?perfProfile=0)');
}
