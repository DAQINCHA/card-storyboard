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
    if (route.view === 'rundown') params.set('view', 'rundown');

    const query = params.toString();
    const projectId = normalizeProjectId(route.projectId);
    const pathname = ['editor', 'rundown'].includes(route.view) && projectId
        ? `/project/${projectId}`
        : '/';
    return `${pathname}${query ? `?${query}` : ''}${window.location.hash}`;
}

function createHistoryState(route) {
    const state = {
        app: HISTORY_STATE_APP,
        view: ['editor', 'rundown'].includes(route.view) ? route.view : 'home'
    };
    const projectId = normalizeProjectId(route.projectId);
    if (['editor', 'rundown'].includes(state.view) && projectId) {
        state.projectId = projectId;
    }
    return state;
}

export function resolveRouteFromHistoryState(state) {
    if (!state || state.app !== HISTORY_STATE_APP) {
        return null;
    }

    if (['editor', 'rundown'].includes(state.view)) {
        const projectId = normalizeProjectId(state.projectId);
        if (projectId) {
            return { view: state.view, projectId };
        }
    }

    return { view: 'home' };
}

export function resolveRouteFromLocation() {
    const projectPathMatch = window.location.pathname.match(PROJECT_PATH_PATTERN);
    if (projectPathMatch) {
        const projectId = normalizeProjectId(projectPathMatch[1]);
        const view = new URLSearchParams(window.location.search).get('view') === 'rundown' ? 'rundown' : 'editor';
        return projectId ? { view, projectId } : { view: 'home' };
    }

    return { view: 'home' };
}

export function syncBrowserHistory(route, replaceHistory = false) {
    const targetRoute = route && ['editor', 'rundown'].includes(route.view)
        ? { view: route.view, projectId: normalizeProjectId(route.projectId) }
        : { view: 'home' };

    if (['editor', 'rundown'].includes(targetRoute.view) && !targetRoute.projectId) {
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
