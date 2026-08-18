const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createStoryboardApplication, setupDatabase } = require('../server.js');
const { collectDataFingerprint, openDatabase, restoreDatabase } = require('../server/schema.js');
const { hashPassword, tokenHash } = require('../server/security.js');

const projectRoot = path.dirname(__dirname);
const TEST_ORIGIN = 'http://storyboard.test';
const TEST_PASSWORD = 'correct horse battery staple';
const TEST_TEMPORARY_PASSWORD = '123456';
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

async function withServer(run, databaseInitializer = initialize, applicationOptions = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'card-storyboard-http-'));
  const databasePath = path.join(directory, 'storyboard.db');
  await databaseInitializer(databasePath);
  const application = createStoryboardApplication({
    databasePath,
    publicDir: path.join(projectRoot, 'public'),
    publicOrigin: TEST_ORIGIN,
    allowedOrigins: [TEST_ORIGIN],
    allowedHosts: ['127.0.0.1'],
    passwordParams: TEST_PASSWORD_PARAMS,
    ...applicationOptions
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

async function register(baseUrl, body, headers = {}) {
  return fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN, ...headers },
    body: JSON.stringify(body)
  });
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

async function createAccount(baseUrl, admin, username) {
  const response = await api(baseUrl, admin, '/api/admin/users', {
    method: 'POST', body: { username, displayName: username.toUpperCase() }
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).id;
}

async function activateAccount(baseUrl, username) {
  const temporary = await login(baseUrl, username, TEST_TEMPORARY_PASSWORD);
  assert.equal(temporary.user.mustChangePassword, true);
  assert.equal((await api(baseUrl, temporary, '/api/projects')).status, 403);
  const weakChange = await api(baseUrl, temporary, '/api/auth/change-password', {
    method: 'POST', body: { currentPassword: TEST_TEMPORARY_PASSWORD, newPassword: TEST_TEMPORARY_PASSWORD }
  });
  assert.equal(weakChange.status, 400);
  const newPassword = `${username} permanent password 2026`;
  const changed = await api(baseUrl, temporary, '/api/auth/change-password', {
    method: 'POST', body: { currentPassword: TEST_TEMPORARY_PASSWORD, newPassword }
  });
  assert.equal(changed.status, 204);
  return login(baseUrl, username, newPassword);
}

test('serves hardened frontend and health endpoint without leaking the database path', async () => {
  await withServer(async (baseUrl) => {
    const healthResponse = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.deepEqual(health, { ok: true, service: 'card-storyboard', schemaVersion: 8 });
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
  await withServer(async (baseUrl, databasePath) => {
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

    const expiryDb = openDatabase(databasePath);
    expiryDb.prepare('UPDATE project_edit_locks SET expires_at = ? WHERE project_id = ?')
      .run(Date.now() - 1, created.id);
    expiryDb.close();
    const resumedHeartbeat = await api(baseUrl, admin, `/api/projects/${created.id}/lock`, {
      method: 'PATCH', headers: { 'X-Edit-Lease': lock.leaseToken }
    });
    assert.equal(resumedHeartbeat.status, 200, await resumedHeartbeat.clone().text());
    assert.ok((await resumedHeartbeat.json()).expiresAt > Date.now());

    const imageData = Buffer.from('small-image').toString('base64');
    const saveResponse = await api(baseUrl, admin, `/api/projects/${created.id}`, {
      method: 'PUT',
      headers: { 'X-Edit-Lease': lock.leaseToken },
      body: {
        baseVersion: 1, name: 'NAS 分镜', scene: '室内', aspectRatio: '4/3',
        shots: [{ shotUnitId: 'unit-1', imageId: 'image-1', hasImage: true, imageSrc: `data:image/png;base64,${imageData}` }],
        rundown: {
          version: 1,
          days: [{
            id: 'day-1', date: '2026-08-18',
            items: [{ id: 'item-1', type: 'shot', shotUnitId: 'unit-1', startTime: '09:00', endTime: '10:00', setupLabel: '客厅日景' }]
          }]
        }
      }
    });
    assert.equal(saveResponse.status, 200, await saveResponse.clone().text());
    const saved = await saveResponse.json();
    assert.equal(saved.version, 2);
    assert.equal(saved.shots[0].shotUnitId, 'unit-1');
    assert.equal(saved.rundown.days[0].items[0].setupLabel, '客厅日景');

    const saveWithoutRundown = await api(baseUrl, admin, `/api/projects/${created.id}`, {
      method: 'PUT', headers: { 'X-Edit-Lease': lock.leaseToken }, body: { baseVersion: 2, name: 'NAS 分镜改名' }
    });
    assert.equal(saveWithoutRundown.status, 200, await saveWithoutRundown.clone().text());
    const savedWithoutRundown = await saveWithoutRundown.json();
    assert.equal(savedWithoutRundown.version, 3);
    assert.equal(savedWithoutRundown.rundown.days[0].items[0].shotUnitId, 'unit-1');
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
    const duplicated = await duplicateResponse.json();
    assert.equal(duplicated.rundown.days[0].items[0].setupLabel, '客厅日景');

    await api(baseUrl, admin, `/api/projects/${created.id}/lock`, { method: 'DELETE', headers: { 'X-Edit-Lease': lock.leaseToken } });
    const deleteResponse = await api(baseUrl, admin, `/api/projects/${created.id}`, { method: 'DELETE' });
    assert.equal(deleteResponse.status, 204);
    assert.equal((await api(baseUrl, admin, `/api/projects/${created.id}`)).status, 404);

    const logout = await api(baseUrl, admin, '/api/auth/logout', { method: 'POST' });
    assert.equal(logout.status, 204);
    assert.equal((await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: admin.cookie } })).status, 401);
  });
});

