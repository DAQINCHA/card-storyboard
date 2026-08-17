import { ApiError, apiRequest } from './js/api.js';
import { bootstrapAccess } from './js/auth.js';
import { openSharingDialog } from './js/sharing.js';
import {
    DEFAULT_SCENE_HEADER_COLOR,
    DEFAULT_TEXT_COLOR_TOKEN,
    TEXT_COLOR_OPTIONS,
    buildPresetSceneColorRows,
    isLightSceneHeaderColor,
    normalizeSceneHeaderColor
} from './js/color-utils.js';
import {
    cleanupEditableFieldMarkup,
    getEditableFieldHtml,
    getEditablePlainText,
    insertPlainTextIntoEditableField,
    isEditableShotField,
    setEditableFieldContent
} from './js/editable-utils.js';
import {
    compressUploadImageToDataUrl,
    copyImageSrcToClipboard
} from './js/image-utils.js';
import {
    perfMeasureAsync,
    perfMeasureSync,
    perfNow,
    perfRecord,
    perfState
} from './js/perf.js';
import {
    PROJECT_STORAGE_KEY,
    VIEW_STORAGE_KEY,
    normalizeProjectId,
    resolveRouteFromHistoryState,
    resolveRouteFromLocation,
    syncBrowserHistory
} from './js/router.js';

const ACCESS_ROLE_LABELS = Object.freeze({
    anonymous: '只读',
    viewer: '只读',
    owner: '所有者',
    editor: '可编辑',
    admin: '管理员'
});

const SHOT_SIZE_OPTIONS = Object.freeze(['大特写', '特写', '近景', '中景', '全景', '远景']);
const CAMERA_MOVEMENT_OPTIONS = Object.freeze([
    '固定', '推进', '拉远', '摇', '移', '前进跟', '后退跟', '环绕', '长镜头'
]);

