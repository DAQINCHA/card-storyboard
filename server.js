const crypto = require('node:crypto');
const { createReadStream, existsSync, mkdirSync, statSync } = require('node:fs');
const { createServer } = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  LoginRateLimiter,
  RegistrationRateLimiter,
  deriveCsrfToken,
  hashPassword,
  hashTemporaryPassword,
  normalizeUsername,
  parseCookies,
  performDummyPasswordCheck,
  randomToken,
  serializeCookie,
  stableHash,
  tokenHash,
  validatePassword,
  verifyPassword
} = require('./lib/security');
const {
  SCHEMA_VERSION,
  assertCurrentSchema,
  collectRundownShotUnitIds,
  collectDataFingerprint,
  migrateDatabase,
  normalizeSingleIdShotUnits,
  openDatabase,
  restoreDatabase,
  setupDatabase
} = require('./lib/schema');

const DEFAULT_PORT = 5199;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'storyboard.db');

function lanAddresses() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if ((item.family === 'IPv4' || item.family === 4) && !item.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address) && !found.includes(item.address)) found.push(item.address);
    }
  }
  return found;
}

const DEFAULT_PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_COOKIE = 'storyboard_session';
const SHARE_COOKIE = 'storyboard_share';
const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PROJECT_PRESENCE_MS = 30000;
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
const EDIT_LOCK_MS = 60 * 1000;
const IMAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const STABLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const RUNDOWN_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RUNDOWN_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const IMAGE_DATA_URL_PATTERN = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i;
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.gif', 'image/gif'], ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'], ['.jpeg', 'image/jpeg'], ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'], ['.png', 'image/png'], ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'], ['.webp', 'image/webp'], ['.woff2', 'font/woff2']
]);

