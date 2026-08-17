const crypto = require('node:crypto');
const { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 5;
const MIGRATIONS = Object.freeze({
  1: 'accounts-sharing-and-edit-locks',
  2: 'project-scoped-reusable-share-links',
  3: 'writing-area-default-scene-header-colors',
  4: 'project-presence-heartbeats',
  5: 'project-presence-per-browser-tab'
});
const MIGRATION_NAME = MIGRATIONS[SCHEMA_VERSION];
const MIGRATION_CHECKSUM = crypto.createHash('sha256').update(MIGRATION_NAME).digest('hex');
const LEGACY_DEFAULT_SCENE_HEADER_COLOR = '#64748b';
const DEFAULT_SCENE_HEADER_COLOR = '#fffdf8';

function migrationChecksum(version) {
  return crypto.createHash('sha256').update(MIGRATIONS[version]).digest('hex');
}

function openDatabase(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function createLegacyTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '未命名项目',
      scene TEXT NOT NULL DEFAULT '',
      aspect_ratio TEXT NOT NULL DEFAULT '16/9',
      shots_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS project_images (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      image_id TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      image_data BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime')),
      PRIMARY KEY (project_id, image_id)
    );
    CREATE INDEX IF NOT EXISTS project_images_project_id_idx ON project_images(project_id);
  `);
}

function getSchemaVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get().user_version || 0);
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function collectDataFingerprint(db) {
  const projectHash = crypto.createHash('sha256');
  const imageHash = crypto.createHash('sha256');
  const projects = db.prepare('SELECT id, name, scene, aspect_ratio, shots_json, updated_at FROM projects ORDER BY id').all();
  const images = db.prepare('SELECT project_id, image_id, mime_type, image_data, updated_at FROM project_images ORDER BY project_id, image_id').all();
  projects.forEach((row) => projectHash.update(JSON.stringify(row)));
  images.forEach((row) => {
    imageHash.update(`${row.project_id}\0${row.image_id}\0${row.mime_type}\0${row.updated_at}\0`);
    imageHash.update(Buffer.from(row.image_data));
  });
  return {
    projectCount: projects.length,
    imageCount: images.length,
    projectHash: projectHash.digest('hex'),
    imageHash: imageHash.digest('hex')
  };
}

function createBackup(databasePath, sourceVersion) {
  if (!existsSync(databasePath) || statSync(databasePath).size === 0) {
    return null;
  }
  const backupDir = path.join(path.dirname(databasePath), 'backups');
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `storyboard-v${sourceVersion}-${stamp}.db`);
  const sourceDb = new DatabaseSync(databasePath);
  sourceDb.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  sourceDb.close();
  const digest = crypto.createHash('sha256').update(readFileSync(backupPath)).digest('hex');
  writeFileSync(`${backupPath}.sha256`, `${digest}  ${path.basename(backupPath)}\n`, { flag: 'wx' });
  return { path: backupPath, sha256: digest };
}

function createVersionOneSchema(db) {
  if (!hasColumn(db, 'projects', 'version')) {
    db.exec('ALTER TABLE projects ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  }
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
      session_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      password_changed_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
    CREATE TABLE user_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash BLOB NOT NULL UNIQUE,
      csrf_token_hash BLOB NOT NULL,
      session_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      idle_expires_at INTEGER NOT NULL,
      absolute_expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      user_agent_hash TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX user_sessions_user_idx ON user_sessions(user_id);
    CREATE TABLE project_members (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, user_id)
    );
    CREATE UNIQUE INDEX project_one_owner_idx ON project_members(project_id) WHERE role = 'owner';
    CREATE INDEX project_members_user_idx ON project_members(user_id, project_id);
    CREATE TABLE project_share_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      token_hash BLOB NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT '',
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER,
      last_used_at INTEGER
    );
    CREATE INDEX project_share_links_project_idx ON project_share_links(project_id);
    CREATE TABLE project_edit_locks (
      project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id INTEGER NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
      lease_token_hash BLOB NOT NULL,
      acquired_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE security_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      share_link_id INTEGER REFERENCES project_share_links(id) ON DELETE SET NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX security_audit_created_idx ON security_audit_events(created_at);
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
}

function createVersionTwoSchema(db) {
  if (!hasColumn(db, 'project_share_links', 'display_number')) {
    db.exec('ALTER TABLE project_share_links ADD COLUMN display_number INTEGER');
  }
  if (!hasColumn(db, 'project_share_links', 'reusable_token')) {
    db.exec('ALTER TABLE project_share_links ADD COLUMN reusable_token TEXT');
  }

  db.exec(`
    DELETE FROM project_share_links
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY project_id ORDER BY created_at DESC, id DESC
        ) AS recency_rank
        FROM project_share_links
      ) ranked
      WHERE recency_rank > 5
    );

    WITH numbered AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY project_id ORDER BY created_at ASC, id ASC
      ) AS project_number
      FROM project_share_links
    )
    UPDATE project_share_links
    SET display_number = (
      SELECT project_number FROM numbered WHERE numbered.id = project_share_links.id
    );
  `);

  const missingTokens = db.prepare('SELECT id FROM project_share_links WHERE reusable_token IS NULL OR reusable_token = ?').all('');
  const updateToken = db.prepare('UPDATE project_share_links SET reusable_token = ? WHERE id = ?');
  missingTokens.forEach((row) => updateToken.run(crypto.randomBytes(32).toString('base64url'), row.id));

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS project_share_links_display_number_idx
      ON project_share_links(project_id, display_number);
    CREATE UNIQUE INDEX IF NOT EXISTS project_share_links_reusable_token_idx
      ON project_share_links(reusable_token);
  `);
}

