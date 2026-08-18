import {
    plainTextToEditableHtml,
    sanitizeEditableHtml
} from './editable-utils.js';

const EMPTY_RUNDOWN = Object.freeze({ version: 1, days: [] });

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function randomId(prefix) {
    if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function unique(values) {
    return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function localIsoDate(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function addDays(value, amount) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date();
    date.setDate(date.getDate() + amount);
    return localIsoDate(date);
}

function timeMinutes(value) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''))) return null;
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
}

function durationLabel(startTime, endTime) {
    const start = timeMinutes(startTime);
    const end = timeMinutes(endTime);
    if (start === null || end === null || end <= start) return '';
    const total = end - start;
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    if (!hours) return `${minutes} 分钟`;
    return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

function toChineseSupportLabel(rawValue = '') {
    const value = String(rawValue || '').trim();
    const labels = {
        'Static固定': '三角架',
        'HH手持': '手持',
        'Dolly轨道': '轨道',
        'Gimbal稳定器': '稳定器'
    };
    if (labels[value]) return labels[value];
    const chineseOnly = value.replace(/[A-Za-z\s]/g, '').trim();
    return chineseOnly || value;
}

function normalizeRundown(value) {
    const source = value && typeof value === 'object' ? value : EMPTY_RUNDOWN;
    return {
        version: 1,
        days: Array.isArray(source.days) ? clone(source.days) : []
    };
}

function appendRichTextEntry(entries, plainValue, htmlValue) {
    const text = String(plainValue || '').trim();
    if (!text) return;
    const html = typeof htmlValue === 'string' ? htmlValue.trim() : '';
    if (entries.some((entry) => entry.text === text && entry.html === html)) return;
    entries.push({ text, html });
}

export function buildShotUnits(shots) {
    const units = [];
    const unitsById = new Map();
    let sceneIndex = -1;
    let sceneLabel = '第1场';
    let nextShotNumber = 1;

    (Array.isArray(shots) ? shots : []).forEach((shot) => {
        if (!shot || typeof shot !== 'object') return;
        if (shot.type === 'scene-divider') {
            sceneIndex += 1;
            sceneLabel = String(shot.label || '').trim() || `第${sceneIndex + 1}场`;
            return;
        }
        const shotUnitId = String(shot.shotUnitId || '').trim() || `legacy-${nextShotNumber}-${units.length}`;
        let unit = unitsById.get(shotUnitId);
        if (!unit) {
            unit = {
                id: shotUnitId,
                number: nextShotNumber,
                scene: sceneLabel,
                cards: [],
                colors: [],
                images: [],
                actions: [],
                notes: [],
                actionEntries: [],
                noteEntries: [],
                shotSizes: [],
                cameraMovements: [],
                supports: [],
                vfx: false
            };
            unitsById.set(shotUnitId, unit);
            units.push(unit);
            nextShotNumber += 1;
        }
        unit.cards.push(shot);
        unit.colors = unique([...unit.colors, shot.headerColor]);
        unit.images = unique([...unit.images, shot.hasImage ? shot.imageSrc : '']);
        unit.actions = unique([...unit.actions, shot.action]);
        unit.notes = unique([...unit.notes, shot.dialogue]);
        appendRichTextEntry(unit.actionEntries, shot.action, shot.actionHtml);
        appendRichTextEntry(unit.noteEntries, shot.dialogue, shot.dialogueHtml);
        unit.shotSizes = unique([...unit.shotSizes, shot.shotSize]);
        unit.cameraMovements = unique([...unit.cameraMovements, shot.cameraMovement]);
        unit.supports = unique([...unit.supports, toChineseSupportLabel(shot.move)]);
        unit.vfx = unit.vfx || Boolean(shot.vfx);
    });
    return { units, unitsById };
}

function unitSearchText(unit) {
    return [unit.number, unit.scene, ...unit.actions, ...unit.notes, ...unit.shotSizes, ...unit.cameraMovements, ...unit.supports]
        .join(' ')
        .toLowerCase();
}

function colorSwatches(colors, className = '') {
    return `<span class="rundown-color-swatches ${className}">${(colors.length ? colors : ['#fffdf8'])
        .map((color) => `<i style="--swatch:${escapeHtml(color)}"></i>`).join('')}</span>`;
}

function unitContentSections(unit) {
    const actions = unit.actions.map((value, index) => unit.actions.length > 1 ? `${index + 1}. ${value}` : value).join(' / ');
    const notes = unit.notes.join(' / ');
    return [
        actions ? { type: 'action', text: actions, entries: unit.actionEntries } : null,
        notes ? { type: 'note', text: notes, entries: unit.noteEntries } : null
    ].filter(Boolean);
}

function unitContent(unit) {
    return unitContentSections(unit).map((section) => section.text).join(' · ');
}

function editableHtmlToInlineHtml(value) {
    const sanitized = sanitizeEditableHtml(value);
    const template = document.createElement('template');
    template.innerHTML = sanitized;
    const parts = [];
    let hasVisualOutput = false;
    let lastWasBreak = false;

    function appendBreak() {
        if (hasVisualOutput && !lastWasBreak) parts.push('<br>');
        hasVisualOutput = true;
        lastWasBreak = true;
    }

    function appendNodes(nodes) {
        Array.from(nodes).forEach((node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent || '';
                if (!text) return;
                parts.push(escapeHtml(text));
                hasVisualOutput = true;
                lastWasBreak = false;
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            const tag = node.tagName.toLowerCase();
            if (tag === 'br') {
                appendBreak();
                return;
            }
            if (tag === 'div') appendBreak();
            if (tag === 'span' && node.style?.color) {
                parts.push(`<span style="color:${escapeHtml(node.style.color)}">`);
                appendNodes(node.childNodes);
                parts.push('</span>');
                return;
            }
            appendNodes(node.childNodes);
        });
    }

    appendNodes(template.content.childNodes);
    return parts.join('');
}

function renderRichTextEntry(entry) {
    const richHtml = entry.html ? editableHtmlToInlineHtml(entry.html) : '';
    const visibleRichText = richHtml.replace(/<[^>]*>/g, '').trim();
    return visibleRichText ? richHtml : plainTextToEditableHtml(entry.text);
}

export function unitContentSectionsHtml(unit, renderEntry = renderRichTextEntry) {
    const sections = unitContentSections(unit);
    if (!sections.length) return '—';
    return `<div class="rundown-content-sections">${sections
        .map((section) => {
            const entries = section.entries?.length
                ? section.entries
                : [{ text: section.text, html: '' }];
            const content = entries.map((entry, index) => {
                const prefix = section.type === 'action' && entries.length > 1 ? `${index + 1}. ` : '';
                return `${prefix}${renderEntry(entry)}`;
            }).join(' / ');
            return `<p class="is-${section.type}">${content}</p>`;
        }).join('')}</div>`;
}

function unitParameterRows(unit) {
    return [
        { label: '设备', value: unique(unit.supports).join(' / ') },
        { label: '景别', value: unique(unit.shotSizes).join(' / ') },
        { label: '运镜', value: unique(unit.cameraMovements).join(' / ') },
        { label: 'VFX', value: unit.vfx ? '是' : '否' }
    ].filter((row) => row.value);
}

function unitParametersHtml(unit, className = '') {
    const rows = unitParameterRows(unit);
    if (!rows.length) return '—';
    return `<div class="rundown-parameter-list ${className}">${rows.map((row) => `
        <div><span>${escapeHtml(row.label)}</span><strong>${escapeHtml(row.value)}</strong></div>`).join('')}</div>`;
}

export function createRundownController({
    view,
    printRoot,
    onBack,
    onChange
}) {
    const elements = {
        title: view.querySelector('#rundown-project-title'),
        saveState: view.querySelector('#rundown-save-state'),
        back: view.querySelector('#rundown-back-btn'),
        addDay: view.querySelector('#rundown-add-day-btn'),
        export: view.querySelector('#rundown-export-btn'),
        readonlyBanner: view.querySelector('#rundown-readonly-banner'),
        search: view.querySelector('#rundown-search'),
        sceneFilter: view.querySelector('#rundown-scene-filter'),
        colorFilter: view.querySelector('#rundown-color-filter'),
        colorFilterValue: view.querySelector('#rundown-color-filter-value'),
        colorFilterMenu: view.querySelector('#rundown-color-filter-menu'),
        targetDay: view.querySelector('#rundown-target-day'),
        addFiltered: view.querySelector('#rundown-add-filtered-btn'),
        pool: view.querySelector('#rundown-shot-pool'),
        unscheduledCount: view.querySelector('#rundown-unscheduled-count'),
        summary: view.querySelector('#rundown-summary'),
        validation: view.querySelector('#rundown-validation-summary'),
        days: view.querySelector('#rundown-days'),
        empty: view.querySelector('#rundown-empty')
    };
    let project = null;
    let rundown = normalizeRundown();
    let shotUnits = [];
    let shotUnitsById = new Map();
    let readOnly = true;
    let activeDrag = null;
    let previousDocumentTitle = '';
    let colorFilterOptions = [];

    function applyProjectAspectRatio() {
        const aspect = ['16/9', '4/3', '2.35/1', '9/16'].includes(project?.aspectRatio)
            ? project.aspectRatio
            : '16/9';
        const cssAspect = aspect.replace('/', ' / ');
        view.style.setProperty('--rundown-shot-aspect', cssAspect);
        printRoot.style.setProperty('--rundown-shot-aspect', cssAspect);
    }

    function sortedDays() {
        return [...rundown.days].sort((left, right) => String(left.date || '').localeCompare(String(right.date || '')));
    }

    function scheduledShotIds() {
        return new Set(rundown.days.flatMap((day) => day.items || [])
            .filter((item) => item.type === 'shot')
            .map((item) => item.shotUnitId));
    }

    function filteredUnscheduledUnits() {
        const scheduled = scheduledShotIds();
        const query = elements.search.value.trim().toLowerCase();
        const scene = elements.sceneFilter.value;
        const color = elements.colorFilter.value;
        return shotUnits.filter((unit) => {
            if (scheduled.has(unit.id)) return false;
            if (query && !unitSearchText(unit).includes(query)) return false;
            if (scene && unit.scene !== scene) return false;
            if (color && !unit.colors.includes(color)) return false;
            return true;
        });
    }

    function emitChange() {
        onChange?.(clone(rundown));
        updateSummary();
        updateValidationSummary();
    }

    function findDay(dayId) {
        return rundown.days.find((day) => day.id === dayId) || null;
    }

    function findItem(dayId, itemId) {
        return findDay(dayId)?.items?.find((item) => item.id === itemId) || null;
    }

    function colorFilterDotHtml(color = '') {
        const colorStyle = color ? ` style="--filter-color:${escapeHtml(color)}"` : '';
        return `<span class="rundown-color-filter-dot${color ? '' : ' is-all'}"${colorStyle} aria-hidden="true"></span>`;
    }

    function setColorFilterExpanded(expanded, focusOption = false) {
        elements.colorFilter.setAttribute('aria-expanded', String(expanded));
        elements.colorFilterMenu.hidden = !expanded;
        if (!expanded || !focusOption) return;
        const selectedOption = elements.colorFilterMenu.querySelector('[aria-selected="true"]');
        (selectedOption || elements.colorFilterMenu.querySelector('[role="option"]'))?.focus();
    }

    function syncColorFilterSelection(value) {
        const normalizedValue = colorFilterOptions.includes(value) ? value : '';
        const colorIndex = colorFilterOptions.indexOf(normalizedValue);
        const label = colorIndex >= 0 ? `色组 ${colorIndex + 1}` : '全部颜色';
        elements.colorFilter.value = normalizedValue;
        elements.colorFilterValue.innerHTML = `${colorFilterDotHtml(normalizedValue)}<span>${label}</span>`;
        elements.colorFilterMenu.querySelectorAll('[role="option"]').forEach((option) => {
            option.setAttribute('aria-selected', String(option.dataset.color === normalizedValue));
        });
    }

    function buildFilterOptions() {
        const currentScene = elements.sceneFilter.value;
        const currentColor = elements.colorFilter.value;
        const scenes = unique(shotUnits.map((unit) => unit.scene));
        const colors = unique(shotUnits.flatMap((unit) => unit.colors));
        colorFilterOptions = colors;
        elements.sceneFilter.innerHTML = '<option value="">全部场次</option>' + scenes
            .map((scene) => `<option value="${escapeHtml(scene)}">${escapeHtml(scene)}</option>`).join('');
        elements.colorFilterMenu.innerHTML = `
            <button class="rundown-color-filter-option" type="button" role="option" tabindex="-1" data-color="">
                <span class="rundown-color-filter-option-label">${colorFilterDotHtml()}<span>全部颜色</span></span>
                <span class="rundown-color-filter-check" aria-hidden="true">✓</span>
            </button>` + colors.map((color, index) => `
            <button class="rundown-color-filter-option" type="button" role="option" tabindex="-1" data-color="${escapeHtml(color)}">
                <span class="rundown-color-filter-option-label">${colorFilterDotHtml(color)}<span>色组 ${index + 1}</span></span>
                <span class="rundown-color-filter-check" aria-hidden="true">✓</span>
            </button>`).join('');
        if (scenes.includes(currentScene)) elements.sceneFilter.value = currentScene;
        syncColorFilterSelection(currentColor);
    }

    function renderPool() {
        const allUnscheduledCount = shotUnits.length - scheduledShotIds().size;
        const units = filteredUnscheduledUnits();
        elements.unscheduledCount.textContent = String(allUnscheduledCount);
        elements.pool.innerHTML = units.length ? units.map((unit) => `
            <article class="rundown-pool-card" data-shot-unit-id="${escapeHtml(unit.id)}">
                <span class="rundown-pool-drag" draggable="${readOnly ? 'false' : 'true'}" title="拖入拍摄日">⋮⋮</span>
                <div class="rundown-pool-thumbs">${unit.images.slice(0, 3).map((src) => `<img src="${escapeHtml(src)}" alt="">`).join('') || '<span>无图</span>'}</div>
                <div class="rundown-pool-copy">
                    <strong>${colorSwatches(unit.colors)} SHOT #${unit.number}</strong>
                    <span>${escapeHtml(unit.scene)}</span>
                    <p>${escapeHtml(unitContent(unit) || '暂无动作描述')}</p>
                </div>
                <button class="rundown-pool-add" type="button" ${readOnly ? 'disabled' : ''}>加入</button>
            </article>`).join('') : '<p class="rundown-pool-empty">当前筛选下没有未安排镜头。</p>';
    }

    function renderDayOptions() {
        const days = sortedDays();
        const current = elements.targetDay.value;
        elements.targetDay.innerHTML = days.length
            ? days.map((day) => `<option value="${escapeHtml(day.id)}">${escapeHtml(day.date || '未设置日期')}</option>`).join('')
            : '<option value="">请先添加拍摄日</option>';
        if (days.some((day) => day.id === current)) elements.targetDay.value = current;
    }

    function itemValidation(item) {
        const start = timeMinutes(item.startTime);
        const end = timeMinutes(item.endTime);
        return start === null || end === null || end <= start;
    }

    function overlapItemIds(day) {
        const ids = new Set();
        let previous = null;
        (day.items || []).forEach((item) => {
            const start = timeMinutes(item.startTime);
            const end = timeMinutes(item.endTime);
            if (start === null || end === null || end <= start) return;
            if (previous && (start < previous.end || start < previous.start)) {
                ids.add(item.id);
                ids.add(previous.id);
            }
            previous = { id: item.id, start, end };
        });
        return ids;
    }

    function renderShotCells(unit) {
        if (!unit) return '<td colspan="4" class="rundown-missing-shot">关联镜头已不存在</td>';
        const thumbnails = unit.images.slice(0, 3).map((src) => `<img src="${escapeHtml(src)}" alt="">`).join('') || '<span>无图</span>';
        const multipleImageClass = unit.images.length > 1 ? ' has-multiple' : '';
        return `
            <td class="rundown-shot-cell"><div class="rundown-row-thumbs${multipleImageClass}">${thumbnails}</div></td>
            <td class="rundown-parameters-cell">${unitParametersHtml(unit)}</td>
            <td>${escapeHtml(unit.scene)}</td>
            <td class="rundown-content-cell">${unitContentSectionsHtml(unit)}</td>`;
    }

    function renderItem(day, item, overlapIds) {
        const unit = item.type === 'shot' ? shotUnitsById.get(item.shotUnitId) : null;
        const invalid = itemValidation(item) || (item.type === 'event' && !String(item.title || '').trim());
        const warningClass = invalid ? ' has-error' : (overlapIds.has(item.id) ? ' has-warning' : '');
        const sourceCells = item.type === 'shot' ? renderShotCells(unit) : `
            <td class="rundown-event-cell" colspan="4">
                <input class="rundown-event-title" data-field="title" type="text" maxlength="240" value="${escapeHtml(item.title || '')}" placeholder="集合、布光、转场、午餐…" ${readOnly ? 'disabled' : ''}>
            </td>`;
        const itemLabel = unit
            ? `${colorSwatches(unit.colors)}<strong>SHOT #${unit.number}</strong>`
            : `<strong>${item.type === 'event' ? '事项' : '镜头缺失'}</strong>`;
        return `<tr class="rundown-item-row${warningClass}" data-day-id="${escapeHtml(day.id)}" data-item-id="${escapeHtml(item.id)}">
            <td class="rundown-order-cell">
                <div class="rundown-order-controls">
                    <span class="rundown-item-drag" draggable="${readOnly ? 'false' : 'true'}" title="拖动整行排序">⋮⋮</span>
                </div>
                <div class="rundown-order-label">${itemLabel}</div>
            </td>
            <td class="rundown-time-cell">
                <div class="rundown-time-fields">
                    <input data-field="startTime" type="time" value="${escapeHtml(item.startTime || '')}" ${readOnly ? 'disabled' : ''}>
                    <span>—</span>
                    <input data-field="endTime" type="time" value="${escapeHtml(item.endTime || '')}" ${readOnly ? 'disabled' : ''}>
                </div>
                <small>${escapeHtml(durationLabel(item.startTime, item.endTime) || '请填写有效时段')}</small>
            </td>
            ${sourceCells}
            <td class="rundown-row-actions"><button data-action="remove-item" type="button" title="移出日程" ${readOnly ? 'disabled' : ''}>×</button></td>
        </tr>`;
    }

    function renderDays() {
        const days = sortedDays();
        elements.empty.classList.toggle('hidden', days.length > 0);
        elements.days.innerHTML = days.map((day, dayIndex) => {
            const overlaps = overlapItemIds(day);
            const items = Array.isArray(day.items) ? day.items : [];
            return `<section class="rundown-day-card" data-day-id="${escapeHtml(day.id)}">
                <header class="rundown-day-header">
                    <div><span>DAY ${dayIndex + 1}</span><input class="rundown-day-date" type="date" value="${escapeHtml(day.date || '')}" ${readOnly ? 'disabled' : ''}></div>
                    <div>
                        <span>${items.length} 项</span>
                        <button data-action="add-event" class="secondary-btn compact-btn" type="button" ${readOnly ? 'disabled' : ''}>添加事项</button>
                        <button data-action="delete-day" class="rundown-text-button danger" type="button" ${readOnly ? 'disabled' : ''}>删除拍摄日</button>
                    </div>
                </header>
                <div class="rundown-table-wrap" data-day-dropzone="${escapeHtml(day.id)}">
                    <table class="rundown-table">
                        <thead><tr><th>顺序</th><th>时间</th><th>画面</th><th>镜头参数</th><th>场次</th><th>画面内容 / 动作</th><th></th></tr></thead>
                        <tbody>${items.map((item) => renderItem(day, item, overlaps)).join('')}
                            ${items.length ? '' : '<tr class="rundown-drop-placeholder"><td colspan="7">把镜头拖到这里，或添加一个现场事项</td></tr>'}
                        </tbody>
                    </table>
                </div>
            </section>`;
        }).join('');
    }

    function render() {
        buildFilterOptions();
        renderDayOptions();
        renderPool();
        renderDays();
        updateSummary();
        updateValidationSummary();
        applyReadOnlyState();
    }

    function applyReadOnlyState() {
        view.classList.toggle('is-readonly', readOnly);
        elements.readonlyBanner.classList.toggle('hidden', !readOnly);
        elements.addDay.disabled = readOnly;
        elements.addFiltered.disabled = readOnly;
    }

    function updateSummary() {
        const scheduledItems = rundown.days.reduce((sum, day) => sum + (day.items?.length || 0), 0);
        const scheduledShots = scheduledShotIds().size;
        elements.summary.textContent = scheduledItems
            ? `${rundown.days.length} 个拍摄日 · ${scheduledShots}/${shotUnits.length} 个镜头已安排 · ${scheduledItems - scheduledShots} 个现场事项`
            : '尚未安排拍摄';
    }

    function validationState() {
        const fatal = [];
        let overlapCount = 0;
        const dates = new Set();
        rundown.days.forEach((day, dayIndex) => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date || '')) fatal.push(`DAY ${dayIndex + 1} 缺少日期`);
            if (dates.has(day.date)) fatal.push(`拍摄日期 ${day.date} 重复`);
            dates.add(day.date);
            overlapCount += overlapItemIds(day).size;
            (day.items || []).forEach((item, itemIndex) => {
                if (itemValidation(item)) fatal.push(`${day.date || `DAY ${dayIndex + 1}`} 第 ${itemIndex + 1} 项时间无效`);
                if (item.type === 'event' && !String(item.title || '').trim()) fatal.push(`${day.date || `DAY ${dayIndex + 1}`} 第 ${itemIndex + 1} 项缺少事项名称`);
            });
        });
        return { fatal, overlapCount, unscheduledCount: Math.max(0, shotUnits.length - scheduledShotIds().size) };
    }

    function updateValidationSummary() {
        const state = validationState();
        const messages = [];
        if (state.fatal.length) messages.push(`${state.fatal.length} 项信息需要补全`);
        if (state.overlapCount) messages.push('存在时间重叠或倒序');
        if (state.unscheduledCount) messages.push(`还有 ${state.unscheduledCount} 个镜头未安排`);
        elements.validation.textContent = messages.join(' · ');
        elements.validation.classList.toggle('hidden', messages.length === 0);
        elements.validation.classList.toggle('has-error', state.fatal.length > 0);
    }

    function nextDate() {
        const dates = rundown.days.map((day) => day.date).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort();
        return dates.length ? addDays(dates.at(-1), 1) : localIsoDate();
    }

    function addDay() {
        if (readOnly) return;
        const day = { id: randomId('rundown-day'), date: nextDate(), items: [] };
        rundown.days.push(day);
        emitChange();
        render();
        elements.targetDay.value = day.id;
    }

    function addShotToDay(shotUnitId, dayId, targetIndex = null) {
        if (readOnly || scheduledShotIds().has(shotUnitId)) return;
        const day = findDay(dayId);
        if (!day || !shotUnitsById.has(shotUnitId)) return;
        const item = { id: randomId('rundown-item'), type: 'shot', shotUnitId, startTime: '', endTime: '', setupLabel: '' };
        if (Number.isInteger(targetIndex)) day.items.splice(targetIndex, 0, item);
        else day.items.push(item);
        emitChange();
        render();
    }

    function addEvent(dayId) {
        const day = findDay(dayId);
        if (readOnly || !day) return;
        day.items.push({ id: randomId('rundown-item'), type: 'event', title: '', startTime: '', endTime: '', setupLabel: '' });
        emitChange();
        render();
        view.querySelector(`[data-day-id="${CSS.escape(dayId)}"] .rundown-event-title:last-of-type`)?.focus();
    }

    function removeItem(dayId, itemId) {
        const day = findDay(dayId);
        if (!day) return;
        day.items = day.items.filter((item) => item.id !== itemId);
        emitChange();
        render();
    }

    function moveItem(sourceDayId, itemId, targetDayId, targetIndex) {
        const sourceDay = findDay(sourceDayId);
        const targetDay = findDay(targetDayId);
        if (!sourceDay || !targetDay) return;
        const sourceIndex = sourceDay.items.findIndex((item) => item.id === itemId);
        if (sourceIndex < 0) return;
        const [item] = sourceDay.items.splice(sourceIndex, 1);
        let index = Number.isInteger(targetIndex) ? targetIndex : targetDay.items.length;
        if (sourceDay === targetDay && sourceIndex < index) index -= 1;
        targetDay.items.splice(Math.max(0, index), 0, item);
        emitChange();
        render();
    }

    function dropIndex(event, dayId) {
        const day = findDay(dayId);
        if (!day) return 0;
        const targetRow = event.target.closest('.rundown-item-row');
        if (!targetRow) return day.items.length;
        const index = day.items.findIndex((item) => item.id === targetRow.dataset.itemId);
        if (index < 0) return day.items.length;
        const rect = targetRow.getBoundingClientRect();
        return event.clientY > rect.top + rect.height / 2 ? index + 1 : index;
    }

    function clearDragFeedback() {
        elements.pool.querySelectorAll('.is-dragging').forEach((element) => element.classList.remove('is-dragging'));
        elements.days.querySelectorAll('.is-dragging, .is-drop-before, .is-drop-after, .is-drop-active')
            .forEach((element) => element.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after', 'is-drop-active'));
    }

    function updateDropFeedback(event, dropzone) {
        elements.days.querySelectorAll('.is-drop-before, .is-drop-after, .is-drop-active')
            .forEach((element) => element.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-active'));
        dropzone.closest('.rundown-day-card')?.classList.add('is-drop-active');
        const targetRow = event.target.closest('.rundown-item-row');
        if (!targetRow || targetRow.classList.contains('is-dragging')) return;
        const rect = targetRow.getBoundingClientRect();
        targetRow.classList.add(event.clientY > rect.top + rect.height / 2 ? 'is-drop-after' : 'is-drop-before');
    }

    function refreshDayValidation(dayId) {
        const day = findDay(dayId);
        if (!day) return;
        const overlapIds = overlapItemIds(day);
        elements.days.querySelectorAll(`.rundown-item-row[data-day-id="${CSS.escape(dayId)}"]`).forEach((row) => {
            const item = findItem(dayId, row.dataset.itemId);
            if (!item) return;
            const invalid = itemValidation(item) || (item.type === 'event' && !String(item.title || '').trim());
            row.classList.toggle('has-error', invalid);
            row.classList.toggle('has-warning', !invalid && overlapIds.has(item.id));
        });
    }

    function buildPrintHtml() {
        return sortedDays().map((day, dayIndex) => `
            <section class="rundown-print-day">
                <header><div><span>拍摄计划 · DAY ${dayIndex + 1}</span><h1>${escapeHtml(project?.name || '未命名项目')}</h1></div><div><strong>${escapeHtml(day.date)}</strong><small>${day.items.length} 项</small></div></header>
                <table><thead><tr><th>顺序</th><th>时间</th><th>画面</th><th>镜头参数</th><th>场次</th><th>画面内容 / 动作</th></tr></thead>
                <tbody>${day.items.map((item) => {
                    if (item.type === 'event') return `<tr class="rundown-print-event"><td><b>事项</b></td><td><b>${escapeHtml(item.startTime)}–${escapeHtml(item.endTime)}</b><small>${escapeHtml(durationLabel(item.startTime, item.endTime))}</small></td><td colspan="4">${escapeHtml(item.title)}</td></tr>`;
                    const unit = shotUnitsById.get(item.shotUnitId);
                    if (!unit) return '';
                    const multipleImageClass = unit.images.length > 1 ? ' has-multiple' : '';
                    return `<tr><td>${colorSwatches(unit.colors, 'print')}<b>SHOT #${unit.number}</b></td><td><b>${escapeHtml(item.startTime)}–${escapeHtml(item.endTime)}</b><small>${escapeHtml(durationLabel(item.startTime, item.endTime))}</small></td><td><div class="rundown-print-thumbs${multipleImageClass}">${unit.images.slice(0, 3).map((src) => `<img src="${escapeHtml(src)}" alt="">`).join('') || '<span>无图</span>'}</div></td><td>${unitParametersHtml(unit, 'print')}</td><td>${escapeHtml(unit.scene)}</td><td>${unitContentSectionsHtml(unit)}</td></tr>`;
                }).join('')}</tbody></table>
            </section>`).join('');
    }

    function exportPdf() {
        const itemCount = rundown.days.reduce((sum, day) => sum + (day.items?.length || 0), 0);
        if (!itemCount) return window.alert('请先安排至少一个镜头或现场事项。');
        const validation = validationState();
        if (validation.fatal.length) return window.alert(`请先修正以下信息：\n${validation.fatal.slice(0, 8).join('\n')}`);
        const warnings = [];
        if (validation.unscheduledCount) warnings.push(`还有 ${validation.unscheduledCount} 个镜头未安排`);
        if (validation.overlapCount) warnings.push('日程中存在时间重叠或倒序');
        if (warnings.length && !window.confirm(`${warnings.join('；')}。\n\n仍然导出当前 Rundown 吗？`)) return;
        printRoot.innerHTML = buildPrintHtml();
        printRoot.setAttribute('aria-hidden', 'false');
        let pageStyle = document.getElementById('rundown-print-page-style');
        if (!pageStyle) {
            pageStyle = document.createElement('style');
            pageStyle.id = 'rundown-print-page-style';
            pageStyle.textContent = '@media print { @page { size: A4 landscape; margin: 8mm; } }';
            document.head.appendChild(pageStyle);
        }
        previousDocumentTitle = document.title;
        const dates = sortedDays().map((day) => day.date).filter(Boolean);
        document.title = `${project?.name || '项目'}-Rundown-${dates[0] || ''}${dates.length > 1 ? `-${dates.at(-1)}` : ''}`;
        document.body.classList.add('printing-rundown');
        window.print();
    }

    function finishPrint() {
        if (!document.body.classList.contains('printing-rundown')) return;
        document.body.classList.remove('printing-rundown');
        printRoot.setAttribute('aria-hidden', 'true');
        printRoot.innerHTML = '';
        document.getElementById('rundown-print-page-style')?.remove();
        if (previousDocumentTitle) document.title = previousDocumentTitle;
        previousDocumentTitle = '';
    }

    elements.back.addEventListener('click', () => onBack?.());
    elements.addDay.addEventListener('click', addDay);
    elements.export.addEventListener('click', exportPdf);
    [elements.search, elements.sceneFilter].forEach((control) => control.addEventListener('input', renderPool));
    elements.colorFilter.addEventListener('click', () => {
        const expanded = elements.colorFilter.getAttribute('aria-expanded') === 'true';
        setColorFilterExpanded(!expanded, !expanded);
    });
    elements.colorFilter.addEventListener('keydown', (event) => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault();
        setColorFilterExpanded(true, true);
        if (event.key === 'ArrowUp') elements.colorFilterMenu.querySelector('[role="option"]:last-child')?.focus();
    });
    elements.colorFilterMenu.addEventListener('click', (event) => {
        const option = event.target.closest('[role="option"]');
        if (!option) return;
        syncColorFilterSelection(option.dataset.color || '');
        setColorFilterExpanded(false);
        elements.colorFilter.focus();
        renderPool();
    });
    elements.colorFilterMenu.addEventListener('keydown', (event) => {
        const options = [...elements.colorFilterMenu.querySelectorAll('[role="option"]')];
        const currentIndex = options.indexOf(document.activeElement);
        let nextIndex = null;
        if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % options.length;
        if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + options.length) % options.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = options.length - 1;
        if (nextIndex !== null) {
            event.preventDefault();
            options[nextIndex]?.focus();
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            setColorFilterExpanded(false);
            elements.colorFilter.focus();
        }
        if (event.key === 'Tab') setColorFilterExpanded(false);
    });
    document.addEventListener('click', (event) => {
        if (!event.target.closest('.rundown-color-filter')) setColorFilterExpanded(false);
    });
    elements.addFiltered.addEventListener('click', () => {
        const day = findDay(elements.targetDay.value);
        if (!day) return window.alert('请先添加并选择一个拍摄日。');
        const units = filteredUnscheduledUnits();
        units.forEach((unit) => day.items.push({ id: randomId('rundown-item'), type: 'shot', shotUnitId: unit.id, startTime: '', endTime: '', setupLabel: '' }));
        if (units.length) {
            emitChange();
            render();
        }
    });
    elements.pool.addEventListener('click', (event) => {
        const button = event.target.closest('.rundown-pool-add');
        if (!button) return;
        const card = button.closest('[data-shot-unit-id]');
        addShotToDay(card?.dataset.shotUnitId, elements.targetDay.value);
    });
    elements.pool.addEventListener('dragstart', (event) => {
        const handle = event.target.closest('.rundown-pool-drag');
        if (!handle || readOnly) return event.preventDefault();
        const card = handle.closest('[data-shot-unit-id]');
        activeDrag = { source: 'pool', shotUnitId: card?.dataset.shotUnitId };
        card?.classList.add('is-dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', activeDrag.shotUnitId || 'rundown');
        if (card) event.dataTransfer.setDragImage(card, 24, Math.min(24, card.offsetHeight / 2));
    });
    elements.pool.addEventListener('dragend', () => {
        clearDragFeedback();
        activeDrag = null;
    });
    elements.days.addEventListener('dragstart', (event) => {
        const handle = event.target.closest('.rundown-item-drag');
        if (!handle || readOnly) return event.preventDefault();
        const row = handle.closest('.rundown-item-row');
        activeDrag = { source: 'schedule', dayId: row?.dataset.dayId, itemId: row?.dataset.itemId };
        row?.classList.add('is-dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', activeDrag.itemId || 'rundown');
        if (row) event.dataTransfer.setDragImage(row, 32, Math.min(32, row.offsetHeight / 2));
    });
    elements.days.addEventListener('dragover', (event) => {
        const dropzone = event.target.closest('[data-day-dropzone]');
        if (!activeDrag || !dropzone) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        updateDropFeedback(event, dropzone);
    });
    elements.days.addEventListener('drop', (event) => {
        const dropzone = event.target.closest('[data-day-dropzone]');
        if (!dropzone || !activeDrag || readOnly) return;
        event.preventDefault();
        const targetDayId = dropzone.dataset.dayDropzone;
        const targetIndex = dropIndex(event, targetDayId);
        if (activeDrag.source === 'pool') addShotToDay(activeDrag.shotUnitId, targetDayId, targetIndex);
        else moveItem(activeDrag.dayId, activeDrag.itemId, targetDayId, targetIndex);
        clearDragFeedback();
        activeDrag = null;
    });
    elements.days.addEventListener('dragend', () => {
        clearDragFeedback();
        activeDrag = null;
    });
    elements.days.addEventListener('click', (event) => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (!action || readOnly) return;
        const dayElement = event.target.closest('[data-day-id]');
        const row = event.target.closest('.rundown-item-row');
        const dayId = row?.dataset.dayId || dayElement?.dataset.dayId;
        if (action === 'add-event') addEvent(dayId);
        if (action === 'remove-item') removeItem(dayId, row?.dataset.itemId);
        if (action === 'delete-day') {
            const day = findDay(dayId);
            if (day?.items?.length && !window.confirm('删除这个拍摄日？镜头会回到未安排池，现场事项会被删除。')) return;
            rundown.days = rundown.days.filter((item) => item.id !== dayId);
            emitChange();
            render();
        }
    });
    elements.days.addEventListener('change', (event) => {
        if (readOnly) return;
        const dayElement = event.target.closest('[data-day-id]');
        const row = event.target.closest('.rundown-item-row');
        const dayId = row?.dataset.dayId || dayElement?.dataset.dayId;
        if (event.target.classList.contains('rundown-day-date')) {
            const duplicate = rundown.days.some((day) => day.id !== dayId && day.date === event.target.value);
            if (duplicate) {
                window.alert('每个拍摄日期只能建立一个拍摄日。');
                render();
                return;
            }
            findDay(dayId).date = event.target.value;
            emitChange();
            render();
        }
    });
    elements.days.addEventListener('input', (event) => {
        if (readOnly) return;
        const row = event.target.closest('.rundown-item-row');
        const field = event.target.dataset.field;
        if (!row || !field) return;
        const item = findItem(row.dataset.dayId, row.dataset.itemId);
        if (!item) return;
        item[field] = event.target.value;
        const duration = row.querySelector('.rundown-time-cell small');
        if (duration) duration.textContent = durationLabel(item.startTime, item.endTime) || '请填写有效时段';
        emitChange();
        refreshDayValidation(row.dataset.dayId);
    });
    window.addEventListener('afterprint', finishPrint);

    return {
        open(nextProject, options = {}) {
            project = nextProject;
            applyProjectAspectRatio();
            rundown = normalizeRundown(nextProject?.rundown);
            ({ units: shotUnits, unitsById: shotUnitsById } = buildShotUnits(nextProject?.shots));
            readOnly = Boolean(options.readOnly);
            elements.title.textContent = nextProject?.name || 'Rundown';
            elements.search.value = '';
            elements.sceneFilter.value = '';
            elements.colorFilter.value = '';
            setColorFilterExpanded(false);
            render();
        },
        setReadOnly(value) {
            readOnly = Boolean(value);
            render();
        },
        setSaveState(value) {
            const displayState = value === 'error' ? 'error' : (value === 'saved' ? 'saved' : 'saving');
            elements.saveState.textContent = displayState === 'error'
                ? '保存失败'
                : (displayState === 'saving' ? '保存中…' : '已保存');
            elements.saveState.dataset.state = displayState;
        },
        acceptSavedRundown(value) {
            rundown = normalizeRundown(value);
        },
        refreshProject(nextProject) {
            project = nextProject;
            applyProjectAspectRatio();
            ({ units: shotUnits, unitsById: shotUnitsById } = buildShotUnits(nextProject?.shots));
            render();
        },
        getRundown() {
            return clone(rundown);
        }
    };
}