test('numbers default project names independently for each owner account', async () => {
  await withServer(async (baseUrl) => {
    const admin = await login(baseUrl);
    const adminFirst = await api(baseUrl, admin, '/api/projects', { method: 'POST', body: {} });
    const adminSecond = await api(baseUrl, admin, '/api/projects', { method: 'POST', body: {} });
    assert.equal((await adminFirst.json()).name, '新项目 1');
    assert.equal((await adminSecond.json()).name, '新项目 2');

    await createAccount(baseUrl, admin, 'independent.names');
    const account = await activateAccount(baseUrl, 'independent.names');
    const accountFirst = await api(baseUrl, account, '/api/projects', { method: 'POST', body: {} });
    const accountSecond = await api(baseUrl, account, '/api/projects', { method: 'POST', body: {} });
    assert.equal((await accountFirst.json()).name, '新项目 1');
    assert.equal((await accountSecond.json()).name, '新项目 2');
  });
});

test('accepts legacy group payloads without persisting groupId', async () => {
  await withServer(async (baseUrl) => {
    const admin = await login(baseUrl);
    const created = await (await api(baseUrl, admin, '/api/projects', {
      method: 'POST', body: { name: 'Partial regrouping' }
    })).json();
    const lock = await (await api(baseUrl, admin, `/api/projects/${created.id}/lock`, {
      method: 'POST', body: {}
    })).json();
    const sharedId = 'shot-unit-before-partial-regroup';
    const scheduledAlternateId = 'shot-unit-scheduled-alternate';
    const existingSingleIdGroup = 'shot-unit-existing-single-id-group';
    const response = await api(baseUrl, admin, `/api/projects/${created.id}`, {
      method: 'PUT',
      headers: { 'X-Edit-Lease': lock.leaseToken },
      body: {
        baseVersion: created.version,
        shots: [
          { shotUnitId: sharedId, action: '拆出的独立镜头' },
          { shotUnitId: sharedId, groupId: 'new-visual-group', action: '编组镜头一' },
          { shotUnitId: sharedId, groupId: 'new-visual-group', action: '编组镜头二' },
          { shotUnitId: sharedId, groupId: 'new-visual-group', action: '编组镜头三' },
          { shotUnitId: 'shot-unit-unscheduled-first', groupId: 'mixed-id-group', action: '历史 ID 一' },
          { shotUnitId: scheduledAlternateId, groupId: 'mixed-id-group', action: '历史 ID 二' },
          { shotUnitId: existingSingleIdGroup, action: '新格式编组一' },
          { shotUnitId: existingSingleIdGroup, action: '新格式编组二' }
        ],
        rundown: {
          version: 1,
          days: [{
            id: 'day-1', date: '2026-08-18',
            items: [
              { id: 'item-1', type: 'shot', shotUnitId: sharedId, startTime: '09:00', endTime: '10:00', setupLabel: '' },
              { id: 'item-2', type: 'shot', shotUnitId: scheduledAlternateId, startTime: '10:00', endTime: '11:00', setupLabel: '' },
              { id: 'item-3', type: 'shot', shotUnitId: existingSingleIdGroup, startTime: '11:00', endTime: '12:00', setupLabel: '' }
            ]
          }]
        }
      }
    });
    assert.equal(response.status, 200, await response.clone().text());
    const saved = await response.json();
    assert.notEqual(saved.shots[0].shotUnitId, sharedId);
    assert.equal(saved.shots[1].shotUnitId, sharedId);
    assert.equal(saved.shots[2].shotUnitId, sharedId);
    assert.equal(saved.shots[3].shotUnitId, sharedId);
    assert.equal(saved.shots[4].shotUnitId, scheduledAlternateId);
    assert.equal(saved.shots[5].shotUnitId, scheduledAlternateId);
    assert.equal(saved.shots[6].shotUnitId, existingSingleIdGroup);
    assert.equal(saved.shots[7].shotUnitId, existingSingleIdGroup);
    assert.ok(saved.shots.every((shot) => !Object.prototype.hasOwnProperty.call(shot, 'groupId')));
    assert.equal(saved.rundown.days[0].items[0].shotUnitId, sharedId);
    assert.equal(saved.rundown.days[0].items[1].shotUnitId, scheduledAlternateId);
    assert.equal(saved.rundown.days[0].items[2].shotUnitId, existingSingleIdGroup);
  });
});

