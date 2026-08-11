export const VIEW_STORAGE_KEY = 'storyboard:last-view';
export const PROJECT_STORAGE_KEY = 'storyboard:last-project-id';
const HISTORY_STATE_APP = 'storyboard-app';
const PROJECT_PATH_PATTERN = /^\/project\/(\d+)\/?$/;

export function normalizeProjectId(projectIdLike) {
    const value = Number(projectIdLike);
    if (!Number.isInteger(value) || value <= 0) {
        return null;
    }
    return value;
}

function buildRouteUrl(route) {
    const params = new URLSearchParams(window.location.search);
    params.delete('view');
    params.delete('project');

    const query = params.toString();
    const projectId = normalizeProjectId(route.projectId);
    const pathname = route.view === 'editor' && projectId
        ? `/project/${projectId}`
        : '/';
    return `${pathname}${query ? `?${query}` : ''}${window.location.hash}`;
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
    const projectPathMatch = window.location.pathname.match(PROJECT_PATH_PATTERN);
    if (projectPathMatch) {
        const projectId = normalizeProjectId(projectPathMatch[1]);
        return projectId ? { view: 'editor', projectId } : { view: 'home' };
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
