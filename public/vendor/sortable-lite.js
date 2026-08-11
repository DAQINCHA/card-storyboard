(function (global) {
    class SortableLite {
        constructor(container, options = {}) {
            this.container = container;
            this.options = { ...options };
            this.dragged = null;
            this.refresh = this.refresh.bind(this);
            this.onDragStart = this.onDragStart.bind(this);
            this.onDragOver = this.onDragOver.bind(this);
            this.onDragEnd = this.onDragEnd.bind(this);
            this.onPointerDown = this.onPointerDown.bind(this);
            this.observer = new MutationObserver(this.refresh);
            this.observer.observe(container, { childList: true });
            container.addEventListener('dragstart', this.onDragStart);
            container.addEventListener('pointerdown', this.onPointerDown);
            container.addEventListener('dragover', this.onDragOver);
            container.addEventListener('dragend', this.onDragEnd);
            this.refresh();
        }

        matches(item) {
            return item instanceof Element && item.matches(this.options.draggable || '*');
        }

        refresh() {
            Array.from(this.container.children).forEach((item) => {
                if (this.matches(item)) item.draggable = !this.options.disabled;
            });
        }

        option(name, value) {
            if (value === undefined) return this.options[name];
            this.options[name] = value;
            this.refresh();
        }

        onPointerDown(event) {
            this.pointerTarget = event.target;
        }

        onDragStart(event) {
            if (this.options.disabled) return event.preventDefault();
            const item = event.target.closest(this.options.draggable || '*');
            if (!item || item.parentElement !== this.container) return;
            const handle = this.options.handle;
            if (handle && !this.pointerTarget?.closest(handle)) return event.preventDefault();
            this.dragged = item;
            this.oldIndex = Array.from(this.container.children).indexOf(item);
            item.classList.add(this.options.chosenClass || 'sortable-chosen', this.options.dragClass || 'sortable-drag');
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', 'move');
            this.options.onStart?.({ item, oldIndex: this.oldIndex });
        }

        onDragOver(event) {
            if (!this.dragged) return;
            event.preventDefault();
            const target = event.target.closest(this.options.draggable || '*');
            if (!target || target === this.dragged || target.parentElement !== this.container) return;
            const rect = target.getBoundingClientRect();
            const before = event.clientY < rect.top + rect.height / 2 || event.clientX < rect.left + rect.width / 2;
            this.container.insertBefore(this.dragged, before ? target : target.nextSibling);
        }

        onDragEnd() {
            if (!this.dragged) return;
            const item = this.dragged;
            item.classList.remove(this.options.chosenClass || 'sortable-chosen', this.options.dragClass || 'sortable-drag');
            const newIndex = Array.from(this.container.children).indexOf(item);
            this.dragged = null;
            this.options.onEnd?.({ item, oldIndex: this.oldIndex, newIndex });
        }
    }
    global.Sortable = SortableLite;
}(window));
