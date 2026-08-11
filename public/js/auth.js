import { ApiError, apiRequest, setCsrfToken } from './api.js';

let currentAuth = null;

function setAppViewsHidden(hidden) {
    document.getElementById('home-view')?.classList.toggle('hidden', hidden);
    document.getElementById('editor-view')?.classList.toggle('hidden', hidden);
}

function showLogin(message = '') {
    const authView = document.getElementById('auth-view');
    const form = document.getElementById('login-form');
    const error = document.getElementById('login-error');
    authView.classList.remove('hidden');
    setAppViewsHidden(true);
    error.textContent = message;
    return new Promise((resolve) => {
        const submit = async (event) => {
            event.preventDefault();
            error.textContent = '';
            const submitButton = form.querySelector('button[type="submit"]');
            submitButton.disabled = true;
            try {
                const payload = await apiRequest('/api/auth/login', {
                    method: 'POST',
                    body: JSON.stringify({
                        username: form.elements.username.value,
                        password: form.elements.password.value
                    })
                });
                setCsrfToken(payload.csrfToken);
                authView.classList.add('hidden');
                form.removeEventListener('submit', submit);
                if (window.location.pathname === '/login') {
                    const next = new URLSearchParams(window.location.search).get('next');
                    const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
                    window.history.replaceState(null, '', safeNext);
                }
                resolve({ mode: 'authenticated', ...payload });
            } catch (requestError) {
                error.textContent = requestError.status === 429
                    ? '登录尝试过多，请稍后再试。'
                    : '用户名或密码错误。';
            } finally {
                submitButton.disabled = false;
            }
        };
        form.addEventListener('submit', submit);
        window.setTimeout(() => form.elements.username.focus(), 0);
    });
}

function createDialog(title, { dismissible = true } = {}) {
    const backdrop = document.createElement('div');
    backdrop.className = 'app-dialog-backdrop';
    const dialog = document.createElement('section');
    dialog.className = 'app-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = `<header><h2></h2><button type="button" class="dialog-close" aria-label="关闭">×</button></header><div class="dialog-body"></div>`;
    dialog.querySelector('h2').textContent = title;
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    const close = () => {
        backdrop.remove();
        if (window.location.pathname === '/account' || window.location.pathname === '/admin/accounts') {
            window.history.replaceState(null, '', '/');
        }
    };
    const closeButton = dialog.querySelector('.dialog-close');
    closeButton.classList.toggle('hidden', !dismissible);
    closeButton.addEventListener('click', close);
    backdrop.addEventListener('click', (event) => { if (dismissible && event.target === backdrop) close(); });
    return { backdrop, dialog, body: dialog.querySelector('.dialog-body'), close };
}

async function openAccountDialog() {
    const required = Boolean(currentAuth?.user?.mustChangePassword);
    const { body, close } = createDialog(required ? '首次登录必须修改密码' : '账户与密码', { dismissible: !required });
    body.innerHTML = `
        <p class="dialog-note">当前账户：<strong></strong><span class="connection-mode hidden"> · 局域网 HTTP 模式</span></p>
        <form class="stack-form">
            <label>当前密码<input name="currentPassword" type="password" autocomplete="current-password" required></label>
            <label>新密码<input name="newPassword" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></label>
            <button class="primary-btn" type="submit">修改密码并退出其他会话</button>
            <p class="form-message" aria-live="polite"></p>
        </form>`;
    body.querySelector('strong').textContent = currentAuth.user.displayName || currentAuth.user.username;
    body.querySelector('.connection-mode')?.classList.toggle('hidden', !currentAuth.insecureHttp);
    const form = body.querySelector('form');
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const message = form.querySelector('.form-message');
        try {
            await apiRequest('/api/auth/change-password', {
                method: 'POST',
                body: JSON.stringify({ currentPassword: form.elements.currentPassword.value, newPassword: form.elements.newPassword.value })
            });
            close();
            window.location.assign('/login');
        } catch (error) {
            message.textContent = error.message;
        }
    });
}