test('uses repeated shotUnitId values as the only grouping source', async () => {
  await withServer(async (baseUrl) => {
    const admin = await login(baseUrl);
    const created = await (await api(baseUrl, admin, '/api/projects', {
      method: 'POST', body: { name: 'Single id grouping' }
    })).json();
    const lock = await (await api(baseUrl, admin, `/api/projects/${created.id}/lock`, {
      method: 'POST', body: {}
    })).json();
    const sharedId = 'shot-unit-shared-group';
    const oversizedId = 'shot-unit-oversized-group';
    const crossSceneId = 'shot-unit-cross-scene-group';
    const response = await api(baseUrl, admin, `/api/projects/${created.id}`, {
      method: 'PUT',
      headers: { 'X-Edit-Lease': lock.leaseToken },
      body: {
        baseVersion: created.version,
        shots: [
          { shotUnitId: 'shot-unit-independent', action: '独立镜头' },
          { shotUnitId: sharedId, action: '编组镜头一' },
          { shotUnitId: sharedId, action: '编组镜头二' },
          { action: '缺少 ID 的独立镜头' },
          { shotUnitId: 'invalid id', action: '非法 ID 的独立镜头' },
          { shotUnitId: oversizedId, action: '超量编组一' },
          { shotUnitId: oversizedId, action: '超量编组二' },
          { shotUnitId: oversizedId, action: '超量编组三' },
          { shotUnitId: oversizedId, action: '超量编组四' },
          { shotUnitId: crossSceneId, action: '跨场编组一' },
          { type: 'scene-divider', label: '第二场' },
          { shotUnitId: crossSceneId, action: '跨场编组二' }
        ],
        rundown: {
          version: 1,
          days: [{
            id: 'day-1', date: '2026-08-18',
            items: [
              { id: 'item-1', type: 'shot', shotUnitId: sharedId, startTime: '09:00', endTime: '10:00', setupLabel: '' },
              { id: 'item-2', type: 'shot', shotUnitId: oversizedId, startTime: '10:00', endTime: '11:00', setupLabel: '' },
              { id: 'item-3', type: 'shot', shotUnitId: crossSceneId, startTime: '11:00', endTime: '12:00', setupLabel: '' }
            ]
          }]
        }
      }
    });
    assert.equal(response.status, 200, await response.clone().text());
    const saved = await response.json();
    assert.equal(saved.shots[1].shotUnitId, sharedId);
    assert.equal(saved.shots[2].shotUnitId, sharedId);
    assert.notEqual(saved.shots[0].shotUnitId, sharedId);
    assert.ok(saved.shots[3].shotUnitId);
    assert.ok(saved.shots[4].shotUnitId);
    assert.notEqual(saved.shots[3].shotUnitId, saved.shots[4].shotUnitId);
    assert.equal(saved.shots[5].shotUnitId, oversizedId);
    assert.ok(saved.shots.slice(6, 9).every((shot) => shot.shotUnitId !== oversizedId));
    assert.equal(new Set(saved.shots.slice(5, 9).map((shot) => shot.shotUnitId)).size, 4);
    assert.equal(saved.shots[9].shotUnitId, crossSceneId);
    assert.notEqual(saved.shots[11].shotUnitId, crossSceneId);
    assert.ok(saved.shots.every((shot) => !Object.prototype.hasOwnProperty.call(shot, 'groupId')));
    assert.deepEqual(saved.rundown.days[0].items.map((item) => item.shotUnitId), [sharedId, oversizedId, crossSceneId]);

    const duplicated = await (await api(baseUrl, admin, '/api/projects', {
      method: 'POST', body: { name: 'Single id grouping copy', sourceProjectId: created.id }
    })).json();
    assert.equal(duplicated.shots[1].shotUnitId, sharedId);
    assert.equal(duplicated.shots[2].shotUnitId, sharedId);
    assert.equal(duplicated.rundown.days[0].items[0].shotUnitId, sharedId);
    assert.ok(duplicated.shots.every((shot) => !Object.prototype.hasOwnProperty.call(shot, 'groupId')));
  });
});

test('allows self-registration with an immediate restricted session and enforces validation and rate limits', async () => {
  await withServer(async (baseUrl, _databasePath, application) => {
    const configResponse = await fetch(`${baseUrl}/api/auth/config`);
    assert.equal(configResponse.status, 200);
    assert.deepEqual(await configResponse.json(), { registrationEnabled: true });

    const registration = await register(baseUrl, {
      username: 'New.User',
      displayName: '  New Storyboard User  ',
      password: 'new user password 2026'
    });
    const payload = await registration.json();
    assert.equal(registration.status, 201, JSON.stringify(payload));
    assert.equal(payload.user.username, 'new.user');
    assert.equal(payload.user.displayName, 'New Storyboard User');
    assert.equal(payload.user.isAdmin, false);
    assert.equal(payload.user.isActive, true);
    assert.equal(payload.user.mustChangePassword, false);
    assert.equal(typeof payload.csrfToken, 'string');
    assert.match(registration.headers.get('set-cookie'), /storyboard_session=.*HttpOnly.*SameSite=Lax/);

    const account = {
      cookie: registration.headers.get('set-cookie').split(';', 1)[0],
      csrf: payload.csrfToken,
      user: payload.user
    };
    const session = await api(baseUrl, account, '/api/auth/session');
    assert.equal(session.status, 200);
    assert.equal((await session.json()).user.username, 'new.user');
    assert.deepEqual(await (await api(baseUrl, account, '/api/projects')).json(), []);
    assert.equal((await api(baseUrl, account, '/api/projects', { method: 'POST', body: { name: 'My first project' } })).status, 201);

    const auditRow = application.store.db.prepare("SELECT actor_user_id, target_user_id, metadata_json FROM security_audit_events WHERE event_type = 'user_self_registered' ORDER BY id DESC LIMIT 1").get();
    assert.equal(auditRow.actor_user_id, payload.user.id);
    assert.equal(auditRow.target_user_id, payload.user.id);
    assert.match(JSON.parse(auditRow.metadata_json).source, /^[a-f0-9]{64}$/);

    const duplicate = await register(baseUrl, { username: 'NEW.USER', displayName: 'Duplicate', password: 'duplicate password 2026' });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).code, 'account_unavailable');

    const invalidUsername = await register(baseUrl, { username: 'not valid!', displayName: 'Invalid', password: 'invalid password 2026' });
    assert.equal(invalidUsername.status, 400);
    assert.equal((await invalidUsername.json()).code, 'invalid_username');

    const invalidDisplayName = await register(baseUrl, { username: 'validname', displayName: '   ', password: 'invalid display password' });
    assert.equal(invalidDisplayName.status, 400);
    assert.equal((await invalidDisplayName.json()).code, 'invalid_display_name');

    const invalidPassword = await register(baseUrl, { username: 'anothername', displayName: 'Another', password: 'short' });
    assert.equal(invalidPassword.status, 400);
    assert.equal((await invalidPassword.json()).code, 'invalid_password');

    const rateLimited = await register(baseUrl, { username: 'ratelimited', displayName: 'Rate Limited', password: 'rate limited password' });
    assert.equal(rateLimited.status, 429);
    assert.equal((await rateLimited.json()).code, 'registration_rate_limited');
    assert.ok(Number(rateLimited.headers.get('retry-after')) > 0);

    const crossSite = await register(baseUrl, { username: 'crosssite', displayName: 'Cross Site', password: 'cross site password' }, { Origin: 'http://attacker.test' });
    assert.equal(crossSite.status, 403);
    assert.equal((await crossSite.json()).code, 'origin_rejected');
  });
});

