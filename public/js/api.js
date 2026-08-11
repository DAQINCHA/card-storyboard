import { perfMeasureAsync } from './perf.js';

let csrfToken = '';

export class ApiError extends Error {
    constructor(message, status, code = 'request_error', details = null) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

export function setCsrfToken(value) {
    csrfToken = typeof value === 'string' ? value : '';
}

export async function apiRequest(path, options = {}) {
    const method = (options.method || 'GET').toString().toUpperCase();
    const requestBodyBytes = typeof options.body === 'string'
        ? options.body.length
        : 0;
    let responseStatus = null;

    return perfMeasureAsync('apiRequest', async () => {
        const init = { credentials: 'same-origin', ...options };
        const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
        init.headers = {
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(isMutation && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
            ...(options.headers || {})
        };

        const response = await fetch(path, init);
        responseStatus = response.status;
        if (!response.ok) {
            const payload = await response.json().catch(() => null);
            if (response.status === 401 && path !== '/api/auth/login') {
                window.dispatchEvent(new CustomEvent('storyboard-session-expired'));
            }
            throw new ApiError(
                payload?.error || `Request failed: ${response.status}`,
                response.status,
                payload?.code || 'request_error',
                payload?.details || null
            );
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