async function openAdminDialog() {
    const { body } = createDialog('账户管理');
    body.innerHTML = `
        <form class="stack-form admin-create-form">
            <h3>创建账户</h3>
            <label>用户名<input name="username" pattern="[a-z0-9][a-z0-9._-]{2,31}" required></label>
            <label>显示名称<input name="displayName" maxlength="80"></label>
            <label>临时密码<input name="password" type="password" minlength="12" maxlength="128" required></label>
            <label class="inline-check"><input name="isAdmin" type="checkbox"> 系统管理员</label>
            <button class="primary-btn" type="submit">创建账户</button>
            <p class="form-message" aria-live="polite"></p>
        </form>
        <div class="dialog-divider"></div>
        <div class="admin-user-list"></div>`;
    const list = body.querySelector('.admin-user-list');
    const render = async () => {
        const users = await apiRequest('/api/admin/users');
        list.innerHTML = '<h3>现有账户</h3>';
        users.forEach((user) => {
            const row = document.createElement('div');
            row.className = 'admin-user-row';
            row.innerHTML = `<div><strong></strong><small></small></div><div class="row-actions"></div>`;
            row.querySelector('strong').textContent = user.displayName || user.username;
            row.querySelector('small').textContent = `${user.username} · ${user.isAdmin ? '管理员' : '普通账户'} · ${user.isActive ? '启用' : '停用'} · 拥有 ${user.ownedProjects} 个项目`;
            const actions = row.querySelector('.row-actions');
            const reset = document.createElement('button');
            reset.type = 'button'; reset.className = 'secondary-btn compact-btn'; reset.textContent = '重置密码';
            const resetPassword = document.createElement('input');
            resetPassword.type = 'password'; resetPassword.placeholder = '至少 12 位临时密码'; resetPassword.className = 'compact-input hidden';
            reset.addEventListener('click', async () => {
                if (resetPassword.classList.contains('hidden')) {
                    resetPassword.classList.remove('hidden');
                    resetPassword.focus();
                    return;
                }
                const password = resetPassword.value;
                if (!password) return;
                try {
                    await apiRequest(`/api/admin/users/${user.id}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) });
                    resetPassword.value = '';
                    resetPassword.classList.add('hidden');
                    alert('密码已重置，用户下次登录必须改密。');
                } catch (error) { alert(error.message); }
            });
            actions.append(resetPassword, reset);
            if (user.id !== currentAuth.user.id) {
                const toggle = document.createElement('button');
                toggle.type = 'button'; toggle.className = 'secondary-btn compact-btn'; toggle.textContent = user.isActive ? '停用' : '启用';
                toggle.addEventListener('click', async () => {
                    try {
                        await apiRequest(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !user.isActive }) });
                        await render();
                    } catch (error) { alert(error.message); }
                });
                actions.appendChild(toggle);
            }
            list.appendChild(row);
        });
    };
    const form = body.querySelector('.admin-create-form');
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const message = form.querySelector('.form-message');
        try {
            await apiRequest('/api/admin/users', {
                method: 'POST',
                body: JSON.stringify({
                    username: form.elements.username.value,
                    displayName: form.elements.displayName.value,
                    password: form.elements.password.value,
                    isAdmin: form.elements.isAdmin.checked
                })
            });
            form.reset(); message.textContent = '账户已创建。'; await render();
        } catch (error) { message.textContent = error.message; }
    });
    try { await render(); } catch (error) { list.textContent = error.message; }
}

function configureAccountControls(auth) {
    currentAuth = auth;
    const accountName = document.getElementById('account-name');
    if (accountName) accountName.textContent = auth.user.displayName || auth.user.username;
    document.getElementById('account-btn')?.addEventListener('click', () => {
        window.history.pushState(null, '', '/account');
        openAccountDialog();
    });
    const adminButton = document.getElementById('admin-accounts-btn');
    if (adminButton) {
        adminButton.classList.toggle('hidden', !auth.user.isAdmin);
        adminButton.addEventListener('click', () => {
            window.history.pushState(null, '', '/admin/accounts');
            openAdminDialog();
        });
    }
    document.getElementById('logout-btn')?.addEventListener('click', async () => {
        window.dispatchEvent(new CustomEvent('storyboard-before-logout'));
        await new Promise((resolve) => window.setTimeout(resolve, 80));
        try { await apiRequest('/api/auth/logout', { method: 'POST' }); } catch { /* session may already be gone */ }
        setCsrfToken('');
        window.location.assign('/login');
    });
    if (window.location.pathname === '/account') window.setTimeout(openAccountDialog, 0);
    if (window.location.pathname === '/admin/accounts' && auth.user.isAdmin) window.setTimeout(openAdminDialog, 0);
}

export async function bootstrapAccess() {
    if (/^\/share\/[A-Za-z0-9_-]+\/?$/.test(window.location.pathname)) {
        try {
            const project = await apiRequest('/api/share/project');
            document.getElementById('auth-view')?.classList.add('hidden');
            return { mode: 'share', project };
        } catch {
            const authView = document.getElementById('auth-view');
            authView.classList.remove('hidden');
            setAppViewsHidden(true);
            authView.innerHTML = '<section class="auth-card"><h1>分享链接不可用</h1><p>链接可能已过期或被撤销。</p></section>';
            return null;
        }
    }

    try {
        const auth = await apiRequest('/api/auth/session');
        setCsrfToken(auth.csrfToken);
        document.getElementById('auth-view')?.classList.add('hidden');
        configureAccountControls(auth);
        if (auth.user.mustChangePassword) {
            setAppViewsHidden(true);
            window.setTimeout(openAccountDialog, 0);
            return null;
        }
        return { mode: 'authenticated', ...auth };
    } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
        const auth = await showLogin();
        configureAccountControls(auth);
        if (auth.user.mustChangePassword) {
            setAppViewsHidden(true);
            window.setTimeout(openAccountDialog, 0);
            return null;
        }
        return auth;
    }
}

window.addEventListener('storyboard-session-expired', () => {
    if (window.location.pathname.startsWith('/share/') || window.location.pathname === '/login') return;
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/login?next=${encodeURIComponent(next)}`);
});