test('can disable public self-registration without affecting login', async () => {
  await withServer(async (baseUrl) => {
    const config = await fetch(`${baseUrl}/api/auth/config`);
    assert.deepEqual(await config.json(), { registrationEnabled: false });
    const disabled = await register(baseUrl, { username: 'closeduser', displayName: 'Closed User', password: 'closed user password' });
    assert.equal(disabled.status, 403);
    assert.equal((await disabled.json()).code, 'registration_disabled');
    assert.equal((await login(baseUrl)).user.username, 'admin');
  }, initialize, { registrationEnabled: false });
});

test('keeps admin as the only administrator and rejects account status changes', async () => {
  await withServer(async (baseUrl, _databasePath, application) => {
    const admin = await login(baseUrl);
    const operatorId = await createAccount(baseUrl, admin, 'operator');

    const promote = await api(baseUrl, admin, `/api/admin/users/${operatorId}`, {
      method: 'PATCH', body: { isAdmin: true }
    });
    assert.equal(promote.status, 409);
    assert.equal((await promote.json()).code, 'admin_status_fixed');

    const disable = await api(baseUrl, admin, `/api/admin/users/${operatorId}`, {
      method: 'PATCH', body: { isActive: false }
    });
    assert.equal(disable.status, 409);
    assert.equal((await disable.json()).code, 'account_status_fixed');

    const adminCreate = await api(baseUrl, admin, '/api/admin/users', {
      method: 'POST', body: { username: 'secondadmin', displayName: 'Second Admin', isAdmin: true }
    });
    assert.equal(adminCreate.status, 409);
    assert.equal((await adminCreate.json()).code, 'admin_status_fixed');

    application.store.db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(operatorId);
    const operator = await activateAccount(baseUrl, 'operator');
    assert.equal(operator.user.isAdmin, false);
    assert.equal((await api(baseUrl, operator, '/api/admin/users')).status, 404);
    const users = await (await api(baseUrl, admin, '/api/admin/users')).json();
    assert.equal(users.find((user) => user.id === operatorId).isAdmin, false);
  });
});

