function defaultClone(value) {
    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

function defaultSerialize(value) {
    return JSON.stringify(value);
}

export function createProjectHistory(options = {}) {
    const maxDepth = Math.max(1, Number(options.maxDepth) || 50);
    const mergeWindowMs = Math.max(0, Number(options.mergeWindowMs ?? 650));
    const clone = typeof options.clone === 'function' ? options.clone : defaultClone;
    const serialize = typeof options.serialize === 'function' ? options.serialize : defaultSerialize;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;

    let past = [];
    let present = null;
    let future = [];
    let sealed = false;
    let transactionDepth = 0;
    let pendingTransactionMeta = null;

    function notify() {
        onChange?.(getState());
    }

    function createEntry(snapshot, meta = {}) {
        const cloned = clone(snapshot);
        return {
            snapshot: cloned,
            signature: serialize(cloned),
            label: String(meta.label || '修改').trim() || '修改',
            view: meta.view === 'rundown' ? 'rundown' : (meta.view === 'initial' ? 'initial' : 'editor'),
            mergeKey: typeof meta.mergeKey === 'string' && meta.mergeKey ? meta.mergeKey : null,
            timestamp: now()
        };
    }

    function canUndo(activeView = 'editor') {
        if (!present || past.length === 0) {
            return false;
        }
        if (activeView === 'rundown') {
            return present.view === 'rundown';
        }
        return true;
    }

    function canRedo(activeView = 'editor') {
        if (future.length === 0) {
            return false;
        }
        const nextEntry = future[future.length - 1];
        if (activeView === 'rundown') {
            return nextEntry.view === 'rundown';
        }
        return true;
    }

    function getUndoEntry(activeView = 'editor') {
        if (!canUndo(activeView)) {
            return null;
        }
        return present;
    }

    function getRedoEntry(activeView = 'editor') {
        if (!canRedo(activeView)) {
            return null;
        }
        return future[future.length - 1];
    }

    function getState(activeView = 'editor') {
        const undoEntry = getUndoEntry(activeView);
        const redoEntry = getRedoEntry(activeView);
        return {
            pastLength: past.length,
            futureLength: future.length,
            canUndo: Boolean(undoEntry),
            canRedo: Boolean(redoEntry),
            undoLabel: undoEntry ? undoEntry.label : '',
            undoView: undoEntry ? undoEntry.view : '',
            redoLabel: redoEntry ? redoEntry.label : '',
            redoView: redoEntry ? redoEntry.view : ''
        };
    }

    function reset(initialSnapshot, meta = {}) {
        past = [];
        future = [];
        sealed = true;
        transactionDepth = 0;
        pendingTransactionMeta = null;
        present = initialSnapshot == null
            ? null
            : createEntry(initialSnapshot, { label: meta.label || '初始状态', view: 'initial', mergeKey: null });
        notify();
    }

    function clear() {
        past = [];
        present = null;
        future = [];
        sealed = true;
        transactionDepth = 0;
        pendingTransactionMeta = null;
        notify();
    }

    function seal() {
        sealed = true;
    }

    function commit(snapshot, meta = {}) {
        if (snapshot == null) {
            return false;
        }
        if (!present) {
            reset(snapshot);
            return true;
        }

        const nextEntry = createEntry(snapshot, meta);
        if (nextEntry.signature === present.signature) {
            return false;
        }

        const shouldMerge = Boolean(
            !sealed
            && !meta.immediate
            && nextEntry.mergeKey
            && present.mergeKey === nextEntry.mergeKey
            && present.view === nextEntry.view
            && past.length > 0
            && (nextEntry.timestamp - present.timestamp) <= mergeWindowMs
        );

        if (shouldMerge) {
            const baseEntry = past[past.length - 1];
            if (baseEntry && baseEntry.signature === nextEntry.signature) {
                present = past.pop();
                future = [];
                sealed = true;
                notify();
                return true;
            }
            present = {
                ...nextEntry,
                label: nextEntry.label || present.label
            };
            future = [];
            notify();
            return true;
        }

        past.push(present);
        if (past.length > maxDepth) {
            past.splice(0, past.length - maxDepth);
        }
        present = nextEntry;
        future = [];
        sealed = Boolean(meta.immediate || !nextEntry.mergeKey);
        notify();
        return true;
    }

    function record(snapshot, meta = {}) {
        if (transactionDepth > 0) {
            if (!pendingTransactionMeta && meta) {
                pendingTransactionMeta = { ...meta };
            }
            return false;
        }
        return commit(snapshot, meta);
    }

    function beginTransaction(meta = {}) {
        if (transactionDepth === 0) {
            pendingTransactionMeta = { ...meta, immediate: true, mergeKey: null };
        }
        transactionDepth += 1;
    }

    function endTransaction(snapshotProvider, overrideMeta = null) {
        if (transactionDepth === 0) {
            return false;
        }
        transactionDepth -= 1;
        if (transactionDepth > 0) {
            return false;
        }
        const meta = {
            ...(pendingTransactionMeta || {}),
            ...(overrideMeta || {}),
            immediate: true,
            mergeKey: null
        };
        pendingTransactionMeta = null;
        const snapshot = typeof snapshotProvider === 'function' ? snapshotProvider() : snapshotProvider;
        return commit(snapshot, meta);
    }

    function runTransaction(meta, action, snapshotProvider) {
        beginTransaction(meta);
        try {
            return action();
        } finally {
            endTransaction(snapshotProvider, meta);
        }
    }

    function undo(activeView = 'editor') {
        if (!canUndo(activeView)) {
            return null;
        }
        const undoneEntry = present;
        const previousEntry = past.pop();
        future.push(undoneEntry);
        present = previousEntry;
        sealed = true;
        notify();
        return {
            snapshot: clone(present.snapshot),
            label: undoneEntry.label,
            view: undoneEntry.view
        };
    }

    function redo(activeView = 'editor') {
        if (!canRedo(activeView)) {
            return null;
        }
        const redoneEntry = future.pop();
        past.push(present);
        if (past.length > maxDepth) {
            past.splice(0, past.length - maxDepth);
        }
        present = redoneEntry;
        sealed = true;
        notify();
        return {
            snapshot: clone(present.snapshot),
            label: redoneEntry.label,
            view: redoneEntry.view
        };
    }

    return {
        reset,
        clear,
        seal,
        record,
        beginTransaction,
        endTransaction,
        runTransaction,
        undo,
        redo,
        canUndo,
        canRedo,
        getState,
        isInTransaction: () => transactionDepth > 0
    };
}
