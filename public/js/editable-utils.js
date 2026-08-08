export function escapeHtml(value = '') {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function plainTextToEditableHtml(value = '') {
    return escapeHtml(value).replace(/\n/g, '<br>');
}

export function getEditablePlainText(field) {
    return (field?.textContent || '').replace(/\u00A0/g, ' ');
}

export function getEditableFieldHtml(field) {
    if (!field) {
        return '';
    }
    return field.innerHTML || '';
}

export function cleanupEditableFieldMarkup(field) {
    if (!field) {
        return;
    }
    if (!getEditablePlainText(field).trim()) {
        field.innerHTML = '';
    }
}

export function setEditableFieldContent(field, htmlValue = '', plainValue = '') {
    if (!field) {
        return;
    }

    if (typeof htmlValue === 'string' && htmlValue.trim()) {
        field.innerHTML = htmlValue;
    } else if (typeof plainValue === 'string' && plainValue) {
        field.innerHTML = plainTextToEditableHtml(plainValue);
    } else {
        field.innerHTML = '';
    }
    cleanupEditableFieldMarkup(field);
}

function normalizeClipboardPlainText(value = '') {
    return value.replace(/\r\n?/g, '\n');
}

export function insertPlainTextIntoEditableField(field, text = '') {
    if (!field) {
        return;
    }
    const normalizedText = normalizeClipboardPlainText(text);
    if (normalizedText.length === 0) {
        return;
    }

    field.focus();
    const selection = window.getSelection && window.getSelection();
    if (!selection) {
        return;
    }

    let range = null;
    if (selection.rangeCount > 0) {
        const activeRange = selection.getRangeAt(0);
        if (field.contains(activeRange.commonAncestorContainer)) {
            range = activeRange;
        }
    }

    if (!range) {
        range = document.createRange();
        range.selectNodeContents(field);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    if (typeof document.execCommand === 'function') {
        try {
            const inserted = document.execCommand('insertText', false, normalizedText);
            if (inserted) {
                return;
            }
        } catch {
        }
    }

    range.deleteContents();
    const fragment = document.createDocumentFragment();
    const lines = normalizedText.split('\n');
    let lastInsertedNode = null;

    lines.forEach((line, index) => {
        if (index > 0) {
            const br = document.createElement('br');
            fragment.appendChild(br);
            lastInsertedNode = br;
        }
        if (line) {
            const textNode = document.createTextNode(line);
            fragment.appendChild(textNode);
            lastInsertedNode = textNode;
        }
    });

    if (!lastInsertedNode) {
        lastInsertedNode = document.createTextNode('');
        fragment.appendChild(lastInsertedNode);
    }

    range.insertNode(fragment);
    range.setStartAfter(lastInsertedNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
}

export function isEditableShotField(field) {
    return Boolean(
        field
        && field.classList
        && field.classList.contains('auto-resize-textarea')
        && field.classList.contains('rich-text-input')
    );
}