test('deletes non-admin accounts after transferring their projects to admin', async () => {
  await withServer(async (baseUrl, _databasePath, application) => {
    const admin = await login(baseUrl);
    const accountId = await createAccount(baseUrl, admin, 'departing');
    const account = await activateAccount(baseUrl, 'departing');
    const firstProject = await (await api(baseUrl, account, '/api/projects', {
      method: 'POST', body: { name: 'Transferred one' }
    })).json();
    const secondProject = await (await api(baseUrl, account, '/api/projects', {
      method: 'POST', body: { name: 'Transferred two' }
    })).json();
    const adminProject = await (await api(baseUrl, admin, '/api/projects', {
      method: 'POST', body: { name: 'Admin owned' }
    })).json();
    await api(baseUrl, account, `/api/projects/${firstProject.id}/members`, {
      method: 'POST', body: { username: 'admin', role: 'editor' }
    });
    await api(baseUrl, admin, `/api/projects/${adminProject.id}/members`, {
      method: 'POST', body: { username: 'departing', role: 'viewer' }
    });

    const deleted = await api(baseUrl, admin, `/api/admin/users/${accountId}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    assert.equal((await api(baseUrl, account, '/api/auth/session')).status, 401);
    const users = await (await api(baseUrl, admin, '/api/admin/users')).json();
    assert.equal(users.some((user) => user.id === accountId), false);

    const transferred = await (await api(baseUrl, admin, '/api/projects')).json();
    assert.deepEqual(
      transferred.filter((item) => [firstProject.id, secondProject.id].includes(item.id)).map((item) => item.owner.username),
      ['admin', 'admin']
    );
    assert.equal(application.store.db.prepare("SELECT COUNT(*) AS count FROM project_members WHERE user_id = ? AND role = 'owner'").get(admin.user.id).count, 3);
    assert.equal(application.store.db.prepare('SELECT COUNT(*) AS count FROM project_members WHERE user_id = ?').get(accountId).count, 0);

    const auditRow = application.store.db.prepare("SELECT target_user_id, metadata_json FROM security_audit_events WHERE event_type = 'user_deleted' ORDER BY id DESC LIMIT 1").get();
    assert.equal(auditRow.target_user_id, null);
    assert.deepEqual(JSON.parse(auditRow.metadata_json), {
      username: 'departing',
      displayName: 'DEPARTING',
      transferredProjects: 2,
      transferredToUserId: admin.user.id
    });

    const protectedDelete = await api(baseUrl, admin, `/api/admin/users/${admin.user.id}`, { method: 'DELETE' });
    assert.equal(protectedDelete.status, 409);
    assert.equal((await protectedDelete.json()).code, 'admin_account_protected');
  });
});

test('allows administrators to edit other account identities with validation and session revocation', async () => {
  await withServer(async (baseUrl, _databasePath, application) => {
    const admin = await login(baseUrl);
    const accountId = await createAccount(baseUrl, admin, 'profileuser');
    const account = await activateAccount(baseUrl, 'profileuser');

    const displayNameUpdate = await api(baseUrl, admin, `/api/admin/users/${accountId}`, {
      method: 'PATCH', body: { displayName: '  Updated Profile  ' }
    });
    assert.equal(displayNameUpdate.status, 204);
    const activeSession = await api(baseUrl, account, '/api/auth/session');
    assert.equal(activeSession.status, 200);
    assert.equal((await activeSession.json()).user.displayName, 'Updated Profile');

    const invalidUsername = await api(baseUrl, admin, `/api/admin/users/${accountId}`, {
      method: 'PATCH', body: { username: 'not valid!' }
    });
    assert.equal(invalidUsername.status, 400);
    assert.equal((await invalidUsername.json()).code, 'invalid_username');

    const duplicateId = await createAccount(baseUrl, admin, 'takenname');
    const duplicateUsername = await api(baseUrl, admin, `/api/admin/users/${accountId}`, {
      method: 'PATCH', body: { username: 'TAKENNAME' }
    });
    assert.equal(duplicateUsername.status, 409);
    assert.equal((await duplicateUsername.json()).code, 'account_unavailable');

    const selfUpdate = await api(baseUrl, admin, `/api/admin/users/${admin.user.id}`, {
      method: 'PATCH', body: { displayName: 'New Administrator' }
    });
    assert.equal(selfUpdate.status, 409);
    assert.equal((await selfUpdate.json()).code, 'cannot_edit_self_identity');

    const nonAdminUpdate = await api(baseUrl, account, `/api/admin/users/${duplicateId}`, {
      method: 'PATCH', body: { displayName: 'Not Allowed' }
    });
    assert.equal(nonAdminUpdate.status, 404);

    const usernameUpdate = await api(baseUrl, admin, `/api/admin/users/${accountId}`, {
      method: 'PATCH', body: { username: 'Profile.User', displayName: '   ' }
    });
    assert.equal(usernameUpdate.status, 204);
    assert.equal((await api(baseUrl, account, '/api/auth/session')).status, 401);

    const oldUsernameLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
      body: JSON.stringify({ username: 'profileuser', password: 'profileuser permanent password 2026' })
    });
    assert.equal(oldUsernameLogin.status, 401);

    const renamedAccount = await login(baseUrl, 'profile.user', 'profileuser permanent password 2026');
    assert.equal(renamedAccount.user.username, 'profile.user');
    assert.equal(renamedAccount.user.displayName, 'profile.user');

    const users = await (await api(baseUrl, admin, '/api/admin/users')).json();
    assert.equal(users.find((user) => user.id === accountId).username, 'profile.user');
    const auditRow = application.store.db.prepare("SELECT metadata_json FROM security_audit_events WHERE event_type = 'user_updated' AND target_user_id = ? ORDER BY id DESC LIMIT 1").get(accountId);
    assert.deepEqual(JSON.parse(auditRow.metadata_json), {
      active: true,
      isAdmin: false,
      before: { username: 'profileuser', displayName: 'Updated Profile' },
      after: { username: 'profile.user', displayName: 'profile.user' }
    });
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
    assert.deepEqual(editorList[0].owner, {
      id: admin.user.id,
      username: admin.user.username,
      displayName: admin.user.displayName
    });

    const editorOwned = await (await api(baseUrl, editor, '/api/projects', {
      method: 'POST', body: { name: 'Editor project' }
    })).json();
    const adminList = await (await api(baseUrl, admin, '/api/projects')).json();
    assert.equal(adminList.find((item) => item.id === editorOwned.id).owner.username, 'editor');
    const ownerSearch = await (await api(baseUrl, admin, '/api/projects?search=EDITOR')).json();
    assert.deepEqual(ownerSearch.map((item) => item.id), [editorOwned.id]);

    assert.equal((await api(baseUrl, viewer, `/api/projects/${project.id}`)).status, 200);
    assert.equal((await api(baseUrl, viewer, '/api/admin/project-presence')).status, 404);
    assert.equal((await api(baseUrl, viewer, `/api/projects/${project.id}/presence`, {
      method: 'POST', headers: { 'X-Project-Presence': 'viewer-browser-tab-one' }
    })).status, 200);
    assert.deepEqual((await (await api(baseUrl, admin, '/api/admin/project-presence')).json()).userIds, [viewerId]);
    assert.equal((await api(baseUrl, viewer, `/api/projects/${project.id}/presence`, {
      method: 'POST', headers: { 'X-Project-Presence': 'viewer-browser-tab-two' }
    })).status, 200);
    assert.equal((await api(baseUrl, viewer, `/api/projects/${project.id}/presence`, {
      method: 'DELETE', headers: { 'X-Project-Presence': 'viewer-browser-tab-one' }
    })).status, 204);
    assert.deepEqual((await (await api(baseUrl, admin, '/api/admin/project-presence')).json()).userIds, [viewerId]);
    assert.equal((await api(baseUrl, viewer, `/api/projects/${project.id}/presence`, {
      method: 'DELETE', headers: { 'X-Project-Presence': 'viewer-browser-tab-two' }
    })).status, 204);
    assert.deepEqual((await (await api(baseUrl, admin, '/api/admin/project-presence')).json()).userIds, []);
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
    const oldEditorHeartbeat = await api(baseUrl, editor, `/api/projects/${project.id}/lock`, {
      method: 'PATCH', headers: { 'X-Edit-Lease': editorLock.leaseToken }
    });
    assert.equal(oldEditorHeartbeat.status, 423);
    const heartbeatPayload = await oldEditorHeartbeat.json();
    assert.equal(heartbeatPayload.code, 'edit_lock_lost');
    assert.equal(heartbeatPayload.details.displayName, admin.user.displayName);
    assert.equal(heartbeatPayload.details.isMine, false);
    const oldEditorSave = await api(baseUrl, editor, `/api/projects/${project.id}`, {
      method: 'PUT', headers: { 'X-Edit-Lease': editorLock.leaseToken }, body: { baseVersion: 2, name: 'lost lock' }
    });
    assert.equal(oldEditorSave.status, 423);
    const savePayload = await oldEditorSave.json();
    assert.equal(savePayload.details.username, admin.user.username);

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

test('keeps five reusable share links with numbering scoped to each project', async () => {
  await withServer(async (baseUrl, databasePath) => {
    const admin = await login(baseUrl);
    const firstProject = await (await api(baseUrl, admin, '/api/projects', { method: 'POST', body: { name: 'First shared project' } })).json();
    const secondProject = await (await api(baseUrl, admin, '/api/projects', { method: 'POST', body: { name: 'Second shared project' } })).json();
    const created = [];

    for (let number = 1; number <= 6; number += 1) {
      const response = await api(baseUrl, admin, `/api/projects/${firstProject.id}/share-links`, {
        method: 'POST', body: { expiresAt: Date.now() + 60_000 }
      });
      assert.equal(response.status, 201);
      const link = await response.json();
      assert.equal(link.displayNumber, number);
      created.push(link);
    }

    const secondLink = await (await api(baseUrl, admin, `/api/projects/${secondProject.id}/share-links`, {
      method: 'POST', body: { expiresAt: Date.now() + 60_000 }
    })).json();
    assert.equal(secondLink.displayNumber, 1);

    const firstLinks = await (await api(baseUrl, admin, `/api/projects/${firstProject.id}/share-links`)).json();
    assert.equal(firstLinks.length, 5);
    assert.deepEqual(firstLinks.map((link) => link.displayNumber), [6, 5, 4, 3, 2]);
    assert.ok(firstLinks.every((link) => typeof link.token === 'string' && link.token.length >= 20));
    assert.equal((await fetch(`${baseUrl}/share/${created[0].token}`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/share/${firstLinks[0].token}`)).status, 200);

    const secondLinks = await (await api(baseUrl, admin, `/api/projects/${secondProject.id}/share-links`)).json();
    assert.deepEqual(secondLinks.map((link) => link.displayNumber), [1]);

    const db = openDatabase(databasePath);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM project_share_links WHERE project_id = ?').get(firstProject.id).count, 5);
    assert.equal(db.prepare('SELECT share_link_id FROM security_audit_events WHERE event_type = ? AND project_id = ? ORDER BY id LIMIT 1').get('share_link_created', firstProject.id).share_link_id, null);
    db.close();
  });
});

