export const VIEW_STORAGE_KEY = 'storyboard:last-view';
export const PROJECT_STORAGE_KEY = 'storyboard:last-project-id';
export const VIEW_QUERY_PARAM = 'view';
export const PROJECT_QUERY_PARAM = 'project';
const HISTORY_STATE_APP = 'storyboard-app';

export function normalizeProjectId(projectIdLike) {
    const value = Number(projectIdLike);
    if (!Number.isInteger(value) || value <= 0) {
        return null;
    }
    return value;
}

function buildRouteUrl(route) {
    const params = new URLSearchParams(window.location.search);
    params.delete(VIEW_QUERY_PARAM);
    params.delete(PROJECT_QUERY_PARAM);

    if (route.view === 'editor' && normalizeProjectId(route.projectId)) {
        params.set(VIEW_QUERY_PARAM, 'editor');
        params.set(PROJECT_QUERY_PARAM, String(route.projectId));
    }

    const query = params.toString();
    return `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
}

function createHistoryState(route) {
    const state = {
        app: HISTORY_STATE_APP,
        view: route.view === 'editor' ? 'editor' : 'home'
    };
    const projectId = normalizeProjectId(route.projectId);
    if (state.view === 'editor' && projectId) {
        state.projectId = projectId;
    }
    return state;
}

export function resolveRouteFromHistoryState(state) {
    if (!state || state.app !== HISTORY_STATE_APP) {
        return null;
    }

    if (state.view === 'editor') {
        const projectId = normalizeProjectId(state.projectId);
        if (projectId) {
            return { view: 'editor', projectId };
        }
    }

    return { view: 'home' };
}

export function resolveRouteFromLocation() {
    const params = new URLSearchParams(window.location.search);
    const hasViewParam = params.has(VIEW_QUERY_PARAM);
    const hasProjectParam = params.has(PROJECT_QUERY_PARAM);

    if (!hasViewParam && !hasProjectParam) {
        return null;
    }

    const viewParam = (params.get(VIEW_QUERY_PARAM) || '').trim().toLowerCase();
    if (viewParam === 'home') {
        return { view: 'home' };
    }

    const projectId = normalizeProjectId(params.get(PROJECT_QUERY_PARAM));
    if (viewParam === 'editor' || hasProjectParam) {
        if (projectId) {
            return { view: 'editor', projectId };
        }
        return { view: 'home' };
    }

    return { view: 'home' };
}

export function resolveRouteFromSessionStorage() {
    const lastView = sessionStorage.getItem(VIEW_STORAGE_KEY);
    const lastProjectId = normalizeProjectId(sessionStorage.getItem(PROJECT_STORAGE_KEY));
    if (lastView === 'editor' && lastProjectId) {
        return { view: 'editor', projectId: lastProjectId };
    }
    return { view: 'home' };
}

export function syncBrowserHistory(route, replaceHistory = false) {
    const targetRoute = route && route.view === 'editor'
        ? { view: 'editor', projectId: normalizeProjectId(route.projectId) }
        : { view: 'home' };

    if (targetRoute.view === 'editor' && !targetRoute.projectId) {
        return;
    }

    const nextUrl = buildRouteUrl(targetRoute);
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const nextState = createHistoryState(targetRoute);
    const currentState = window.history.state;
    const currentProjectId = normalizeProjectId(currentState?.projectId);
    const nextProjectId = normalizeProjectId(nextState.projectId);
    const sameState = currentState
        && currentState.app === HISTORY_STATE_APP
        && currentState.view === nextState.view
        && currentProjectId === nextProjectId;

    if (!replaceHistory && sameState && currentUrl === nextUrl) {
        return;
    }

    if (replaceHistory || currentUrl === nextUrl) {
        window.history.replaceState(nextState, '', nextUrl);
        return;
    }

    window.history.pushState(nextState, '', nextUrl);
}