function migrateSceneHeaderColors(shotsJson) {
  let shots;
  try {
    shots = JSON.parse(shotsJson || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(shots)) return null;

  let changed = false;
  const migratedShots = shots.map((shot) => {
    if (!shot || typeof shot !== 'object' || Array.isArray(shot)) return shot;
    const headerColor = typeof shot.headerColor === 'string' ? shot.headerColor.trim().toLowerCase() : '';
    if (headerColor !== LEGACY_DEFAULT_SCENE_HEADER_COLOR) return shot;
    changed = true;
    return { ...shot, headerColor: DEFAULT_SCENE_HEADER_COLOR };
  });

  return changed ? JSON.stringify(migratedShots) : null;
}

function createVersionThreeSchema(db) {
  const updateProject = db.prepare('UPDATE projects SET shots_json = ? WHERE id = ?');
  db.prepare('SELECT id, shots_json FROM projects').all().forEach((project) => {
    const migratedShotsJson = migrateSceneHeaderColors(project.shots_json);
    if (migratedShotsJson !== null) updateProject.run(migratedShotsJson, project.id);
  });
}

function createVersionFourSchema(db) {
  db.exec(`
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
  `);
}

function createVersionFiveSchema(db) {
  db.exec(`
    DROP INDEX project_presence_user_idx;
    DROP INDEX project_presence_expiry_idx;
    ALTER TABLE project_presence RENAME TO project_presence_v4;
    CREATE TABLE project_presence (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id INTEGER NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
      presence_id TEXT NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, session_id, presence_id)
    );
    INSERT INTO project_presence (project_id, user_id, session_id, presence_id, heartbeat_at, expires_at)
      SELECT project_id, user_id, session_id, 'legacy-session', heartbeat_at, expires_at FROM project_presence_v4;
    DROP TABLE project_presence_v4;
    CREATE INDEX project_presence_user_idx ON project_presence(user_id, project_id);
    CREATE INDEX project_presence_expiry_idx ON project_presence(expires_at);
  `);
}

function collectProjectRows(db) {
  return db.prepare('SELECT id, name, scene, aspect_ratio, shots_json, updated_at FROM projects ORDER BY id').all();
}

function assertExpectedProjectData(db, beforeProjects) {
  const expectedProjects = beforeProjects.map((project) => ({
    ...project,
    shots_json: migrateSceneHeaderColors(project.shots_json) || project.shots_json
  }));
  const actualProjects = collectProjectRows(db);
  if (JSON.stringify(expectedProjects) !== JSON.stringify(actualProjects)) {
    throw new Error('Existing project data changed unexpectedly during migration');
  }
}

function assertMigrationMetadata(db, version) {
  const migration = db.prepare('SELECT name, checksum FROM schema_migrations WHERE version = ?').get(version);
  if (!migration || migration.name !== MIGRATIONS[version] || migration.checksum !== migrationChecksum(version)) {
    throw new Error('Database schema migration metadata is inconsistent');
  }
}

function assertCurrentSchema(db) {
  const version = getSchemaVersion(db);
  if (version !== SCHEMA_VERSION) {
    const direction = version < SCHEMA_VERSION ? 'setup-admin or migration is required' : 'database is newer than this application';
    throw new Error(`Unsupported database schema version ${version}; ${direction}`);
  }
  Object.keys(MIGRATIONS).map(Number).filter((item) => item <= version).forEach((item) => assertMigrationMetadata(db, item));
  if (!db.prepare('SELECT 1 FROM users WHERE is_admin = 1 AND is_active = 1 LIMIT 1').get()) {
    throw new Error('Database has no active administrator');
  }
}

function migrateDatabase(databasePath) {
  let db = openDatabase(databasePath);
  const version = getSchemaVersion(db);
  if (version === SCHEMA_VERSION) {
    try {
      assertCurrentSchema(db);
    } finally {
      db.close();
    }
    return { migrated: false, backup: null };
  }
  if (![1, 2, 3, 4].includes(version)) {
    db.close();
    const direction = version < 1 ? 'setup-admin or migration is required' : 'database is newer than this application';
    throw new Error(`Unsupported database schema version ${version}; ${direction}`);
  }
  let before;
  let beforeProjects;
  let integrity;
  try {
    Object.keys(MIGRATIONS).map(Number).filter((item) => item <= version).forEach((item) => assertMigrationMetadata(db, item));
    before = collectDataFingerprint(db);
    beforeProjects = collectProjectRows(db);
    integrity = db.prepare('PRAGMA integrity_check').all();
  } finally {
    db.close();
  }
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
    throw new Error('Database integrity check failed before migration');
  }

  const backup = createBackup(databasePath, version);
  db = openDatabase(databasePath);
  db.exec('BEGIN EXCLUSIVE');
  try {
    if (getSchemaVersion(db) !== version) throw new Error('Database schema changed while migration was starting');
    Object.keys(MIGRATIONS).map(Number).filter((item) => item <= version).forEach((item) => assertMigrationMetadata(db, item));
    for (let nextVersion = version + 1; nextVersion <= SCHEMA_VERSION; nextVersion += 1) {
      if (nextVersion === 2) createVersionTwoSchema(db);
      if (nextVersion === 3) createVersionThreeSchema(db);
      if (nextVersion === 4) createVersionFourSchema(db);
      if (nextVersion === 5) createVersionFiveSchema(db);
      db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(nextVersion, MIGRATIONS[nextVersion], migrationChecksum(nextVersion), Date.now());
      db.exec(`PRAGMA user_version = ${nextVersion}`);
    }
    const after = collectDataFingerprint(db);
    assertExpectedProjectData(db, beforeProjects);
    if (before.imageCount !== after.imageCount || before.imageHash !== after.imageHash) throw new Error('Existing image data changed during migration');
    const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyErrors.length) throw new Error('Foreign key validation failed after migration');
    db.exec('COMMIT');
    return { migrated: true, backup };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

function setupDatabase({ databasePath, username, displayName, passwordHash, mustChangePassword = false, onBeforeCommit = null }) {
  if (username !== 'admin') throw new Error('The administrator username must be admin');
  mkdirSync(path.dirname(databasePath), { recursive: true });
  let db = openDatabase(databasePath);
  createLegacyTables(db);
  const version = getSchemaVersion(db);
  if (version !== 0) {
    db.close();
    throw new Error(`Database is already initialized at schema version ${version}`);
  }
  const before = collectDataFingerprint(db);
  const beforeProjects = collectProjectRows(db);
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
    db.close();
    throw new Error('Database integrity check failed before migration');
  }
  db.close();

  const backup = createBackup(databasePath, version);
  db = openDatabase(databasePath);
  const now = Date.now();
  db.exec('BEGIN EXCLUSIVE');
  try {
    createVersionOneSchema(db);
    db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
      .run(1, MIGRATIONS[1], migrationChecksum(1), now);
    const result = db.prepare(`
      INSERT INTO users (
        username, display_name, password_hash, is_admin, is_active, must_change_password,
        session_version, created_at, updated_at, password_changed_at
      ) VALUES (?, ?, ?, 1, 1, ?, 1, ?, ?, ?)
    `).run(username, displayName || username, passwordHash, mustChangePassword ? 1 : 0, now, now, now);
    const adminId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO project_members (project_id, user_id, role, created_by_user_id, created_at, updated_at)
      SELECT id, ?, 'owner', ?, ?, ? FROM projects
    `).run(adminId, adminId, now, now);
    createVersionTwoSchema(db);
    db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
      .run(2, MIGRATIONS[2], migrationChecksum(2), now);
    createVersionThreeSchema(db);
    db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
      .run(3, MIGRATIONS[3], migrationChecksum(3), now);
    createVersionFourSchema(db);
    db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
      .run(4, MIGRATIONS[4], migrationChecksum(4), now);
    createVersionFiveSchema(db);
    db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
      .run(5, MIGRATIONS[5], migrationChecksum(5), now);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    const after = collectDataFingerprint(db);
    assertExpectedProjectData(db, beforeProjects);
    if (before.imageCount !== after.imageCount || before.imageHash !== after.imageHash) throw new Error('Existing image data changed during migration');
    const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyErrors.length) {
      throw new Error('Foreign key validation failed after migration');
    }
    if (typeof onBeforeCommit === 'function') onBeforeCommit(db);
    db.exec('COMMIT');
    return { adminId, backup, fingerprint: after };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

function restoreDatabase({ databasePath, backupPath }) {
  const resolvedDatabase = path.resolve(databasePath);
  const resolvedBackup = path.resolve(backupPath);
  if (resolvedBackup === resolvedDatabase || !existsSync(resolvedBackup) || !statSync(resolvedBackup).isFile()) {
    throw new Error('Backup file is invalid');
  }
  const checksumPath = `${resolvedBackup}.sha256`;
  const backupDigest = crypto.createHash('sha256').update(readFileSync(resolvedBackup)).digest('hex');
  if (existsSync(checksumPath)) {
    const expected = readFileSync(checksumPath, 'utf8').trim().split(/\s+/, 1)[0];
    if (expected && expected !== backupDigest) throw new Error('Backup checksum verification failed');
  }
  const validationDb = new DatabaseSync(resolvedBackup, { readOnly: true });
  validationDb.exec('PRAGMA query_only = ON');
  const integrity = validationDb.prepare('PRAGMA integrity_check').all();
  validationDb.close();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('Backup database integrity check failed');

  let currentVersion = 0;
  if (existsSync(resolvedDatabase) && statSync(resolvedDatabase).size > 0) {
    const currentDb = new DatabaseSync(resolvedDatabase, { readOnly: true });
    currentVersion = getSchemaVersion(currentDb);
    currentDb.close();
  }
  const preserved = createBackup(resolvedDatabase, currentVersion);
  const temporaryPath = `${resolvedDatabase}.restore-${process.pid}-${Date.now()}`;
  const replacedPath = `${resolvedDatabase}.replaced-${Date.now()}`;
  copyFileSync(resolvedBackup, temporaryPath, 0);
  try {
    if (existsSync(resolvedDatabase)) renameSync(resolvedDatabase, replacedPath);
    renameSync(temporaryPath, resolvedDatabase);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    if (!existsSync(resolvedDatabase) && existsSync(replacedPath)) renameSync(replacedPath, resolvedDatabase);
    throw error;
  }
  return { restoredFrom: resolvedBackup, restoredSha256: backupDigest, preservedCurrent: preserved, replacedPath: existsSync(replacedPath) ? replacedPath : null };
}

module.exports = {
  MIGRATION_CHECKSUM,
  MIGRATION_NAME,
  SCHEMA_VERSION,
  assertCurrentSchema,
  collectDataFingerprint,
  createBackup,
  createLegacyTables,
  getSchemaVersion,
  migrateDatabase,
  openDatabase,
  restoreDatabase,
  setupDatabase
};
