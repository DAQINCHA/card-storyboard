const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createStoryboardApplication, setupDatabase } = require('../server.js');
const { collectDataFingerprint, openDatabase, restoreDatabase } = require('../server/schema.js');
const { hashPassword } = require('../server/security.js');

const projectRoot = path.dirname(__dirname);
const TEST_ORIGIN = 'http://storyboard.test';
const TEST_PASSWORD = 'correct horse battery staple';
const TEST_PASSWORD_PARAMS = { N: 1024, r: 8, p: 1, maxmem: 16 * 1024 * 1024 };

function createLegacyTestDatabase(databasePath) {
  const db = openDatabase(databasePath);
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '未命名项目',
      scene TEXT NOT NULL DEFAULT '',
      aspect_ratio TEXT NOT NULL DEFAULT '16/9',
      shots_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE project_images (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      image_id TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      image_data BLOB NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, image_id)
    );
    CREATE INDEX project_images_project_id_idx ON project_images(project_id);
    PRAGMA user_version = 0;
  `);
  const insertProject = db.prepare('INSERT INTO projects (id, name, scene, aspect_ratio, shots_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (let id = 1; id <= 4; id += 1) {
    insertProject.run(id, `Legacy project ${id}`, `Scene ${id}`, '16/9', '[]', '2026-01-01 12:00:00');
  }
  db.prepare('INSERT INTO project_images (project_id, image_id, mime_type, image_data, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(1, 'legacy-image', 'image/png', Buffer.from('legacy-image-bytes'), '2026-01-01 12:00:00');
  db.close();
}

async function initialize(databasePath) {
  const passwordHash = await hashPassword(TEST_PASSWORD, TEST_PASSWORD_PARAMS);
  return setupDatabase({ databasePath, username: 'admin', displayName: 'Administrator', passwordHash });
}

async function withServer(run, databaseInitializer = initialize) {
  const directory = mkdtempSync(path.join(tmpdir(), 'card-storyboard-http-'));
  const databasePath = path.join(directory, 'storyboard.db');
  await databaseInitializer(databasePath);
  const application = createStoryboardApplication({
    databasePath,
    publicDir: path.join(projectRoot, 'public'),
    publicOrigin: TEST_ORIGIN,
    allowedOrigins: [TEST_ORIGIN],
    allowedHosts: ['127.0.0.1'],
    passwordParams: TEST_PASSWORD_PARAMS
  });
  await new Promise((resolve) => application.server.listen(0, '127.0.0.1', resolve));
  const address = application.server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`, databasePath, application);
  } finally {
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function login(baseUrl, username = 'admin', password = TEST_PASSWORD) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
    body: JSON.stringify({ username, password })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  const setCookie = response.headers.get('set-cookie');
  const cookie = setCookie.split(';', 1)[0];
  return { cookie, setCookie, csrf: payload.csrfToken, user: payload.user };
}

function api(baseUrl, session, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (session) headers.Cookie = session.cookie;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (session && !['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase())) {
    headers.Origin = TEST_ORIGIN;
    headers['X-CSRF-Token'] = session.csrf;
  }
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
  });
}