test('migrates v4 project presence to per-browser-tab records', async () => {
  await withServer(async (baseUrl, databasePath) => {
    const admin = await login(baseUrl);
    const project = await (await api(baseUrl, admin, '/api/projects', {
      method: 'POST', body: { name: 'Presence migration project' }
    })).json();
    assert.equal((await api(baseUrl, admin, `/api/projects/${project.id}/presence`, {
      method: 'POST', headers: { 'X-Project-Presence': 'admin-browser-tab-one' }
    })).status, 200);
    assert.deepEqual((await (await api(baseUrl, admin, '/api/admin/project-presence')).json()).userIds, [admin.user.id]);

    const db = openDatabase(databasePath);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
    assert.ok(db.prepare('PRAGMA table_info(project_presence)').all().some((column) => column.name === 'presence_id'));
    db.close();
  }, async (databasePath) => {
    await initialize(databasePath);
    const db = openDatabase(databasePath);
    db.exec(`
      DROP TABLE project_presence;
      CREATE TABLE project_presence (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id INTEGER NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
        heartbeat_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, session_id)
      );
      CREATE INDEX project_presence_user_idx ON project_presence(user_id, project_id);
      CREATE INDEX project_presence_expiry_idx ON project_presence(expires_at);
      DELETE FROM schema_migrations WHERE version = 5;
      DELETE FROM schema_migrations WHERE version = 6;
      DELETE FROM schema_migrations WHERE version = 7;
      DELETE FROM schema_migrations WHERE version = 8;
      ALTER TABLE projects DROP COLUMN rundown_json;
      PRAGMA user_version = 4;
    `);
    db.close();
  });
});

test('automatically migrates v1 share links, trims history and resets project numbering', async () => {
  const legacyTokens = Array.from({ length: 7 }, (_, index) => `legacy-share-token-${index + 1}-still-valid`);
  await withServer(async (baseUrl, databasePath) => {
    const admin = await login(baseUrl);
    const projects = await (await api(baseUrl, admin, '/api/projects')).json();
    assert.equal(projects.length, 1);
    const links = await (await api(baseUrl, admin, `/api/projects/${projects[0].id}/share-links`)).json();
    assert.equal(links.length, 5);
    assert.deepEqual(links.map((link) => link.displayNumber), [5, 4, 3, 2, 1]);
    assert.ok(links.every((link) => typeof link.token === 'string' && link.token.length >= 20));
    assert.equal((await fetch(`${baseUrl}/share/${legacyTokens[0]}`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/share/${legacyTokens[6]}`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/share/${links[0].token}`)).status, 200);

    const db = openDatabase(databasePath);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();
  }, async (databasePath) => {
    await initialize(databasePath);
    const db = openDatabase(databasePath);
    db.exec(`
      DROP INDEX project_share_links_display_number_idx;
      DROP INDEX project_share_links_reusable_token_idx;
      ALTER TABLE project_share_links DROP COLUMN reusable_token;
      ALTER TABLE project_share_links DROP COLUMN display_number;
      DELETE FROM schema_migrations WHERE version = 2;
      DELETE FROM schema_migrations WHERE version = 3;
      DELETE FROM schema_migrations WHERE version = 4;
      DELETE FROM schema_migrations WHERE version = 5;
      DELETE FROM schema_migrations WHERE version = 6;
      DELETE FROM schema_migrations WHERE version = 7;
      DELETE FROM schema_migrations WHERE version = 8;
      ALTER TABLE projects DROP COLUMN rundown_json;
      DROP TABLE project_presence;
      PRAGMA user_version = 1;
    `);
    const now = Date.now();
    const projectResult = db.prepare("INSERT INTO projects (name, scene, aspect_ratio, shots_json, updated_at, version) VALUES ('Legacy shared project', '', '16/9', '[]', '2026-01-01 00:00:00', 1)").run();
    const projectId = Number(projectResult.lastInsertRowid);
    const adminId = Number(db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id);
    db.prepare("INSERT INTO project_members (project_id, user_id, role, created_by_user_id, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?)")
      .run(projectId, adminId, adminId, now, now);
    const insert = db.prepare('INSERT INTO project_share_links (project_id, token_hash, created_by_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)');
    legacyTokens.forEach((token, index) => insert.run(projectId, tokenHash(token), adminId, now + index, now + 60_000));
    db.close();
  });
});