document.addEventListener('DOMContentLoaded', async () => {
    const copyrightYear = document.getElementById('copyright-year');
    if (copyrightYear) {
        const currentYear = String(new Date().getFullYear());
        copyrightYear.textContent = currentYear;
        copyrightYear.dateTime = currentYear;
    }

    const accessContext = await bootstrapAccess();
    if (!accessContext) {
        document.documentElement.classList.remove('preload-view-home', 'preload-view-editor');
        return;
    }
    const isShareMode = accessContext.mode === 'share';
    const appUser = accessContext.user || null;
    const homeView = document.getElementById('home-view');
    const editorView = document.getElementById('editor-view');
    const projectsGrid = document.getElementById('projects-grid');
    const projectSortSelect = document.getElementById('project-sort');
    const projectSearchInput = document.getElementById('project-search');
    const projectCardTemplate = document.getElementById('project-card-template');

    const storyboardGrid = document.getElementById('storyboard-grid');
    const addShotBtn = document.getElementById('add-shot-btn');
    const template = document.getElementById('shot-template');
    const addDropdownToggle = document.getElementById('add-dropdown-toggle');
    const addDropdownMenu = document.getElementById('add-dropdown-menu');
    const exportPdfBtn = document.getElementById('export-pdf-btn');
    const multiSelectToggleBtn = document.getElementById('multi-select-toggle-btn');
    const backToHomeBtn = document.getElementById('back-to-home-btn');
    const aspectRatioSelect = document.getElementById('aspect-ratio-select');
    const projectAccessBadge = document.getElementById('project-access-badge');
    const projectTotalDuration = document.getElementById('project-total-duration');
    const manageSharingBtn = document.getElementById('manage-sharing-btn');
    const editLockBanner = document.getElementById('edit-lock-banner');
    const appContainer = document.querySelector('.app-container');
    const projectHeader = document.querySelector('.project-header');
    const headerTextInputs = projectHeader ? projectHeader.querySelectorAll('.flex-1 .header-input') : [];
    const projectInput = headerTextInputs[0] || null;
    const sceneInput = headerTextInputs[1] || null;
    if (sceneInput) {
        sceneInput.readOnly = true;
        sceneInput.placeholder = '自动关联当前场标题';
        sceneInput.setAttribute('aria-label', '当前场标题（自动）');
    }

    const printPages = document.createElement('div');
    printPages.id = 'print-pages';
    printPages.className = 'print-pages';
    document.body.appendChild(printPages);

    const multiSelectPanel = document.createElement('div');
    multiSelectPanel.className = 'multi-select-float-panel';
    multiSelectPanel.setAttribute('aria-hidden', 'true');
    const multiSelectGroupBtn = document.createElement('button');
    multiSelectGroupBtn.type = 'button';
    multiSelectGroupBtn.className = 'multi-select-action-btn group';
    multiSelectGroupBtn.textContent = '编组';
    const multiSelectUngroupBtn = document.createElement('button');
    multiSelectUngroupBtn.type = 'button';
    multiSelectUngroupBtn.className = 'multi-select-action-btn';
    multiSelectUngroupBtn.textContent = '取消编组';
    const multiSelectGroupDivider = document.createElement('div');
    multiSelectGroupDivider.className = 'multi-select-divider';
    const multiSelectDeleteBtn = document.createElement('button');
    multiSelectDeleteBtn.type = 'button';
    multiSelectDeleteBtn.className = 'multi-select-action-btn danger';
    multiSelectDeleteBtn.textContent = '批量删除所选镜头';
    const multiSelectDivider = document.createElement('div');
    multiSelectDivider.className = 'multi-select-divider';
    const multiSelectMoveTitle = document.createElement('div');
    multiSelectMoveTitle.className = 'multi-select-move-title';
    multiSelectMoveTitle.textContent = '批量移动到其他场';
    const multiSelectMoveList = document.createElement('div');
    multiSelectMoveList.className = 'multi-select-move-list';
    multiSelectPanel.appendChild(multiSelectGroupBtn);
    multiSelectPanel.appendChild(multiSelectUngroupBtn);
    multiSelectPanel.appendChild(multiSelectGroupDivider);
    multiSelectPanel.appendChild(multiSelectDeleteBtn);
    multiSelectPanel.appendChild(multiSelectDivider);
    multiSelectPanel.appendChild(multiSelectMoveTitle);
    multiSelectPanel.appendChild(multiSelectMoveList);
    document.body.appendChild(multiSelectPanel);
    const textColorPalette = document.createElement('div');
    textColorPalette.className = 'text-color-floating-palette';
    textColorPalette.setAttribute('aria-hidden', 'true');
    document.body.appendChild(textColorPalette);
    const clipboardToast = document.createElement('div');
    clipboardToast.className = 'clipboard-toast';
    clipboardToast.setAttribute('aria-live', 'polite');
    clipboardToast.setAttribute('aria-atomic', 'true');
    document.body.appendChild(clipboardToast);

    let projectsCache = [];
    let currentProjectId = null;
    let currentProject = null;
    let currentProjectVersion = null;
    let currentCapabilities = {};
    let editLeaseToken = '';
    let editLockHeartbeatTimer = null;
    let editLockHeartbeatPromise = null;
    let editorReadOnly = true;
    let saveConflictActive = false;
    let shotCount = 0;
    let isPrintLayoutReady = false;
    let hoveredImageUploadContext = null;
    let isRestoringState = false;
    let saveTimer = null;
    let hasUnsavedChanges = false;
    let pendingSavePromise = null;
    let saveStatusState = 'saved';
    let saveStatusElement = null;
    let takeoverNoticeShown = false;
    let searchTimer = null;
    const PRINT_PAGE_STYLE_ID = 'dynamic-print-page-style';
    const PRELOAD_HOME_CLASS = 'preload-view-home';
    const PRELOAD_EDITOR_CLASS = 'preload-view-editor';
    const DEFAULT_NEW_PROJECT_SHOT_COUNT = 5;
    const EDIT_LOCK_HEARTBEAT_MS = 3000;
    const PINNED_PROJECTS_KEY = `storyboard:pinned-project-ids:${appUser?.id || 'anonymous'}`;
    const PRESET_SCENE_COLOR_ROWS = buildPresetSceneColorRows();
    let pinnedProjectIds = loadPinnedProjectIds();
    let sceneDividerTriggerEl = null;
    let draggingSceneContext = null;
    let pendingHeaderSyncRaf = null;
    let pendingSceneHeaderSyncRaf = null;
    let pendingShotGroupFrameRaf = null;
    let storyboardSortable = null;
    let isMultiSelectMode = false;
    let hoveredShotGroupId = '';
    let printShotGroupPatternSequence = 0;
    let selectedShotCards = new Set();
    let lastMultiSelectPointer = null;
    let previousDocumentTitleBeforePrint = null;
    let activeTextColorRange = null;
    let activeTextColorField = null;
    let lastTextColorPointer = null;
    let clipboardToastHideTimer = null;

    function renderSaveStatus() {
        if (!saveStatusElement) return;
        saveStatusElement.classList.toggle('hidden', saveStatusState !== 'saved');
    }

    function setSaveStatusState(state) {
        saveStatusState = state;
        renderSaveStatus();
    }

    function setLockBanner(message = '', options = {}) {
        if (!editLockBanner) return;
        editLockBanner.innerHTML = '';
        saveStatusElement = null;
        editLockBanner.classList.toggle('hidden', !message);
        editLockBanner.classList.toggle('has-save-status', Boolean(message && options.showSaveStatus));
        if (!message) return;
        const text = document.createElement('span');
        text.className = 'edit-lock-message';
        text.textContent = message;
        editLockBanner.appendChild(text);
        if (options.showSaveStatus) {
            const status = document.createElement('span');
            status.className = 'save-status-indicator';
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            const dot = document.createElement('span');
            dot.className = 'save-status-dot';
            dot.setAttribute('aria-hidden', 'true');
            const label = document.createElement('span');
            label.textContent = '已保存';
            status.append(dot, label);
            saveStatusElement = status;
            editLockBanner.appendChild(status);
            renderSaveStatus();
        }
        if (options.force) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'secondary-btn compact-btn';
            button.textContent = '强制接管';
            button.addEventListener('click', () => acquireCurrentProjectLock(true));
            editLockBanner.appendChild(button);
        }
        if (options.reload) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'secondary-btn compact-btn';
            button.textContent = '重新载入服务器版本';
            button.addEventListener('click', () => openProject(currentProjectId, { flushSave: false, replaceHistory: true }));
            editLockBanner.appendChild(button);
        }
        if (options.saveCopy) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'secondary-btn compact-btn';
            button.textContent = '将本地内容另存为副本';
            button.addEventListener('click', saveLocalStateAsCopy);
            editLockBanner.appendChild(button);
        }
    }

    function showTakeoverNotice(error) {
        if (error?.code !== 'edit_lock_lost') return '';
        const holder = error.details?.displayName || error.details?.username;
        if (!holder) return '';
        const holderLabel = error.details?.isMine ? `${holder}（另一个标签页）` : holder;
        if (!takeoverNoticeShown) {
            takeoverNoticeShown = true;
            const backdrop = document.createElement('div');
            backdrop.className = 'takeover-alert-backdrop';
            const dialog = document.createElement('section');
            dialog.className = 'takeover-alert-dialog';
            dialog.setAttribute('role', 'alertdialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.setAttribute('aria-labelledby', 'takeover-alert-title');

            const icon = document.createElement('div');
            icon.className = 'takeover-alert-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = '!';
            const title = document.createElement('h2');
            title.id = 'takeover-alert-title';
            title.textContent = '编辑已被接管';
            const message = document.createElement('p');
            message.className = 'takeover-alert-message';
            message.textContent = `项目编辑权已被“${holderLabel}”接管。`;
            const detail = document.createElement('p');
            detail.className = 'takeover-alert-detail';
            detail.textContent = hasUnsavedChanges
                ? '当前页面已切换为只读，本地仍有尚未保存的修改。请另存为副本，或确认后重新载入服务器版本。'
                : '当前页面已切换为只读，后续修改不会自动保存。';
            const actions = document.createElement('div');
            actions.className = 'takeover-alert-actions';
            const acknowledge = document.createElement('button');
            acknowledge.type = 'button';
            acknowledge.className = 'primary-btn';
            acknowledge.textContent = '知道了';
            acknowledge.addEventListener('click', () => backdrop.remove());
            if (hasUnsavedChanges && currentCapabilities.canDuplicate) {
                const saveCopy = document.createElement('button');
                saveCopy.type = 'button';
                saveCopy.className = 'secondary-btn';
                saveCopy.textContent = '将本地内容另存为副本';
                saveCopy.addEventListener('click', () => {
                    backdrop.remove();
                    saveLocalStateAsCopy();
                });
                actions.appendChild(saveCopy);
            }
            actions.appendChild(acknowledge);
            dialog.append(icon, title, message, detail, actions);
            backdrop.appendChild(dialog);
            document.body.appendChild(backdrop);
            window.setTimeout(() => acknowledge.focus(), 0);
        }
        return holderLabel;
    }

    function applyEditorAccess() {
        const canEdit = Boolean(currentCapabilities.canEdit && editLeaseToken && !saveConflictActive);
        editorReadOnly = !canEdit;
        if (editorReadOnly && isMultiSelectMode) {
            setMultiSelectMode(false);
        }
        editorView.classList.toggle('is-readonly', editorReadOnly);
        if (projectInput) projectInput.readOnly = editorReadOnly;
        if (aspectRatioSelect) aspectRatioSelect.disabled = editorReadOnly;
        [addShotBtn, addDropdownToggle, multiSelectToggleBtn].forEach((button) => { if (button) button.disabled = editorReadOnly; });
        storyboardGrid.querySelectorAll('.rich-text-input').forEach((field) => field.setAttribute('contenteditable', canEdit ? 'true' : 'false'));
        storyboardGrid.querySelectorAll('input, button').forEach((control) => { control.disabled = editorReadOnly; });
        if (storyboardSortable) storyboardSortable.option('disabled', editorReadOnly || isMultiSelectMode);
        if (projectAccessBadge) {
            const accessRole = String(currentProject?.accessRole || '').toLowerCase();
            projectAccessBadge.textContent = ACCESS_ROLE_LABELS[accessRole] || accessRole;
            projectAccessBadge.dataset.role = accessRole;
            projectAccessBadge.classList.toggle('hidden', !accessRole);
            if (projectHeader) {
                if (accessRole) projectHeader.dataset.accessRole = accessRole;
                else delete projectHeader.dataset.accessRole;
            }
        }
        if (manageSharingBtn) manageSharingBtn.classList.toggle('hidden', !currentCapabilities.canManageMembers);
    }

    function stopLockHeartbeat() {
        if (editLockHeartbeatTimer) clearInterval(editLockHeartbeatTimer);
        editLockHeartbeatTimer = null;
        editLockHeartbeatPromise = null;
    }

    async function heartbeatCurrentProjectLock() {
        if (editLockHeartbeatPromise) {
            return editLockHeartbeatPromise;
        }
        if (!editLeaseToken || !currentProjectId || isShareMode) {
            return false;
        }

        const projectId = currentProjectId;
        const lease = editLeaseToken;
        const heartbeatPromise = (async () => {
            try {
                await apiRequest(`/api/projects/${projectId}/lock`, {
                    method: 'PATCH', headers: { 'X-Edit-Lease': lease }
                });
                return currentProjectId === projectId && editLeaseToken === lease;
            } catch (error) {
                if (currentProjectId !== projectId || editLeaseToken !== lease) {
                    return false;
                }
                if (error.status === 423 || error.status === 404) {
                    const takeoverHolder = showTakeoverNotice(error);
                    editLeaseToken = '';
                    saveConflictActive = true;
                    stopLockHeartbeat();
                    setLockBanner(
                        takeoverHolder
                            ? `编辑权已被 ${takeoverHolder} 接管，本地内容不会继续自动保存。`
                            : '编辑权已失效，本地内容不会继续自动保存。',
                        { reload: true, saveCopy: hasUnsavedChanges }
                    );
                    applyEditorAccess();
                }
                return false;
            }
        })();

        editLockHeartbeatPromise = heartbeatPromise;
        try {
            return await heartbeatPromise;
        } finally {
            if (editLockHeartbeatPromise === heartbeatPromise) {
                editLockHeartbeatPromise = null;
            }
        }
    }

    function startLockHeartbeat() {
        stopLockHeartbeat();
        if (!editLeaseToken || !currentProjectId) return;
        editLockHeartbeatTimer = setInterval(() => {
            heartbeatCurrentProjectLock();
        }, EDIT_LOCK_HEARTBEAT_MS);
    }

    async function releaseCurrentLock() {
        stopLockHeartbeat();
        const projectId = currentProjectId;
        const lease = editLeaseToken;
        editLeaseToken = '';
        if (!projectId || !lease || isShareMode) return;
        try {
            await apiRequest(`/api/projects/${projectId}/lock`, {
                method: 'DELETE', headers: { 'X-Edit-Lease': lease }, keepalive: true
            });
        } catch {
            // The lease will expire automatically.
        }
    }

    async function acquireCurrentProjectLock(force = false) {
        if (!currentProjectId || !currentCapabilities.canEdit || isShareMode) return false;
        try {
            const lock = await apiRequest(`/api/projects/${currentProjectId}/lock`, {
                method: 'POST', body: JSON.stringify({ force })
            });
            editLeaseToken = lock.leaseToken;
            currentProjectVersion = lock.version;
            saveConflictActive = false;
            takeoverNoticeShown = false;
            setSaveStatusState(hasUnsavedChanges ? 'unsaved' : 'saved');
            setLockBanner('你正在编辑此项目。', { showSaveStatus: true });
            applyEditorAccess();
            startLockHeartbeat();
            return true;
        } catch (error) {
            editLeaseToken = '';
            const holder = error.details?.displayName || error.details?.username || '另一位用户';
            setLockBanner(`项目正由 ${holder} 编辑，当前以只读方式打开。`, { force: Boolean(currentCapabilities.canForceLock) });
            applyEditorAccess();
            return false;
        }
    }

    async function saveLocalStateAsCopy() {
        if (!currentProjectId || !currentCapabilities.canDuplicate) return;
        const snapshot = buildStateSnapshot();
        try {
            const created = await apiRequest('/api/projects', {
                method: 'POST',
                body: JSON.stringify({ name: `${snapshot.name || '未命名项目'} 冲突副本`, sourceProjectId: currentProjectId })
            });
            const lock = await apiRequest(`/api/projects/${created.id}/lock`, { method: 'POST', body: '{}' });
            const saved = await apiRequest(`/api/projects/${created.id}`, {
                method: 'PUT',
                headers: { 'X-Edit-Lease': lock.leaseToken },
                body: JSON.stringify({ ...snapshot, baseVersion: created.version })
            });
            currentProjectId = saved.id;
            editLeaseToken = lock.leaseToken;
            saveConflictActive = false;
            applyProjectToEditor(saved);
            switchToEditor({ syncHistory: true, replaceHistory: false });
            setLockBanner('本地内容已另存为新项目。');
            startLockHeartbeat();
        } catch (error) {
            alert(error.message || '另存为副本失败。');
        }
    }
    function clearPreloadViewClasses() {
        document.documentElement.classList.remove(PRELOAD_HOME_CLASS, PRELOAD_EDITOR_CLASS);
    }
    function switchToHome(options = {}) {
        const { syncHistory = true, replaceHistory = false } = options;
        clearPreloadViewClasses();
        setMultiSelectMode(false);
        homeView.classList.remove('hidden');
        editorView.classList.add('hidden');
        sessionStorage.setItem(VIEW_STORAGE_KEY, 'home');
        sessionStorage.removeItem(PROJECT_STORAGE_KEY);
        if (syncHistory) {
            syncBrowserHistory({ view: 'home' }, replaceHistory);
        }
    }

    function switchToEditor(options = {}) {
        const { syncHistory = true, replaceHistory = false } = options;
        clearPreloadViewClasses();
        homeView.classList.add('hidden');
        editorView.classList.remove('hidden');
        sessionStorage.setItem(VIEW_STORAGE_KEY, 'editor');
        if (currentProjectId) {
            sessionStorage.setItem(PROJECT_STORAGE_KEY, String(currentProjectId));
        }
        if (syncHistory && currentProjectId) {
            syncBrowserHistory({ view: 'editor', projectId: currentProjectId }, replaceHistory);
        }
        scheduleSyncProjectHeaderWidth(true);
        scheduleSyncSceneHeaderInputByViewport();
        scheduleSyncShotGroupFrames();
    }

    function scheduleSyncProjectHeaderWidth(runDouble = false) {
        if (pendingHeaderSyncRaf) {
            cancelAnimationFrame(pendingHeaderSyncRaf);
        }

        pendingHeaderSyncRaf = requestAnimationFrame(() => {
            pendingHeaderSyncRaf = null;
            syncProjectHeaderWidth();
            if (runDouble) {
                requestAnimationFrame(syncProjectHeaderWidth);
            }
        });
    }

    function syncProjectHeaderWidth() {
        const perfMeta = {
            inEditor: !editorView.classList.contains('hidden'),
            availableWidth: 0,
            itemCount: 0,
            cardCount: 0,
            targetColumns: 0
        };

        perfMeasureSync('syncProjectHeaderWidth', () => {
            if (!projectHeader || !storyboardGrid || editorView.classList.contains('hidden')) {
                return;
            }

            const availableWidth = Math.max(0, storyboardGrid.clientWidth);
            perfMeta.availableWidth = Math.round(availableWidth);
            if (availableWidth > 0) {
                storyboardGrid.style.setProperty('--storyboard-content-width', `${Math.round(availableWidth)}px`);
            } else {
                storyboardGrid.style.removeProperty('--storyboard-content-width');
            }

            projectHeader.style.width = '';
            projectHeader.style.maxWidth = '';
            projectHeader.style.marginLeft = '';
            projectHeader.style.marginRight = '';

            const items = Array.from(storyboardGrid.children).filter((item) => !item.classList.contains('scene-divider-trigger'));
            const allCards = items.filter((item) => item.classList.contains('shot-card'));
            perfMeta.itemCount = items.length;
            perfMeta.cardCount = allCards.length;
            if (allCards.length === 0) {
                storyboardGrid.style.setProperty('--grid-columns', '1');
                return;
            }

            let hasDivider = false;
            let dividerCount = 0;
            let currentSceneCount = 0;
            let maxSceneCount = 0;
            items.forEach((item) => {
                if (item.classList.contains('scene-divider')) {
                    hasDivider = true;
                    dividerCount += 1;
                    maxSceneCount = Math.max(maxSceneCount, currentSceneCount);
                    currentSceneCount = 0;
                    return;
                }
                if (item.classList.contains('shot-card')) {
                    currentSceneCount += 1;
                }
            });
            maxSceneCount = Math.max(maxSceneCount, currentSceneCount);
            const sceneCount = hasDivider ? dividerCount : 1;
            const targetSceneCards = hasDivider ? maxSceneCount : allCards.length;

            const gridComputedStyle = window.getComputedStyle(storyboardGrid);
            const rootComputedStyle = window.getComputedStyle(document.documentElement);
            const gridGap = Number.parseFloat(gridComputedStyle.columnGap) || 20;
            const shotCardWidth = Number.parseFloat(rootComputedStyle.getPropertyValue('--shot-card-width')) || 285;
            const maxColumnsByWidth = Math.max(1, Math.floor((availableWidth + gridGap) / (shotCardWidth + gridGap)));
            const targetColumns = Math.max(1, Math.min(targetSceneCards, maxColumnsByWidth));
            perfMeta.targetColumns = targetColumns;
            storyboardGrid.style.setProperty('--grid-columns', String(targetColumns));

            // Center each visible scene within the shared target column width.
            allCards.forEach((card) => {
                card.style.gridColumnStart = '';
            });
            let visibleSceneCards = [];
            const flushVisibleScene = () => {
                if (visibleSceneCards.length === 0) {
                    return;
                }
                const sceneVisibleCount = visibleSceneCards.length;
                const shouldCenterThisScene = sceneCount === 1;
                const startColumn = shouldCenterThisScene && sceneVisibleCount < targetColumns
                    ? Math.floor((targetColumns - sceneVisibleCount) / 2) + 1
                    : 1;
                let nextColumn = startColumn;
                let cardIndex = 0;
                while (cardIndex < visibleSceneCards.length) {
                    const firstCard = visibleSceneCards[cardIndex];
                    const groupId = normalizeShotGroupId(firstCard.dataset.shotGroupId);
                    let unitSize = 1;
                    if (groupId) {
                        while (
                            cardIndex + unitSize < visibleSceneCards.length
                            && normalizeShotGroupId(visibleSceneCards[cardIndex + unitSize].dataset.shotGroupId) === groupId
                        ) {
                            unitSize += 1;
                        }
                    }

                    if (nextColumn > targetColumns) {
                        nextColumn = 1;
                    }
                    const remainingColumns = targetColumns - nextColumn + 1;
                    const moveWholeGroupToNextRow = unitSize <= targetColumns && unitSize > remainingColumns;
                    if (moveWholeGroupToNextRow) {
                        nextColumn = 1;
                    }
                    if (cardIndex === 0 || moveWholeGroupToNextRow) {
                        firstCard.style.gridColumnStart = String(nextColumn);
                    }

                    nextColumn += unitSize;
                    cardIndex += unitSize;
                }
                visibleSceneCards = [];
            };

            items.forEach((item) => {
                if (item.classList.contains('scene-divider')) {
                    flushVisibleScene();
                    return;
                }
                if (!item.classList.contains('shot-card')) {
                    return;
                }
                if (!item.classList.contains('scene-collapsed-hidden')) {
                    visibleSceneCards.push(item);
                }
            });
            flushVisibleScene();
        }, () => perfMeta);
        scheduleSyncShotGroupFrames();
    }

    function clearTextSelection() {
        const selection = window.getSelection && window.getSelection();
        if (selection && selection.rangeCount > 0) {
            selection.removeAllRanges();
        }
    }

    function closeAllColorPalettes() {
        document.querySelectorAll('.scene-color-palette.show').forEach((palette) => {
            palette.classList.remove('show');
        });
    }

    function hideTextColorPalette() {
        textColorPalette.classList.remove('show');
        textColorPalette.setAttribute('aria-hidden', 'true');
        activeTextColorRange = null;
        activeTextColorField = null;
    }

    function showTextColorPaletteAt(clientX, clientY) {
        const fallbackX = window.innerWidth / 2;
        const fallbackY = window.innerHeight / 2;
        const nextX = Number.isFinite(clientX) ? clientX : (lastTextColorPointer?.x ?? fallbackX);
        const nextY = Number.isFinite(clientY) ? clientY : (lastTextColorPointer?.y ?? fallbackY);
        lastTextColorPointer = { x: nextX, y: nextY };

        textColorPalette.classList.add('show');
        textColorPalette.setAttribute('aria-hidden', 'false');

        const offset = 10;
        const margin = 8;
        const rect = textColorPalette.getBoundingClientRect();
        const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
        const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
        const left = Math.max(margin, Math.min(nextX + offset, maxLeft));
        const top = Math.max(margin, Math.min(nextY + offset, maxTop));
        textColorPalette.style.left = `${Math.round(left)}px`;
        textColorPalette.style.top = `${Math.round(top)}px`;
    }

    function restoreActiveTextColorSelection() {
        if (!activeTextColorRange || !activeTextColorField || !activeTextColorField.isConnected) {
            return null;
        }

        activeTextColorField.focus();
        const selection = window.getSelection && window.getSelection();
        if (!selection) {
            return null;
        }
        selection.removeAllRanges();
        selection.addRange(activeTextColorRange);
        return selection;
    }

    function cacheActiveTextColorSelection(field, clientX = null, clientY = null) {
        if (!isEditableShotField(field)) {
            hideTextColorPalette();
            return;
        }

        const selection = window.getSelection && window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
            hideTextColorPalette();
            return;
        }

        const range = selection.getRangeAt(0);
        if (!field.contains(range.commonAncestorContainer)) {
            hideTextColorPalette();
            return;
        }

        activeTextColorField = field;
        activeTextColorRange = range.cloneRange();

        const rect = range.getBoundingClientRect();
        const anchorX = Number.isFinite(clientX) ? clientX : (rect.left + (rect.width / 2));
        const anchorY = Number.isFinite(clientY) ? clientY : rect.bottom;
        showTextColorPaletteAt(anchorX, anchorY);
    }

    function resolveDefaultTextColorValue(field) {
        if (field?.classList?.contains('text-dialogue')) {
            return 'var(--primary-color)';
        }
        return 'var(--text-main)';
    }

    function applyColorToActiveSelection(colorValue) {
        if (!colorValue) {
            return;
        }

        const selection = restoreActiveTextColorSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
            hideTextColorPalette();
            return;
        }

        const isDefaultColor = colorValue === DEFAULT_TEXT_COLOR_TOKEN;
        const targetColorValue = isDefaultColor
            ? resolveDefaultTextColorValue(activeTextColorField)
            : colorValue;

        let applied = false;
        if (!isDefaultColor && typeof document.execCommand === 'function') {
            try {
                document.execCommand('styleWithCSS', false, true);
                applied = document.execCommand('foreColor', false, targetColorValue);
            } catch {
                applied = false;
            }
        }

        if (!applied) {
            const range = selection.getRangeAt(0);
            const span = document.createElement('span');
            span.style.color = targetColorValue;
            const extracted = range.extractContents();
            span.appendChild(extracted);
            range.insertNode(span);
        }

        cleanupEditableFieldMarkup(activeTextColorField);
        autoResizeTextarea(activeTextColorField);
        scheduleSaveState();
        hideTextColorPalette();
    }

    TEXT_COLOR_OPTIONS.forEach((item) => {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'text-color-swatch';
        swatch.style.background = item.swatch || item.value;
        swatch.title = `应用${item.label}`;
        swatch.setAttribute('aria-label', `应用${item.label}`);
        swatch.addEventListener('mousedown', (event) => {
            event.preventDefault();
            event.stopPropagation();
            applyColorToActiveSelection(item.value);
        });
        textColorPalette.appendChild(swatch);
    });
    textColorPalette.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
    });

    function isSceneDividerShot(item) {
        return Boolean(item && typeof item === 'object' && item.type === 'scene-divider');
    }

    function normalizeSceneDividerLabel(value) {
        return (value || '').replace(/\s+/g, ' ').trim();
    }

    function countStoryboardCards(items) {
        if (!Array.isArray(items)) {
            return 0;
        }
        return items.filter((item) => !isSceneDividerShot(item)).length;
    }

    function getAllSceneDividers() {
        return Array.from(storyboardGrid.querySelectorAll('.scene-divider'));
    }

    function getFollowingSceneCards(divider) {
        const cards = [];
        let current = divider?.nextElementSibling || null;
        while (current) {
            if (current.classList.contains('scene-divider') || current.classList.contains('scene-divider-trigger')) {
                break;
            }
            if (current.classList.contains('shot-card')) {
                cards.push(current);
            }
            current = current.nextElementSibling;
        }
        return cards;
    }

    function updateMultiSelectToggleButton() {
        if (!multiSelectToggleBtn) {
            return;
        }
        multiSelectToggleBtn.classList.toggle('is-active', isMultiSelectMode);
        multiSelectToggleBtn.setAttribute('aria-pressed', isMultiSelectMode ? 'true' : 'false');
    }

    function hideMultiSelectPanel() {
        multiSelectPanel.classList.remove('show');
        multiSelectPanel.setAttribute('aria-hidden', 'true');
    }

    function showMultiSelectPanelAt(clientX, clientY) {
        const fallbackX = window.innerWidth / 2;
        const fallbackY = window.innerHeight / 2;
        const nextX = Number.isFinite(clientX) ? clientX : (lastMultiSelectPointer?.x ?? fallbackX);
        const nextY = Number.isFinite(clientY) ? clientY : (lastMultiSelectPointer?.y ?? fallbackY);
        lastMultiSelectPointer = { x: nextX, y: nextY };

        multiSelectPanel.classList.add('show');
        multiSelectPanel.setAttribute('aria-hidden', 'false');

        const offset = 12;
        const margin = 8;
        const panelRect = multiSelectPanel.getBoundingClientRect();
        const maxLeft = Math.max(margin, window.innerWidth - panelRect.width - margin);
        const maxTop = Math.max(margin, window.innerHeight - panelRect.height - margin);
        const left = Math.max(margin, Math.min(nextX + offset, maxLeft));
        const top = Math.max(margin, Math.min(nextY + offset, maxTop));
        multiSelectPanel.style.left = `${Math.round(left)}px`;
        multiSelectPanel.style.top = `${Math.round(top)}px`;
    }

    function getSceneSegments() {
        const trigger = ensureSceneDividerTrigger();
        const items = Array.from(storyboardGrid.children).filter((item) => item !== trigger);
        const hasDivider = items.some((item) => item.classList.contains('scene-divider'));
        if (!hasDivider) {
            return [{
                index: 0,
                divider: null,
                label: '第1场',
                cards: items.filter((item) => item.classList.contains('shot-card'))
            }];
        }

        const segments = [];
        let currentSegment = null;
        items.forEach((item) => {
            if (item.classList.contains('scene-divider')) {
                const rawLabel = normalizeSceneDividerLabel(item.querySelector('.scene-divider-label-text')?.textContent || '');
                currentSegment = {
                    index: segments.length,
                    divider: item,
                    label: rawLabel || `第${segments.length + 1}场`,
                    cards: []
                };
                segments.push(currentSegment);
                return;
            }
            if (!item.classList.contains('shot-card')) {
                return;
            }
            if (!currentSegment) {
                currentSegment = {
                    index: segments.length,
                    divider: null,
                    label: `第${segments.length + 1}场`,
                    cards: []
                };
                segments.push(currentSegment);
            }
            currentSegment.cards.push(item);
        });

        if (segments.length === 0) {
            return [{
                index: 0,
                divider: null,
                label: '第1场',
                cards: []
            }];
        }
        return segments;
    }

    function getSceneSegmentDisplayLabel(segment) {
        const normalized = normalizeSceneDividerLabel(segment?.label || '');
        if (normalized) {
            return normalized;
        }
        const fallbackIndex = Number.isInteger(segment?.index) ? segment.index + 1 : 1;
        return `第${fallbackIndex}场`;
    }

    function getSceneSegmentStartElement(segment) {
        if (!segment || typeof segment !== 'object') {
            return null;
        }
        if (segment.divider && segment.divider.isConnected) {
            return segment.divider;
        }

        const cards = Array.isArray(segment.cards) ? segment.cards : [];
        const firstVisibleCard = cards.find((card) => (
            card
            && card.isConnected
            && card.classList.contains('shot-card')
            && !card.classList.contains('scene-collapsed-hidden')
        ));
        if (firstVisibleCard) {
            return firstVisibleCard;
        }
        return cards.find((card) => card && card.isConnected && card.classList.contains('shot-card')) || null;
    }

    function resolveCurrentSceneSegment(segments) {
        const sceneSegments = Array.isArray(segments) && segments.length > 0
            ? segments
            : getSceneSegments();
        if (sceneSegments.length === 0) {
            return null;
        }

        const anchorY = projectHeader
            ? projectHeader.getBoundingClientRect().bottom + 8
            : 0;
        let activeSegment = sceneSegments[0];
        let firstSegmentWithStart = null;
        let hasMatchedAnchor = false;

        sceneSegments.forEach((segment) => {
            const startEl = getSceneSegmentStartElement(segment);
            if (!startEl) {
                return;
            }
            if (!firstSegmentWithStart) {
                firstSegmentWithStart = segment;
            }
            if (startEl.getBoundingClientRect().top <= anchorY) {
                activeSegment = segment;
                hasMatchedAnchor = true;
            }
        });

        if (hasMatchedAnchor) {
            return activeSegment;
        }
        return firstSegmentWithStart || activeSegment;
    }

    function syncSceneHeaderInputByViewport() {
        if (!sceneInput || editorView.classList.contains('hidden')) {
            return;
        }
        const segments = getSceneSegments();
        const activeSegment = resolveCurrentSceneSegment(segments);
        const nextLabel = getSceneSegmentDisplayLabel(activeSegment);
        if (sceneInput.value !== nextLabel) {
            sceneInput.value = nextLabel;
        }
    }

    function scheduleSyncSceneHeaderInputByViewport() {
        if (pendingSceneHeaderSyncRaf) {
            cancelAnimationFrame(pendingSceneHeaderSyncRaf);
        }
        pendingSceneHeaderSyncRaf = requestAnimationFrame(() => {
            pendingSceneHeaderSyncRaf = null;
            syncSceneHeaderInputByViewport();
        });
    }

    function getSceneIndexForCard(card, segments) {
        for (let i = 0; i < segments.length; i += 1) {
            if (segments[i].cards.includes(card)) {
                return i;
            }
        }
        return -1;
    }

    function getSelectedShotCardsInDomOrder() {
        return Array.from(storyboardGrid.querySelectorAll('.shot-card.multi-selected'));
    }

    function normalizeShotGroupId(value) {
        return typeof value === 'string' ? value.trim() : '';
    }

    function setShotCardGroup(card, groupId) {
        if (!card || !card.classList?.contains('shot-card')) {
            return;
        }
        const normalizedGroupId = normalizeShotGroupId(groupId);
        if (normalizedGroupId) {
            card.dataset.shotGroupId = normalizedGroupId;
            card.classList.add('shot-grouped');
            return;
        }
        delete card.dataset.shotGroupId;
        card.classList.remove('shot-grouped', 'is-group-hovered');
    }

    function buildShotGroupUnionPath(rectangles) {
        if (!Array.isArray(rectangles) || rectangles.length === 0) {
            return '';
        }
        const cornerRadius = 4;
        const formatCoordinate = (value) => String(Math.round(value * 100) / 100);
        const buildRoundedPath = (points) => {
            const closedPoints = points.length > 1
                && points[0][0] === points[points.length - 1][0]
                && points[0][1] === points[points.length - 1][1]
                ? points.slice(0, -1)
                : points;
            if (closedPoints.length < 3) {
                return '';
            }
            const corners = closedPoints.map(([x, y], index) => {
                const [previousX, previousY] = closedPoints[(index - 1 + closedPoints.length) % closedPoints.length];
                const [nextX, nextY] = closedPoints[(index + 1) % closedPoints.length];
                const previousDistance = Math.hypot(previousX - x, previousY - y);
                const nextDistance = Math.hypot(nextX - x, nextY - y);
                if (previousDistance === 0 || nextDistance === 0) {
                    return { point: [x, y], before: [x, y], after: [x, y] };
                }
                const radius = Math.min(cornerRadius, previousDistance / 2, nextDistance / 2);
                const before = [
                    x + ((previousX - x) / previousDistance) * radius,
                    y + ((previousY - y) / previousDistance) * radius
                ];
                const after = [
                    x + ((nextX - x) / nextDistance) * radius,
                    y + ((nextY - y) / nextDistance) * radius
                ];
                return { point: [x, y], before, after };
            });
            const firstCorner = corners[0];
            const commands = [
                `M ${formatCoordinate(firstCorner.before[0])} ${formatCoordinate(firstCorner.before[1])}`,
                `Q ${formatCoordinate(firstCorner.point[0])} ${formatCoordinate(firstCorner.point[1])} ${formatCoordinate(firstCorner.after[0])} ${formatCoordinate(firstCorner.after[1])}`
            ];
            corners.slice(1).forEach((corner) => {
                commands.push(`L ${formatCoordinate(corner.before[0])} ${formatCoordinate(corner.before[1])}`);
                commands.push(`Q ${formatCoordinate(corner.point[0])} ${formatCoordinate(corner.point[1])} ${formatCoordinate(corner.after[0])} ${formatCoordinate(corner.after[1])}`);
            });
            commands.push(`L ${formatCoordinate(firstCorner.before[0])} ${formatCoordinate(firstCorner.before[1])} Z`);
            return commands.join(' ');
        };
        const xs = Array.from(new Set(rectangles.flatMap((rect) => [rect.left, rect.right])))
            .sort((left, right) => left - right);
        const ys = Array.from(new Set(rectangles.flatMap((rect) => [rect.top, rect.bottom])))
            .sort((left, right) => left - right);
        const occupied = Array.from({ length: Math.max(0, ys.length - 1) }, () => (
            Array(Math.max(0, xs.length - 1)).fill(false)
        ));

        for (let row = 0; row < ys.length - 1; row += 1) {
            for (let column = 0; column < xs.length - 1; column += 1) {
                const centerX = (xs[column] + xs[column + 1]) / 2;
                const centerY = (ys[row] + ys[row + 1]) / 2;
                occupied[row][column] = rectangles.some((rect) => (
                    centerX > rect.left && centerX < rect.right
                    && centerY > rect.top && centerY < rect.bottom
                ));
            }
        }

        const edges = [];
        const addEdge = (fromX, fromY, toX, toY) => {
            edges.push({ fromX, fromY, toX, toY, used: false });
        };
        const isOccupied = (row, column) => Boolean(occupied[row]?.[column]);

        for (let row = 0; row < occupied.length; row += 1) {
            for (let column = 0; column < occupied[row].length; column += 1) {
                if (!occupied[row][column]) {
                    continue;
                }
                const left = xs[column];
                const right = xs[column + 1];
                const top = ys[row];
                const bottom = ys[row + 1];
                if (!isOccupied(row - 1, column)) addEdge(left, top, right, top);
                if (!isOccupied(row, column + 1)) addEdge(right, top, right, bottom);
                if (!isOccupied(row + 1, column)) addEdge(right, bottom, left, bottom);
                if (!isOccupied(row, column - 1)) addEdge(left, bottom, left, top);
            }
        }

        const pointKey = (x, y) => `${x},${y}`;
        const outgoingEdges = new Map();
        edges.forEach((edge) => {
            const key = pointKey(edge.fromX, edge.fromY);
            if (!outgoingEdges.has(key)) {
                outgoingEdges.set(key, []);
            }
            outgoingEdges.get(key).push(edge);
        });

        const paths = [];
        edges.forEach((startEdge) => {
            if (startEdge.used) {
                return;
            }
            const points = [[startEdge.fromX, startEdge.fromY]];
            let edge = startEdge;
            while (edge && !edge.used) {
                edge.used = true;
                points.push([edge.toX, edge.toY]);
                if (edge.toX === startEdge.fromX && edge.toY === startEdge.fromY) {
                    break;
                }
                edge = (outgoingEdges.get(pointKey(edge.toX, edge.toY)) || [])
                    .find((candidate) => !candidate.used) || null;
            }
            if (points.length > 3) {
                const roundedPath = buildRoundedPath(points);
                if (roundedPath) {
                    paths.push(roundedPath);
                }
            }
        });

        return paths.join(' ');
    }

    function buildShotGroupFrameRectangles(cards, padding) {
        const visibleCards = cards
            .filter((card) => card && card.offsetParent !== null)
            .map((card) => ({
                left: card.offsetLeft,
                top: card.offsetTop,
                right: card.offsetLeft + card.offsetWidth,
                bottom: card.offsetTop + card.offsetHeight
            }))
            .sort((left, right) => left.top - right.top || left.left - right.left);
        if (visibleCards.length === 0) {
            return [];
        }

        const rowTolerance = 3;
        const rows = [];
        visibleCards.forEach((rect) => {
            let row = rows.find((candidate) => Math.abs(candidate.top - rect.top) <= rowTolerance);
            if (!row) {
                row = { top: rect.top, cards: [] };
                rows.push(row);
            }
            row.cards.push(rect);
        });

        const rowRects = rows.map((row) => ({
            left: Math.min(...row.cards.map((rect) => rect.left)) - padding,
            top: Math.min(...row.cards.map((rect) => rect.top)) - padding,
            right: Math.max(...row.cards.map((rect) => rect.right)) + padding,
            bottom: Math.max(...row.cards.map((rect) => rect.bottom)) + padding
        }));
        const rectangles = [...rowRects];

        for (let index = 1; index < rowRects.length; index += 1) {
            const previous = rowRects[index - 1];
            const current = rowRects[index];
            const overlapLeft = Math.max(previous.left, current.left);
            const overlapRight = Math.min(previous.right, current.right);
            let left;
            let right;
            if (overlapRight > overlapLeft) {
                const center = (overlapLeft + overlapRight) / 2;
                left = center - 5;
                right = center + 5;
            } else if (previous.right <= current.left) {
                left = previous.right - 1;
                right = current.left + 1;
            } else {
                left = current.right - 1;
                right = previous.left + 1;
            }
            rectangles.push({
                left,
                top: Math.min(previous.bottom, current.top) - 1,
                right,
                bottom: Math.max(previous.bottom, current.top) + 1
            });
        }

        return rectangles.map((rect) => ({
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            right: Math.round(rect.right),
            bottom: Math.round(rect.bottom)
        }));
    }

    function buildShotGroupGapRectangles(cards) {
        const visibleCards = cards
            .filter((card) => card && card.offsetParent !== null)
            .map((card) => ({
                left: card.offsetLeft,
                top: card.offsetTop,
                right: card.offsetLeft + card.offsetWidth,
                bottom: card.offsetTop + card.offsetHeight
            }))
            .sort((left, right) => left.top - right.top || left.left - right.left);
        const rowTolerance = 3;
        const gaps = [];
        for (let index = 1; index < visibleCards.length; index += 1) {
            const previous = visibleCards[index - 1];
            const current = visibleCards[index];
            if (Math.abs(previous.top - current.top) > rowTolerance || current.left <= previous.right) {
                continue;
            }
            gaps.push({
                left: Math.round(previous.right),
                top: Math.round(Math.min(previous.top, current.top)),
                right: Math.round(current.left),
                bottom: Math.round(Math.max(previous.bottom, current.bottom))
            });
        }
        return gaps;
    }

    function renderShotGroupFrames(grid) {
        if (!grid) {
            return;
        }
        grid.querySelectorAll(':scope > .shot-group-frame-layer').forEach((layer) => layer.remove());
        const cardsByGroup = new Map();
        grid.querySelectorAll(':scope > .shot-card.shot-grouped').forEach((card) => {
            const groupId = normalizeShotGroupId(card.dataset.shotGroupId);
            if (!groupId) {
                return;
            }
            if (!cardsByGroup.has(groupId)) {
                cardsByGroup.set(groupId, []);
            }
            cardsByGroup.get(groupId).push(card);
        });
        if (cardsByGroup.size === 0) {
            return;
        }

        const svgNamespace = 'http://www.w3.org/2000/svg';
        const layer = document.createElementNS(svgNamespace, 'svg');
        const width = Math.max(grid.clientWidth, grid.scrollWidth);
        const height = Math.max(grid.clientHeight, grid.scrollHeight);
        layer.classList.add('shot-group-frame-layer');
        layer.setAttribute('width', String(width));
        layer.setAttribute('height', String(height));
        layer.setAttribute('viewBox', `0 0 ${width} ${height}`);
        layer.setAttribute('aria-hidden', 'true');

        const hatchPatternId = 'shot-group-hatch-pattern';
        const definitions = document.createElementNS(svgNamespace, 'defs');
        const hatchPattern = document.createElementNS(svgNamespace, 'pattern');
        hatchPattern.setAttribute('id', hatchPatternId);
        hatchPattern.setAttribute('width', '4');
        hatchPattern.setAttribute('height', '4');
        hatchPattern.setAttribute('patternUnits', 'userSpaceOnUse');
        hatchPattern.setAttribute('patternTransform', 'rotate(45)');
        const hatchStripe = document.createElementNS(svgNamespace, 'rect');
        hatchStripe.classList.add('shot-group-hatch-stripe');
        hatchStripe.setAttribute('x', '0');
        hatchStripe.setAttribute('y', '0');
        hatchStripe.setAttribute('width', '1.5');
        hatchStripe.setAttribute('height', '4');
        hatchPattern.appendChild(hatchStripe);
        definitions.appendChild(hatchPattern);
        layer.appendChild(definitions);

        cardsByGroup.forEach((cards, groupId) => {
            const rectangles = buildShotGroupFrameRectangles(cards, 0);
            const pathData = buildShotGroupUnionPath(rectangles);
            if (!pathData) {
                return;
            }
            const isHovered = !grid.classList.contains('is-multi-select')
                && !grid.classList.contains('is-sorting')
                && (hoveredShotGroupId === groupId || cards.some((card) => card.matches(':hover')));
            cards.forEach((card) => card.classList.toggle('is-group-hovered', isHovered));

            const offsetShadow = document.createElementNS(svgNamespace, 'path');
            offsetShadow.classList.add('shot-group-shadow-path', 'shot-group-shadow-offset');
            offsetShadow.setAttribute('d', pathData);
            offsetShadow.dataset.shotGroupId = groupId;
            offsetShadow.classList.toggle('is-hovered', isHovered);
            layer.appendChild(offsetShadow);

            buildShotGroupGapRectangles(cards).forEach((gap) => {
                const connector = document.createElementNS(svgNamespace, 'g');
                connector.classList.add('shot-group-connector');
                connector.classList.toggle('is-hovered', isHovered);
                connector.dataset.shotGroupId = groupId;

                const hatch = document.createElementNS(svgNamespace, 'rect');
                hatch.classList.add('shot-group-hatch-connector');
                hatch.setAttribute('x', String(gap.left));
                hatch.setAttribute('y', String(gap.top));
                hatch.setAttribute('width', String(gap.right - gap.left));
                hatch.setAttribute('height', String(gap.bottom - gap.top));
                hatch.setAttribute('fill', `url(#${hatchPatternId})`);
                connector.appendChild(hatch);

                [gap.top + 0.75, gap.bottom - 0.75].forEach((y) => {
                    const edge = document.createElementNS(svgNamespace, 'line');
                    edge.classList.add('shot-group-connector-edge');
                    edge.setAttribute('x1', String(gap.left));
                    edge.setAttribute('x2', String(gap.right));
                    edge.setAttribute('y1', String(y));
                    edge.setAttribute('y2', String(y));
                    connector.appendChild(edge);
                });

                layer.appendChild(connector);
            });
        });

        if (layer.childNodes.length > 0) {
            grid.insertBefore(layer, grid.firstChild);
        }
    }

    function scheduleSyncShotGroupFrames() {
        if (pendingShotGroupFrameRaf) {
            cancelAnimationFrame(pendingShotGroupFrameRaf);
        }
        pendingShotGroupFrameRaf = requestAnimationFrame(() => {
            pendingShotGroupFrameRaf = null;
            renderShotGroupFrames(storyboardGrid);
        });
    }

    function getShotGroupIdFromPointerTarget(target) {
        if (!(target instanceof Element)) {
            return '';
        }
        const card = target.closest('.shot-card.shot-grouped');
        if (card?.parentElement === storyboardGrid) {
            return normalizeShotGroupId(card.dataset.shotGroupId);
        }
        const connector = target.closest('.shot-group-connector');
        return normalizeShotGroupId(connector?.dataset.shotGroupId);
    }

    function setShotGroupHoverState(groupId, isHovered) {
        const normalizedGroupId = normalizeShotGroupId(groupId);
        if (!normalizedGroupId) {
            return;
        }
        const shouldHover = Boolean(isHovered)
            && !storyboardGrid.classList.contains('is-multi-select')
            && !storyboardGrid.classList.contains('is-sorting');
        if (shouldHover) {
            hoveredShotGroupId = normalizedGroupId;
        } else if (hoveredShotGroupId === normalizedGroupId) {
            hoveredShotGroupId = '';
        }
        storyboardGrid.querySelectorAll(':scope > .shot-card.shot-grouped').forEach((card) => {
            if (normalizeShotGroupId(card.dataset.shotGroupId) === normalizedGroupId) {
                card.classList.toggle('is-group-hovered', shouldHover);
            }
        });
        storyboardGrid.querySelectorAll(':scope > .shot-group-frame-layer [data-shot-group-id]')
            .forEach((groupElement) => {
                if (normalizeShotGroupId(groupElement.dataset.shotGroupId) === normalizedGroupId) {
                    groupElement.classList.toggle('is-hovered', shouldHover);
                }
            });
    }

    storyboardGrid.addEventListener('mouseover', (event) => {
        const groupId = getShotGroupIdFromPointerTarget(event.target);
        if (!groupId) {
            return;
        }
        if (getShotGroupIdFromPointerTarget(event.relatedTarget) === groupId) {
            return;
        }
        setShotGroupHoverState(groupId, true);
    });

    storyboardGrid.addEventListener('mouseout', (event) => {
        const groupId = getShotGroupIdFromPointerTarget(event.target);
        if (!groupId) {
            return;
        }
        if (getShotGroupIdFromPointerTarget(event.relatedTarget) === groupId) {
            return;
        }
        setShotGroupHoverState(groupId, false);
    });

    function areShotCardsContiguousInSameScene(cards) {
        const normalizedCards = Array.from(new Set(cards || []))
            .filter((card) => card && card.classList?.contains('shot-card'));
        if (normalizedCards.length < 2) {
            return false;
        }
        const allCards = Array.from(storyboardGrid.querySelectorAll('.shot-card'));
        const indexes = normalizedCards
            .map((card) => allCards.indexOf(card))
            .sort((left, right) => left - right);
        if (indexes.some((index) => index < 0)) {
            return false;
        }
        const areContiguous = indexes.every((index, position) => {
            return position === 0 || index === indexes[position - 1] + 1;
        });
        if (!areContiguous) {
            return false;
        }
        const segments = getSceneSegments();
        const sceneIndexes = new Set(
            normalizedCards.map((card) => getSceneIndexForCard(card, segments))
        );
        return sceneIndexes.size === 1 && !sceneIndexes.has(-1);
    }

    function cleanupInvalidShotGroups() {
        const cardsByGroup = new Map();
        storyboardGrid.querySelectorAll('.shot-card').forEach((card) => {
            const groupId = normalizeShotGroupId(card.dataset.shotGroupId);
            if (!groupId) {
                setShotCardGroup(card, '');
                return;
            }
            if (!cardsByGroup.has(groupId)) {
                cardsByGroup.set(groupId, []);
            }
            cardsByGroup.get(groupId).push(card);
        });
        cardsByGroup.forEach((cards) => {
            if (cards.length > 3 || !areShotCardsContiguousInSameScene(cards)) {
                cards.forEach((card) => setShotCardGroup(card, ''));
            }
        });
    }

    function createShotGroupId() {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
            return `shot-group-${globalThis.crypto.randomUUID()}`;
        }
        return `shot-group-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    function groupSelectedShots() {
        if (editorReadOnly) {
            return;
        }
        const selectedCards = getSelectedShotCardsInDomOrder();
        if (selectedCards.length < 2) {
            return;
        }
        if (selectedCards.length > 3) {
            window.alert('每组最多可以包含 3 张卡片。');
            return;
        }
        if (!areShotCardsContiguousInSameScene(selectedCards)) {
            window.alert('请选择同一场内连续的卡片进行打组。');
            return;
        }
        const groupId = createShotGroupId();
        selectedCards.forEach((card) => setShotCardGroup(card, groupId));
        cleanupInvalidShotGroups();
        updateShotNumbers();
        scheduleSaveState();
        setMultiSelectMode(false);
    }

    function ungroupSelectedShots() {
        if (editorReadOnly) {
            return;
        }
        const selectedCards = getSelectedShotCardsInDomOrder();
        if (!selectedCards.some((card) => normalizeShotGroupId(card.dataset.shotGroupId))) {
            return;
        }
        selectedCards.forEach((card) => setShotCardGroup(card, ''));
        cleanupInvalidShotGroups();
        updateShotNumbers();
        scheduleSaveState();
        setMultiSelectMode(false);
    }

    function pruneSelectedShotCards() {
        selectedShotCards.forEach((card) => {
            if (!card || !card.isConnected || !card.classList.contains('shot-card')) {
                selectedShotCards.delete(card);
            }
        });
    }

    function clearSelectedShotCards() {
        selectedShotCards.forEach((card) => {
            card.classList.remove('multi-selected');
        });
        selectedShotCards.clear();
        hideMultiSelectPanel();
    }

    function shotCardHasUserContent(card) {
        if (!card || !card.classList?.contains('shot-card')) {
            return false;
        }

        const timeInput = card.querySelector('.shot-time-input');
        if ((typeof timeInput?.value === 'string' && timeInput.value.trim()) || card.dataset.legacyTimeRange) {
            return true;
        }

        const preview = card.querySelector('.shot-image-preview');
        const hasImage = Boolean(preview && preview.style.display !== 'none' && preview.src);
        if (hasImage) {
            return true;
        }

        const textFields = card.querySelectorAll('.text-action, .text-dialogue');
        const hasTextContent = Array.from(textFields).some((field) => {
            return Boolean(getEditablePlainText(field).trim());
        });
        if (hasTextContent) {
            return true;
        }

        const detailSelects = card.querySelectorAll('.shot-size-select, .camera-movement-select');
        return Array.from(detailSelects).some((select) => Boolean(select.value));
    }

    function sanitizeShotDurationInput(value) {
        const digitsAndDots = String(value || '').replace(/[^0-9.]/g, '');
        const firstDotIndex = digitsAndDots.indexOf('.');
        if (firstDotIndex === -1) {
            return digitsAndDots;
        }
        return `${digitsAndDots.slice(0, firstDotIndex + 1)}${digitsAndDots.slice(firstDotIndex + 1).replace(/\./g, '')}`;
    }

    function normalizeSavedShotDuration(value) {
        const normalized = typeof value === 'string' ? value.trim() : '';
        const match = normalized.match(/^((?:\d+(?:\.\d*)?)|(?:\.\d+))\s*s?$/i);
        return match ? match[1] : '';
    }

    function parseShotDuration(value) {
        const normalized = typeof value === 'string' ? value.trim() : '';
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
            return null;
        }
        const seconds = Number(normalized);
        return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
    }

    function formatShotDurationNumber(value, fractionDigits = 10) {
        if (!Number.isFinite(value) || value <= 0) {
            return '0';
        }
        return Number(value.toFixed(fractionDigits)).toString();
    }

    function stepShotDurationValue(value, step) {
        const normalized = sanitizeShotDurationInput(value);
        const currentSeconds = parseShotDuration(normalized) ?? 0;
        const fractionDigits = Math.min(
            10,
            Math.max(1, normalized.includes('.') ? normalized.split('.')[1].length : 0)
        );
        return formatShotDurationNumber(Math.max(0, currentSeconds + step), fractionDigits);
    }

    function updateTotalDuration() {
        if (!projectTotalDuration) {
            return;
        }
        const totalSeconds = Array.from(storyboardGrid.querySelectorAll('.shot-time-input'))
            .reduce((total, input) => {
                const seconds = parseShotDuration(input.value);
                return total + (seconds ?? 0);
            }, 0);
        const formattedTotal = formatShotDurationNumber(totalSeconds);
        projectTotalDuration.textContent = `总时长 ${formattedTotal}s`;
        projectTotalDuration.setAttribute('aria-label', `全片总时长 ${formattedTotal} 秒`);
    }

    function shouldConfirmShotDeletion(cards) {
        const uniqueCards = Array.from(new Set(
            (Array.isArray(cards) ? cards : []).filter((card) => card && card.classList?.contains('shot-card'))
        ));
        return uniqueCards.some((card) => shotCardHasUserContent(card));
    }

    function deleteShotCards(cards, options = {}) {
        const { exitMultiSelectAfterDone = false } = options;
        const uniqueCards = Array.from(new Set(
            (Array.isArray(cards) ? cards : []).filter((card) => card && card.classList?.contains('shot-card'))
        ));
        if (uniqueCards.length === 0) {
            return;
        }

        if (hoveredImageUploadContext && uniqueCards.some((card) => card.contains(hoveredImageUploadContext.container))) {
            hoveredImageUploadContext = null;
        }

        uniqueCards.forEach((card) => {
            selectedShotCards.delete(card);
            card.classList.remove('multi-selected');
            card.style.opacity = '0';
            card.style.transform = 'scale(0.95)';
        });
        refreshMultiSelectPanel();

        setTimeout(() => {
            uniqueCards.forEach((card) => {
                if (card.isConnected) {
                    card.remove();
                }
            });
            cleanupInvalidShotGroups();
            updateShotNumbers();
            scheduleSaveState();
            if (exitMultiSelectAfterDone) {
                setMultiSelectMode(false);
            }
        }, 200);
    }

    function deleteSelectedShotsWithConfirm() {
        if (editorReadOnly) {
            return;
        }
        const selectedCards = getSelectedShotCardsInDomOrder();
        if (selectedCards.length === 0) {
            return;
        }
        if (shouldConfirmShotDeletion(selectedCards)) {
            const confirmed = window.confirm(`确认批量删除已选中的 ${selectedCards.length} 个镜头？此操作不可恢复。`);
            if (!confirmed) {
                return;
            }
        }
        deleteShotCards(selectedCards, { exitMultiSelectAfterDone: true });
    }

    function moveSelectedShotsToScene(sceneIndex) {
        if (editorReadOnly) {
            return;
        }
        const segments = getSceneSegments();
        if (segments.length < 2) {
            return;
        }

        const targetScene = segments.find((segment) => segment.index === sceneIndex);
        if (!targetScene) {
            return;
        }

        const selectedCards = getSelectedShotCardsInDomOrder();
        if (selectedCards.length === 0) {
            return;
        }

        let insertBefore = null;
        if (targetScene.divider) {
            insertBefore = targetScene.divider.nextElementSibling;
            while (insertBefore && !insertBefore.classList.contains('scene-divider') && !insertBefore.classList.contains('scene-divider-trigger')) {
                insertBefore = insertBefore.nextElementSibling;
            }
        } else {
            insertBefore = ensureSceneDividerTrigger();
        }

        selectedCards.forEach((card) => {
            storyboardGrid.insertBefore(card, insertBefore);
        });

        updateShotNumbers();
        scheduleSaveState();
        setMultiSelectMode(false);
    }

    function refreshMoveTargets() {
        multiSelectMoveList.innerHTML = '';
        const scenes = getSceneSegments();
        const selectedCards = getSelectedShotCardsInDomOrder();
        const selectedSceneIndexes = new Set();
        selectedCards.forEach((card) => {
            const index = getSceneIndexForCard(card, scenes);
            if (index >= 0) {
                selectedSceneIndexes.add(index);
            }
        });
        const singleSourceScene = selectedSceneIndexes.size === 1
            ? Array.from(selectedSceneIndexes)[0]
            : -1;

        const addDisabledMoveOption = (text) => {
            const disabledBtn = document.createElement('button');
            disabledBtn.type = 'button';
            disabledBtn.className = 'multi-select-action-btn is-disabled';
            disabledBtn.textContent = text;
            disabledBtn.disabled = true;
            multiSelectMoveList.appendChild(disabledBtn);
        };

        if (scenes.length < 2) {
            addDisabledMoveOption('批量移动到其他场（需至少 2 场）');
            return;
        }

        let optionCount = 0;
        scenes.forEach((scene) => {
            if (singleSourceScene >= 0 && scene.index === singleSourceScene) {
                return;
            }
            const moveBtn = document.createElement('button');
            moveBtn.type = 'button';
            moveBtn.className = 'multi-select-action-btn';
            moveBtn.textContent = `移动到 ${scene.label}`;
            moveBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                moveSelectedShotsToScene(scene.index);
            });
            multiSelectMoveList.appendChild(moveBtn);
            optionCount += 1;
        });

        if (optionCount === 0) {
            addDisabledMoveOption('没有可移动的其他场');
        }
    }

    function refreshMultiSelectPanel(clientX = null, clientY = null) {
        pruneSelectedShotCards();
        if (!isMultiSelectMode || selectedShotCards.size === 0) {
            hideMultiSelectPanel();
            return;
        }
        const selectedCards = getSelectedShotCardsInDomOrder();
        const isWithinGroupLimit = selectedCards.length >= 2 && selectedCards.length <= 3;
        const canGroup = isWithinGroupLimit && areShotCardsContiguousInSameScene(selectedCards);
        multiSelectGroupBtn.disabled = !canGroup;
        multiSelectGroupBtn.classList.toggle('is-disabled', !canGroup);
        multiSelectGroupBtn.title = canGroup
            ? '让这些卡片共享同一个镜头序号'
            : selectedCards.length > 3
                ? '每组最多 3 张卡片'
                : '请选择同一场内连续的卡片';
        multiSelectUngroupBtn.classList.toggle(
            'hidden',
            !selectedCards.some((card) => normalizeShotGroupId(card.dataset.shotGroupId))
        );
        refreshMoveTargets();
        showMultiSelectPanelAt(clientX, clientY);
    }

    function toggleShotCardSelection(card, clientX, clientY) {
        if (!card || !card.classList.contains('shot-card')) {
            return;
        }
        if (selectedShotCards.has(card)) {
            selectedShotCards.delete(card);
            card.classList.remove('multi-selected');
        } else {
            selectedShotCards.add(card);
            card.classList.add('multi-selected');
        }
        refreshMultiSelectPanel(clientX, clientY);
    }

    function setMultiSelectMode(enabled) {
        const nextEnabled = Boolean(enabled);
        if (isMultiSelectMode === nextEnabled) {
            refreshMultiSelectPanel();
            return;
        }

        if (nextEnabled && hoveredShotGroupId) {
            setShotGroupHoverState(hoveredShotGroupId, false);
        }
        isMultiSelectMode = nextEnabled;
        storyboardGrid.classList.toggle('is-multi-select', isMultiSelectMode);
        if (storyboardSortable) {
            storyboardSortable.option('disabled', isMultiSelectMode || editorReadOnly);
        }
        if (!isMultiSelectMode) {
            clearSelectedShotCards();
        } else {
            refreshMultiSelectPanel();
        }
        updateMultiSelectToggleButton();
    }

    function refreshSceneDividerShotCounts() {
        getAllSceneDividers().forEach((divider) => {
            const countNode = divider.querySelector('.scene-divider-shot-count');
            if (!countNode) {
                return;
            }

            const shotCount = getFollowingSceneCards(divider).length;
            countNode.textContent = `(${shotCount})`;
        });
    }

    function applySceneDividerCollapsedState(divider, collapsed, shouldSave = false) {
        if (!divider) {
            return;
        }

        divider.dataset.collapsed = collapsed ? 'true' : 'false';
        divider.classList.toggle('is-collapsed', collapsed);

        const toggleBtn = divider.querySelector('.scene-divider-toggle-btn');
        if (toggleBtn) {
            toggleBtn.textContent = collapsed ? '▸' : '▾';
            toggleBtn.title = collapsed ? '展开该场' : '折叠该场';
            toggleBtn.setAttribute('aria-label', collapsed ? '展开该场' : '折叠该场');
            toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        }

        const sceneCards = getFollowingSceneCards(divider);
        sceneCards.forEach((card) => {
            card.classList.toggle('scene-collapsed-hidden', collapsed);
        });

        if (shouldSave) {
            scheduleSyncProjectHeaderWidth(false);
            scheduleSyncSceneHeaderInputByViewport();
        }
        scheduleSyncShotGroupFrames();

        if (shouldSave && !isRestoringState) {
            scheduleSaveState();
        }
    }

    function applyAllSceneDividerStates() {
        storyboardGrid.querySelectorAll('.shot-card.scene-collapsed-hidden').forEach((card) => {
            card.classList.remove('scene-collapsed-hidden');
        });

        getAllSceneDividers().forEach((divider) => {
            const collapsed = divider.dataset.collapsed === 'true';
            applySceneDividerCollapsedState(divider, collapsed, false);
        });
    }

    function addSceneDividerFromTrigger() {
        const existingDividers = getAllSceneDividers();
        if (existingDividers.length === 0) {
            addSceneDivider({ animate: false, shouldSave: false, insertAtTop: true, dividerData: { label: '第1场' } });
        }
        addSceneDivider({ animate: true, shouldSave: true });
    }

    function removeOnlyLeadingSceneDividerIfNeeded() {
        const allDividers = getAllSceneDividers();
        if (allDividers.length !== 1) {
            return false;
        }

        const trigger = ensureSceneDividerTrigger();
        const firstContentItem = Array.from(storyboardGrid.children).find((child) => (
            child !== trigger && !child.classList.contains('shot-group-frame-layer')
        ));
        if (!firstContentItem || !firstContentItem.classList.contains('scene-divider')) {
            return false;
        }

        firstContentItem.remove();
        return true;
    }

    function ensureFirstSceneDividerWhenSegmented() {
        const allDividers = getAllSceneDividers();
        if (allDividers.length === 0) {
            return false;
        }

        const trigger = ensureSceneDividerTrigger();
        const firstContentItem = Array.from(storyboardGrid.children).find((child) => (
            child !== trigger && !child.classList.contains('shot-group-frame-layer')
        ));
        if (firstContentItem && firstContentItem.classList.contains('scene-divider')) {
            return false;
        }

        const leadingDivider = createSceneDividerElement(false, { label: '第1场' });
        prependStoryboardItem(leadingDivider);
        applySceneDividerCollapsedState(leadingDivider, false, false);
        return true;
    }

    function ensureSceneDividerTrigger() {
        if (!storyboardGrid) {
            return null;
        }

        if (sceneDividerTriggerEl && sceneDividerTriggerEl.isConnected) {
            return sceneDividerTriggerEl;
        }

        const existingTrigger = storyboardGrid.querySelector('.scene-divider-trigger');
        if (existingTrigger) {
            sceneDividerTriggerEl = existingTrigger;
            return sceneDividerTriggerEl;
        }

        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'scene-divider-trigger';
        trigger.innerHTML = '<span class="scene-divider-trigger-label">点击添加场划分线</span>';
        trigger.addEventListener('click', () => {
            addSceneDividerFromTrigger();
        });
        storyboardGrid.appendChild(trigger);
        sceneDividerTriggerEl = trigger;
        return sceneDividerTriggerEl;
    }

    function placeSceneDividerTriggerAtEnd() {
        const trigger = ensureSceneDividerTrigger();
        if (trigger && trigger.parentElement === storyboardGrid && storyboardGrid.lastElementChild !== trigger) {
            storyboardGrid.appendChild(trigger);
        }
    }

    function appendStoryboardItem(node) {
        const trigger = ensureSceneDividerTrigger();
        if (trigger && trigger.parentElement === storyboardGrid) {
            storyboardGrid.insertBefore(node, trigger);
            return;
        }
        storyboardGrid.appendChild(node);
    }

    function prependStoryboardItem(node) {
        const trigger = ensureSceneDividerTrigger();
        const firstContentChild = Array.from(storyboardGrid.children).find((child) => (
            child !== trigger && !child.classList.contains('shot-group-frame-layer')
        ));
        if (firstContentChild) {
            storyboardGrid.insertBefore(node, firstContentChild);
            return;
        }
        if (trigger && trigger.parentElement === storyboardGrid) {
            storyboardGrid.insertBefore(node, trigger);
            return;
        }
        storyboardGrid.appendChild(node);
    }

    function serializeStoryboardItem(item) {
        if (!item || !item.classList) {
            return null;
        }

        if (item.classList.contains('shot-card')) {
            return serializeCard(item);
        }
        if (item.classList.contains('scene-divider')) {
            const label = item.querySelector('.scene-divider-label-text');
            return {
                type: 'scene-divider',
                label: normalizeSceneDividerLabel(label?.textContent || ''),
                collapsed: item.dataset.collapsed === 'true'
            };
        }
        return null;
    }

    function startSceneDragContext(divider) {
        if (!divider) {
            return;
        }

        const cards = getFollowingSceneCards(divider);
        draggingSceneContext = { divider, cards };
        divider.classList.add('is-scene-dragging');
        cards.forEach((card) => card.classList.add('scene-drag-follow'));
    }

    function moveSceneCardsAfterDraggedDivider() {
        if (!draggingSceneContext || !draggingSceneContext.divider) {
            return;
        }

        const { divider, cards } = draggingSceneContext;
        for (let i = cards.length - 1; i >= 0; i -= 1) {
            storyboardGrid.insertBefore(cards[i], divider.nextSibling);
        }
    }

    function clearSceneDragContext() {
        if (!draggingSceneContext) {
            return;
        }

        draggingSceneContext.divider?.classList.remove('is-scene-dragging');
        draggingSceneContext.cards?.forEach((card) => {
            card.classList.remove('scene-drag-follow');
        });
        draggingSceneContext = null;
    }

    function createSceneDividerElement(animate = true, dividerData = null) {
        const divider = document.createElement('div');
        divider.className = 'scene-divider';
        divider.dataset.collapsed = 'false';

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'scene-divider-toggle-btn';
        toggleBtn.textContent = '▾';
        toggleBtn.title = '折叠该场';
        toggleBtn.setAttribute('aria-label', '折叠该场');
        toggleBtn.setAttribute('aria-expanded', 'true');

        const lineLeft = document.createElement('div');
        lineLeft.className = 'scene-divider-line scene-divider-drag-zone';
        lineLeft.title = '拖动调整场顺序';

        const label = document.createElement('div');
        label.className = 'scene-divider-label';
        const labelText = document.createElement('span');
        labelText.className = 'scene-divider-label-text';
        labelText.contentEditable = 'true';
        labelText.dataset.placeholder = '点击添加场次描述';
        labelText.setAttribute('role', 'textbox');
        labelText.setAttribute('aria-label', '场次描述');
        const shotCount = document.createElement('span');
        shotCount.className = 'scene-divider-shot-count';
        shotCount.textContent = '(0)';
        label.appendChild(labelText);
        label.appendChild(shotCount);

        const lineRight = document.createElement('div');
        lineRight.className = 'scene-divider-line scene-divider-drag-zone';
        lineRight.title = '拖动调整场顺序';

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'scene-divider-delete-btn';
        deleteBtn.title = '删除场划分线';
        deleteBtn.setAttribute('aria-label', '删除场划分线');
        deleteBtn.innerHTML = '&times;';

        const initialLabel = normalizeSceneDividerLabel(dividerData?.label || '');
        if (initialLabel) {
            labelText.textContent = initialLabel;
        }

        toggleBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            const nextCollapsed = divider.dataset.collapsed !== 'true';
            applySceneDividerCollapsedState(divider, nextCollapsed, true);
        });

        labelText.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                labelText.blur();
            }
        });
        labelText.addEventListener('blur', () => {
            const normalized = normalizeSceneDividerLabel(labelText.textContent || '');
            labelText.textContent = normalized;
            scheduleSyncSceneHeaderInputByViewport();
            if (!isRestoringState) {
                scheduleSaveState();
            }
        });
        labelText.addEventListener('input', () => {
            scheduleSyncSceneHeaderInputByViewport();
            if (!isRestoringState) {
                scheduleSaveState();
            }
        });
        label.addEventListener('click', () => {
            labelText.focus();
        });

        deleteBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            const sceneCards = getFollowingSceneCards(divider);
            if (sceneCards.length > 0) {
                const confirmed = window.confirm('确认删除这个场分界线？此操作不可恢复。');
                if (!confirmed) {
                    return;
                }
            }
            divider.style.opacity = '0';
            divider.style.transform = 'translateY(-5px)';
            setTimeout(() => {
                divider.remove();
                removeOnlyLeadingSceneDividerIfNeeded();
                updateShotNumbers();
                scheduleSaveState();
            }, 180);
        });

        divider.appendChild(toggleBtn);
        divider.appendChild(lineLeft);
        divider.appendChild(label);
        divider.appendChild(lineRight);
        divider.appendChild(deleteBtn);

        if (animate) {
            divider.style.opacity = '0';
            divider.style.transform = 'translateY(8px)';
            divider.style.transition = 'opacity 0.24s ease, transform 0.24s ease';
            requestAnimationFrame(() => {
                divider.style.opacity = '1';
                divider.style.transform = 'translateY(0)';
            });
        }

        return divider;
    }

    function addSceneDivider(options = {}) {
        const {
            animate = true,
            shouldSave = true,
            insertAtTop = false,
            dividerData = null
        } = options;

        const divider = createSceneDividerElement(animate, dividerData);
        if (insertAtTop) {
            prependStoryboardItem(divider);
        } else {
            appendStoryboardItem(divider);
        }

        const collapsed = Boolean(dividerData && typeof dividerData === 'object' && dividerData.collapsed);
        applySceneDividerCollapsedState(divider, collapsed, false);
        if (!isRestoringState) {
            updateShotNumbers();
        }
        if (shouldSave && !isRestoringState) {
            scheduleSaveState();
        }
        return divider;
    }

    function serializeCard(card) {
        const colorWrapper = card.querySelector('.color-picker-wrapper');
        const vfxCheckbox = card.querySelector('.vfx-checkbox input[type="checkbox"]');
        const shotTimeInput = card.querySelector('.shot-time-input');
        const checkedMove = card.querySelector('.shot-camera-move input[type="radio"]:checked');
        const actionText = card.querySelector('.text-action');
        const shotSizeSelect = card.querySelector('.shot-size-select');
        const cameraMovementSelect = card.querySelector('.camera-movement-select');
        const dialogueText = card.querySelector('.text-dialogue');
        const preview = card.querySelector('.shot-image-preview');

        return {
            groupId: normalizeShotGroupId(card.dataset.shotGroupId),
            headerColor: colorWrapper?.dataset.color || '',
            vfx: Boolean(vfxCheckbox?.checked),
            timeRange: (typeof shotTimeInput?.value === 'string' ? shotTimeInput.value.trim() : '')
                || card.dataset.legacyTimeRange
                || '',
            move: checkedMove?.value || 'Static固定',
            action: getEditablePlainText(actionText),
            shotSize: shotSizeSelect?.value || '',
            cameraMovement: cameraMovementSelect?.value || '',
            camera: card.dataset.legacyCamera || '',
            dialogue: getEditablePlainText(dialogueText),
            actionHtml: getEditableFieldHtml(actionText),
            cameraHtml: card.dataset.legacyCameraHtml || '',
            dialogueHtml: getEditableFieldHtml(dialogueText),
            imageId: card.dataset.imageId || '',
            imageSrc: preview?.src || '',
            hasImage: preview?.style.display !== 'none' && Boolean(preview?.src)
        };
    }

    function buildStateSnapshot() {
        const perfMeta = { shotItems: 0, outputShots: 0 };
        return perfMeasureSync('buildStateSnapshot', () => {
            const shotItems = Array.from(storyboardGrid.children)
                .filter((item) => !item.classList.contains('scene-divider-trigger'));
            perfMeta.shotItems = shotItems.length;
            const shots = shotItems
                .map(serializeStoryboardItem)
                .filter(Boolean);
            perfMeta.outputShots = shots.length;
            return {
                name: projectInput ? projectInput.value : '',
                scene: sceneInput ? sceneInput.value : '',
                aspectRatio: aspectRatioSelect ? aspectRatioSelect.value : '16/9',
                shots
            };
        }, () => perfMeta);
    }

    function syncSavedImageReferences(payloadShots, savedShots, saveProjectId) {
        if (currentProjectId !== saveProjectId) {
            return;
        }

        const cards = Array.from(storyboardGrid.querySelectorAll('.shot-card'));
        const payloadCards = (Array.isArray(payloadShots) ? payloadShots : [])
            .filter((shot) => !isSceneDividerShot(shot));
        const savedCards = (Array.isArray(savedShots) ? savedShots : [])
            .filter((shot) => !isSceneDividerShot(shot));

        cards.forEach((card, index) => {
            const payloadShot = payloadCards[index];
            const savedShot = savedCards[index];
            if (!payloadShot || !savedShot) {
                return;
            }

            const payloadImageId = typeof payloadShot.imageId === 'string' ? payloadShot.imageId : '';
            if ((card.dataset.imageId || '') !== payloadImageId) {
                return;
            }

            const preview = card.querySelector('.shot-image-preview');
            const placeholder = card.querySelector('.image-placeholder');
            const imageContainer = card.querySelector('.shot-image-container');
            const savedImageId = typeof savedShot.imageId === 'string' ? savedShot.imageId : '';
            const savedImageSrc = typeof savedShot.imageSrc === 'string' ? savedShot.imageSrc : '';
            if (savedShot.hasImage && savedImageId && savedImageSrc) {
                card.dataset.imageId = savedImageId;
                preview.src = savedImageSrc;
                preview.style.display = 'block';
                placeholder.style.display = 'none';
                imageContainer.classList.add('has-image');
                return;
            }

            delete card.dataset.imageId;
            preview.src = '';
            preview.style.display = 'none';
            placeholder.style.display = 'flex';
            imageContainer.classList.remove('has-image');
        });
    }

    async function saveState() {
        if (isRestoringState || !currentProjectId || editorReadOnly || !editLeaseToken || saveConflictActive) {
            return;
        }
        // A visibility/focus heartbeat may be recovering a lease after browser
        // timer throttling. Do not let a save race it and invalidate the lease.
        if (editLockHeartbeatPromise) {
            await editLockHeartbeatPromise;
            if (isRestoringState || !currentProjectId || editorReadOnly || !editLeaseToken || saveConflictActive) {
                return;
            }
        }
        if (pendingSavePromise) {
            return pendingSavePromise;
        }
        if (!hasUnsavedChanges) {
            return;
        }

        const saveProjectId = currentProjectId;
        const perfMeta = {
            projectId: saveProjectId,
            payloadShots: 0,
            bodyBytes: 0,
            savedShots: 0
        };
        hasUnsavedChanges = false;
        setSaveStatusState('saving');

        pendingSavePromise = perfMeasureAsync('saveState', async () => {
            const payload = buildStateSnapshot();
            payload.baseVersion = currentProjectVersion;
            perfMeta.payloadShots = Array.isArray(payload.shots) ? payload.shots.length : 0;
            const body = JSON.stringify(payload);
            perfMeta.bodyBytes = body.length;
            const saved = await apiRequest(`/api/projects/${saveProjectId}`, {
                method: 'PUT',
                headers: { 'X-Edit-Lease': editLeaseToken },
                body
            });
            currentProjectVersion = saved.version;
            currentProject = saved;
            setSaveStatusState('saved');
            perfMeta.savedShots = Array.isArray(saved?.shots) ? saved.shots.length : 0;
            syncSavedImageReferences(payload.shots, saved?.shots, saveProjectId);

            projectsCache = projectsCache.map((project) => {
                if (project.id !== saveProjectId) {
                    return project;
                }
                return {
                    ...project,
                    name: saved.name,
                    scene: saved.scene,
                    aspectRatio: saved.aspectRatio,
                    updatedAt: saved.updatedAt,
                    shotCount: countStoryboardCards(saved.shots),
                    previewImage: saved.shots.find((shot) => shot && shot.hasImage && shot.imageSrc)?.imageSrc || ''
                };
            });
        }, () => perfMeta).catch((error) => {
            console.error('Save failed:', error);
            setSaveStatusState('error');
            if (error instanceof ApiError && (error.status === 409 || error.status === 423)) {
                const takeoverHolder = error.status === 423 ? showTakeoverNotice(error) : '';
                hasUnsavedChanges = true;
                saveConflictActive = true;
                editLeaseToken = '';
                stopLockHeartbeat();
                setLockBanner(
                    error.status === 409
                        ? '服务器上已有更新；已停止自动保存以避免覆盖。'
                        : (takeoverHolder
                            ? `编辑权已被 ${takeoverHolder} 接管；已停止自动保存。`
                            : '编辑锁已失效；已停止自动保存。'),
                    { reload: true, saveCopy: true }
                );
                applyEditorAccess();
                return;
            }
            hasUnsavedChanges = true;
        }).finally(() => {
            pendingSavePromise = null;
            if (hasUnsavedChanges && !isRestoringState && currentProjectId && !saveConflictActive) {
                scheduleSaveState();
            }
        });

        return pendingSavePromise;
    }

    function scheduleSaveState() {
        if (isRestoringState || !currentProjectId || editorReadOnly || saveConflictActive) {
            return;
        }
        hasUnsavedChanges = true;
        setSaveStatusState('unsaved');

        if (saveTimer) {
            clearTimeout(saveTimer);
        }
        const scheduledAt = perfNow();
        saveTimer = setTimeout(() => {
            saveTimer = null;
            perfRecord('saveStateDebounceDelay', perfNow() - scheduledAt, {
                projectId: currentProjectId
            });
            saveState();
        }, 180);
    }

    async function flushPendingSave() {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        if (pendingSavePromise) {
            await pendingSavePromise;
        }
        if (!hasUnsavedChanges) {
            return !saveConflictActive;
        }
        await saveState();
        return !hasUnsavedChanges && !saveConflictActive;
    }

    function discardPendingLocalChanges() {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        hasUnsavedChanges = false;
        saveConflictActive = false;
        setSaveStatusState('saved');
    }

    async function prepareToLeaveCurrentProject() {
        if (!currentProjectId || isShareMode) return true;
        const saved = await flushPendingSave();
        if (saved) return true;
        const confirmed = window.confirm('当前修改尚未保存。退出项目后，这些修改将会丢失。\n\n确定仍要退出吗？');
        if (!confirmed) return false;
        discardPendingLocalChanges();
        return true;
    }

    function updateShotNumbers() {
        const perfMeta = { cardCount: 0, insertedLeadingDivider: false };
        perfMeasureSync('updateShotNumbers', () => {
            const insertedLeadingDivider = ensureFirstSceneDividerWhenSegmented();
            const cards = storyboardGrid.querySelectorAll('.shot-card');
            const groupNumbers = new Map();
            let nextShotNumber = 1;
            perfMeta.cardCount = cards.length;
            perfMeta.insertedLeadingDivider = insertedLeadingDivider;
            cleanupInvalidShotGroups();
            cards.forEach((card) => {
                const groupId = normalizeShotGroupId(card.dataset.shotGroupId);
                let shotNumber = nextShotNumber;
                if (groupId && groupNumbers.has(groupId)) {
                    shotNumber = groupNumbers.get(groupId);
                } else {
                    if (groupId) {
                        groupNumbers.set(groupId, shotNumber);
                    }
                    nextShotNumber += 1;
                }
                card.querySelector('.shot-index').textContent = shotNumber;
            });
            updateTotalDuration();
            refreshSceneDividerShotCounts();
            placeSceneDividerTriggerAtEnd();
            applyAllSceneDividerStates();
            syncProjectHeaderWidth();
            syncSceneHeaderInputByViewport();
            scheduleSyncShotGroupFrames();
            refreshMultiSelectPanel();
            if (insertedLeadingDivider && !isRestoringState) {
                scheduleSaveState();
            }
        }, () => perfMeta);
    }

    function autoResizeTextarea(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = `${textarea.scrollHeight}px`;
        scheduleSyncShotGroupFrames();
    }

    function isCopyShortcut(event) {
        if (!(event.metaKey || event.ctrlKey)) {
            return false;
        }
        if (event.shiftKey || event.altKey) {
            return false;
        }
        return event.key && event.key.toLowerCase() === 'c';
    }

    function isEditableElement(element) {
        if (!(element instanceof Element)) {
            return false;
        }
        if (element.isContentEditable) {
            return true;
        }
        return Boolean(element.closest('input, textarea, [contenteditable="true"]'));
    }

    function hasActiveEditableSelection() {
        const activeElement = document.activeElement;
        if (!isEditableElement(activeElement)) {
            return false;
        }

        if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) {
            if (typeof activeElement.selectionStart !== 'number' || typeof activeElement.selectionEnd !== 'number') {
                return false;
            }
            return activeElement.selectionStart !== activeElement.selectionEnd;
        }

        const selection = window.getSelection ? window.getSelection() : null;
        return Boolean(selection && !selection.isCollapsed && selection.toString());
    }

    function getActiveHoveredImageUploadContext() {
        if (!hoveredImageUploadContext
            || !hoveredImageUploadContext.card?.isConnected
            || !hoveredImageUploadContext.container?.isConnected
            || !storyboardGrid.contains(hoveredImageUploadContext.card)) {
            hoveredImageUploadContext = null;
            return null;
        }
        return hoveredImageUploadContext;
    }

    function clipboardHasImage(clipboardData) {
        return Array.from(clipboardData?.items || [])
            .some((item) => typeof item.type === 'string' && item.type.startsWith('image/'));
    }

    function getHoveredImageSrc() {
        const imageContext = getActiveHoveredImageUploadContext();
        if (!imageContext?.preview) {
            return '';
        }
        if (imageContext.preview.style.display === 'none') {
            return '';
        }
        return imageContext.preview.src || '';
    }

    function showClipboardToast(message = '') {
        clipboardToast.textContent = message;
        clipboardToast.classList.add('show');
        if (clipboardToastHideTimer) {
            clearTimeout(clipboardToastHideTimer);
        }
        clipboardToastHideTimer = window.setTimeout(() => {
            clipboardToast.classList.remove('show');
            clipboardToastHideTimer = null;
        }, 1500);
    }

    function createClientImageId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }
        return `image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    async function applyImageToCard(file, imageContext) {
        if (!file || !file.type || !file.type.startsWith('image/')) {
            return;
        }

        try {
            const compressedImageSrc = await compressUploadImageToDataUrl(file);
            imageContext.card.dataset.imageId = createClientImageId();
            imageContext.preview.src = compressedImageSrc;
            imageContext.preview.style.display = 'block';
            imageContext.placeholder.style.display = 'none';
            imageContext.container.classList.add('has-image');
            scheduleSaveState();
        } catch (error) {
            console.error('Apply image failed:', error);
            alert('图片处理失败，请重试。');
        }
    }

    function clearImageFromCard(imageContext) {
        imageContext.preview.src = '';
        imageContext.preview.style.display = 'none';
        imageContext.placeholder.style.display = 'flex';
        imageContext.container.classList.remove('has-image');
        imageContext.fileInput.value = '';
        delete imageContext.card.dataset.imageId;
        scheduleSaveState();
    }

    function toChineseMoveLabel(rawValue = '') {
        const map = {
            'Static固定': '三角架',
            'Dolly轨道': '轨道',
            'Gimbal稳定器': '稳定器',
            'HH手持': '手持'
        };
        if (map[rawValue]) {
            return map[rawValue];
        }

        const chineseOnly = rawValue.replace(/[A-Za-z\s]/g, '').trim();
        return chineseOnly || rawValue;
    }

    function formatDateYYYYMMDD(date = new Date()) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}${month}${day}`;
    }

    function sanitizeFileNameSegment(value = '') {
        return value
            .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function buildExportPdfDefaultName() {
        const projectName = sanitizeFileNameSegment(projectInput ? projectInput.value : '');
        const safeProjectName = projectName || '未命名项目';
        return `${safeProjectName}_${formatDateYYYYMMDD()}`;
    }

    function applyExportPdfDocumentTitle() {
        if (previousDocumentTitleBeforePrint === null) {
            previousDocumentTitleBeforePrint = document.title;
        }
        document.title = buildExportPdfDefaultName();
    }

    function restoreDocumentTitleAfterPrint() {
        if (previousDocumentTitleBeforePrint === null) {
            return;
        }
        document.title = previousDocumentTitleBeforePrint;
        previousDocumentTitleBeforePrint = null;
    }

    function applyPrintPageSizeOverride(printAspect) {
        const existingStyle = document.getElementById(PRINT_PAGE_STYLE_ID);
        if (printAspect !== '9/16') {
            if (existingStyle) {
                existingStyle.remove();
            }
            return;
        }

        const styleEl = existingStyle || document.createElement('style');
        styleEl.id = PRINT_PAGE_STYLE_ID;
        styleEl.textContent = `
            @media print {
                @page {
                    size: 16in 9in;
                    margin: 8mm 10mm 14mm 10mm;
                }
            }
        `;
        if (!existingStyle) {
            document.head.appendChild(styleEl);
        }
    }

    function createPrintTextBlockFromField(sourceField) {
        const className = ((sourceField?.className || 'auto-resize-textarea')
            .replace(/\brich-text-input\b/g, '')
            .replace(/\s+/g, ' ')
            .trim()) || 'auto-resize-textarea';
        const printText = document.createElement('div');
        printText.className = `${className} print-text-block`;
        if (getEditablePlainText(sourceField).trim()) {
            printText.innerHTML = sourceField?.innerHTML || '';
        }
        return printText;
    }

    function createPrintShotSelectRow(card) {
        const row = document.createElement('div');
        row.className = 'shot-select-row shot-select-row-print';
        const values = [
            ['景别', card.querySelector('.shot-size-select')?.value || ''],
            ['运镜', card.querySelector('.camera-movement-select')?.value || '']
        ];

        values.forEach(([labelText, value], index) => {
            const field = document.createElement('div');
            field.className = 'shot-select-print-field';
            const label = document.createElement('span');
            label.className = 'shot-select-print-label';
            label.textContent = `${labelText}：`;
            const selectedValue = document.createElement('span');
            selectedValue.className = 'shot-select-print-value';
            selectedValue.textContent = value || '—';
            field.appendChild(label);
            field.appendChild(selectedValue);
            row.appendChild(field);

            if (index === 0) {
                const separator = document.createElement('span');
                separator.className = 'shot-select-divider';
                separator.setAttribute('aria-hidden', 'true');
                row.appendChild(separator);
            }
        });

        return row;
    }

    function appendPrintShotGroupConnectors(grid, entries, columnCount = 5) {
        const svgNamespace = 'http://www.w3.org/2000/svg';
        for (let index = 1; index < entries.length; index += 1) {
            const previous = entries[index - 1];
            const current = entries[index];
            const groupId = normalizeShotGroupId(current.card.dataset.shotGroupId);
            const isConnected = groupId
                && groupId === normalizeShotGroupId(previous.card.dataset.shotGroupId)
                && current.slotIndex === previous.slotIndex + 1
                && Math.floor(current.slotIndex / columnCount) === Math.floor(previous.slotIndex / columnCount);
            if (!isConnected) {
                continue;
            }
            const connector = document.createElement('div');
            connector.className = 'print-shot-group-connector';
            connector.dataset.shotGroupId = groupId;
            connector.setAttribute('aria-hidden', 'true');
            connector.style.gridColumn = String((previous.slotIndex % columnCount) * 2 + 2);
            connector.style.gridRow = String(Math.floor(previous.slotIndex / columnCount) + 1);

            const patternId = `print-shot-group-hatch-${printShotGroupPatternSequence += 1}`;
            const svg = document.createElementNS(svgNamespace, 'svg');
            svg.classList.add('print-shot-group-connector-svg');
            svg.setAttribute('width', '100%');
            svg.setAttribute('height', '100%');
            svg.setAttribute('preserveAspectRatio', 'none');
            svg.setAttribute('focusable', 'false');

            const definitions = document.createElementNS(svgNamespace, 'defs');
            const pattern = document.createElementNS(svgNamespace, 'pattern');
            pattern.setAttribute('id', patternId);
            pattern.setAttribute('width', '4');
            pattern.setAttribute('height', '4');
            pattern.setAttribute('patternUnits', 'userSpaceOnUse');
            pattern.setAttribute('patternTransform', 'rotate(45)');

            const stripe = document.createElementNS(svgNamespace, 'rect');
            stripe.classList.add('print-shot-group-hatch-stripe');
            stripe.setAttribute('x', '0');
            stripe.setAttribute('y', '0');
            stripe.setAttribute('width', '1.5');
            stripe.setAttribute('height', '4');
            pattern.appendChild(stripe);
            definitions.appendChild(pattern);
            svg.appendChild(definitions);

            const hatch = document.createElementNS(svgNamespace, 'rect');
            hatch.setAttribute('width', '100%');
            hatch.setAttribute('height', '100%');
            hatch.setAttribute('fill', `url(#${patternId})`);
            svg.appendChild(hatch);
            connector.appendChild(svg);
            grid.appendChild(connector);
        }
    }

    function paginatePrintCards(cards, columnCount = 5, rowCount = 2) {
        const pageCapacity = columnCount * rowCount;
        const units = [];
        cards.forEach((card) => {
            const groupId = normalizeShotGroupId(card.dataset.shotGroupId);
            const previousUnit = units[units.length - 1];
            if (groupId && previousUnit?.groupId === groupId) {
                previousUnit.cards.push(card);
                return;
            }
            units.push({ groupId, cards: [card] });
        });

        const pages = [];
        let pageEntries = [];
        let nextSlot = 0;
        const flushPage = () => {
            if (pageEntries.length > 0) {
                pages.push(pageEntries);
                pageEntries = [];
            }
            nextSlot = 0;
        };

        units.forEach((unit) => {
            const unitSize = unit.cards.length;
            if (unit.groupId && unitSize > 1) {
                const remainingInRow = columnCount - (nextSlot % columnCount);
                if (unitSize > remainingInRow) {
                    nextSlot += remainingInRow;
                }
            }
            if (nextSlot >= pageCapacity || nextSlot + unitSize > pageCapacity) {
                flushPage();
            }
            unit.cards.forEach((card) => {
                pageEntries.push({ card, slotIndex: nextSlot });
                nextSlot += 1;
            });
            if (nextSlot >= pageCapacity) {
                flushPage();
            }
        });
        flushPage();
        return pages;
    }

    function createPrintCard(card, printIndex) {
        const cardClone = document.createElement('article');
        cardClone.className = 'shot-card';
        const groupId = normalizeShotGroupId(card.dataset.shotGroupId);
        if (groupId) {
            cardClone.classList.add('shot-grouped');
            cardClone.dataset.shotGroupId = groupId;
        }

        const sourceHeader = card.querySelector('.shot-header');
        const header = document.createElement('header');
        header.className = 'shot-header';
        if (sourceHeader && sourceHeader.style.backgroundColor) {
            header.style.backgroundColor = sourceHeader.style.backgroundColor;
        }
        header.classList.toggle(
            'light-scene-header',
            Boolean(sourceHeader?.classList.contains('light-scene-header'))
        );

        const headerLeft = document.createElement('div');
        headerLeft.className = 'header-left-actions';
        const shotNumber = document.createElement('div');
        shotNumber.className = 'shot-number';
        const sourceShotNumber = card.querySelector('.shot-index')?.textContent?.trim() || String(printIndex);
        shotNumber.innerHTML = `SHOT #<span class="shot-index">${sourceShotNumber}</span>`;
        headerLeft.appendChild(shotNumber);

        const sourceTimeInput = card.querySelector('.shot-time-input');
        const timeRange = (sourceTimeInput?.value || '').trim();
        let headerCenter = null;
        if (/\d/.test(timeRange)) {
            headerCenter = document.createElement('div');
            headerCenter.className = 'header-center-actions';
            const printTimeValue = document.createElement('span');
            printTimeValue.className = 'shot-time-print-value';
            printTimeValue.textContent = `${timeRange}s`;
            printTimeValue.setAttribute('aria-label', `镜头时长 ${timeRange} 秒`);
            headerCenter.appendChild(printTimeValue);
        }

        const headerRight = document.createElement('div');
        headerRight.className = 'header-right-actions';
        const sourceVfx = card.querySelector('.vfx-checkbox input[type="checkbox"]');
        const shotVfx = document.createElement('div');
        shotVfx.className = 'shot-vfx';
        const vfxLabel = document.createElement('label');
        vfxLabel.className = 'vfx-checkbox';
        const vfxInput = document.createElement('input');
        vfxInput.type = 'checkbox';
        vfxInput.checked = Boolean(sourceVfx?.checked);
        const vfxCircle = document.createElement('span');
        vfxCircle.className = 'vfx-circle';
        vfxLabel.appendChild(vfxInput);
        vfxLabel.appendChild(vfxCircle);
        vfxLabel.appendChild(document.createTextNode('VFX'));
        shotVfx.appendChild(vfxLabel);
        headerRight.appendChild(shotVfx);

        header.appendChild(headerLeft);
        if (headerCenter) {
            header.appendChild(headerCenter);
        }
        header.appendChild(headerRight);
        cardClone.appendChild(header);

        const imageContainer = document.createElement('div');
        imageContainer.className = 'shot-image-container';
        const sourcePreview = card.querySelector('.shot-image-preview');
        const hasImage = Boolean(sourcePreview && sourcePreview.style.display !== 'none' && sourcePreview.src);
        if (hasImage) {
            imageContainer.classList.add('has-image');
            const preview = document.createElement('img');
            preview.className = 'shot-image-preview';
            preview.alt = sourcePreview.alt || 'Shot Preview';
            preview.src = sourcePreview.src;
            preview.style.display = 'block';
            imageContainer.appendChild(preview);
        }
        cardClone.appendChild(imageContainer);

        const moveRow = document.createElement('div');
        moveRow.className = 'shot-camera-move';
        const sourceLabels = card.querySelectorAll('.shot-camera-move .radio-label');
        const printRadioGroupName = `print-camera-move-${printIndex}`;
        sourceLabels.forEach((sourceLabel) => {
            const sourceRadio = sourceLabel.querySelector('input[type="radio"]');
            const label = document.createElement('label');
            label.className = 'radio-label';

            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = printRadioGroupName;
            radio.value = sourceRadio?.value || '';
            radio.checked = Boolean(sourceRadio?.checked);

            const custom = document.createElement('span');
            custom.className = 'radio-custom';

            const textEl = document.createElement('span');
            textEl.className = 'radio-label-text';
            textEl.textContent = toChineseMoveLabel(radio.value);

            label.appendChild(radio);
            label.appendChild(custom);
            label.appendChild(textEl);
            moveRow.appendChild(label);
        });
        cardClone.appendChild(moveRow);

        const details = document.createElement('div');
        details.className = 'shot-details';
        details.appendChild(createPrintTextBlockFromField(card.querySelector('.text-action')));
        const firstDivider = document.createElement('div');
        firstDivider.className = 'divider';
        details.appendChild(firstDivider);
        details.appendChild(createPrintShotSelectRow(card));
        const secondDivider = document.createElement('div');
        secondDivider.className = 'divider';
        details.appendChild(secondDivider);
        details.appendChild(createPrintTextBlockFromField(card.querySelector('.text-dialogue')));
        cardClone.appendChild(details);

        return cardClone;
    }

    function createPrintPage(entries, startIndex, headerSource, sceneLabel = '') {
        const page = document.createElement('section');
        page.className = 'print-page';
        const pageContent = document.createElement('div');
        pageContent.className = 'print-page-content';

        const headerClone = headerSource.cloneNode(true);
        headerClone.style.width = '';
        headerClone.style.maxWidth = '';
        headerClone.style.marginLeft = '';
        headerClone.style.marginRight = '';
        const sourceHeaderFields = headerSource.querySelectorAll('input, select');
        const cloneHeaderFields = headerClone.querySelectorAll('input, select');
        cloneHeaderFields.forEach((field, i) => {
            if (sourceHeaderFields[i]) {
                field.value = sourceHeaderFields[i].value;
            }
            if (field.matches('input')) {
                field.removeAttribute('placeholder');
            }
        });
        if (sceneLabel) {
            const cloneHeaderTextInputs = headerClone.querySelectorAll('.header-group.flex-1 .header-input');
            const cloneSceneInput = cloneHeaderTextInputs[1] || null;
            if (cloneSceneInput) {
                cloneSceneInput.value = sceneLabel;
            }
        }
        pageContent.appendChild(headerClone);

        const grid = document.createElement('div');
        grid.className = 'storyboard-grid print-grid';

        const printColumnCount = 5;
        entries.forEach(({ card, slotIndex }, cardOffset) => {
            const printCard = createPrintCard(card, startIndex + cardOffset + 1);
            printCard.style.gridColumn = String((slotIndex % printColumnCount) * 2 + 1);
            printCard.style.gridRow = String(Math.floor(slotIndex / printColumnCount) + 1);
            grid.appendChild(printCard);
        });
        appendPrintShotGroupConnectors(grid, entries, printColumnCount);

        pageContent.appendChild(grid);
        page.appendChild(pageContent);

        return page;
    }

    function buildPrintLayout() {
        printPages.innerHTML = '';
        let printAspect = '';
        if (aspectRatioSelect && aspectRatioSelect.value) {
            printAspect = aspectRatioSelect.value;
            printPages.dataset.printAspect = printAspect;
        } else {
            delete printPages.dataset.printAspect;
        }
        applyPrintPageSizeOverride(printAspect);
        const headerSource = appContainer.querySelector('.project-header');
        const cardsPerPage = 10;
        const pagesFragment = document.createDocumentFragment();
        if (!headerSource) {
            return;
        }

        const sceneSegments = getSceneSegments();
        const groupsToPrint = sceneSegments
            .map((segment) => ({
                sceneLabel: getSceneSegmentDisplayLabel(segment),
                cards: segment.cards.filter((item) => item && item.classList?.contains('shot-card'))
            }))
            .filter((segment) => segment.cards.length > 0);

        if (groupsToPrint.length === 0) {
            const fallbackLabel = getSceneSegmentDisplayLabel(sceneSegments[0]);
            pagesFragment.appendChild(createPrintPage([], 0, headerSource, fallbackLabel));
            printPages.appendChild(pagesFragment);
            isPrintLayoutReady = true;
            return;
        }

        let printedCardCount = 0;
        groupsToPrint.forEach((group) => {
            const printPagesForScene = paginatePrintCards(group.cards, 5, cardsPerPage / 5);
            printPagesForScene.forEach((pageEntries) => {
                pagesFragment.appendChild(createPrintPage(pageEntries, printedCardCount, headerSource, group.sceneLabel));
                printedCardCount += pageEntries.length;
            });
        });
        printPages.appendChild(pagesFragment);

        isPrintLayoutReady = true;
    }

    function clearPrintLayout() {
        printPages.innerHTML = '';
        delete printPages.dataset.printAspect;
        applyPrintPageSizeOverride('');
        isPrintLayoutReady = false;
    }

    function formatUpdatedTime(value) {
        if (!value) {
            return '';
        }
        return `最近修改 ${value}`;
    }

    function loadPinnedProjectIds() {
        try {
            const raw = localStorage.getItem(PINNED_PROJECTS_KEY);
            if (!raw) {
                return [];
            }

            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                return [];
            }

            const uniqueIds = [];
            parsed.forEach((value) => {
                const id = Number(value);
                if (Number.isInteger(id) && id > 0 && !uniqueIds.includes(id)) {
                    uniqueIds.push(id);
                }
            });
            return uniqueIds;
        } catch (_error) {
            return [];
        }
    }

    function persistPinnedProjectIds() {
        try {
            localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify(pinnedProjectIds));
        } catch (error) {
            console.warn('Persist pinned projects failed:', error);
        }
    }

    function isProjectPinned(projectId) {
        const normalizedId = Number(projectId);
        return Number.isInteger(normalizedId) && pinnedProjectIds.includes(normalizedId);
    }

    function sortProjectsByPinned(projects) {
        const pinnedSet = new Set(pinnedProjectIds);
        const pinnedMap = new Map();
        const unpinned = [];

        projects.forEach((project) => {
            const projectId = Number(project.id);
            if (pinnedSet.has(projectId)) {
                pinnedMap.set(projectId, project);
            } else {
                unpinned.push(project);
            }
        });

        const pinned = pinnedProjectIds
            .map((projectId) => pinnedMap.get(projectId))
            .filter(Boolean);

        return [...pinned, ...unpinned];
    }

    function updatePinButtonState(pinBtn, pinned) {
        if (!pinBtn) {
            return;
        }
        const label = pinned ? '取消置顶' : '置顶项目';
        pinBtn.title = label;
        pinBtn.setAttribute('aria-label', label);
        pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    }

    function removeProjectPin(projectId) {
        const normalizedId = Number(projectId);
        if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
            return;
        }

        const nextPinnedIds = pinnedProjectIds.filter((id) => id !== normalizedId);
        if (nextPinnedIds.length === pinnedProjectIds.length) {
            return;
        }

        pinnedProjectIds = nextPinnedIds;
        persistPinnedProjectIds();
    }

    function toggleProjectPin(projectId) {
        const normalizedId = Number(projectId);
        if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
            return;
        }

        const targetIndex = pinnedProjectIds.indexOf(normalizedId);
        if (targetIndex >= 0) {
            pinnedProjectIds.splice(targetIndex, 1);
        } else {
            pinnedProjectIds.unshift(normalizedId);
        }

        persistPinnedProjectIds();
        projectsCache = sortProjectsByPinned(projectsCache);
        renderProjects();
    }

    async function deleteProject(projectId, projectName) {
        const label = (projectName || '该项目').trim();
        const confirmed = window.confirm(`确认删除“${label}”？此操作不可恢复。`);
        if (!confirmed) {
            return;
        }

        try {
            await apiRequest(`/api/projects/${projectId}`, { method: 'DELETE' });
            removeProjectPin(projectId);
            if (currentProjectId === projectId) {
                currentProjectId = null;
            }
            await refreshProjects();
        } catch (error) {
            console.error('Delete project failed:', error);
            alert('删除项目失败，请稍后重试。');
        }
    }

    async function duplicateProject(projectId) {
        try {
            const source = await apiRequest(`/api/projects/${projectId}`);
            const sourceName = (source?.name || '未命名项目').toString().trim() || '未命名项目';
            const duplicateName = `${sourceName} 副本`;

            await apiRequest('/api/projects', {
                method: 'POST',
                body: JSON.stringify({
                    name: duplicateName,
                    sourceProjectId: projectId
                })
            });

            await refreshProjects();
        } catch (error) {
            console.error('Duplicate project failed:', error);
            alert('复制项目失败，请稍后重试。');
        }
    }

    async function renameProject(projectId, nextName) {
        let lease = '';
        try {
            const source = await apiRequest(`/api/projects/${projectId}`);
            if (!source.capabilities?.canEdit) {
                throw new Error('你没有编辑此项目的权限。');
            }
            const lock = await apiRequest(`/api/projects/${projectId}/lock`, {
                method: 'POST', body: JSON.stringify({ force: false })
            });
            lease = lock.leaseToken;
            await apiRequest(`/api/projects/${projectId}`, {
                method: 'PUT',
                headers: { 'X-Edit-Lease': lease },
                body: JSON.stringify({ name: nextName, baseVersion: source.version })
            });
            return true;
        } catch (error) {
            console.error('Rename project failed:', error);
            alert(error.status === 423 ? '项目正在由其他用户编辑，暂时不能重命名。' : (error.message || '修改项目名称失败。'));
            return false;
        } finally {
            if (lease) {
                apiRequest(`/api/projects/${projectId}/lock`, {
                    method: 'DELETE', headers: { 'X-Edit-Lease': lease }
                }).catch(() => {});
            }
        }
    }

    function startInlineProjectRename(project, titleElement) {
        if (!titleElement || titleElement.dataset.editing === 'true') {
            return;
        }

        const originalName = (project?.name || titleElement.textContent || '未命名项目').toString().trim() || '未命名项目';
        let isFinalized = false;

        const cleanup = () => {
            titleElement.dataset.editing = 'false';
            titleElement.removeAttribute('contenteditable');
            titleElement.removeAttribute('role');
            titleElement.removeAttribute('aria-label');
            titleElement.removeEventListener('blur', onBlur);
            titleElement.removeEventListener('keydown', onKeyDown);
        };

        const cancelEdit = () => {
            if (isFinalized) {
                return;
            }
            isFinalized = true;
            titleElement.textContent = originalName;
            cleanup();
        };

        const commitEdit = async () => {
            if (isFinalized) {
                return;
            }
            isFinalized = true;

            const nextName = (titleElement.textContent || '').replace(/\s+/g, ' ').trim();
            cleanup();

            if (!nextName) {
                titleElement.textContent = originalName;
                return;
            }
            if (nextName === originalName) {
                titleElement.textContent = originalName;
                return;
            }

            const renamed = await renameProject(project.id, nextName);
            if (!renamed) {
                titleElement.textContent = originalName;
                return;
            }

            project.name = nextName;
            titleElement.textContent = nextName;
            await refreshProjects();
        };

        const onBlur = () => {
            void commitEdit();
        };

        const onKeyDown = (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                titleElement.blur();
                return;
            }

            if (event.key === 'Escape') {
                event.preventDefault();
                cancelEdit();
            }
        };

        titleElement.dataset.editing = 'true';
        titleElement.setAttribute('contenteditable', 'true');
        titleElement.setAttribute('role', 'textbox');
        titleElement.setAttribute('aria-label', '项目名称');
        titleElement.focus();
        titleElement.addEventListener('blur', onBlur);
        titleElement.addEventListener('keydown', onKeyDown);

        const selection = window.getSelection && window.getSelection();
        if (selection) {
            const range = document.createRange();
            range.selectNodeContents(titleElement);
            selection.removeAllRanges();
            selection.addRange(range);
        }
    }

    function renderProjects() {
        projectsGrid.innerHTML = '';
        const isAdminHome = Boolean(appUser?.isAdmin);
        projectsGrid.classList.toggle('is-admin-grouped', isAdminHome);

        const createProjectCard = () => {
            const createWrap = document.createElement('article');
            createWrap.className = 'new-project-card';
            createWrap.innerHTML = `
                <button type="button" class="new-project-btn" id="create-project-btn">+</button>
                <p class="new-project-title">创建新项目</p>
            `;
            createWrap.querySelector('#create-project-btn').addEventListener('click', async () => {
                try {
                    const created = await apiRequest('/api/projects', {
                        method: 'POST'
                    });
                    await refreshProjects();
                    await openProject(created.id);
                } catch (error) {
                    console.error('Create project failed:', error);
                    alert('创建项目失败，请检查服务是否已启动。');
                }
            });
            return createWrap;
        };

        const createProjectElement = (project) => {
            const fragment = projectCardTemplate.content.cloneNode(true);
            const card = fragment.querySelector('.project-card');
            const cover = fragment.querySelector('.project-card-cover');
            const coverInner = fragment.querySelector('.project-card-cover-inner');
            const duplicateBtn = fragment.querySelector('.project-duplicate-btn');
            const deleteBtn = fragment.querySelector('.project-delete-btn');
            const pinBtn = fragment.querySelector('.project-pin-btn');
            const title = fragment.querySelector('.project-card-title');
            const updated = fragment.querySelector('.project-card-updated');
            const pinned = isProjectPinned(project.id);
            const accessRole = String(project.accessRole || '').toLowerCase();

            title.textContent = project.name || '未命名项目';
            updated.textContent = formatUpdatedTime(project.updatedAt);
            if (accessRole) card.dataset.accessRole = accessRole;
            card.classList.toggle('pinned', pinned);
            updatePinButtonState(pinBtn, pinned);
            const hasPreviewImage = Boolean(project.previewImage);
            card.classList.toggle('no-preview', !hasPreviewImage);

            if (hasPreviewImage) {
                coverInner.style.backgroundImage = `url(${project.previewImage})`;
            }

            cover.addEventListener('click', () => {
                openProject(project.id).catch((error) => {
                    console.error('Open project failed:', error);
                    alert('打开项目失败。');
                });
            });

            if (project.capabilities?.canEdit) {
                title.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    startInlineProjectRename(project, title);
                });
            } else {
                title.classList.add('is-readonly');
            }

            if (deleteBtn) {
                deleteBtn.classList.toggle('hidden', !project.capabilities?.canDelete);
                deleteBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    deleteProject(project.id, project.name);
                });
            }

            if (duplicateBtn) {
                duplicateBtn.classList.toggle('hidden', !project.capabilities?.canDuplicate);
                duplicateBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    duplicateProject(project.id);
                });
            }

            if (pinBtn) {
                pinBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleProjectPin(project.id);
                });
            }

            card.dataset.projectId = String(project.id);
            return fragment;
        };

        if (!isAdminHome) {
            projectsGrid.appendChild(createProjectCard());
            projectsCache.forEach((project) => projectsGrid.appendChild(createProjectElement(project)));
            return;
        }

        const groupsByOwner = new Map();
        const currentOwner = {
            id: appUser.id,
            username: appUser.username,
            displayName: appUser.displayName || appUser.username
        };
        groupsByOwner.set(String(currentOwner.id), { owner: currentOwner, projects: [] });

        projectsCache.forEach((project) => {
            const owner = project.owner || currentOwner;
            const key = String(owner.id ?? owner.username);
            if (!groupsByOwner.has(key)) groupsByOwner.set(key, { owner, projects: [] });
            groupsByOwner.get(key).projects.push(project);
        });

        const groups = Array.from(groupsByOwner.values()).sort((left, right) => {
            const leftIsCurrent = Number(left.owner.id) === Number(appUser.id);
            const rightIsCurrent = Number(right.owner.id) === Number(appUser.id);
            if (leftIsCurrent !== rightIsCurrent) return leftIsCurrent ? -1 : 1;
            return String(left.owner.displayName || left.owner.username).localeCompare(
                String(right.owner.displayName || right.owner.username),
                'zh-Hans-CN'
            );
        });

        groups.forEach(({ owner, projects }) => {
            const section = document.createElement('section');
            section.className = 'account-project-group';

            const divider = document.createElement('header');
            divider.className = 'account-project-divider';
            divider.innerHTML = `
                <span class="account-project-divider-line" aria-hidden="true"></span>
                <div class="account-project-divider-label">
                    <strong class="account-project-owner"></strong>
                    <span class="account-project-meta"></span>
                </div>
                <span class="account-project-divider-line" aria-hidden="true"></span>
            `;
            divider.querySelector('.account-project-owner').textContent = owner.displayName || owner.username;
            divider.querySelector('.account-project-meta').textContent = `@${owner.username} · ${projects.length} 个项目`;

            const grid = document.createElement('div');
            grid.className = 'account-project-grid';
            if (Number(owner.id) === Number(appUser.id)) grid.appendChild(createProjectCard());
            projects.forEach((project) => grid.appendChild(createProjectElement(project)));

            section.appendChild(divider);
            section.appendChild(grid);
            projectsGrid.appendChild(section);
        });
    }

    async function refreshProjects() {
        const perfMeta = {
            sort: projectSortSelect.value,
            searchLength: projectSearchInput.value.trim().length,
            projectCount: 0
        };
        const params = new URLSearchParams();
        params.set('sort', projectSortSelect.value);
        const keyword = projectSearchInput.value.trim();
        if (keyword) {
            params.set('search', keyword);
        }

        await perfMeasureAsync('refreshProjects', async () => {
            try {
                const projects = await apiRequest(`/api/projects?${params.toString()}`);
                perfMeta.projectCount = Array.isArray(projects) ? projects.length : 0;
                projectsCache = sortProjectsByPinned(projects);
                renderProjects();
            } catch (error) {
                console.error('Load project list failed:', error);
                projectsGrid.innerHTML = '<p style="color:#ef4444;font-size:1rem;">项目列表加载失败，请检查服务端是否已正常启动。</p>';
            }
        }, () => perfMeta);
    }

    function applyProjectToEditor(project) {
        const perfStartedAt = perfNow();
        const perfMeta = {
            projectId: project?.id || null,
            incomingShots: Array.isArray(project?.shots) ? project.shots.length : 0,
            renderedCards: 0,
            renderedDividers: 0
        };
        setMultiSelectMode(false);
        isRestoringState = true;
        try {
            currentProject = project;
            currentProjectId = project.id;
            currentProjectVersion = project.version;
            currentCapabilities = project.capabilities || {};
            takeoverNoticeShown = false;
            sessionStorage.setItem(PROJECT_STORAGE_KEY, String(project.id));
            if (projectInput) {
                projectInput.value = project.name || '';
            }
            if (sceneInput) {
                sceneInput.value = project.scene || '';
            }

            const targetAspect = project.aspectRatio || '16/9';
            const hasOption = Array.from(aspectRatioSelect.options).some((option) => option.value === targetAspect);
            aspectRatioSelect.value = hasOption ? targetAspect : '16/9';
            document.documentElement.style.setProperty('--shot-aspect', aspectRatioSelect.value);

            hoveredImageUploadContext = null;
            storyboardGrid.innerHTML = '';
            sceneDividerTriggerEl = null;
            shotCount = 0;
            const shots = Array.isArray(project.shots) ? project.shots : [];
            if (shots.length === 0) {
                for (let i = 0; i < DEFAULT_NEW_PROJECT_SHOT_COUNT; i += 1) {
                    addShot(false);
                }
            } else {
                shots.forEach((shotData) => {
                    if (isSceneDividerShot(shotData)) {
                        addSceneDivider({ animate: false, shouldSave: false, dividerData: shotData });
                        return;
                    }
                    addShot(false, shotData);
                });
            }
            updateShotNumbers();
            hasUnsavedChanges = false;
            setSaveStatusState('saved');
        } finally {
            isRestoringState = false;
            applyEditorAccess();
            if (perfState.enabled) {
                perfMeta.renderedCards = storyboardGrid.querySelectorAll('.shot-card').length;
                perfMeta.renderedDividers = storyboardGrid.querySelectorAll('.scene-divider').length;
            }
            perfRecord('applyProjectToEditor', perfNow() - perfStartedAt, perfMeta);
        }
    }

    async function openProject(projectId, options = {}) {
        const {
            syncHistory = true,
            replaceHistory = false,
            flushSave = true
        } = options;

        const normalizedProjectId = normalizeProjectId(projectId);
        if (!normalizedProjectId) {
            throw new Error('Invalid project id');
        }

        if (flushSave && !await prepareToLeaveCurrentProject()) {
            switchToEditor({ syncHistory: true, replaceHistory: true });
            return false;
        }
        await releaseCurrentLock();
        const project = await apiRequest(`/api/projects/${normalizedProjectId}`);
        editLeaseToken = '';
        saveConflictActive = false;
        applyProjectToEditor(project);
        switchToEditor({ syncHistory, replaceHistory });
        if (project.capabilities?.canEdit) {
            await acquireCurrentProjectLock(false);
        } else {
            setLockBanner(project.accessRole === 'anonymous' ? '匿名只读分享' : '你对该项目拥有只读权限。');
            applyEditorAccess();
        }
        return true;
    }

    if (typeof Sortable !== 'undefined') {
        storyboardSortable = new Sortable(storyboardGrid, {
            animation: 250,
            draggable: '.shot-card, .scene-divider',
            handle: '.drag-handle, .scene-divider-drag-zone',
            chosenClass: 'sortable-chosen',
            ghostClass: 'sortable-ghost',
            dragClass: 'sortable-drag',
            onStart: function (evt) {
                clearTextSelection();
                if (hoveredShotGroupId) {
                    setShotGroupHoverState(hoveredShotGroupId, false);
                }
                storyboardGrid.classList.add('is-sorting');
                document.body.classList.add('is-sorting');
                if (evt.item && evt.item.classList.contains('scene-divider')) {
                    startSceneDragContext(evt.item);
                }
            },
            onEnd: function (evt) {
                storyboardGrid.classList.remove('is-sorting');
                document.body.classList.remove('is-sorting');
                clearTextSelection();

                if (draggingSceneContext && evt.item === draggingSceneContext.divider) {
                    moveSceneCardsAfterDraggedDivider();
                }

                updateShotNumbers();
                scheduleSaveState();

                if (evt.item) {
                    evt.item.classList.add('drag-settled');
                    setTimeout(() => evt.item.classList.remove('drag-settled'), 320);
                }
                clearSceneDragContext();
            }
        });
    }

    function resolveShotSelectValue(savedValue, legacyCameraText, allowedValues) {
        const normalizedSavedValue = typeof savedValue === 'string' ? savedValue.trim() : '';
        if (allowedValues.includes(normalizedSavedValue)) {
            return normalizedSavedValue;
        }

        const normalizedLegacyText = typeof legacyCameraText === 'string' ? legacyCameraText.trim() : '';
        if (!normalizedLegacyText) {
            return '';
        }

        return [...allowedValues]
            .sort((left, right) => right.length - left.length)
            .find((value) => normalizedLegacyText.includes(value)) || '';
    }

    function addShot(animate = true, shotData = null) {
        const perfStartedAt = perfNow();
        const perfMeta = {
            animate: Boolean(animate),
            hasShotData: Boolean(shotData),
            restoring: isRestoringState,
            totalCards: 0
        };
        shotCount++;
        const clone = template.content.cloneNode(true);
        const card = clone.querySelector('.shot-card');
        const header = clone.querySelector('.shot-header');

        const radios = clone.querySelectorAll('input[type="radio"]');
        const uniqueId = `camera-move-${Date.now()}-${shotCount}`;
        radios.forEach((radio) => {
            radio.name = uniqueId;
        });

        const deleteBtn = clone.querySelector('.delete-shot-btn');
        deleteBtn.addEventListener('click', () => {
            if (shouldConfirmShotDeletion([card])) {
                const confirmed = window.confirm('确认删除这个镜头？此操作不可恢复。');
                if (!confirmed) {
                    return;
                }
            }
            deleteShotCards([card]);
        });

        const imageContainer = clone.querySelector('.shot-image-container');
        const fileInput = clone.querySelector('.image-upload');
        const preview = clone.querySelector('.shot-image-preview');
        const placeholder = clone.querySelector('.image-placeholder');
        const replaceImageBtn = clone.querySelector('.replace-image-btn');
        const deleteImageBtn = clone.querySelector('.delete-image-btn');
        const imageContext = { card, container: imageContainer, fileInput, preview, placeholder };

        const vfxCheckbox = clone.querySelector('.vfx-checkbox input[type="checkbox"]');
        const shotTimeInput = clone.querySelector('.shot-time-input');
        const shotTimeInputSizer = clone.querySelector('.shot-time-input-sizer');
        const shotTimeDecrement = clone.querySelector('.shot-time-decrement');
        const shotTimeIncrement = clone.querySelector('.shot-time-increment');
        const actionField = clone.querySelector('.text-action');
        const shotSizeSelect = clone.querySelector('.shot-size-select');
        const cameraMovementSelect = clone.querySelector('.camera-movement-select');
        const dialogueField = clone.querySelector('.text-dialogue');

        preview.draggable = false;
        imageContainer.addEventListener('dragstart', (e) => e.preventDefault());
        preview.addEventListener('dragstart', (e) => e.preventDefault());

        imageContainer.addEventListener('click', () => {
            fileInput.click();
        });

        fileInput.addEventListener('click', (e) => e.stopPropagation());
        imageContainer.addEventListener('mouseenter', () => {
            hoveredImageUploadContext = imageContext;
        });
        imageContainer.addEventListener('mouseleave', () => {
            if (hoveredImageUploadContext?.container === imageContainer) {
                hoveredImageUploadContext = null;
            }
        });

        replaceImageBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            fileInput.click();
        });
        deleteImageBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            clearImageFromCard(imageContext);
        });

        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                applyImageToCard(file, imageContext);
            }
        });

        const textFields = clone.querySelectorAll('.auto-resize-textarea');
        textFields.forEach((field) => {
            field.addEventListener('paste', (event) => {
                // Chrome keeps a contenteditable field focused after the pointer moves away.
                // Let image pastes bubble to the hovered card's image handler instead of
                // consuming them as empty plain text here.
                if (!isMultiSelectMode
                    && !editorReadOnly
                    && getActiveHoveredImageUploadContext()
                    && clipboardHasImage(event.clipboardData)) {
                    return;
                }
                const plainText = event.clipboardData?.getData('text/plain') || '';
                event.preventDefault();
                event.stopPropagation();
                hideTextColorPalette();
                insertPlainTextIntoEditableField(field, plainText);
                cleanupEditableFieldMarkup(field);
                autoResizeTextarea(field);
                scheduleSaveState();
            });
            field.addEventListener('input', () => {
                cleanupEditableFieldMarkup(field);
                autoResizeTextarea(field);
                hideTextColorPalette();
                scheduleSaveState();
            });
            field.addEventListener('blur', () => {
                cleanupEditableFieldMarkup(field);
                autoResizeTextarea(field);
            });
            field.addEventListener('mousedown', () => {
                hideTextColorPalette();
            });
            field.addEventListener('mouseup', (event) => {
                window.setTimeout(() => {
                    cacheActiveTextColorSelection(field, event.clientX, event.clientY);
                }, 0);
            });
            field.addEventListener('keyup', () => {
                window.setTimeout(() => {
                    cacheActiveTextColorSelection(field);
                }, 0);
            });
            requestAnimationFrame(() => autoResizeTextarea(field));
        });

        const colorWrapper = clone.querySelector('.color-picker-wrapper');
        const colorTrigger = clone.querySelector('.scene-color-trigger');
        const colorPalette = clone.querySelector('.scene-color-palette');
        const defaultColor = DEFAULT_SCENE_HEADER_COLOR;

        function setHeaderColor(newColor, shouldSave = true) {
            if (!newColor) {
                return;
            }
            const readableColor = normalizeSceneHeaderColor(newColor);
            colorWrapper.dataset.color = readableColor;
            const usesWritingAreaBackground = readableColor === DEFAULT_SCENE_HEADER_COLOR;
            colorTrigger.style.backgroundColor = usesWritingAreaBackground ? '' : readableColor;
            header.style.backgroundColor = usesWritingAreaBackground ? '' : readableColor;
            header.classList.toggle('light-scene-header', isLightSceneHeaderColor(readableColor));

            const options = colorPalette.querySelectorAll('.scene-color-option');
            options.forEach((option) => {
                option.classList.toggle('active', option.dataset.color === readableColor);
            });

            if (shouldSave) {
                scheduleSaveState();
            }
        }

        PRESET_SCENE_COLOR_ROWS.forEach((row, rowIndex) => {
            row.forEach((hex, columnIndex) => {
                const colorOption = document.createElement('button');
                colorOption.type = 'button';
                colorOption.className = 'scene-color-option';
                colorOption.dataset.color = hex;
                colorOption.style.backgroundColor = hex;
                colorOption.setAttribute('aria-label', `选择第${rowIndex + 1}行第${columnIndex + 1}列颜色`);
                colorPalette.appendChild(colorOption);
            });
        });

        const toggleColorPalette = (event) => {
            event.stopPropagation();
            addDropdownMenu.classList.remove('show');
            const willOpen = !colorPalette.classList.contains('show');
            closeAllColorPalettes();
            if (willOpen) {
                colorPalette.classList.add('show');
            }
        };

        colorWrapper.addEventListener('click', (event) => {
            if (event.target !== colorWrapper) {
                return;
            }
            if (event.target.closest('.scene-color-palette')) {
                return;
            }
            toggleColorPalette(event);
        });

        colorTrigger.addEventListener('click', toggleColorPalette);

        colorPalette.addEventListener('click', (event) => {
            event.stopPropagation();
            const option = event.target.closest('.scene-color-option');
            if (!option) {
                return;
            }

            setHeaderColor(option.dataset.color, true);
            colorPalette.classList.remove('show');
        });

        if (vfxCheckbox) {
            vfxCheckbox.addEventListener('change', scheduleSaveState);
        }
        const syncShotTimeInputSizer = () => {
            if (!shotTimeInput || !shotTimeInputSizer) {
                return;
            }
            shotTimeInputSizer.dataset.value = shotTimeInput.value || shotTimeInput.placeholder || ' ';
        };
        if (shotTimeInput) {
            shotTimeInput.addEventListener('input', () => {
                delete card.dataset.legacyTimeRange;
                shotTimeInput.placeholder = '时长';
                shotTimeInput.removeAttribute('title');
                const sanitizedValue = sanitizeShotDurationInput(shotTimeInput.value);
                if (shotTimeInput.value !== sanitizedValue) {
                    shotTimeInput.value = sanitizedValue;
                }
                syncShotTimeInputSizer();
                updateTotalDuration();
                scheduleSaveState();
            });
        }
        const stepShotDuration = (step) => {
            if (!shotTimeInput) {
                return;
            }
            shotTimeInput.value = stepShotDurationValue(shotTimeInput.value, step);
            shotTimeInput.dispatchEvent(new Event('input', { bubbles: true }));
        };
        if (shotTimeDecrement) {
            shotTimeDecrement.addEventListener('click', () => stepShotDuration(-0.1));
        }
        if (shotTimeIncrement) {
            shotTimeIncrement.addEventListener('click', () => stepShotDuration(0.1));
        }
        if (shotSizeSelect) {
            shotSizeSelect.addEventListener('change', scheduleSaveState);
        }
        if (cameraMovementSelect) {
            cameraMovementSelect.addEventListener('change', scheduleSaveState);
        }
        radios.forEach((radio) => radio.addEventListener('change', scheduleSaveState));

        if (shotData && typeof shotData === 'object') {
            setShotCardGroup(card, shotData.groupId);
            if (typeof shotData.headerColor === 'string' && shotData.headerColor) {
                setHeaderColor(shotData.headerColor, false);
            } else {
                setHeaderColor(defaultColor, false);
            }

            if (vfxCheckbox) {
                vfxCheckbox.checked = Boolean(shotData.vfx);
            }
            if (shotTimeInput) {
                const savedTimeRange = typeof shotData.timeRange === 'string' ? shotData.timeRange.trim() : '';
                const normalizedDuration = normalizeSavedShotDuration(savedTimeRange);
                shotTimeInput.value = normalizedDuration;
                if (savedTimeRange && !normalizedDuration) {
                    card.dataset.legacyTimeRange = savedTimeRange;
                    shotTimeInput.placeholder = '需重填';
                    shotTimeInput.title = `旧格式时长“${savedTimeRange}”未计入总时长，请按秒数重填。`;
                } else {
                    delete card.dataset.legacyTimeRange;
                    shotTimeInput.placeholder = '时长';
                    shotTimeInput.removeAttribute('title');
                }
            }

            if (typeof shotData.move === 'string') {
                const targetRadio = Array.from(radios).find((radio) => radio.value === shotData.move);
                if (targetRadio) {
                    targetRadio.checked = true;
                }
            }

            const legacyCamera = typeof shotData.camera === 'string' ? shotData.camera : '';
            const legacyCameraHtml = typeof shotData.cameraHtml === 'string' ? shotData.cameraHtml : '';
            card.dataset.legacyCamera = legacyCamera;
            card.dataset.legacyCameraHtml = legacyCameraHtml;
            if (shotSizeSelect) {
                shotSizeSelect.value = resolveShotSelectValue(
                    shotData.shotSize,
                    legacyCamera,
                    SHOT_SIZE_OPTIONS
                );
            }
            if (cameraMovementSelect) {
                cameraMovementSelect.value = resolveShotSelectValue(
                    shotData.cameraMovement,
                    legacyCamera,
                    CAMERA_MOVEMENT_OPTIONS
                );
            }

            setEditableFieldContent(
                actionField,
                typeof shotData.actionHtml === 'string' ? shotData.actionHtml : '',
                typeof shotData.action === 'string' ? shotData.action : ''
            );
            setEditableFieldContent(
                dialogueField,
                typeof shotData.dialogueHtml === 'string' ? shotData.dialogueHtml : '',
                typeof shotData.dialogue === 'string' ? shotData.dialogue : ''
            );

            if (shotData.hasImage && typeof shotData.imageSrc === 'string' && shotData.imageSrc) {
                if (typeof shotData.imageId === 'string' && shotData.imageId) {
                    card.dataset.imageId = shotData.imageId;
                }
                preview.src = shotData.imageSrc;
                preview.style.display = 'block';
                placeholder.style.display = 'none';
                imageContainer.classList.add('has-image');
            } else {
                delete card.dataset.imageId;
                preview.src = '';
                preview.style.display = 'none';
                placeholder.style.display = 'flex';
                imageContainer.classList.remove('has-image');
            }
        } else {
            setShotCardGroup(card, '');
            setHeaderColor(defaultColor, false);
            if (shotTimeInput) {
                shotTimeInput.value = '';
                shotTimeInput.placeholder = '时长';
                shotTimeInput.removeAttribute('title');
            }
            delete card.dataset.legacyTimeRange;
            delete card.dataset.legacyCamera;
            delete card.dataset.legacyCameraHtml;
            if (shotSizeSelect) {
                shotSizeSelect.value = '';
            }
            if (cameraMovementSelect) {
                cameraMovementSelect.value = '';
            }
            setEditableFieldContent(actionField, '', '');
            setEditableFieldContent(dialogueField, '', '');
        }

        syncShotTimeInputSizer();

        appendStoryboardItem(clone);

        if (animate) {
            card.style.opacity = '0';
            card.style.transform = 'translateY(20px)';
            card.style.transition = 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)';
            void card.offsetWidth;
            card.style.opacity = '1';
            card.style.transform = 'translateY(0)';
        }

        if (!isRestoringState) {
            updateShotNumbers();
            scheduleSaveState();
        }
        if (perfState.enabled) {
            perfMeta.totalCards = storyboardGrid.querySelectorAll('.shot-card').length;
        }
        perfRecord('addShot', perfNow() - perfStartedAt, perfMeta);
    }

    document.addEventListener('paste', (e) => {
        if (isMultiSelectMode || editorReadOnly) {
            return;
        }
        const imageContext = getActiveHoveredImageUploadContext();
        if (!imageContext) {
            return;
        }

        const items = e.clipboardData?.items;
        if (!items) {
            return;
        }

        const imageItem = Array.from(items).find((item) => item.type.startsWith('image/'));
        if (!imageItem) {
            return;
        }

        const file = imageItem.getAsFile();
        if (!file) {
            return;
        }

        e.preventDefault();
        applyImageToCard(file, imageContext);
    });

    updateMultiSelectToggleButton();
    multiSelectPanel.addEventListener('click', (event) => {
        event.stopPropagation();
    });
    multiSelectGroupBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        groupSelectedShots();
    });
    multiSelectUngroupBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        ungroupSelectedShots();
    });
    multiSelectDeleteBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        deleteSelectedShotsWithConfirm();
    });
    if (multiSelectToggleBtn) {
        multiSelectToggleBtn.addEventListener('click', () => {
            setMultiSelectMode(!isMultiSelectMode);
        });
    }
    storyboardGrid.addEventListener('click', (event) => {
        if (!isMultiSelectMode) {
            return;
        }
        const card = event.target.closest('.shot-card');
        if (!card || !storyboardGrid.contains(card)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        toggleShotCardSelection(card, event.clientX, event.clientY);
    }, true);
    document.addEventListener('keydown', (event) => {
        if (isCopyShortcut(event) && getActiveHoveredImageUploadContext()) {
            if (hasActiveEditableSelection()) {
                return;
            }

            const hoveredImageSrc = getHoveredImageSrc();
            if (hoveredImageSrc) {
                event.preventDefault();
                copyImageSrcToClipboard(hoveredImageSrc).then((copied) => {
                    if (!copied) {
                        alert('复制图片失败，请检查浏览器剪贴板权限。');
                        return;
                    }
                    showClipboardToast('已复制到剪切板');
                }).catch((error) => {
                    console.error('Copy image failed:', error);
                    alert('复制图片失败，请检查浏览器剪贴板权限。');
                });
                return;
            }
        }

        if (event.key === 'Escape' && isMultiSelectMode) {
            clearSelectedShotCards();
            return;
        }
        if (event.key === 'Escape') {
            hideTextColorPalette();
        }
    });

    addShotBtn.addEventListener('click', () => addShot(true));

    addDropdownToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllColorPalettes();
        addDropdownMenu.classList.toggle('show');
    });

    document.addEventListener('click', (event) => {
        if (event.target.closest('.color-picker-wrapper')) {
            return;
        }
        addDropdownMenu.classList.remove('show');
        closeAllColorPalettes();
        if (!event.target.closest('.text-color-floating-palette') && !event.target.closest('.rich-text-input')) {
            hideTextColorPalette();
        }
    });

    const dropdownItems = addDropdownMenu.querySelectorAll('.dropdown-item');
    dropdownItems.forEach((item) => {
        item.addEventListener('click', (e) => {
            const count = parseInt(e.target.dataset.addCount, 10);
            for (let i = 0; i < count; i++) {
                addShot(false);
            }
            addDropdownMenu.classList.remove('show');
        });
    });

    async function navigateToHome(options = {}) {
        const {
            syncHistory = true,
            replaceHistory = false,
            flushSave = true
        } = options;

        if (isShareMode) return;
        if (flushSave && !await prepareToLeaveCurrentProject()) {
            switchToEditor({ syncHistory: true, replaceHistory: true });
            return false;
        }
        await releaseCurrentLock();
        switchToHome({ syncHistory, replaceHistory });
        await refreshProjects();
        return true;
    }

    backToHomeBtn.addEventListener('click', () => {
        navigateToHome().catch((error) => {
            console.error('Navigate home failed:', error);
            alert('返回主页失败，请稍后重试。');
        });
    });

    if (isShareMode) backToHomeBtn.classList.add('hidden');
    manageSharingBtn?.addEventListener('click', () => {
        if (currentProject && currentCapabilities.canManageMembers) openSharingDialog(currentProject);
    });

    exportPdfBtn.addEventListener('click', () => {
        clearSelectedShotCards();
        buildPrintLayout();
        applyExportPdfDocumentTitle();
        window.print();
    });

    aspectRatioSelect.addEventListener('change', (e) => {
        document.documentElement.style.setProperty('--shot-aspect', e.target.value);
        scheduleSyncShotGroupFrames();
        scheduleSaveState();
    });

    if (projectInput) {
        projectInput.addEventListener('input', scheduleSaveState);
    }

    projectSortSelect.addEventListener('change', () => {
        refreshProjects();
    });

    projectSearchInput.addEventListener('input', () => {
        if (searchTimer) {
            clearTimeout(searchTimer);
        }
        searchTimer = setTimeout(() => {
            searchTimer = null;
            refreshProjects();
        }, 180);
    });

    window.addEventListener('beforeprint', () => {
        hideMultiSelectPanel();
        if (!isPrintLayoutReady) {
            buildPrintLayout();
        }
    });

    window.addEventListener('afterprint', () => {
        clearPrintLayout();
        restoreDocumentTitleAfterPrint();
    });

    window.addEventListener('resize', () => {
        scheduleSyncProjectHeaderWidth(false);
        scheduleSyncSceneHeaderInputByViewport();
        scheduleSyncShotGroupFrames();
        refreshMultiSelectPanel();
        hideTextColorPalette();
    });
    const heartbeatAfterPageResume = () => {
        if (!document.hidden) {
            heartbeatCurrentProjectLock();
        }
    };
    document.addEventListener('visibilitychange', heartbeatAfterPageResume);
    window.addEventListener('pageshow', heartbeatAfterPageResume);
    window.addEventListener('focus', heartbeatAfterPageResume);
    window.addEventListener('scroll', () => {
        scheduleSyncSceneHeaderInputByViewport();
    }, { passive: true });
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
            if (!editorView.classList.contains('hidden')) {
                scheduleSyncProjectHeaderWidth(false);
                scheduleSyncSceneHeaderInputByViewport();
                scheduleSyncShotGroupFrames();
            }
        }).catch(() => {
            // ignore font readiness failures
        });
    }
    window.storyboardPrepareForExit = prepareToLeaveCurrentProject;

    window.addEventListener('beforeunload', (event) => {
        if (hasUnsavedChanges || pendingSavePromise || saveTimer) {
            event.preventDefault();
            event.returnValue = '';
            return;
        }
        releaseCurrentLock();
    });
    window.addEventListener('storyboard-before-logout', () => { releaseCurrentLock(); });

    async function applyRoute(route, options = {}) {
        const { syncHistory = true, replaceHistory = false, flushSave = true } = options;
        const normalizedProjectId = normalizeProjectId(route?.projectId);

        if (route?.view === 'editor' && normalizedProjectId) {
            await openProject(normalizedProjectId, { syncHistory, replaceHistory, flushSave });
            return;
        }

        await navigateToHome({ syncHistory, replaceHistory, flushSave });
    }

    function resolveInitialRoute() {
        return resolveRouteFromLocation();
    }

    async function restoreInitialView() {
        const initialRoute = resolveInitialRoute();
        try {
            await applyRoute(initialRoute, {
                syncHistory: true,
                replaceHistory: true,
                flushSave: false
            });
        } catch (error) {
            if (initialRoute?.view === 'editor') {
                console.warn('Restore editor view failed:', error);
                await applyRoute({ view: 'home' }, {
                    syncHistory: true,
                    replaceHistory: true,
                    flushSave: false
                });
                return;
            }
            throw error;
        }
    }

    window.addEventListener('popstate', (event) => {
        const route = resolveRouteFromHistoryState(event.state)
            || resolveRouteFromLocation()
            || { view: 'home' };

        applyRoute(route, {
            syncHistory: false,
            replaceHistory: false,
            flushSave: true
        }).catch((error) => {
            console.error('History navigation failed:', error);
            applyRoute({ view: 'home' }, {
                syncHistory: true,
                replaceHistory: true,
                flushSave: false
            }).catch((fallbackError) => {
                console.error('Fallback to home failed:', fallbackError);
            });
        });
    });

    syncProjectHeaderWidth();
    const initialViewPromise = isShareMode
        ? Promise.resolve().then(() => {
            editLeaseToken = '';
            saveConflictActive = false;
            applyProjectToEditor(accessContext.project);
            switchToEditor({ syncHistory: false });
            setLockBanner('匿名只读分享');
            applyEditorAccess();
        })
        : restoreInitialView();
    initialViewPromise.catch((error) => {
        console.error('Initialize app failed:', error);
        if (isShareMode) return;
        applyRoute({ view: 'home' }, {
            syncHistory: true,
            replaceHistory: true,
            flushSave: false
        }).catch((fallbackError) => {
            console.error('Fallback to home failed:', fallbackError);
        });
    }).finally(() => {
        clearPreloadViewClasses();
    });
});
