import { ApiError, apiRequest, setCsrfToken } from './api.js';

let currentAuth = null;

function setAppViewsHidden(hidden) {
    document.getElementById('home-view')?.classList.toggle('hidden', hidden);
    document.getElementById('editor-view')?.classList.toggle('hidden', hidden);
}

async function showLogin(message = '') {
    const authView = document.getElementById('auth-view');
    const loginForm = document.getElementById('login-form');
    const registrationForm = document.getElementById('registration-form');
    const loginError = document.getElementById('login-error');
    const registrationError = document.getElementById('registration-error');
    const title = document.getElementById('auth-title');
    const description = document.getElementById('auth-description');
    const switcher = document.getElementById('auth-switch');
    const switchLabel = switcher.querySelector('span');
    const showRegistrationButton = document.getElementById('show-registration-btn');
    const showLoginButton = document.getElementById('show-login-btn');
    authView.classList.remove('hidden');
    setAppViewsHidden(true);
    loginError.textContent = message;

    let registrationEnabled = false;
    try {
        const config = await apiRequest('/api/auth/config');
        registrationEnabled = Boolean(config.registrationEnabled);
    } catch {
        // Keep login available if public auth configuration cannot be loaded.
    }
    switcher.classList.toggle('hidden', !registrationEnabled);

    return new Promise((resolve) => {
        const setMode = (mode) => {
            const registering = mode === 'registration' && registrationEnabled;
            loginForm.classList.toggle('hidden', registering);
            registrationForm.classList.toggle('hidden', !registering);
            showRegistrationButton.classList.toggle('hidden', registering);
            showLoginButton.classList.toggle('hidden', !registering);
            switchLabel.textContent = registering ? '已经有账户？' : '还没有账户？';
            title.textContent = registering ? '创建卡片分镜账户' : '登录卡片分镜';
            description.textContent = registering
                ? '创建一个普通账户，开始整理自己的分镜本。'
                : '登录已有账户，继续整理你的分镜本。';
            loginError.textContent = registering ? '' : loginError.textContent;
            registrationError.textContent = '';
            window.setTimeout(() => (registering ? registrationForm : loginForm).elements.username.focus(), 0);
        };

        const completeAuthentication = (payload) => {
            setCsrfToken(payload.csrfToken);
            authView.classList.add('hidden');
            loginForm.removeEventListener('submit', submitLogin);
            registrationForm.removeEventListener('submit', submitRegistration);
            showRegistrationButton.removeEventListener('click', showRegistration);
            showLoginButton.removeEventListener('click', showLogin);
            if (window.location.pathname === '/login') {
                const next = new URLSearchParams(window.location.search).get('next');
                const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
                window.history.replaceState(null, '', safeNext);
            }
            resolve({ mode: 'authenticated', ...payload });
        };

        const submitLogin = async (event) => {
            event.preventDefault();
            loginError.textContent = '';
            const submitButton = loginForm.querySelector('button[type="submit"]');
            submitButton.disabled = true;
            try {
                const payload = await apiRequest('/api/auth/login', {
                    method: 'POST',
                    body: JSON.stringify({
                        username: loginForm.elements.username.value,
                        password: loginForm.elements.password.value
                    })
                });
                completeAuthentication(payload);
            } catch (requestError) {
                loginError.textContent = requestError.status === 429
                    ? '登录尝试过多，请稍后再试。'
                    : '用户名或密码错误。';
            } finally {
                submitButton.disabled = false;
            }
        };

        const submitRegistration = async (event) => {
            event.preventDefault();
            registrationError.textContent = '';
            if (registrationForm.elements.password.value !== registrationForm.elements.confirmPassword.value) {
                registrationError.textContent = '两次输入的密码不一致。';
                return;
            }
            const submitButton = registrationForm.querySelector('button[type="submit"]');
            submitButton.disabled = true;
            try {
                const payload = await apiRequest('/api/auth/register', {
                    method: 'POST',
                    body: JSON.stringify({
                        username: registrationForm.elements.username.value,
                        displayName: registrationForm.elements.displayName.value,
                        password: registrationForm.elements.password.value
                    })
                });
                completeAuthentication(payload);
            } catch (requestError) {
                const messages = {
                    account_unavailable: '这个用户名已被使用，请换一个。',
                    invalid_username: '用户名格式不正确。',
                    invalid_display_name: '请输入 1–80 个字符的显示名称。',
                    invalid_password: '密码需包含 12–128 个字符。',
                    registration_rate_limited: '注册尝试过多，请稍后再试。',
                    registration_disabled: '当前已关闭自助注册。'
                };
                registrationError.textContent = messages[requestError.code] || '账户创建失败，请稍后再试。';
                if (requestError.code === 'registration_disabled') {
                    registrationEnabled = false;
                    switcher.classList.add('hidden');
                    setMode('login');
                    loginError.textContent = messages.registration_disabled;
                }
            } finally {
                submitButton.disabled = false;
            }
        };

        const showRegistration = () => setMode('registration');
        const showLogin = () => setMode('login');
        loginForm.addEventListener('submit', submitLogin);
        registrationForm.addEventListener('submit', submitRegistration);
        showRegistrationButton.addEventListener('click', showRegistration);
        showLoginButton.addEventListener('click', showLogin);
        setMode('login');
    });
}