async function createAccount(baseUrl, admin, username, password = TEST_PASSWORD) {
  const response = await api(baseUrl, admin, '/api/admin/users', {
    method: 'POST', body: { username, displayName: username.toUpperCase(), password }
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).id;
}

async function activateAccount(baseUrl, username) {
  const temporary = await login(baseUrl, username, TEST_PASSWORD);
  assert.equal(temporary.user.mustChangePassword, true);
  assert.equal((await api(baseUrl, temporary, '/api/projects')).status, 403);
  const newPassword = `${username} permanent password 2026`;
  const changed = await api(baseUrl, temporary, '/api/auth/change-password', {
    method: 'POST', body: { currentPassword: TEST_PASSWORD, newPassword }
  });
  assert.equal(changed.status, 204);
  return login(baseUrl, username, newPassword);
}

test('serves hardened frontend and health endpoint without leaking the database path', async () => {
  await withServer(async (baseUrl) => {
    const healthResponse = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.deepEqual(health, { ok: true, service: 'card-storyboard', schemaVersion: 1 });
    assert.equal(healthResponse.headers.get('x-frame-options'), 'DENY');
    assert.match(healthResponse.headers.get('content-security-policy'), /default-src 'self'/);

    const indexResponse = await fetch(`${baseUrl}/`);
    assert.equal(indexResponse.status, 200);
    assert.match(await indexResponse.text(), /卡片分镜/);

    const projectRouteResponse = await fetch(`${baseUrl}/project/38`);
    assert.equal(projectRouteResponse.status, 200);
    assert.match(projectRouteResponse.headers.get('content-type'), /text\/html/);

    assert.equal((await fetch(`${baseUrl}/api/projects`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/projects/38/images/image-1`)).status, 401);
  });
});

test('authenticates with HttpOnly session and enforces CSRF, edit locks and project versions', async () => {
  await withServer(async (baseUrl) => {
    const invalid = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
      body: JSON.stringify({ username: 'admin', password: 'wrong password value' })
    });
    assert.equal(invalid.status, 401);
    assert.equal((await invalid.json()).error, '用户名或密码错误');

    const admin = await login(baseUrl);
    assert.match(admin.cookie, /^storyboard_session=/);
    assert.match(admin.setCookie, /HttpOnly/);
    assert.match(admin.setCookie, /SameSite=Lax/);
    assert.doesNotMatch(admin.setCookie, /Secure/);
    const loginAgain = await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: admin.cookie } });
    assert.equal(loginAgain.status, 200);
    assert.equal((await loginAgain.json()).user.username, 'admin');

    const withoutCsrf = await fetch(`${baseUrl}/api/projects`, { method: 'POST', headers: { Cookie: admin.cookie } });
    assert.equal(withoutCsrf.status, 403);

    const createResponse = await api(baseUrl, admin, '/api/projects', { method: 'POST', body: {} });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.equal(created.version, 1);
    assert.equal(created.accessRole, 'admin');

    const lockResponse = await api(baseUrl, admin, `/api/projects/${created.id}/lock`, { method: 'POST', body: {} });
    assert.equal(lockResponse.status, 200);
    const lock = await lockResponse.json();

    const imageData = Buffer.from('small-image').toString('base64');
    const saveResponse = await api(baseUrl, admin, `/api/projects/${created.id}`, {
      method: 'PUT',
      headers: { 'X-Edit-Lease': lock.leaseToken },
      body: {
        baseVersion: 1, name: 'NAS 分镜', scene: '室内', aspectRatio: '4/3',
        shots: [{ id: 'shot-1', imageId: 'image-1', hasImage: true, imageSrc: `data:image/png;base64,${imageData}` }]
      }
    });
    assert.equal(saveResponse.status, 200, await saveResponse.clone().text());
    const saved = await saveResponse.json();
    assert.equal(saved.version, 2);
    assert.equal(saved.shots[0].imageSrc, `/api/projects/${created.id}/images/image-1`);

    const stale = await api(baseUrl, admin, `/api/projects/${created.id}`, {
      method: 'PUT', headers: { 'X-Edit-Lease': lock.leaseToken }, body: { baseVersion: 1, name: 'stale' }
    });
    assert.equal(stale.status, 409);

    const imageResponse = await api(baseUrl, admin, saved.shots[0].imageSrc);
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), Buffer.from('small-image'));

    const duplicateResponse = await api(baseUrl, admin, '/api/projects', {
      method: 'POST', body: { name: 'NAS 分镜副本', sourceProjectId: created.id }
    });
    assert.equal(duplicateResponse.status, 201);

    await api(baseUrl, admin, `/api/projects/${created.id}/lock`, { method: 'DELETE', headers: { 'X-Edit-Lease': lock.leaseToken } });
    const deleteResponse = await api(baseUrl, admin, `/api/projects/${created.id}`, { method: 'DELETE' });
    assert.equal(deleteResponse.status, 204);
    assert.equal((await api(baseUrl, admin, `/api/projects/${created.id}`)).status, 404);

    const logout = await api(baseUrl, admin, '/api/auth/logout', { method: 'POST' });
    assert.equal(logout.status, 204);
    assert.equal((await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: admin.cookie } })).status, 401);
  });
});

test('enforces owner editor viewer permissions and revocable anonymous sharing', async () => {
  await withServer(async (baseUrl) => {
    const admin = await login(baseUrl);
    const editorId = await createAccount(baseUrl, admin, 'editor');
    const viewerId = await createAccount(baseUrl, admin, 'viewer');
    assert.ok(editorId > 0 && viewerId > 0);

    const project = await (await api(baseUrl, admin, '/api/projects', { method: 'POST', body: { name: 'Shared project' } })).json();
    assert.equal((await api(baseUrl, admin, `/api/projects/${project.id}/members`, { method: 'POST', body: { username: 'editor', role: 'editor' } })).status, 200);
    assert.equal((await api(baseUrl, admin, `/api/projects/${project.id}/members`, { method: 'POST', body: { username: 'viewer', role: 'viewer' } })).status, 200);

    const editor = await activateAccount(baseUrl, 'editor');
    const viewer = await activateAccount(baseUrl, 'viewer');
    const editorList = await (await api(baseUrl, editor, '/api/projects')).json();
    assert.equal(editorList.length, 1);
    assert.equal(editorList[0].accessRole, 'editor');
    assert.equal((await api(baseUrl, viewer, `/api/projects/${project.id}`)).status, 200);
    assert.equal((await api(baseUrl, viewer, `/api/projects/${project.id}/lock`, { method: 'POST', body: {} })).status, 404);
    assert.equal((await api(baseUrl, viewer, `/api/projects/${project.id}`, { method: 'DELETE' })).status, 404);

    const editorLockResponse = await api(baseUrl, editor, `/api/projects/${project.id}/lock`, { method: 'POST', body: {} });
    assert.equal(editorLockResponse.status, 200);
    const editorLock = await editorLockResponse.json();
    const editorSave = await api(baseUrl, editor, `/api/projects/${project.id}`, {
      method: 'PUT', headers: { 'X-Edit-Lease': editorLock.leaseToken },
      body: { baseVersion: project.version, name: 'Edited by editor', shots: [] }
    });
    assert.equal(editorSave.status, 200, await editorSave.clone().text());

    const blockedLock = await api(baseUrl, admin, `/api/projects/${project.id}/lock`, { method: 'POST', body: {} });
    assert.equal(blockedLock.status, 423);
    const forceLock = await api(baseUrl, admin, `/api/projects/${project.id}/lock`, { method: 'POST', body: { force: true } });
    assert.equal(forceLock.status, 200);
    const oldEditorSave = await api(baseUrl, editor, `/api/projects/${project.id}`, {
      method: 'PUT', headers: { 'X-Edit-Lease': editorLock.leaseToken }, body: { baseVersion: 2, name: 'lost lock' }
    });
    assert.equal(oldEditorSave.status, 423);

    const shareCreate = await api(baseUrl, admin, `/api/projects/${project.id}/share-links`, {
      method: 'POST', body: { label: 'Client review', expiresAt: Date.now() + 60_000 }
    });
    assert.equal(shareCreate.status, 201);
    const shareLink = await shareCreate.json();
    const landing = await fetch(`${baseUrl}/share/${shareLink.token}`);
    assert.equal(landing.status, 200);
    const shareCookie = landing.headers.get('set-cookie').split(';', 1)[0];
    const sharedProjectResponse = await fetch(`${baseUrl}/api/share/project`, { headers: { Cookie: shareCookie } });
    assert.equal(sharedProjectResponse.status, 200);
    const shared = await sharedProjectResponse.json();
    assert.equal(shared.accessRole, 'anonymous');
    assert.equal(shared.capabilities.canEdit, false);
    assert.equal(shared.capabilities.canExportPdf, true);

    const revoke = await api(baseUrl, admin, `/api/projects/${project.id}/share-links/${shareLink.id}`, { method: 'DELETE' });
    assert.equal(revoke.status, 204);
    assert.equal((await fetch(`${baseUrl}/api/share/project`, { headers: { Cookie: shareCookie } })).status, 404);
  });
});

test('migrates an isolated v0 database without changing project or image bytes', async () => {
  await withServer(async (baseUrl, databasePath) => {
    const admin = await login(baseUrl);
    const projectsResponse = await api(baseUrl, admin, '/api/projects');
    assert.equal(projectsResponse.status, 200);
    assert.equal((await projectsResponse.json()).length, 4);
    assert.ok(readFileSync(databasePath).length > 0);
    const db = openDatabase(databasePath);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM project_members WHERE role = 'owner'").get().count, 4);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();
  }, async (databasePath) => {
    createLegacyTestDatabase(databasePath);
    const beforeDb = openDatabase(databasePath);
    const before = collectDataFingerprint(beforeDb);
    beforeDb.close();
    const passwordHash = await hashPassword(TEST_PASSWORD, TEST_PASSWORD_PARAMS);
    const migrated = setupDatabase({ databasePath, username: 'admin', displayName: 'Administrator', passwordHash });
    assert.deepEqual(migrated.fingerprint, before);
    assert.ok(migrated.backup?.path);
  });
});

test('refuses to start against an uninitialized v0 database', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'card-storyboard-v0-startup-'));
  const databasePath = path.join(directory, 'storyboard.db');
  try {
    createLegacyTestDatabase(databasePath);
    assert.throws(() => createStoryboardApplication({
      databasePath,
      publicDir: path.join(projectRoot, 'public'),
      publicOrigin: TEST_ORIGIN,
      allowedOrigins: [TEST_ORIGIN],
      allowedHosts: ['127.0.0.1']
    }), /setup-admin or migration is required/);
    const db = openDatabase(databasePath);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rolls back a failed migration and can restore a checksummed backup', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'card-storyboard-migration-'));
  const databasePath = path.join(directory, 'storyboard.db');
  try {
    createLegacyTestDatabase(databasePath);
    const passwordHash = await hashPassword(TEST_PASSWORD, TEST_PASSWORD_PARAMS);
    assert.throws(() => setupDatabase({
      databasePath, username: 'admin', displayName: 'Administrator', passwordHash,
      onBeforeCommit() { throw new Error('injected migration failure'); }
    }), /injected migration failure/);
    let db = openDatabase(databasePath);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().count, 0);
    db.close();

    const migrated = setupDatabase({ databasePath, username: 'admin', displayName: 'Administrator', passwordHash });
    db = openDatabase(databasePath);
    db.prepare("UPDATE projects SET name = 'changed after backup' WHERE id = (SELECT MIN(id) FROM projects)").run();
    db.close();
    const restored = restoreDatabase({ databasePath, backupPath: migrated.backup.path });
    assert.ok(restored.preservedCurrent?.path);
    db = openDatabase(databasePath);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
    assert.notEqual(db.prepare('SELECT name FROM projects ORDER BY id LIMIT 1').get().name, 'changed after backup');
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