test('migrates legacy gray shot headers to the writing area background', async () => {
  await withServer(async (baseUrl, databasePath) => {
    const admin = await login(baseUrl);
    const project = await (await api(baseUrl, admin, '/api/projects/1')).json();
    assert.equal(project.shots[0].headerColor, '#fffdf8');

    const db = openDatabase(databasePath);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 3').get().count, 1);
    db.close();
  }, async (databasePath) => {
    await initialize(databasePath);
    const db = openDatabase(databasePath);
    const projectResult = db.prepare("INSERT INTO projects (name, scene, aspect_ratio, shots_json, updated_at, version) VALUES ('Legacy colors', '', '16/9', ?, '2026-01-01 00:00:00', 1)")
      .run(JSON.stringify([
        { headerColor: '#64748b', vfx: false, move: 'Static固定' }
      ]));
    const adminId = Number(db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id);
    db.prepare("INSERT INTO project_members (project_id, user_id, role, created_by_user_id, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?)")
      .run(Number(projectResult.lastInsertRowid), adminId, adminId, Date.now(), Date.now());
    db.prepare('DELETE FROM schema_migrations WHERE version = 3').run();
    db.prepare('DELETE FROM schema_migrations WHERE version = 4').run();
    db.prepare('DELETE FROM schema_migrations WHERE version = 5').run();
    db.prepare('DELETE FROM schema_migrations WHERE version = 6').run();
    db.prepare('DELETE FROM schema_migrations WHERE version = 7').run();
    db.prepare('DELETE FROM schema_migrations WHERE version = 8').run();
    db.exec('ALTER TABLE projects DROP COLUMN rundown_json');
    db.exec('DROP TABLE project_presence');
    db.exec('PRAGMA user_version = 2');
    db.close();
  });
});

test('migrates logical shot ids and keeps grouped cards as one rundown unit', async () => {
  await withServer(async (baseUrl, databasePath) => {
    const admin = await login(baseUrl);
    const project = await (await api(baseUrl, admin, '/api/projects/1')).json();
    assert.ok(project.shots[0].shotUnitId);
    assert.equal(project.shots[0].shotUnitId, project.shots[1].shotUnitId);
    assert.ok(project.shots[2].shotUnitId);
    assert.notEqual(project.shots[0].shotUnitId, project.shots[2].shotUnitId);
    assert.ok(project.shots.every((shot) => !Object.prototype.hasOwnProperty.call(shot, 'groupId')));
    assert.deepEqual(project.rundown, { version: 1, days: [] });

    const db = openDatabase(databasePath);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
    assert.ok(db.prepare('PRAGMA table_info(projects)').all().some((column) => column.name === 'rundown_json'));
    db.close();
  }, async (databasePath) => {
    await initialize(databasePath);
    const db = openDatabase(databasePath);
    const result = db.prepare("INSERT INTO projects (name, shots_json) VALUES ('Legacy grouped shots', ?)").run(JSON.stringify([
      { groupId: 'group-a', action: '第一格' },
      { groupId: 'group-a', action: '第二格' },
      { action: '独立镜头' }
    ]));
    const adminId = Number(db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id);
    db.prepare("INSERT INTO project_members (project_id, user_id, role, created_by_user_id, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?)")
      .run(Number(result.lastInsertRowid), adminId, adminId, Date.now(), Date.now());
    db.prepare('DELETE FROM schema_migrations WHERE version = 6').run();
    db.prepare('DELETE FROM schema_migrations WHERE version = 7').run();
    db.prepare('DELETE FROM schema_migrations WHERE version = 8').run();
    db.exec('ALTER TABLE projects DROP COLUMN rundown_json');
    db.exec('PRAGMA user_version = 5');
    db.close();
  });
});

test('repairs v6 logical id conflicts and removes groupId while preserving the grouped rundown schedule', async () => {
  const sharedId = 'shot-unit-existing-rundown';
  const scheduledAlternateId = 'shot-unit-scheduled-alternate';
  const rundownJson = JSON.stringify({
    version: 1,
    days: [{
      id: 'day-1', date: '2026-08-18',
      items: [
        { id: 'item-1', type: 'shot', shotUnitId: sharedId, startTime: '09:00', endTime: '10:00', setupLabel: '原排期' },
        { id: 'item-2', type: 'shot', shotUnitId: scheduledAlternateId, startTime: '10:00', endTime: '11:00', setupLabel: '历史排期' }
      ]
    }]
  });
  await withServer(async (baseUrl, databasePath) => {
    const admin = await login(baseUrl);
    const project = await (await api(baseUrl, admin, '/api/projects/1')).json();
    assert.notEqual(project.shots[0].shotUnitId, sharedId);
    assert.equal(project.shots[1].shotUnitId, sharedId);
    assert.equal(project.shots[2].shotUnitId, sharedId);
    assert.equal(project.shots[3].shotUnitId, sharedId);
    assert.equal(project.shots[4].shotUnitId, scheduledAlternateId);
    assert.equal(project.shots[5].shotUnitId, scheduledAlternateId);
    assert.ok(project.shots.every((shot) => !Object.prototype.hasOwnProperty.call(shot, 'groupId')));
    assert.equal(project.rundown.days[0].items[0].shotUnitId, sharedId);
    assert.equal(project.rundown.days[0].items[1].shotUnitId, scheduledAlternateId);

    const db = openDatabase(databasePath);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
    assert.equal(db.prepare('SELECT rundown_json FROM projects WHERE id = 1').get().rundown_json, rundownJson);
    db.close();
    const backupFiles = readdirSync(path.join(path.dirname(databasePath), 'backups'));
    const backup = backupFiles.find((name) => name.startsWith('storyboard-v6-') && name.endsWith('.db'));
    assert.ok(backup);
    assert.ok(backupFiles.includes(`${backup}.sha256`));
  }, async (databasePath) => {
    await initialize(databasePath);
    const db = openDatabase(databasePath);
    const result = db.prepare('INSERT INTO projects (name, shots_json, rundown_json) VALUES (?, ?, ?)').run(
      'Conflicting v6 grouping',
      JSON.stringify([
        { shotUnitId: sharedId, action: '拆出的独立镜头' },
        { shotUnitId: sharedId, groupId: 'group-a', action: '编组镜头一' },
        { shotUnitId: sharedId, groupId: 'group-a', action: '编组镜头二' },
        { shotUnitId: sharedId, groupId: 'group-a', action: '编组镜头三' },
        { shotUnitId: 'shot-unit-unscheduled-first', groupId: 'mixed-id-group', action: '历史 ID 一' },
        { shotUnitId: scheduledAlternateId, groupId: 'mixed-id-group', action: '历史 ID 二' }
      ]),
      rundownJson
    );
    const adminId = Number(db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id);
    db.prepare("INSERT INTO project_members (project_id, user_id, role, created_by_user_id, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?)")
      .run(Number(result.lastInsertRowid), adminId, adminId, Date.now(), Date.now());
    db.prepare('DELETE FROM schema_migrations WHERE version = 7').run();
    db.prepare('DELETE FROM schema_migrations WHERE version = 8').run();
    db.exec('PRAGMA user_version = 6');
    db.close();
  });
});