function createDialog(title, { dismissible = true, resetRouteOnClose = true } = {}) {
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
        if (resetRouteOnClose && (window.location.pathname === '/account' || window.location.pathname === '/admin/accounts')) {
            window.history.replaceState(null, '', '/');
        }
    };
    const closeButton = dialog.querySelector('.dialog-close');
    closeButton.classList.toggle('hidden', !dismissible);
    closeButton.addEventListener('click', close);
    backdrop.addEventListener('click', (event) => { if (dismissible && event.target === backdrop) close(); });
    return { backdrop, dialog, body: dialog.querySelector('.dialog-body'), close };
}

function openEditUserDialog(user, onSaved) {
    const { body, close } = createDialog('编辑账户资料', { resetRouteOnClose: false });
    body.innerHTML = `
        <form class="stack-form">
            <label>用户名<input name="username" pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,31}" autocomplete="off" required></label>
            <label>显示名称<input name="displayName" maxlength="80"></label>
            <p class="dialog-note">用户名会统一保存为小写。更改用户名后，此账户的所有现有会话会立即退出。</p>
            <button class="primary-btn" type="submit">保存资料</button>
            <p class="form-message" aria-live="polite"></p>
        </form>`;
    const form = body.querySelector('form');
    form.elements.username.value = user.username;
    form.elements.displayName.value = user.displayName || '';
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const message = form.querySelector('.form-message');
        const submitButton = form.querySelector('button[type="submit"]');
        const normalizedUsername = form.elements.username.value.trim().toLowerCase();
        if (normalizedUsername !== user.username && !window.confirm(`确认将用户名 ${user.username} 改为 ${normalizedUsername}？该账户当前登录会立即失效。`)) return;
        submitButton.disabled = true;
        message.textContent = '';
        try {
            await apiRequest(`/api/admin/users/${user.id}`, {
                method: 'PATCH',
                body: JSON.stringify({
                    username: form.elements.username.value,
                    displayName: form.elements.displayName.value
                })
            });
        } catch (error) {
            message.textContent = error.message;
            submitButton.disabled = false;
            return;
        }
        close();
        try { await onSaved(); } catch (error) { window.alert(error.message); }
    });
    window.setTimeout(() => form.elements.username.focus(), 0);
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
            <p class="dialog-note">临时密码固定为 <strong>123456</strong>，用户首次登录时必须修改。</p>
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
            reset.type = 'button'; reset.className = 'secondary-btn compact-btn'; reset.textContent = '重制密码';
            reset.addEventListener('click', async () => {
                if (!window.confirm(`确认将 ${user.username} 的临时密码重置为 123456？`)) return;
                try {
                    await apiRequest(`/api/admin/users/${user.id}/reset-password`, { method: 'POST', body: JSON.stringify({}) });
                    alert('临时密码已重置为 123456，用户下次登录必须改密。');
                } catch (error) { alert(error.message); }
            });
            actions.append(reset);
            if (user.id !== currentAuth.user.id) {
                const edit = document.createElement('button');
                edit.type = 'button'; edit.className = 'secondary-btn compact-btn'; edit.textContent = '编辑资料';
                edit.addEventListener('click', () => openEditUserDialog(user, render));
                actions.prepend(edit);
                const deleteButton = document.createElement('button');
                deleteButton.type = 'button'; deleteButton.className = 'danger-btn compact-btn'; deleteButton.textContent = '删除';
                deleteButton.addEventListener('click', async () => {
                    const projectMessage = user.ownedProjects > 0
                        ? `其拥有的 ${user.ownedProjects} 个项目将全部移交给 admin。`
                        : '该账户没有拥有的项目。';
                    if (!window.confirm(`确认永久删除账户 ${user.displayName || user.username}（${user.username}）？\n\n${projectMessage}\n账户及其登录权限将被删除，此操作无法撤销。`)) return;
                    try {
                        await apiRequest(`/api/admin/users/${user.id}`, { method: 'DELETE' });
                        await render();
                    } catch (error) { alert(error.message); }
                });
                actions.appendChild(deleteButton);
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
                    displayName: form.elements.displayName.value
                })
            });
            form.reset(); message.textContent = '账户已创建，临时密码为 123456。'; await render();
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
        if (typeof window.storyboardPrepareForExit === 'function') {
            const canExit = await window.storyboardPrepareForExit();
            if (!canExit) return;
        }
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
