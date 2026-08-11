(function () {
    const path = window.location.pathname;
    const editor = /^\/project\/\d+\/?$/.test(path) || /^\/share\/[A-Za-z0-9_-]+\/?$/.test(path);
    document.documentElement.classList.add(editor ? 'preload-view-editor' : 'preload-view-home');
}());
