import { perfMeasureAsync } from './perf.js';

export async function apiRequest(path, options = {}) {
    const method = (options.method || 'GET').toString().toUpperCase();
    const requestBodyBytes = typeof options.body === 'string'
        ? options.body.length
        : 0;
    let responseStatus = null;

    return perfMeasureAsync('apiRequest', async () => {
        const init = { ...options };
        init.headers = {
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {})
        };

        const response = await fetch(path, init);
        responseStatus = response.status;
        if (!response.ok) {
            const message = await response.text().catch(() => 'Request failed');
            throw new Error(message || `Request failed: ${response.status}`);
        }

        if (response.status === 204) {
            return null;
        }

        return response.json();
    }, () => ({
        path,
        method,
        requestBodyBytes,
        responseStatus
    }));
}
