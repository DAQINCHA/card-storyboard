import { apiRequest } from './api.js';

const ROLE_LABELS = Object.freeze({
    owner: '所有者',
    editor: '可编辑',
    viewer: '仅查看'
});

async function copyText(text) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }
    const input = document.createElement('textarea');
    input.value = text;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    try {
        if (!document.execCommand('copy')) throw new Error('复制失败，请手动复制链接');
    } finally {
        input.remove();
    }
}

function createSharingDialog(project) {
    const backdrop = document.createElement('div');
    backdrop.className = 'app-dialog-backdrop';
    backdrop.innerHTML = `
        <section class="app-dialog share-dialog" role="dialog" aria-modal="true">
            <header><h2>成员与分享</h2><button type="button" class="dialog-close" aria-label="关闭">×</button></header>
            <div class="dialog-body">
                <section><h3>项目成员</h3><form class="member-form inline-form"><input name="username" placeholder="准确用户名" required><select name="role"><option value="editor">可编辑</option><option value="viewer">仅查看</option></select><button class="primary-btn" type="submit">添加或更新</button></form><div class="member-list"></div></section>
                <div class="dialog-divider"></div>
                <section><h3>匿名只读链接</h3><form class="link-form inline-form"><input name="label" placeholder="链接备注"><select name="days"><option value="1">1 天</option><option value="7" selected>7 天</option><option value="30">30 天</option><option value="90">90 天</option><option value="never">永不过期</option></select><button class="primary-btn" type="submit">创建链接</button></form><p class="new-link-output"></p><div class="link-list"></div></section>
                <div class="dialog-divider"></div>
                <section><h3>转移所有权</h3><form class="transfer-form inline-form"><input name="username" placeholder="新所有者用户名" required><input name="password" type="password" placeholder="当前密码" required><button class="danger-btn" type="submit">转移</button></form></section>
                <p class="form-message" aria-live="polite"></p>
            </div>
        </section>`;
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.querySelector('.dialog-close').addEventListener('click', close);
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
    return { backdrop, close };
}

export async function openSharingDialog(project) {
    const { backdrop, close } = createSharingDialog(project);
    const message = backdrop.querySelector('.form-message');
    const renderMembers = async () => {
        const members = await apiRequest(`/api/projects/${project.id}/members`);
        const list = backdrop.querySelector('.member-list'); list.innerHTML = '';
        members.forEach((member) => {
            const row = document.createElement('div'); row.className = 'member-row';
            row.innerHTML = '<div><strong></strong><small></small></div><div class="row-actions"></div>';
            row.querySelector('strong').textContent = member.displayName || member.username;
            row.querySelector('small').textContent = `${member.username} · ${ROLE_LABELS[member.role] || member.role}`;
            if (member.role !== 'owner') {
                const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary-btn compact-btn'; remove.textContent = '移除';
                remove.addEventListener('click', async () => { await apiRequest(`/api/projects/${project.id}/members/${member.id}`, { method: 'DELETE' }); await renderMembers(); });
                row.querySelector('.row-actions').appendChild(remove);
            }
            list.appendChild(row);
        });
    };
    const renderLinks = async () => {
        const links = await apiRequest(`/api/projects/${project.id}/share-links`);
        const list = backdrop.querySelector('.link-list'); list.innerHTML = '';
        links.forEach((link) => {
            const row = document.createElement('div'); row.className = 'member-row';
            const state = link.revokedAt ? '已撤销' : (link.expiresAt && link.expiresAt <= Date.now() ? '已过期' : '有效');
            row.innerHTML = '<div><strong></strong><small></small></div><div class="row-actions"></div>';
            row.querySelector('strong').textContent = link.label || `链接 #${link.displayNumber}`;
            row.querySelector('small').textContent = `${state} · ${link.expiresAt ? new Date(link.expiresAt).toLocaleString() : '永不过期'}`;
            const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'secondary-btn compact-btn'; copy.textContent = '复制';
            copy.addEventListener('click', async () => {
                try {
                    await copyText(`${window.location.origin}/share/${link.token}`);
                    message.textContent = `链接 #${link.displayNumber} 已复制`;
                } catch (error) { message.textContent = error.message; }
            });
            row.querySelector('.row-actions').appendChild(copy);
            if (!link.revokedAt) {
                const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'secondary-btn compact-btn'; revoke.textContent = '撤销';
                revoke.addEventListener('click', async () => { await apiRequest(`/api/projects/${project.id}/share-links/${link.id}`, { method: 'DELETE' }); await renderLinks(); });
                row.querySelector('.row-actions').appendChild(revoke);
            }
            list.appendChild(row);
        });
    };
    backdrop.querySelector('.member-form').addEventListener('submit', async (event) => {
        event.preventDefault(); const form = event.currentTarget;
        try { await apiRequest(`/api/projects/${project.id}/members`, { method: 'POST', body: JSON.stringify({ username: form.elements.username.value, role: form.elements.role.value }) }); form.reset(); await renderMembers(); }
        catch (error) { message.textContent = error.message; }
    });
    backdrop.querySelector('.link-form').addEventListener('submit', async (event) => {
        event.preventDefault(); const form = event.currentTarget; const days = form.elements.days.value;
        const expiresAt = days === 'never' ? null : Date.now() + Number(days) * 24 * 60 * 60 * 1000;
        try {
            const link = await apiRequest(`/api/projects/${project.id}/share-links`, { method: 'POST', body: JSON.stringify({ label: form.elements.label.value, expiresAt }) });
            const url = `${window.location.origin}/share/${link.token}`;
            const output = backdrop.querySelector('.new-link-output'); output.textContent = '链接已创建，可随时从下方列表复制。';
            await copyText(url).catch(() => {}); await renderLinks();
        } catch (error) { message.textContent = error.message; }
    });
    backdrop.querySelector('.transfer-form').addEventListener('submit', async (event) => {
        event.preventDefault(); const form = event.currentTarget;
        if (!window.confirm('确认转移所有权？转移后你将变为可编辑成员。')) return;
        try { await apiRequest(`/api/projects/${project.id}/transfer`, { method: 'POST', body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value }) }); close(); window.location.reload(); }
        catch (error) { message.textContent = error.message; }
    });
    try { await Promise.all([renderMembers(), renderLinks()]); } catch (error) { message.textContent = error.message; }
}
