import { ApiError, apiRequest } from './js/api.js';
import { bootstrapAccess } from './js/auth.js';
import { openSharingDialog } from './js/sharing.js';
import {
    DEFAULT_SCENE_HEADER_COLOR,
    DEFAULT_TEXT_COLOR_TOKEN,
    TEXT_COLOR_OPTIONS,
    buildPresetSceneColorRows,
    ensureWhiteTextReadableHex
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

document.addEventListener('DOMContentLoaded', async () => {
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
    let editorReadOnly = true;
    let saveConflictActive = false;
    let shotCount = 0;
    let isPrintLayoutReady = false;
    let hoveredImageUploadContext = null;
    let isRestoringState = false;
    let saveTimer = null;
    let hasUnsavedChanges = false;
    let pendingSavePromise = null;
    let searchTimer = null;
    const PRINT_PAGE_STYLE_ID = 'dynamic-print-page-style';
    const PRELOAD_HOME_CLASS = 'preload-view-home';
    const PRELOAD_EDITOR_CLASS = 'preload-view-editor';
    const DEFAULT_NEW_PROJECT_SHOT_COUNT = 5;
    const PINNED_PROJECTS_KEY = `storyboard:pinned-project-ids:${appUser?.id || 'anonymous'}`;
    const PRESET_SCENE_COLOR_ROWS = buildPresetSceneColorRows();
    let pinnedProjectIds = loadPinnedProjectIds();
    let sceneDividerTriggerEl = null;
    let draggingSceneContext = null;
    let pendingHeaderSyncRaf = null;
    let pendingSceneHeaderSyncRaf = null;
    let storyboardSortable = null;
    let isMultiSelectMode = false;
    let selectedShotCards = new Set();
    let lastMultiSelectPointer = null;
    let previousDocumentTitleBeforePrint = null;
    let activeTextColorRange = null;
    let activeTextColorField = null;
    let lastTextColorPointer = null;
    let clipboardToastHideTimer = null;

    function setLockBanner(message = '', options = {}) {
        if (!editLockBanner) return;
        editLockBanner.innerHTML = '';
        editLockBanner.classList.toggle('hidden', !message);
        if (!message) return;
        const text = document.createElement('span');
        text.textContent = message;
        editLockBanner.appendChild(text);
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

    function applyEditorAccess() {
        const canEdit = Boolean(currentCapabilities.canEdit && editLeaseToken && !saveConflictActive);
        editorReadOnly = !canEdit;
        editorView.classList.toggle('is-readonly', editorReadOnly);
        if (projectInput) projectInput.readOnly = editorReadOnly;
        if (aspectRatioSelect) aspectRatioSelect.disabled = editorReadOnly;
        [addShotBtn, addDropdownToggle, multiSelectToggleBtn].forEach((button) => { if (button) button.disabled = editorReadOnly; });
        storyboardGrid.querySelectorAll('.rich-text-input').forEach((field) => field.setAttribute('contenteditable', canEdit ? 'true' : 'false'));
        storyboardGrid.querySelectorAll('input, button').forEach((control) => { control.disabled = editorReadOnly; });
        if (storyboardSortable) storyboardSortable.option('disabled', editorReadOnly || isMultiSelectMode);
        if (projectAccessBadge) {
            const accessRole = String(currentProject?.accessRole || '').toLowerCase();
            projectAccessBadge.textContent = accessRole;
            projectAccessBadge.dataset.role = accessRole;
            projectAccessBadge.classList.toggle('hidden', !accessRole);
        }
        if (manageSharingBtn) manageSharingBtn.classList.toggle('hidden', !currentCapabilities.canManageMembers);
    }

    function stopLockHeartbeat() {
        if (editLockHeartbeatTimer) clearInterval(editLockHeartbeatTimer);
        editLockHeartbeatTimer = null;
    }

    function startLockHeartbeat() {
        stopLockHeartbeat();
        if (!editLeaseToken || !currentProjectId) return;
        editLockHeartbeatTimer = setInterval(async () => {
            try {
                await apiRequest(`/api/projects/${currentProjectId}/lock`, {
                    method: 'PATCH', headers: { 'X-Edit-Lease': editLeaseToken }
                });
            } catch (error) {
                if (error.status === 423 || error.status === 404) {
                    editLeaseToken = '';
                    saveConflictActive = true;
                    stopLockHeartbeat();
                    setLockBanner('编辑权已失效，本地内容不会继续自动保存。', { reload: true });
                    applyEditorAccess();
                }
            }
        }, 15000);
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
            setLockBanner('你正在编辑此项目。');
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
                visibleSceneCards[0].style.gridColumnStart = String(startColumn);
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
        if (typeof timeInput?.value === 'string' && timeInput.value.trim()) {
            return true;
        }

        const preview = card.querySelector('.shot-image-preview');
        const hasImage = Boolean(preview && preview.style.display !== 'none' && preview.src);
        if (hasImage) {
            return true;
        }

        const textFields = card.querySelectorAll('.text-action, .text-camera, .text-dialogue');
        return Array.from(textFields).some((field) => {
            return Boolean(getEditablePlainText(field).trim());
        });
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
            updateShotNumbers();
            scheduleSaveState();
            if (exitMultiSelectAfterDone) {
                setMultiSelectMode(false);
            }
        }, 200);
    }

    function deleteSelectedShotsWithConfirm() {
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
        const firstContentItem = Array.from(storyboardGrid.children).find((child) => child !== trigger);
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
        const firstContentItem = Array.from(storyboardGrid.children).find((child) => child !== trigger);
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
        const firstContentChild = Array.from(storyboardGrid.children).find((child) => child !== trigger);
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
        const cameraText = card.querySelector('.text-camera');
        const dialogueText = card.querySelector('.text-dialogue');
        const preview = card.querySelector('.shot-image-preview');

        return {
            headerColor: colorWrapper?.dataset.color || '',
            vfx: Boolean(vfxCheckbox?.checked),
            timeRange: typeof shotTimeInput?.value === 'string' ? shotTimeInput.value.trim() : '',
            move: checkedMove?.value || 'Static固定',
            action: getEditablePlainText(actionText),
            camera: getEditablePlainText(cameraText),
            dialogue: getEditablePlainText(dialogueText),
            actionHtml: getEditableFieldHtml(actionText),
            cameraHtml: getEditableFieldHtml(cameraText),
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
            if (error instanceof ApiError && (error.status === 409 || error.status === 423)) {
                hasUnsavedChanges = true;
                saveConflictActive = true;
                editLeaseToken = '';
                stopLockHeartbeat();
                setLockBanner(
                    error.status === 409
                        ? '服务器上已有更新；已停止自动保存以避免覆盖。'
                        : '编辑锁已失效；已停止自动保存。',
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
            return;
        }
        await saveState();
    }

    function updateShotNumbers() {
        const perfMeta = { cardCount: 0, insertedLeadingDivider: false };
        perfMeasureSync('updateShotNumbers', () => {
            const insertedLeadingDivider = ensureFirstSceneDividerWhenSegmented();
            const cards = storyboardGrid.querySelectorAll('.shot-card');
            perfMeta.cardCount = cards.length;
            perfMeta.insertedLeadingDivider = insertedLeadingDivider;
            cards.forEach((card, index) => {
                card.querySelector('.shot-index').textContent = index + 1;
            });
            refreshSceneDividerShotCounts();
            placeSceneDividerTriggerAtEnd();
            applyAllSceneDividerStates();
            syncProjectHeaderWidth();
            syncSceneHeaderInputByViewport();
            refreshMultiSelectPanel();
            if (insertedLeadingDivider && !isRestoringState) {
                scheduleSaveState();
            }
        }, () => perfMeta);
    }

    function autoResizeTextarea(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = `${textarea.scrollHeight}px`;
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

    function getHoveredImageSrc() {
        if (!hoveredImageUploadContext || !hoveredImageUploadContext.preview) {
            return '';
        }
        if (hoveredImageUploadContext.preview.style.display === 'none') {
            return '';
        }
        return hoveredImageUploadContext.preview.src || '';
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
            'Static固定': '固定',
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
                    size: A4 portrait;
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

    function createPrintCard(card, printIndex) {
        const cardClone = document.createElement('article');
        cardClone.className = 'shot-card';

        const sourceHeader = card.querySelector('.shot-header');
        const header = document.createElement('header');
        header.className = 'shot-header';
        if (sourceHeader && sourceHeader.style.backgroundColor) {
            header.style.backgroundColor = sourceHeader.style.backgroundColor;
        }

        const headerLeft = document.createElement('div');
        headerLeft.className = 'header-left-actions';
        const shotNumber = document.createElement('div');
        shotNumber.className = 'shot-number';
        shotNumber.innerHTML = `SHOT #<span class="shot-index">${printIndex}</span>`;
        headerLeft.appendChild(shotNumber);

        const sourceTimeInput = card.querySelector('.shot-time-input');
        const timeRange = (sourceTimeInput?.value || '').trim();
        let headerCenter = null;
        if (timeRange) {
            headerCenter = document.createElement('div');
            headerCenter.className = 'header-center-actions';
            const printTimeInput = document.createElement('input');
            printTimeInput.type = 'text';
            printTimeInput.className = 'shot-time-input';
            printTimeInput.value = timeRange;
            printTimeInput.placeholder = '';
            printTimeInput.readOnly = true;
            printTimeInput.tabIndex = -1;
            headerCenter.appendChild(printTimeInput);
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
        const fields = [
            card.querySelector('.text-action'),
            card.querySelector('.text-camera'),
            card.querySelector('.text-dialogue')
        ];
        fields.forEach((sourceField, index) => {
            details.appendChild(createPrintTextBlockFromField(sourceField));
            if (index < fields.length - 1) {
                const divider = document.createElement('div');
                divider.className = 'divider';
                details.appendChild(divider);
            }
        });
        cardClone.appendChild(details);

        return cardClone;
    }

    function createPrintPage(cards, startIndex, headerSource, sceneLabel = '') {
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

        cards.forEach((card, cardOffset) => {
            grid.appendChild(createPrintCard(card, startIndex + cardOffset + 1));
        });

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
        const cardsPerPage = 8;
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
            for (let i = 0; i < group.cards.length; i += cardsPerPage) {
                const pageCards = group.cards.slice(i, i + cardsPerPage);
                pagesFragment.appendChild(createPrintPage(pageCards, printedCardCount, headerSource, group.sceneLabel));
                printedCardCount += pageCards.length;
            }
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

        const createWrap = document.createElement('article');
        createWrap.className = 'new-project-card';
        createWrap.innerHTML = `
            <button type="button" class="new-project-btn" id="create-project-btn">+</button>
            <p class="new-project-title">创建新项目</p>
        `;
        projectsGrid.appendChild(createWrap);
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

        projectsCache.forEach((project) => {
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

            title.textContent = project.name || '未命名项目';
            updated.textContent = formatUpdatedTime(project.updatedAt);
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
            projectsGrid.appendChild(fragment);
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

        if (flushSave) {
            await flushPendingSave();
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
        const actionField = clone.querySelector('.text-action');
        const cameraField = clone.querySelector('.text-camera');
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
            const readableColor = ensureWhiteTextReadableHex(newColor);
            colorWrapper.dataset.color = readableColor;
            colorTrigger.style.backgroundColor = readableColor;
            header.style.backgroundColor = readableColor;

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
        if (shotTimeInput) {
            shotTimeInput.addEventListener('input', scheduleSaveState);
        }
        radios.forEach((radio) => radio.addEventListener('change', scheduleSaveState));

        if (shotData && typeof shotData === 'object') {
            if (typeof shotData.headerColor === 'string' && shotData.headerColor) {
                setHeaderColor(shotData.headerColor, false);
            } else {
                setHeaderColor(defaultColor, false);
            }

            if (vfxCheckbox) {
                vfxCheckbox.checked = Boolean(shotData.vfx);
            }
            if (shotTimeInput) {
                shotTimeInput.value = typeof shotData.timeRange === 'string' ? shotData.timeRange : '';
            }

            if (typeof shotData.move === 'string') {
                const targetRadio = Array.from(radios).find((radio) => radio.value === shotData.move);
                if (targetRadio) {
                    targetRadio.checked = true;
                }
            }

            setEditableFieldContent(
                actionField,
                typeof shotData.actionHtml === 'string' ? shotData.actionHtml : '',
                typeof shotData.action === 'string' ? shotData.action : ''
            );
            setEditableFieldContent(
                cameraField,
                typeof shotData.cameraHtml === 'string' ? shotData.cameraHtml : '',
                typeof shotData.camera === 'string' ? shotData.camera : ''
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
            setHeaderColor(defaultColor, false);
            if (shotTimeInput) {
                shotTimeInput.value = '';
            }
            setEditableFieldContent(actionField, '', '');
            setEditableFieldContent(cameraField, '', '');
            setEditableFieldContent(dialogueField, '', '');
        }

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
        if (!hoveredImageUploadContext) {
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
        applyImageToCard(file, hoveredImageUploadContext);
    });

    updateMultiSelectToggleButton();
    multiSelectPanel.addEventListener('click', (event) => {
        event.stopPropagation();
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
        if (isCopyShortcut(event) && hoveredImageUploadContext) {
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
        if (flushSave) await flushPendingSave();
        await releaseCurrentLock();
        switchToHome({ syncHistory, replaceHistory });
        await refreshProjects();
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
        refreshMultiSelectPanel();
        hideTextColorPalette();
    });
    window.addEventListener('scroll', () => {
        scheduleSyncSceneHeaderInputByViewport();
    }, { passive: true });
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
            if (!editorView.classList.contains('hidden')) {
                scheduleSyncProjectHeaderWidth(false);
                scheduleSyncSceneHeaderInputByViewport();
            }
        }).catch(() => {
            // ignore font readiness failures
        });
    }
    window.addEventListener('beforeunload', () => {
        if (currentProjectId) {
            if (saveTimer) {
                clearTimeout(saveTimer);
                saveTimer = null;
            }
            saveState();
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