test('migrates v7 groups to repeated shotUnitId values without rewriting Rundown', async () => {
  const firstGroupId = 'shot-unit-v7-group-a';
  const independentId = 'shot-unit-v7-independent';
  const earlySingleIdGroup = 'shot-unit-v7-without-group-id';
  const secondGroupId = 'shot-unit-v7-group-b';
  const rundownJson = JSON.stringify({
    version: 1,
    days: [{
      id: 'day-1', date: '2026-08-18',
      items: [
        { id: 'item-1', type: 'shot', shotUnitId: firstGroupId, startTime: '09:00', endTime: '10:00', setupLabel: '编组排期' },
        { id: 'item-2', type: 'shot', shotUnitId: independentId, startTime: '10:00', endTime: '11:00', setupLabel: '独立排期' }
      ]
    }]
  });
  await withServer(async (baseUrl, databasePath) => {
    const admin = await login(baseUrl);
    const project = await (await api(baseUrl, admin, '/api/projects/1')).json();
    assert.equal(project.shots[0].shotUnitId, firstGroupId);
    assert.equal(project.shots[1].shotUnitId, firstGroupId);
    assert.equal(project.shots[2].shotUnitId, independentId);
    assert.equal(project.shots[3].shotUnitId, earlySingleIdGroup);
    assert.equal(project.shots[4].shotUnitId, earlySingleIdGroup);
    assert.equal(project.shots[6].shotUnitId, secondGroupId);
    assert.equal(project.shots[7].shotUnitId, secondGroupId);
    assert.equal(project.shots[8].shotUnitId, secondGroupId);
    assert.ok(project.shots.every((shot) => !Object.prototype.hasOwnProperty.call(shot, 'groupId')));
    assert.deepEqual(project.rundown.days[0].items.map((item) => item.shotUnitId), [firstGroupId, independentId]);

    const db = openDatabase(databasePath);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
    assert.equal(db.prepare('SELECT rundown_json FROM projects WHERE id = 1').get().rundown_json, rundownJson);
    const rawShots = JSON.parse(db.prepare('SELECT shots_json FROM projects WHERE id = 1').get().shots_json);
    assert.ok(rawShots.every((shot) => !Object.prototype.hasOwnProperty.call(shot, 'groupId')));
    db.close();
    const backupFiles = readdirSync(path.join(path.dirname(databasePath), 'backups'));
    const backup = backupFiles.find((name) => name.startsWith('storyboard-v7-') && name.endsWith('.db'));
    assert.ok(backup);
    assert.ok(backupFiles.includes(`${backup}.sha256`));
  }, async (databasePath) => {
    await initialize(databasePath);
    const db = openDatabase(databasePath);
    const result = db.prepare('INSERT INTO projects (name, shots_json, rundown_json) VALUES (?, ?, ?)').run(
      'V7 grouped project',
      JSON.stringify([
        { shotUnitId: firstGroupId, groupId: 'legacy-group-a', action: '组 A 一' },
        { shotUnitId: firstGroupId, groupId: 'legacy-group-a', action: '组 A 二' },
        { shotUnitId: independentId, action: '独立镜头' },
        { shotUnitId: earlySingleIdGroup, action: '无旧字段编组一' },
        { shotUnitId: earlySingleIdGroup, action: '无旧字段编组二' },
        { type: 'scene-divider', label: '第二场', groupId: 'unexpected-divider-group' },
        { shotUnitId: secondGroupId, groupId: 'legacy-group-b', action: '组 B 一' },
        { shotUnitId: secondGroupId, groupId: 'legacy-group-b', action: '组 B 二' },
        { shotUnitId: secondGroupId, groupId: 'legacy-group-b', action: '组 B 三' }
      ]),
      rundownJson
    );
    const adminId = Number(db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id);
    db.prepare("INSERT INTO project_members (project_id, user_id, role, created_by_user_id, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?)")
      .run(Number(result.lastInsertRowid), adminId, adminId, Date.now(), Date.now());
    db.prepare('DELETE FROM schema_migrations WHERE version = 8').run();
    db.exec('PRAGMA user_version = 7');
    db.close();
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
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
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
    assert.equal(migrated.fingerprint.projectCount, before.projectCount);
    assert.equal(migrated.fingerprint.imageCount, before.imageCount);
    assert.equal(migrated.fingerprint.imageHash, before.imageHash);
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