class HttpError extends Error {
  constructor(statusCode, message, code = 'request_error', details = null, headers = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

function safeParseShots(shotsJson) {
  try {
    const parsed = JSON.parse(shotsJson || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isSceneDividerShot(shot) {
  return Boolean(shot && typeof shot === 'object' && shot.type === 'scene-divider');
}

function normalizeStableId(value) {
  const id = String(value || '').trim();
  return STABLE_ID_PATTERN.test(id) ? id : '';
}

function parseRundown(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeRundown(value, validShotUnitIds = new Set()) {
  const source = parseRundown(value);
  const seenShotUnitIds = new Set();
  const seenDayIds = new Set();
  const days = [];
  const sourceDays = Array.isArray(source.days) ? source.days.slice(0, 500) : [];
  sourceDays.forEach((sourceDay) => {
    if (!sourceDay || typeof sourceDay !== 'object' || Array.isArray(sourceDay)) return;
    let dayId = normalizeStableId(sourceDay.id);
    if (!dayId || seenDayIds.has(dayId)) dayId = crypto.randomUUID();
    seenDayIds.add(dayId);
    const items = [];
    const seenItemIds = new Set();
    const sourceItems = Array.isArray(sourceDay.items) ? sourceDay.items.slice(0, 5000) : [];
    sourceItems.forEach((sourceItem) => {
      if (!sourceItem || typeof sourceItem !== 'object' || Array.isArray(sourceItem)) return;
      const type = sourceItem.type === 'event' ? 'event' : 'shot';
      let itemId = normalizeStableId(sourceItem.id);
      if (!itemId || seenItemIds.has(itemId)) itemId = crypto.randomUUID();
      seenItemIds.add(itemId);
      const base = {
        id: itemId,
        type,
        startTime: RUNDOWN_TIME_PATTERN.test(String(sourceItem.startTime || '')) ? String(sourceItem.startTime) : '',
        endTime: RUNDOWN_TIME_PATTERN.test(String(sourceItem.endTime || '')) ? String(sourceItem.endTime) : '',
        setupLabel: String(sourceItem.setupLabel || '').trim().slice(0, 160)
      };
      if (type === 'event') {
        items.push({ ...base, title: String(sourceItem.title || '').trim().slice(0, 240) });
        return;
      }
      const shotUnitId = normalizeStableId(sourceItem.shotUnitId);
      if (!shotUnitId || !validShotUnitIds.has(shotUnitId) || seenShotUnitIds.has(shotUnitId)) return;
      seenShotUnitIds.add(shotUnitId);
      items.push({ ...base, shotUnitId });
    });
    days.push({
      id: dayId,
      date: RUNDOWN_DATE_PATTERN.test(String(sourceDay.date || '')) ? String(sourceDay.date) : '',
      items
    });
  });
  return { version: 1, days };
}

function ensureLogicalShotUnitIds(shots, preferredUnitIds = new Set()) {
  return normalizeSingleIdShotUnits(shots, { preferredUnitIds }).shots;
}

function normalizeProjectId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeImageId(value) {
  const id = String(value || '').trim();
  return IMAGE_ID_PATTERN.test(id) ? id : null;
}

function normalizePresenceId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{16,80}$/.test(id) ? id : null;
}

function buildImageUrl(projectId, imageId) {
  return `/api/projects/${projectId}/images/${encodeURIComponent(imageId)}`;
}

function buildShareImageUrl(imageId) {
  return `/api/share/images/${encodeURIComponent(imageId)}`;
}

function parseImageDataUrl(imageSrc) {
  if (typeof imageSrc !== 'string') return null;
  const match = IMAGE_DATA_URL_PATTERN.exec(imageSrc);
  if (!match) return null;
  const imageData = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!imageData.length) throw new Error('Image data is empty');
  if (imageData.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 8 MB limit');
  return { mimeType: match[1].toLowerCase(), imageData };
}

function extractImageIdFromUrl(projectId, imageSrc) {
  if (typeof imageSrc !== 'string') return null;
  const prefixes = [`/api/projects/${projectId}/images/`, '/api/share/images/'];
  let pathname;
  try {
    pathname = new URL(imageSrc, 'http://storyboard.local').pathname;
  } catch {
    return null;
  }
  const prefix = prefixes.find((item) => pathname.startsWith(item));
  if (!prefix) return null;
  try {
    return normalizeImageId(decodeURIComponent(pathname.slice(prefix.length)));
  } catch {
    return null;
  }
}

function roleCapabilities(role, isAdmin = false) {
  const admin = Boolean(isAdmin);
  const canEdit = admin || role === 'owner' || role === 'editor';
  const canManage = admin || role === 'owner';
  return {
    canView: admin || ['owner', 'editor', 'viewer'].includes(role),
    canEdit,
    canDuplicate: canEdit,
    canDelete: canManage,
    canManageMembers: canManage,
    canManageShareLinks: canManage,
    canTransferOwnership: canManage,
    canForceLock: canManage,
    canExportPdf: true
  };
}

function decorateShotsWithImageUrls(projectId, shots, share = false) {
  return shots.map((shot) => {
    if (!shot || typeof shot !== 'object' || isSceneDividerShot(shot)) return shot;
    const imageId = normalizeImageId(shot.imageId);
    if (!imageId) return shot;
    return { ...shot, imageId, hasImage: true, imageSrc: share ? buildShareImageUrl(imageId) : buildImageUrl(projectId, imageId) };
  });
}

function toProjectSummary(row, user) {
  const shots = safeParseShots(row.shots_json);
  const firstImage = shots.find((shot) => shot && shot.hasImage && normalizeImageId(shot.imageId));
  const role = user?.isAdmin ? 'admin' : row.access_role;
  return {
    id: row.id, name: row.name, scene: row.scene, aspectRatio: row.aspect_ratio,
    shotCount: shots.filter((shot) => !isSceneDividerShot(shot)).length,
    previewImage: firstImage ? buildImageUrl(row.id, normalizeImageId(firstImage.imageId)) : '',
    updatedAt: row.updated_at, version: row.version, accessRole: role,
    owner: {
      id: row.owner_id,
      username: row.owner_username,
      displayName: row.owner_display_name
    },
    capabilities: roleCapabilities(row.access_role, user?.isAdmin)
  };
}

function toProjectDetail(row, user, { share = false, lock = null } = {}) {
  const role = share ? 'anonymous' : (user?.isAdmin ? 'admin' : row.access_role);
  const shots = safeParseShots(row.shots_json);
  const validShotUnitIds = new Set(shots.filter((shot) => !isSceneDividerShot(shot)).map((shot) => normalizeStableId(shot?.shotUnitId)).filter(Boolean));
  return {
    id: row.id, name: row.name, scene: row.scene, aspectRatio: row.aspect_ratio,
    shots: decorateShotsWithImageUrls(row.id, shots, share),
    rundown: normalizeRundown(row.rundown_json, validShotUnitIds),
    updatedAt: row.updated_at, version: row.version, accessRole: role,
    capabilities: share ? {
      canView: true, canEdit: false, canDuplicate: false, canDelete: false,
      canManageMembers: false, canManageShareLinks: false, canTransferOwnership: false,
      canForceLock: false, canExportPdf: true
    } : roleCapabilities(row.access_role, user?.isAdmin),
    editLock: lock
  };
}

function createStoryboardStore(databasePath) {
  migrateDatabase(databasePath);
  const db = openDatabase(databasePath);
  try {
    assertCurrentSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const canonicalAdmin = db.prepare("SELECT id FROM users WHERE username = 'admin' AND is_admin = 1 AND is_active = 1").get();
  if (!canonicalAdmin) {
    db.close();
    throw new Error('Database has no active admin account');
  }
  const extraAdmins = db.prepare("SELECT id, username FROM users WHERE username <> 'admin' AND is_admin = 1").all();
  if (extraAdmins.length) {
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      extraAdmins.forEach((user) => {
        db.prepare('UPDATE users SET is_admin = 0, session_version = session_version + 1, updated_at = ? WHERE id = ?').run(now, user.id);
        db.prepare(`INSERT INTO security_audit_events (event_type, actor_user_id, target_user_id, metadata_json, created_at) VALUES ('admin_status_reconciled', ?, ?, ?, ?)`)
          .run(canonicalAdmin.id, user.id, JSON.stringify({ username: user.username, isAdmin: false }), now);
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  const cleanupNow = Date.now();
  db.prepare('DELETE FROM user_sessions WHERE revoked_at IS NOT NULL OR idle_expires_at <= ? OR absolute_expires_at <= ?').run(cleanupNow, cleanupNow);

  const getProjectRowStmt = db.prepare('SELECT id, name, scene, aspect_ratio, shots_json, rundown_json, updated_at, version FROM projects WHERE id = ?');
  const createProjectStmt = db.prepare("INSERT INTO projects (name, scene, aspect_ratio, shots_json, rundown_json, updated_at, version) VALUES (?, '', '16/9', '[]', '{\"version\":1,\"days\":[]}', strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime'), 1)");
  const updateProjectStmt = db.prepare(`UPDATE projects SET name = ?, scene = ?, aspect_ratio = ?, shots_json = ?, rundown_json = ?, updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime'), version = version + 1 WHERE id = ? AND version = ?`);
  const deleteProjectStmt = db.prepare('DELETE FROM projects WHERE id = ?');
  const getImageStmt = db.prepare('SELECT mime_type, image_data FROM project_images WHERE project_id = ? AND image_id = ?');
  const imageExistsStmt = db.prepare('SELECT 1 FROM project_images WHERE project_id = ? AND image_id = ?');
  const listImageIdsStmt = db.prepare('SELECT image_id FROM project_images WHERE project_id = ?');
  const deleteImageStmt = db.prepare('DELETE FROM project_images WHERE project_id = ? AND image_id = ?');
  const upsertImageStmt = db.prepare(`INSERT INTO project_images (project_id, image_id, mime_type, image_data, updated_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime')) ON CONFLICT (project_id, image_id) DO UPDATE SET mime_type = excluded.mime_type, image_data = excluded.image_data, updated_at = excluded.updated_at`);
  const copyImagesStmt = db.prepare(`INSERT INTO project_images (project_id, image_id, mime_type, image_data, updated_at) SELECT ?, image_id, mime_type, image_data, strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime') FROM project_images WHERE project_id = ?`);

  function transaction(action, mode = 'IMMEDIATE') {
    db.exec(`BEGIN ${mode}`);
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function audit(eventType, { actorUserId = null, targetUserId = null, projectId = null, shareLinkId = null, metadata = {} } = {}) {
    db.prepare(`INSERT INTO security_audit_events (event_type, actor_user_id, target_user_id, project_id, share_link_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(eventType, actorUserId, targetUserId, projectId, shareLinkId, JSON.stringify(metadata), Date.now());
  }

  function getUserByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
  }

  function publicUser(row) {
    return row ? {
      id: row.id, username: row.username, displayName: row.display_name,
      isAdmin: row.username === 'admin' && Boolean(row.is_admin), isActive: Boolean(row.is_active),
      mustChangePassword: Boolean(row.must_change_password)
    } : null;
  }

  function createSession(user, rawToken, csrfToken, userAgent) {
    const now = Date.now();
    const result = db.prepare(`INSERT INTO user_sessions (user_id, token_hash, csrf_token_hash, session_version, created_at, last_seen_at, idle_expires_at, absolute_expires_at, user_agent_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(user.id, tokenHash(rawToken), tokenHash(csrfToken), user.session_version, now, now, now + SESSION_IDLE_MS, now + SESSION_ABSOLUTE_MS, stableHash(userAgent));
    db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now, now, user.id);
    return Number(result.lastInsertRowid);
  }

  function getSession(rawToken) {
    if (!rawToken) return null;
    const now = Date.now();
    const row = db.prepare(`
      SELECT s.*, u.username, u.display_name, u.is_admin, u.is_active, u.must_change_password,
             u.session_version AS current_session_version
      FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL
    `).get(tokenHash(rawToken));
    if (!row || !row.is_active || row.session_version !== row.current_session_version || row.idle_expires_at <= now || row.absolute_expires_at <= now) {
      if (row) db.prepare('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(now, row.id);
      return null;
    }
    if (now - row.last_seen_at >= 5 * 60 * 1000) {
      db.prepare('UPDATE user_sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?').run(now, Math.min(now + SESSION_IDLE_MS, row.absolute_expires_at), row.id);
    }
    return {
      id: row.id, userId: row.user_id, username: row.username, displayName: row.display_name,
      isAdmin: row.username === 'admin' && Boolean(row.is_admin), mustChangePassword: Boolean(row.must_change_password),
      csrfTokenHash: Buffer.from(row.csrf_token_hash)
    };
  }

  function revokeSession(sessionId) {
    db.prepare('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(Date.now(), sessionId);
    db.prepare('DELETE FROM project_edit_locks WHERE session_id = ?').run(sessionId);
  }

  function revokeUserSessions(userId) {
    const now = Date.now();
    db.prepare('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?').run(now, userId);
    db.prepare('DELETE FROM project_edit_locks WHERE user_id = ?').run(userId);
  }

  function getProjectAccess(projectId, user) {
    const row = db.prepare(`
      SELECT p.id, p.name, p.scene, p.aspect_ratio, p.shots_json, p.rundown_json, p.updated_at, p.version, pm.role AS access_role
      FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
      WHERE p.id = ? AND (? = 1 OR pm.user_id IS NOT NULL)
    `).get(user.id, projectId, user.isAdmin ? 1 : 0);
    return row || null;
  }

  function requireProjectAccess(projectId, user, permission = 'view') {
    const row = getProjectAccess(projectId, user);
    if (!row) throw new HttpError(404, 'Project not found', 'project_not_found');
    const capabilities = roleCapabilities(row.access_role, user.isAdmin);
    const permissionMap = { view: 'canView', edit: 'canEdit', manage: 'canManageMembers', delete: 'canDelete', duplicate: 'canDuplicate' };
    if (!capabilities[permissionMap[permission]]) throw new HttpError(404, 'Project not found', 'project_not_found');
    if (user.isAdmin && !row.access_role) {
      audit('admin_project_access', { actorUserId: user.id, projectId, metadata: { permission } });
    }
    return row;
  }

  function listProjects(user, search, sort) {
    const rows = db.prepare(`
      SELECT p.id, p.name, p.scene, p.aspect_ratio, p.shots_json, p.updated_at, p.version,
             pm.role AS access_role, owner.id AS owner_id, owner.username AS owner_username,
             owner.display_name AS owner_display_name
      FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
      JOIN project_members ownership ON ownership.project_id = p.id AND ownership.role = 'owner'
      JOIN users owner ON owner.id = ownership.user_id
      WHERE ? = 1 OR pm.user_id IS NOT NULL
    `).all(user.id, user.isAdmin ? 1 : 0);
    const query = String(search || '').toLowerCase();
    let result = rows.map((row) => toProjectSummary(row, user));
    if (query) result = result.filter((item) => `${item.name} ${item.scene} ${item.owner.displayName} ${item.owner.username}`.toLowerCase().includes(query));
    if (sort === 'name_asc') result.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    else if (sort === 'updated_asc') result.sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
    else result.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return result;
  }

  function buildNextProjectName(user) {
    const names = new Set(db.prepare(`
      SELECT p.name
      FROM projects p
      JOIN project_members pm ON pm.project_id = p.id
      WHERE pm.user_id = ? AND pm.role = 'owner'
    `).all(user.id).map((row) => String(row.name || '').trim()));
    let suffix = 1;
    while (names.has(`新项目 ${suffix}`)) suffix += 1;
    return `新项目 ${suffix}`;
  }

  function createProject(user, payload = {}) {
    const requestedName = String(payload.name || '').trim();
    const sourceId = normalizeProjectId(payload.sourceProjectId);
    const row = transaction(() => {
      let source = null;
      if (sourceId) source = requireProjectAccess(sourceId, user, 'duplicate');
      const name = requestedName && requestedName !== '新项目' ? requestedName : buildNextProjectName(user);
      const result = createProjectStmt.run(name);
      const projectId = Number(result.lastInsertRowid);
      const now = Date.now();
      db.prepare(`INSERT INTO project_members (project_id, user_id, role, created_by_user_id, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?)`)
        .run(projectId, user.id, user.id, now, now);
      if (source) {
        db.prepare(`UPDATE projects SET scene = ?, aspect_ratio = ?, shots_json = ?, rundown_json = ?, updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime') WHERE id = ?`)
          .run(source.scene, source.aspect_ratio, source.shots_json, source.rundown_json, projectId);
        copyImagesStmt.run(projectId, sourceId);
      }
      return getProjectAccess(projectId, user);
    });
    return toProjectDetail(row, user);
  }

  function normalizeShotForStorage(projectId, shot, referencedImageIds) {
    if (!shot || typeof shot !== 'object') return shot;
    const normalized = { ...shot };
    if (isSceneDividerShot(shot)) {
      delete normalized.imageId; delete normalized.imageSrc; delete normalized.hasImage;
      return normalized;
    }
    const imageSrc = typeof shot.imageSrc === 'string' ? shot.imageSrc : '';
    const dataUrlImage = imageSrc.startsWith('data:') ? parseImageDataUrl(imageSrc) : null;
    if (imageSrc.startsWith('data:') && !dataUrlImage) throw new Error('Unsupported image format');
    const imageId = normalizeImageId(shot.imageId) || extractImageIdFromUrl(projectId, imageSrc);
    if (dataUrlImage) {
      const storedImageId = imageId || crypto.randomUUID();
      upsertImageStmt.run(projectId, storedImageId, dataUrlImage.mimeType, dataUrlImage.imageData);
      referencedImageIds.add(storedImageId);
      normalized.imageId = storedImageId; normalized.hasImage = true; delete normalized.imageSrc;
      return normalized;
    }
    if (shot.hasImage !== false && imageId && imageExistsStmt.get(projectId, imageId)) {
      referencedImageIds.add(imageId);
      normalized.imageId = imageId; normalized.hasImage = true; delete normalized.imageSrc;
      return normalized;
    }
    delete normalized.imageId; delete normalized.imageSrc; normalized.hasImage = false;
    return normalized;
  }

  function normalizeShotsForStorage(projectId, shots, preferredUnitIds = new Set()) {
    const referenced = new Set();
    const normalized = shots.map((shot) => normalizeShotForStorage(projectId, shot, referenced));
    listImageIdsStmt.all(projectId).forEach(({ image_id: imageId }) => {
      if (!referenced.has(imageId)) deleteImageStmt.run(projectId, imageId);
    });
    return ensureLogicalShotUnitIds(normalized, preferredUnitIds);
  }

  function getLockRow(projectId) {
    return db.prepare(`SELECT l.*, u.username, u.display_name FROM project_edit_locks l JOIN users u ON u.id = l.user_id WHERE l.project_id = ?`).get(projectId) || null;
  }

  function currentLock(projectId) {
    const row = getLockRow(projectId);
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      db.prepare('DELETE FROM project_edit_locks WHERE project_id = ?').run(projectId);
      return null;
    }
    return row;
  }

  function touchProjectPresence(projectId, user, session, presenceId) {
    requireProjectAccess(projectId, user, 'view');
    const normalizedPresenceId = normalizePresenceId(presenceId);
    if (!normalizedPresenceId) throw new HttpError(400, 'Project presence id is invalid', 'invalid_presence_id');
    const now = Date.now();
    db.prepare('DELETE FROM project_presence WHERE expires_at <= ?').run(now);
    db.prepare(`INSERT INTO project_presence (project_id, user_id, session_id, presence_id, heartbeat_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id, session_id, presence_id) DO UPDATE SET user_id = excluded.user_id, heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at`)
      .run(projectId, user.id, session.id, normalizedPresenceId, now, now + PROJECT_PRESENCE_MS);
    return { expiresAt: now + PROJECT_PRESENCE_MS };
  }

  function releaseProjectPresence(projectId, session, presenceId) {
    const normalizedPresenceId = normalizePresenceId(presenceId);
    if (!normalizedPresenceId) throw new HttpError(400, 'Project presence id is invalid', 'invalid_presence_id');
    db.prepare('DELETE FROM project_presence WHERE project_id = ? AND session_id = ? AND presence_id = ?')
      .run(projectId, session.id, normalizedPresenceId);
  }

  function listActivePresenceUserIds() {
    const now = Date.now();
    db.prepare('DELETE FROM project_presence WHERE expires_at <= ?').run(now);
    return db.prepare('SELECT DISTINCT user_id FROM project_presence WHERE expires_at > ? ORDER BY user_id')
      .all(now)
      .map((row) => Number(row.user_id));
  }

  function publicLock(row, sessionId = null) {
    return row ? {
      held: true, isMine: row.session_id === sessionId, userId: row.user_id,
      username: row.username, displayName: row.display_name, acquiredAt: row.acquired_at,
      heartbeatAt: row.heartbeat_at, expiresAt: row.expires_at
    } : { held: false, isMine: false };
  }

  function acquireLock(projectId, user, session, force = false) {
    const project = requireProjectAccess(projectId, user, 'edit');
    const existing = currentLock(projectId);
    const capabilities = roleCapabilities(project.access_role, user.isAdmin);
    if (existing && existing.session_id !== session.id && !(force && capabilities.canForceLock)) {
      throw new HttpError(423, 'Project is being edited by another user', 'project_locked', publicLock(existing, session.id));
    }
    const rawLease = randomToken();
    const now = Date.now();
    transaction(() => {
      db.prepare(`INSERT INTO project_edit_locks (project_id, user_id, session_id, lease_token_hash, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (project_id) DO UPDATE SET user_id = excluded.user_id, session_id = excluded.session_id, lease_token_hash = excluded.lease_token_hash, acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at`)
        .run(projectId, user.id, session.id, tokenHash(rawLease), now, now, now + EDIT_LOCK_MS);
      if (existing && existing.session_id !== session.id) audit('edit_lock_forced', { actorUserId: user.id, projectId, metadata: { previousUserId: existing.user_id } });
    });
    return { leaseToken: rawLease, expiresAt: now + EDIT_LOCK_MS, version: project.version };
  }

  function leaseMatches(lock, session, rawLease) {
    if (!lock || lock.session_id !== session.id || !rawLease) return null;
    const supplied = tokenHash(rawLease);
    const expected = Buffer.from(lock.lease_token_hash);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected) ? lock : null;
  }

  function validateLease(projectId, session, rawLease) {
    return leaseMatches(currentLock(projectId), session, rawLease);
  }

  function editLockLostError(projectId, session) {
    const holder = currentLock(projectId);
    return new HttpError(
      423,
      'Edit lock is no longer valid',
      'edit_lock_lost',
      holder ? publicLock(holder, session.id) : null
    );
  }

  function heartbeatLock(projectId, user, session, rawLease) {
    requireProjectAccess(projectId, user, 'edit');
    // A hidden Chrome tab or a sleeping Mac can delay timers beyond the lease TTL.
    // Renew the same, otherwise untouched lease even when its timestamp has just
    // elapsed. If another editor has acquired the lock, the stored token differs
    // and the old tab still loses the lock normally.
    if (!leaseMatches(getLockRow(projectId), session, rawLease)) throw editLockLostError(projectId, session);
    const now = Date.now();
    db.prepare('UPDATE project_edit_locks SET heartbeat_at = ?, expires_at = ? WHERE project_id = ?').run(now, now + EDIT_LOCK_MS, projectId);
    return { expiresAt: now + EDIT_LOCK_MS };
  }

  function releaseLock(projectId, session, rawLease) {
    if (validateLease(projectId, session, rawLease)) db.prepare('DELETE FROM project_edit_locks WHERE project_id = ?').run(projectId);
  }

  function saveProject(projectId, user, session, rawLease, payload) {
    return transaction(() => {
      const current = requireProjectAccess(projectId, user, 'edit');
      if (!validateLease(projectId, session, rawLease)) throw editLockLostError(projectId, session);
      const baseVersion = Number(payload.baseVersion);
      if (!Number.isInteger(baseVersion) || baseVersion !== current.version) {
        throw new HttpError(409, 'Project was changed by another editor', 'version_conflict', { currentVersion: current.version });
      }
      const name = String(payload.name ?? current.name).trim() || '未命名项目';
      const scene = String(payload.scene ?? current.scene);
      const aspectRatio = String(payload.aspectRatio ?? current.aspect_ratio) || '16/9';
      const shots = Array.isArray(payload.shots) ? payload.shots : safeParseShots(current.shots_json);
      const rundownSource = Object.prototype.hasOwnProperty.call(payload, 'rundown') ? payload.rundown : current.rundown_json;
      const normalizedShots = normalizeShotsForStorage(projectId, shots, collectRundownShotUnitIds(rundownSource));
      const validShotUnitIds = new Set(normalizedShots.filter((shot) => !isSceneDividerShot(shot)).map((shot) => normalizeStableId(shot?.shotUnitId)).filter(Boolean));
      const normalizedRundown = normalizeRundown(rundownSource, validShotUnitIds);
      const result = updateProjectStmt.run(name, scene, aspectRatio, JSON.stringify(normalizedShots), JSON.stringify(normalizedRundown), projectId, baseVersion);
      if (Number(result.changes) !== 1) throw new HttpError(409, 'Project was changed by another editor', 'version_conflict');
      return toProjectDetail(getProjectAccess(projectId, user), user, { lock: publicLock(currentLock(projectId), session.id) });
    });
  }

  function deleteProject(projectId, user) {
    requireProjectAccess(projectId, user, 'delete');
    transaction(() => {
      audit('project_deleted', { actorUserId: user.id, projectId, metadata: { deletedProjectId: projectId } });
      deleteProjectStmt.run(projectId);
    });
  }

  function listMembers(projectId, user) {
    requireProjectAccess(projectId, user, 'manage');
    return db.prepare(`SELECT u.id, u.username, u.display_name, pm.role, pm.created_at, pm.updated_at FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY CASE pm.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.username`).all(projectId)
      .map((row) => ({ id: row.id, username: row.username, displayName: row.display_name, role: row.role, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  function addOrUpdateMember(projectId, user, username, role) {
    requireProjectAccess(projectId, user, 'manage');
    if (!['editor', 'viewer'].includes(role)) throw new HttpError(400, 'Invalid member role', 'invalid_role');
    const target = getUserByUsername(username);
    if (!target || !target.is_active || target.id === user.id) throw new HttpError(404, 'Account is unavailable', 'account_unavailable');
    const now = Date.now();
    transaction(() => {
      const existing = db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, target.id);
      if (existing?.role === 'owner') throw new HttpError(409, 'Project owner role cannot be changed here', 'owner_role_protected');
      db.prepare(`INSERT INTO project_members (project_id, user_id, role, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`).run(projectId, target.id, role, user.id, now, now);
      if (role === 'viewer') db.prepare('DELETE FROM project_edit_locks WHERE project_id = ? AND user_id = ?').run(projectId, target.id);
      audit(existing ? 'project_member_updated' : 'project_member_added', { actorUserId: user.id, targetUserId: target.id, projectId, metadata: { role } });
    });
    return listMembers(projectId, user);
  }

  function removeMember(projectId, user, targetUserId) {
    requireProjectAccess(projectId, user, 'manage');
    const existing = db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, targetUserId);
    if (!existing) throw new HttpError(404, 'Member not found', 'member_not_found');
    if (existing.role === 'owner') throw new HttpError(409, 'Project owner cannot be removed', 'owner_role_protected');
    transaction(() => {
      db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, targetUserId);
      db.prepare('DELETE FROM project_edit_locks WHERE project_id = ? AND user_id = ?').run(projectId, targetUserId);
      audit('project_member_removed', { actorUserId: user.id, targetUserId, projectId });
    });
  }

  function transferOwnership(projectId, user, targetUsername) {
    const project = requireProjectAccess(projectId, user, 'manage');
    const target = getUserByUsername(targetUsername);
    if (!target || !target.is_active) throw new HttpError(404, 'Account is unavailable', 'account_unavailable');
    const oldOwner = db.prepare("SELECT user_id FROM project_members WHERE project_id = ? AND role = 'owner'").get(projectId);
    if (!oldOwner || oldOwner.user_id === target.id) throw new HttpError(409, 'Ownership transfer target is invalid', 'invalid_transfer_target');
    const now = Date.now();
    transaction(() => {
      db.prepare("UPDATE project_members SET role = 'editor', updated_at = ? WHERE project_id = ? AND role = 'owner'").run(now, projectId);
      db.prepare(`INSERT INTO project_members (project_id, user_id, role, created_by_user_id, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?) ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'owner', updated_at = excluded.updated_at`).run(projectId, target.id, user.id, now, now);
      audit('project_ownership_transferred', { actorUserId: user.id, targetUserId: target.id, projectId, metadata: { previousOwnerUserId: oldOwner.user_id, adminOverride: Boolean(user.isAdmin && project.access_role !== 'owner') } });
    });
  }

  function listShareLinks(projectId, user) {
    requireProjectAccess(projectId, user, 'manage');
    return db.prepare('SELECT id, display_number, reusable_token, label, created_at, expires_at, revoked_at, last_used_at FROM project_share_links WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 5').all(projectId)
      .map((row) => ({
        id: row.id,
        displayNumber: row.display_number,
        token: row.reusable_token,
        label: row.label,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        lastUsedAt: row.last_used_at
      }));
  }

  function createShareLink(projectId, user, payload) {
    requireProjectAccess(projectId, user, 'manage');
    const label = String(payload.label || '').trim().slice(0, 80);
    const expiresAt = payload.expiresAt === undefined
      ? Date.now() + 7 * 24 * 60 * 60 * 1000
      : (payload.expiresAt === null ? null : Number(payload.expiresAt));
    if (expiresAt !== null && (!Number.isInteger(expiresAt) || expiresAt <= Date.now())) throw new HttpError(400, 'Share link expiry must be in the future', 'invalid_expiry');
    if (expiresAt !== null && expiresAt > Date.now() + 90 * 24 * 60 * 60 * 1000 + 60_000) throw new HttpError(400, 'Share link expiry cannot exceed 90 days', 'invalid_expiry');
    const rawToken = randomToken();
    const now = Date.now();
    let id;
    let displayNumber;
    transaction(() => {
      displayNumber = Number(db.prepare('SELECT COALESCE(MAX(display_number), 0) + 1 AS next_number FROM project_share_links WHERE project_id = ?').get(projectId).next_number);
      const result = db.prepare('INSERT INTO project_share_links (project_id, token_hash, reusable_token, display_number, label, created_by_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(projectId, tokenHash(rawToken), rawToken, displayNumber, label, user.id, now, expiresAt);
      id = Number(result.lastInsertRowid);
      audit('share_link_created', { actorUserId: user.id, projectId, shareLinkId: id, metadata: { expiresAt } });
      db.prepare(`DELETE FROM project_share_links WHERE project_id = ? AND id NOT IN (
        SELECT id FROM project_share_links WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 5
      )`).run(projectId, projectId);
    });
    return { id, displayNumber, label, token: rawToken, createdAt: now, expiresAt };
  }

  function revokeShareLink(projectId, user, linkId) {
    requireProjectAccess(projectId, user, 'manage');
    transaction(() => {
      const result = db.prepare('UPDATE project_share_links SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND project_id = ?').run(Date.now(), linkId, projectId);
      if (Number(result.changes) !== 1) throw new HttpError(404, 'Share link not found', 'share_link_not_found');
      audit('share_link_revoked', { actorUserId: user.id, projectId, shareLinkId: linkId });
    });
  }

  function getShare(rawToken) {
    if (!rawToken) return null;
    const now = Date.now();
    const row = db.prepare(`SELECT l.*, p.id AS project_exists FROM project_share_links l JOIN projects p ON p.id = l.project_id WHERE (l.token_hash = ? OR l.reusable_token = ?) AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > ?)`).get(tokenHash(rawToken), rawToken, now);
    if (!row) return null;
    if (!row.last_used_at || now - row.last_used_at >= 5 * 60 * 1000) db.prepare('UPDATE project_share_links SET last_used_at = ? WHERE id = ?').run(now, row.id);
    return row;
  }

  function getSharedProject(share) {
    const row = getProjectRowStmt.get(share.project_id);
    return row ? toProjectDetail(row, null, { share: true }) : null;
  }

  function listUsers() {
    return db.prepare(`SELECT u.id, u.username, u.display_name, u.is_admin, u.is_active, u.must_change_password, u.created_at, u.last_login_at, (SELECT COUNT(*) FROM project_members pm WHERE pm.user_id = u.id AND pm.role = 'owner') AS owned_projects FROM users u ORDER BY u.username`).all()
      .map((row) => ({ id: row.id, username: row.username, displayName: row.display_name, isAdmin: row.username === 'admin' && Boolean(row.is_admin), isActive: Boolean(row.is_active), mustChangePassword: Boolean(row.must_change_password), createdAt: row.created_at, lastLoginAt: row.last_login_at, ownedProjects: row.owned_projects }));
  }

  function createUser(actor, { username, displayName, passwordHash }) {
    const now = Date.now();
    try {
      const result = db.prepare(`INSERT INTO users (username, display_name, password_hash, is_admin, is_active, must_change_password, session_version, created_at, updated_at, password_changed_at) VALUES (?, ?, ?, 0, 1, 1, 1, ?, ?, ?)`).run(username, displayName || username, passwordHash, now, now, now);
      const id = Number(result.lastInsertRowid);
      audit('user_created', { actorUserId: actor.id, targetUserId: id, metadata: { isAdmin: false } });
      return id;
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new HttpError(409, 'Account is unavailable', 'account_unavailable');
      throw error;
    }
  }

  function registerUser({ username, displayName, passwordHash, source }) {
    const now = Date.now();
    try {
      return transaction(() => {
        const result = db.prepare(`INSERT INTO users (username, display_name, password_hash, is_admin, is_active, must_change_password, session_version, created_at, updated_at, password_changed_at) VALUES (?, ?, ?, 0, 1, 0, 1, ?, ?, ?)`).run(username, displayName, passwordHash, now, now, now);
        const id = Number(result.lastInsertRowid);
        audit('user_self_registered', {
          actorUserId: id,
          targetUserId: id,
          metadata: { source }
        });
        return getUserByUsername(username);
      });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new HttpError(409, 'Account is unavailable', 'account_unavailable');
      throw error;
    }
  }

  function updateUser(actor, targetUserId, payload) {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId);
    if (!target) throw new HttpError(404, 'Account not found', 'account_not_found');
    const identityChangedByRequest = payload.username !== undefined || payload.displayName !== undefined;
    if (targetUserId === actor.id && identityChangedByRequest) {
      throw new HttpError(409, 'You cannot edit your own account identity', 'cannot_edit_self_identity');
    }
    if (payload.isAdmin !== undefined) throw new HttpError(409, 'Administrator status is fixed', 'admin_status_fixed');
    if (payload.isActive !== undefined) throw new HttpError(409, 'Accounts must be deleted instead of disabled', 'account_status_fixed');
    let username = target.username;
    if (payload.username !== undefined) {
      username = normalizeUsername(payload.username);
      if (!username) throw new HttpError(400, 'Username format is invalid', 'invalid_username');
    }
    const active = Boolean(target.is_active);
    const isAdmin = target.username === 'admin' && Boolean(target.is_admin);
    const displayName = String(payload.displayName ?? target.display_name).trim().slice(0, 80) || username;
    const usernameChanged = username !== target.username;
    const sessionsChanged = usernameChanged;
    try {
      transaction(() => {
        db.prepare('UPDATE users SET username = ?, display_name = ?, session_version = session_version + ?, updated_at = ? WHERE id = ?')
          .run(username, displayName, sessionsChanged ? 1 : 0, Date.now(), targetUserId);
        if (sessionsChanged) revokeUserSessions(targetUserId);
        audit('user_updated', {
          actorUserId: actor.id,
          targetUserId,
          metadata: {
            active,
            isAdmin,
            before: { username: target.username, displayName: target.display_name },
            after: { username, displayName }
          }
        });
      });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new HttpError(409, 'Account is unavailable', 'account_unavailable');
      throw error;
    }
  }

  function deleteUser(actor, targetUserId) {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId);
    if (!target) throw new HttpError(404, 'Account not found', 'account_not_found');
    const admin = db.prepare("SELECT * FROM users WHERE username = 'admin' AND is_admin = 1 AND is_active = 1").get();
    if (!admin) throw new HttpError(409, 'The admin account is unavailable', 'admin_account_unavailable');
    if (target.id === admin.id || target.id === actor.id || target.username === 'admin') {
      throw new HttpError(409, 'The admin account cannot be deleted', 'admin_account_protected');
    }

    const ownedProjects = db.prepare("SELECT project_id FROM project_members WHERE user_id = ? AND role = 'owner' ORDER BY project_id").all(targetUserId);
    const now = Date.now();
    transaction(() => {
      ownedProjects.forEach(({ project_id: projectId }) => {
        db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, admin.id);
        db.prepare("UPDATE project_members SET user_id = ?, created_by_user_id = ?, updated_at = ? WHERE project_id = ? AND user_id = ? AND role = 'owner'")
          .run(admin.id, actor.id, now, projectId, targetUserId);
        audit('project_ownership_transferred', {
          actorUserId: actor.id,
          targetUserId: admin.id,
          projectId,
          metadata: { previousOwnerUserId: targetUserId, accountDeletion: true }
        });
      });
      db.prepare('DELETE FROM project_members WHERE user_id = ?').run(targetUserId);
      audit('user_deleted', {
        actorUserId: actor.id,
        targetUserId,
        metadata: {
          username: target.username,
          displayName: target.display_name,
          transferredProjects: ownedProjects.length,
          transferredToUserId: admin.id
        }
      });
      db.prepare('DELETE FROM users WHERE id = ?').run(targetUserId);
    });
  }

  function resetUserPassword(actor, targetUserId, passwordHash) {
    const result = db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, session_version = session_version + 1, password_changed_at = ?, updated_at = ? WHERE id = ?').run(passwordHash, Date.now(), Date.now(), targetUserId);
    if (Number(result.changes) !== 1) throw new HttpError(404, 'Account not found', 'account_not_found');
    revokeUserSessions(targetUserId);
    audit('user_password_reset', { actorUserId: actor.id, targetUserId });
  }

  function changePassword(userId, passwordHash) {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, session_version = session_version + 1, password_changed_at = ?, updated_at = ? WHERE id = ?').run(passwordHash, Date.now(), Date.now(), userId);
    revokeUserSessions(userId);
    audit('password_changed', { actorUserId: userId, targetUserId: userId });
  }

  return {
    db, audit, publicUser, getUserByUsername, createSession, getSession, revokeSession,
    revokeUserSessions, listProjects, getProjectAccess, requireProjectAccess, createProject,
    getImage: (projectId, imageId) => getImageStmt.get(projectId, imageId) || null,
    getProjectDetail(projectId, user, sessionId) {
      const row = requireProjectAccess(projectId, user, 'view');
      return toProjectDetail(row, user, { lock: publicLock(currentLock(projectId), sessionId) });
    },
    acquireLock, heartbeatLock, releaseLock, saveProject, deleteProject,
    touchProjectPresence, releaseProjectPresence, listActivePresenceUserIds,
    listMembers, addOrUpdateMember, removeMember, transferOwnership,
    listShareLinks, createShareLink, revokeShareLink, getShare, getSharedProject,
    listUsers, createUser, registerUser, updateUser, deleteUser, resetUserPassword, changePassword,
    close() { db.close(); }
  };
}

function applySecurityHeaders(response, secure) {
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(payload));
}

function sendEmpty(response, statusCode, headers = {}) {
  response.writeHead(statusCode, headers);
  response.end();
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) { exceeded = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (exceeded) return reject(new HttpError(413, 'Request body exceeds the 20 MB limit', 'request_too_large'));
      if (!size) return resolve({});
      const type = String(request.headers['content-type'] || '').split(';', 1)[0].trim();
      if (type !== 'application/json') return reject(new HttpError(415, 'Request must use application/json', 'invalid_content_type'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Request body is not valid JSON', 'invalid_json')); }
    });
    request.on('error', reject);
  });
}

function safeStaticFile(publicDir, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const filePath = path.resolve(publicDir, decoded.replace(/^\/+/, ''));
  const root = path.resolve(publicDir);
  return filePath === root || filePath.startsWith(`${root}${path.sep}`) ? filePath : null;
}

function sendStaticFile(request, response, filePath) {
  response.writeHead(200, { 'Content-Type': MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  if (request.method === 'HEAD') return response.end();
  const stream = createReadStream(filePath);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

function createStoryboardApplication({
  databasePath = DEFAULT_DB_PATH,
  publicDir = DEFAULT_PUBLIC_DIR,
  publicOrigin = 'http://localhost:5199',
  allowedOrigins = [publicOrigin],
  secureCookies = publicOrigin.startsWith('https://'),
  passwordParams = {},
  loginRateLimiter = new LoginRateLimiter(),
  registrationRateLimiter = new RegistrationRateLimiter(),
  registrationEnabled = process.env.STORYBOARD_ALLOW_REGISTRATION !== '0'
} = {}) {
  const store = createStoryboardStore(databasePath);

  function authenticate(request, { allowPasswordChange = false } = {}) {
    const rawToken = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    const session = store.getSession(rawToken);
    if (!session) throw new HttpError(401, 'Authentication required', 'authentication_required');
    const auth = { session, rawToken, user: { id: session.userId, username: session.username, displayName: session.displayName, isAdmin: session.isAdmin, mustChangePassword: session.mustChangePassword } };
    if (session.mustChangePassword && !allowPasswordChange) throw new HttpError(403, 'Password change is required', 'password_change_required');
    return auth;
  }

  function validateRequestOrigin(request) {
    const fetchSite = String(request.headers['sec-fetch-site'] || '');
    if (fetchSite === 'cross-site') throw new HttpError(403, 'Cross-site request rejected', 'cross_site_rejected');
    const origin = request.headers.origin;
    if (!origin || allowedOrigins.includes(origin)) return;
    const hostName = (value) => String(value || "").split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
    let originName = "";
    try { originName = new URL(origin).hostname.toLowerCase(); } catch (error) {}
    const candidates = [request.headers.host, request.headers["x-forwarded-host"]].map(hostName).filter(Boolean);
    if (originName && candidates.includes(originName)) return;
    console.warn(`  拒绝来源 ${origin}（Host: ${request.headers.host || "-"}，X-Forwarded-Host: ${request.headers["x-forwarded-host"] || "-"}）`);
    throw new HttpError(403, "Request origin is not allowed", "origin_rejected", { origin, host: request.headers.host || null });
  }

  function requireCsrf(request, auth) {
    validateRequestOrigin(request);
    const supplied = String(request.headers['x-csrf-token'] || '');
    const actual = tokenHash(supplied);
    const expected = auth.session.csrfTokenHash;
    if (!supplied || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new HttpError(403, 'CSRF validation failed', 'csrf_failed');
  }

  function requireAdmin(auth) {
    if (!auth.user.isAdmin) throw new HttpError(404, 'Endpoint not found', 'not_found');
  }

  function requestIp(request) {
    return String(request.socket.remoteAddress || 'unknown');
  }

  function sessionPayload(auth) {
    return { user: store.publicUser({ id: auth.user.id, username: auth.user.username, display_name: auth.user.displayName, is_admin: auth.user.isAdmin, is_active: true, must_change_password: auth.user.mustChangePassword }), csrfToken: deriveCsrfToken(auth.rawToken), insecureHttp: !secureCookies };
  }

  const server = createServer(async (request, response) => {
    applySecurityHeaders(response, secureCookies);
    let url;
    try { url = new URL(request.url, `http://${request.headers.host || 'localhost'}`); }
    catch { return sendJson(response, 400, { error: 'Invalid request URL', code: 'invalid_url' }); }

    try {
      if (request.method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { ok: true, service: 'card-storyboard', schemaVersion: SCHEMA_VERSION });

      if (request.method === 'GET' && url.pathname === '/api/auth/config') {
        return sendJson(response, 200, { registrationEnabled });
      }

      if (url.pathname === '/api/auth/register' && request.method === 'POST') {
        if (!registrationEnabled) throw new HttpError(403, 'Registration is disabled', 'registration_disabled');
        validateRequestOrigin(request);
        const ip = requestIp(request);
        const rate = registrationRateLimiter.consume(ip);
        if (!rate.allowed) throw new HttpError(429, 'Too many registration attempts', 'registration_rate_limited', null, { 'Retry-After': String(rate.retryAfterSeconds) });
        const payload = await readJson(request);
        const username = normalizeUsername(payload.username);
        if (!username) throw new HttpError(400, 'Username format is invalid', 'invalid_username');
        if (typeof payload.displayName !== 'string') throw new HttpError(400, 'Display name is required', 'invalid_display_name');
        const displayName = payload.displayName.trim();
        if (!displayName || Array.from(displayName).length > 80) throw new HttpError(400, 'Display name must contain 1 to 80 characters', 'invalid_display_name');
        if (!validatePassword(payload.password)) throw new HttpError(400, 'Password must contain 12 to 128 characters', 'invalid_password');
        if (store.getUserByUsername(username)) throw new HttpError(409, 'Account is unavailable', 'account_unavailable');
        const user = store.registerUser({
          username,
          displayName,
          passwordHash: await hashPassword(payload.password, passwordParams),
          source: stableHash(ip)
        });
        const rawToken = randomToken();
        const csrfToken = deriveCsrfToken(rawToken);
        store.createSession(user, rawToken, csrfToken, request.headers['user-agent'] || '');
        store.audit('login_succeeded', { actorUserId: user.id, metadata: { source: stableHash(ip), via: 'registration' } });
        const cookie = serializeCookie(SESSION_COOKIE, rawToken, { secure: secureCookies, maxAge: SESSION_ABSOLUTE_MS / 1000 });
        return sendJson(response, 201, { user: store.publicUser(user), csrfToken, insecureHttp: !secureCookies }, { 'Set-Cookie': cookie });
      }

      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        validateRequestOrigin(request);
        const payload = await readJson(request);
        const username = normalizeUsername(payload.username) || String(payload.username || '').trim().toLowerCase().slice(0, 64);
        const submittedPassword = String(payload.password || '');
        const passwordWithinLimit = Buffer.byteLength(submittedPassword, 'utf8') <= 512;
        const ip = requestIp(request);
        const rate = loginRateLimiter.check(ip, username);
        if (!rate.allowed) throw new HttpError(429, 'Too many login attempts', 'login_rate_limited', null, { 'Retry-After': String(rate.retryAfterSeconds) });
        const user = normalizeUsername(username) ? store.getUserByUsername(username) : null;
        const valid = user && user.is_active && passwordWithinLimit
          ? await verifyPassword(submittedPassword, user.password_hash)
          : await performDummyPasswordCheck(submittedPassword, passwordParams);
        if (!valid) {
          loginRateLimiter.recordFailure(ip, username);
          store.audit('login_failed', { targetUserId: user?.id || null, metadata: { source: stableHash(ip) } });
          throw new HttpError(401, '用户名或密码错误', 'invalid_credentials');
        }
        loginRateLimiter.clear(ip, username);
        const rawToken = randomToken();
        const csrfToken = deriveCsrfToken(rawToken);
        store.createSession(user, rawToken, csrfToken, request.headers['user-agent'] || '');
        store.audit('login_succeeded', { actorUserId: user.id, metadata: { source: stableHash(ip) } });
        const cookie = serializeCookie(SESSION_COOKIE, rawToken, { secure: secureCookies, maxAge: SESSION_ABSOLUTE_MS / 1000 });
        return sendJson(response, 200, { user: store.publicUser(user), csrfToken, insecureHttp: !secureCookies }, { 'Set-Cookie': cookie });
      }

      if (url.pathname === '/api/auth/session' && request.method === 'GET') {
        const auth = authenticate(request, { allowPasswordChange: true });
        return sendJson(response, 200, sessionPayload(auth));
      }

      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        const auth = authenticate(request, { allowPasswordChange: true }); requireCsrf(request, auth); store.revokeSession(auth.session.id);
        return sendEmpty(response, 204, { 'Set-Cookie': serializeCookie(SESSION_COOKIE, '', { secure: secureCookies, maxAge: 0 }) });
      }

      if (url.pathname === '/api/auth/change-password' && request.method === 'POST') {
        const auth = authenticate(request, { allowPasswordChange: true }); requireCsrf(request, auth);
        const payload = await readJson(request);
        const user = store.getUserByUsername(auth.user.username);
        if (!await verifyPassword(String(payload.currentPassword || ''), user.password_hash)) throw new HttpError(400, 'Current password is incorrect', 'current_password_incorrect');
        if (!validatePassword(payload.newPassword)) throw new HttpError(400, 'New password must contain 12 to 128 characters', 'invalid_password');
        store.changePassword(user.id, await hashPassword(payload.newPassword, passwordParams));
        return sendEmpty(response, 204, { 'Set-Cookie': serializeCookie(SESSION_COOKIE, '', { secure: secureCookies, maxAge: 0 }) });
      }

      if (url.pathname === '/api/admin/project-presence' && request.method === 'GET') {
        const auth = authenticate(request); requireAdmin(auth);
        return sendJson(response, 200, { userIds: store.listActivePresenceUserIds() });
      }

      if (url.pathname === '/api/admin/users') {
        const auth = authenticate(request); requireAdmin(auth);
        if (request.method === 'GET') return sendJson(response, 200, store.listUsers());
        if (request.method === 'POST') {
          requireCsrf(request, auth); const payload = await readJson(request);
          const username = normalizeUsername(payload.username);
          if (!username) throw new HttpError(400, 'Username format is invalid', 'invalid_username');
          if (payload.isAdmin !== undefined) throw new HttpError(409, 'Administrator status is fixed', 'admin_status_fixed');
          const id = store.createUser(auth.user, { username, displayName: String(payload.displayName || '').trim().slice(0, 80), passwordHash: await hashTemporaryPassword(passwordParams) });
          return sendJson(response, 201, { id });
        }
      }

      const adminUserMatch = /^\/api\/admin\/users\/(\d+)$/.exec(url.pathname);
      if (adminUserMatch && request.method === 'PATCH') {
        const auth = authenticate(request); requireAdmin(auth); requireCsrf(request, auth);
        store.updateUser(auth.user, Number(adminUserMatch[1]), await readJson(request)); return sendEmpty(response, 204);
      }
      if (adminUserMatch && request.method === 'DELETE') {
        const auth = authenticate(request); requireAdmin(auth); requireCsrf(request, auth);
        store.deleteUser(auth.user, Number(adminUserMatch[1])); return sendEmpty(response, 204);
      }
      const adminResetMatch = /^\/api\/admin\/users\/(\d+)\/reset-password$/.exec(url.pathname);
      if (adminResetMatch && request.method === 'POST') {
        const auth = authenticate(request); requireAdmin(auth); requireCsrf(request, auth);
        store.resetUserPassword(auth.user, Number(adminResetMatch[1]), await hashTemporaryPassword(passwordParams)); return sendEmpty(response, 204);
      }

      if (url.pathname === '/api/projects') {
        const auth = authenticate(request);
        if (request.method === 'GET') return sendJson(response, 200, store.listProjects(auth.user, url.searchParams.get('search') || '', url.searchParams.get('sort') || 'updated_desc'));
        if (request.method === 'POST') { requireCsrf(request, auth); return sendJson(response, 201, store.createProject(auth.user, await readJson(request))); }
      }

      const imageMatch = /^\/api\/projects\/([^/]+)\/images\/([^/]+)$/.exec(url.pathname);
      if (imageMatch && request.method === 'GET') {
        const auth = authenticate(request); const projectId = normalizeProjectId(imageMatch[1]); const imageId = normalizeImageId(decodeURIComponent(imageMatch[2]));
        if (!projectId || !imageId) throw new HttpError(404, 'Image not found', 'image_not_found');
        store.requireProjectAccess(projectId, auth.user, 'view'); const image = store.getImage(projectId, imageId);
        if (!image) throw new HttpError(404, 'Image not found', 'image_not_found');
        response.writeHead(200, { 'Content-Type': image.mime_type, 'Cache-Control': 'private, no-store' }); response.end(Buffer.from(image.image_data)); return;
      }

      const lockMatch = /^\/api\/projects\/(\d+)\/lock$/.exec(url.pathname);
      if (lockMatch) {
        const auth = authenticate(request); const projectId = Number(lockMatch[1]);
        if (request.method === 'POST') { requireCsrf(request, auth); const payload = await readJson(request); return sendJson(response, 200, store.acquireLock(projectId, auth.user, auth.session, Boolean(payload.force))); }
        if (request.method === 'PATCH') { requireCsrf(request, auth); return sendJson(response, 200, store.heartbeatLock(projectId, auth.user, auth.session, String(request.headers['x-edit-lease'] || ''))); }
        if (request.method === 'DELETE') { requireCsrf(request, auth); store.releaseLock(projectId, auth.session, String(request.headers['x-edit-lease'] || '')); return sendEmpty(response, 204); }
      }

      const presenceMatch = /^\/api\/projects\/(\d+)\/presence$/.exec(url.pathname);
      if (presenceMatch) {
        const auth = authenticate(request); const projectId = Number(presenceMatch[1]);
        requireCsrf(request, auth);
        const presenceId = String(request.headers['x-project-presence'] || '');
        if (request.method === 'POST' || request.method === 'PATCH') return sendJson(response, 200, store.touchProjectPresence(projectId, auth.user, auth.session, presenceId));
        if (request.method === 'DELETE') { store.releaseProjectPresence(projectId, auth.session, presenceId); return sendEmpty(response, 204); }
      }

      const membersMatch = /^\/api\/projects\/(\d+)\/members$/.exec(url.pathname);
      if (membersMatch) {
        const auth = authenticate(request); const projectId = Number(membersMatch[1]);
        if (request.method === 'GET') return sendJson(response, 200, store.listMembers(projectId, auth.user));
        if (request.method === 'POST') { requireCsrf(request, auth); const payload = await readJson(request); return sendJson(response, 200, store.addOrUpdateMember(projectId, auth.user, normalizeUsername(payload.username) || '', String(payload.role || ''))); }
      }
      const memberMatch = /^\/api\/projects\/(\d+)\/members\/(\d+)$/.exec(url.pathname);
      if (memberMatch && request.method === 'DELETE') {
        const auth = authenticate(request); requireCsrf(request, auth); store.removeMember(Number(memberMatch[1]), auth.user, Number(memberMatch[2])); return sendEmpty(response, 204);
      }
      const transferMatch = /^\/api\/projects\/(\d+)\/transfer$/.exec(url.pathname);
      if (transferMatch && request.method === 'POST') {
        const auth = authenticate(request); requireCsrf(request, auth); const payload = await readJson(request);
        const current = store.getUserByUsername(auth.user.username);
        if (!await verifyPassword(String(payload.password || ''), current.password_hash)) throw new HttpError(400, 'Current password is incorrect', 'current_password_incorrect');
        store.transferOwnership(Number(transferMatch[1]), auth.user, normalizeUsername(payload.username) || ''); return sendEmpty(response, 204);
      }

      const linksMatch = /^\/api\/projects\/(\d+)\/share-links$/.exec(url.pathname);
      if (linksMatch) {
        const auth = authenticate(request); const projectId = Number(linksMatch[1]);
        if (request.method === 'GET') return sendJson(response, 200, store.listShareLinks(projectId, auth.user));
        if (request.method === 'POST') { requireCsrf(request, auth); return sendJson(response, 201, store.createShareLink(projectId, auth.user, await readJson(request))); }
      }
      const linkMatch = /^\/api\/projects\/(\d+)\/share-links\/(\d+)$/.exec(url.pathname);
      if (linkMatch && request.method === 'DELETE') {
        const auth = authenticate(request); requireCsrf(request, auth); store.revokeShareLink(Number(linkMatch[1]), auth.user, Number(linkMatch[2])); return sendEmpty(response, 204);
      }

      const projectMatch = /^\/api\/projects\/(\d+)$/.exec(url.pathname);
      if (projectMatch) {
        const auth = authenticate(request); const projectId = Number(projectMatch[1]);
        if (request.method === 'GET') return sendJson(response, 200, store.getProjectDetail(projectId, auth.user, auth.session.id));
        if (request.method === 'PUT') { requireCsrf(request, auth); return sendJson(response, 200, store.saveProject(projectId, auth.user, auth.session, String(request.headers['x-edit-lease'] || ''), await readJson(request))); }
        if (request.method === 'DELETE') { requireCsrf(request, auth); store.deleteProject(projectId, auth.user); return sendEmpty(response, 204); }
      }

      if (url.pathname === '/api/share/project' && request.method === 'GET') {
        const share = store.getShare(parseCookies(request.headers.cookie)[SHARE_COOKIE]);
        if (!share) throw new HttpError(404, 'Share link is unavailable', 'share_unavailable');
        return sendJson(response, 200, store.getSharedProject(share));
      }
      const shareImageMatch = /^\/api\/share\/images\/([^/]+)$/.exec(url.pathname);
      if (shareImageMatch && request.method === 'GET') {
        const share = store.getShare(parseCookies(request.headers.cookie)[SHARE_COOKIE]); const imageId = normalizeImageId(decodeURIComponent(shareImageMatch[1]));
        if (!share || !imageId) throw new HttpError(404, 'Image not found', 'image_not_found');
        const image = store.getImage(share.project_id, imageId); if (!image) throw new HttpError(404, 'Image not found', 'image_not_found');
        response.writeHead(200, { 'Content-Type': image.mime_type, 'Cache-Control': 'private, no-store' }); response.end(Buffer.from(image.image_data)); return;
      }

      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'API endpoint not found', 'not_found');
      if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed', 'method_not_allowed');

      const shareRoute = /^\/share\/([A-Za-z0-9_-]{20,})\/?$/.exec(url.pathname);
      if (shareRoute) {
        const share = store.getShare(shareRoute[1]);
        if (!share) throw new HttpError(404, 'Share link is unavailable', 'share_unavailable');
        response.setHeader('Set-Cookie', serializeCookie(SHARE_COOKIE, shareRoute[1], { path: '/api/share', secure: secureCookies, maxAge: Math.max(1, Math.floor(((share.expires_at || Date.now() + 24 * 60 * 60 * 1000) - Date.now()) / 1000)) }));
      }

      const requested = safeStaticFile(publicDir, url.pathname);
      if (requested && existsSync(requested) && statSync(requested).isFile()) return sendStaticFile(request, response, requested);
      const indexFile = path.join(publicDir, 'index.html');
      if (!existsSync(indexFile)) throw new HttpError(404, 'Frontend entry file not found', 'not_found');
      return sendStaticFile(request, response, indexFile);
    } catch (error) {
      if (response.headersSent) return response.destroy();
      const status = error.statusCode || 500;
      if (status >= 500) console.error('Request failed:', error);
      return sendJson(response, status, {
        error: status >= 500 ? 'Internal server error' : (error.message || 'Request failed'),
        code: error.code || 'internal_error',
        ...(error.details ? { details: error.details } : {})
      }, error.headers || {});
    }
  });

  return {
    server, store,
    close() {
      return new Promise((resolve, reject) => {
        if (!server.listening) { store.close(); resolve(); return; }
        server.close((error) => { store.close(); error ? reject(error) : resolve(); });
      });
    }
  };
}

async function promptHidden(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('A TTY is required for hidden password input');
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener('data', onData); process.stdout.write('\n');
      error ? reject(error) : resolve(value);
    };
    const onData = (char) => {
      if (char === '\u0003') return finish(new Error('Cancelled'));
      if (char === '\r' || char === '\n') return finish();
      if (char === '\u007f') { value = value.slice(0, -1); return; }
      value += char;
    };
    process.stdin.on('data', onData);
  });
}

async function runSetupAdmin(databasePath, argv) {
  const usernameIndex = argv.indexOf('--username');
  const username = normalizeUsername(usernameIndex >= 0 ? argv[usernameIndex + 1] : '');
  if (username !== 'admin') throw new Error('Usage: node server.js setup-admin --username admin');
  const password = await promptHidden('管理员密码（12–128 个字符）: ');
  const confirmation = await promptHidden('再次输入管理员密码: ');
  if (password !== confirmation) throw new Error('Passwords do not match');
  const passwordHash = await hashPassword(password);
  const result = setupDatabase({ databasePath, username, displayName: username, passwordHash });
  console.log(`数据库已升级到 schema v${SCHEMA_VERSION}。`);
  console.log(`初始管理员: ${username}`);
  console.log(`迁移项目: ${result.fingerprint.projectCount}，图片: ${result.fingerprint.imageCount}`);
  if (result.backup) console.log(`备份: ${result.backup.path}`);
}

if (require.main === module) {
  const databasePath = path.resolve(process.env.STORYBOARD_DATA_FILE || DEFAULT_DB_PATH);
  const command = process.argv[2];
  if (command === 'setup-admin') {
    runSetupAdmin(databasePath, process.argv.slice(3)).catch((error) => { console.error(error.message); process.exitCode = 1; });
  } else if (command === 'verify-db') {
    try {
      const db = openDatabase(databasePath); assertCurrentSchema(db); const fingerprint = collectDataFingerprint(db); db.close();
      console.log(JSON.stringify({ ok: true, schemaVersion: SCHEMA_VERSION, ...fingerprint }, null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  } else if (command === 'restore-db') {
    const args = process.argv.slice(3);
    const backupIndex = args.indexOf('--backup');
    if (backupIndex < 0 || !args[backupIndex + 1] || !args.includes('--confirm=RESTORE')) {
      console.error('Usage: node server.js restore-db --backup <path> --confirm=RESTORE');
      process.exitCode = 1;
    } else {
      try {
        const result = restoreDatabase({ databasePath, backupPath: args[backupIndex + 1] });
        console.log(JSON.stringify(result, null, 2));
      } catch (error) { console.error(error.message); process.exitCode = 1; }
    }
  } else {
    const port = Number(process.env.PORT || DEFAULT_PORT);
    const host = process.env.HOST || DEFAULT_HOST;
    const publicOrigin = process.env.STORYBOARD_PUBLIC_ORIGIN || `http://localhost:${port}`;
    if (publicOrigin.startsWith('http://') && process.env.STORYBOARD_ALLOW_INSECURE_HTTP !== '1') {
      console.error('Refusing insecure HTTP startup. Set STORYBOARD_ALLOW_INSECURE_HTTP=1 only on a trusted LAN, or configure HTTPS.');
      process.exitCode = 1;
    } else {
      try {
        const allowedOrigins = (process.env.STORYBOARD_ALLOWED_ORIGINS || publicOrigin).split(',').map((item) => item.trim()).filter(Boolean);
        const application = createStoryboardApplication({ databasePath, publicDir: DEFAULT_PUBLIC_DIR, publicOrigin, allowedOrigins });
        application.server.listen(port, host, () => {
          const bar = '='.repeat(60);
          const lines = [bar, '   卡片分镜  CARD STORYBOARD', bar, '', `  Node:    ${process.execPath}`, '', `  本机    http://127.0.0.1:${port}`];
          if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
            for (const ip of lanAddresses().slice(0, 2)) lines.push(`  局域网  http://${ip}:${port}`);
          }
          const dataPath = path.relative(__dirname, databasePath);
          lines.push(`  数据    ${dataPath.startsWith('..') ? databasePath : dataPath}`);
          lines.push('', '  关闭这个窗口即停止服务。', '');
          console.log(lines.join('\n'));
        });
        let closing = false;
        const shutdown = async () => {
          if (closing) return; closing = true;
          try { await application.close(); process.exit(0); }
          catch (error) { console.error('Server shutdown failed:', error); process.exit(1); }
        };
        process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
      } catch (error) {
        console.error(`Startup failed: ${error.message}`);
        if (String(error.message).includes('setup-admin')) console.error('Run: node server.js setup-admin --username admin');
        process.exitCode = 1;
      }
    }
  }
}

module.exports = { HttpError, createStoryboardApplication, createStoryboardStore, setupDatabase };
