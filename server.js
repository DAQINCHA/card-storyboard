const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 5188;
const DB_PATH = path.join(__dirname, 'data', 'storyboard.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PERF_LOG_ENABLED = process.env.STORYBOARD_PERF === '1';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const IMAGE_DATA_URL_PATTERN = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = DELETE');
db.pragma('synchronous = NORMAL');

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

const listStmt = db.prepare('SELECT id, name, scene, aspect_ratio, shots_json, updated_at FROM projects');
const listNamesStmt = db.prepare('SELECT name FROM projects');
const getStmt = db.prepare('SELECT id, name, scene, aspect_ratio, shots_json, updated_at FROM projects WHERE id = ?');
const createStmt = db.prepare("INSERT INTO projects (name, scene, aspect_ratio, shots_json, updated_at) VALUES (?, '', '16/9', '[]', strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime'))");
const updateStmt = db.prepare(`
UPDATE projects
SET name = ?,
    scene = ?,
    aspect_ratio = ?,
    shots_json = ?,
    updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime')
WHERE id = ?
`);
const deleteStmt = db.prepare('DELETE FROM projects WHERE id = ?');
const upsertImageStmt = db.prepare(`
INSERT INTO project_images (project_id, image_id, mime_type, image_data, updated_at)
VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime'))
ON CONFLICT (project_id, image_id) DO UPDATE SET
  mime_type = excluded.mime_type,
  image_data = excluded.image_data,
  updated_at = excluded.updated_at
`);
const getImageStmt = db.prepare('SELECT mime_type, image_data FROM project_images WHERE project_id = ? AND image_id = ?');
const imageExistsStmt = db.prepare('SELECT 1 AS exists_flag FROM project_images WHERE project_id = ? AND image_id = ?');
const listImageIdsStmt = db.prepare('SELECT image_id FROM project_images WHERE project_id = ?');
const deleteImageStmt = db.prepare('DELETE FROM project_images WHERE project_id = ? AND image_id = ?');
const copyProjectImagesStmt = db.prepare(`
INSERT INTO project_images (project_id, image_id, mime_type, image_data, updated_at)
SELECT ?, image_id, mime_type, image_data, strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime')
FROM project_images
WHERE project_id = ?
`);
let projectSummaryCache = null;

function perfNowNs() {
  return process.hrtime.bigint();
}

function perfDurationMs(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

function logPerf(label, startNs, meta = {}) {
  if (!PERF_LOG_ENABLED) {
    return;
  }
  const durationMs = perfDurationMs(startNs);
  const payload = {
    ...meta,
    durationMs: Number(durationMs.toFixed(2))
  };
  console.log(`[perf] ${label} ${JSON.stringify(payload)}`);
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

function normalizeProjectId(projectIdLike) {
  const value = Number(projectIdLike);
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function normalizeImageId(imageId) {
  const normalized = (imageId || '').toString().trim();
  return IMAGE_ID_PATTERN.test(normalized) ? normalized : null;
}

function buildImageUrl(projectId, imageId) {
  return `/api/projects/${projectId}/images/${encodeURIComponent(imageId)}`;
}

function parseImageDataUrl(imageSrc) {
  if (typeof imageSrc !== 'string') {
    return null;
  }

  const match = IMAGE_DATA_URL_PATTERN.exec(imageSrc);
  if (!match) {
    return null;
  }

  const imageData = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!imageData.length) {
    throw new Error('Image data is empty');
  }
  if (imageData.length > MAX_IMAGE_BYTES) {
    throw new Error('Image exceeds the 8 MB limit');
  }

  return {
    mimeType: match[1].toLowerCase(),
    imageData
  };
}

function extractImageIdFromUrl(projectId, imageSrc) {
  if (typeof imageSrc !== 'string') {
    return null;
  }

  const prefix = `/api/projects/${projectId}/images/`;
  let pathname;
  try {
    pathname = new URL(imageSrc, 'http://storyboard.local').pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  try {
    return normalizeImageId(decodeURIComponent(pathname.slice(prefix.length)));
  } catch {
    return null;
  }
}

function decorateShotsWithImageUrls(projectId, shots) {
  return shots.map((shot) => {
    if (!shot || typeof shot !== 'object' || isSceneDividerShot(shot)) {
      return shot;
    }

    const imageId = normalizeImageId(shot.imageId);
    if (!imageId) {
      return shot;
    }

    return {
      ...shot,
      imageId,
      hasImage: true,
      imageSrc: buildImageUrl(projectId, imageId)
    };
  });
}

function toProjectSummary(row) {
  const shots = safeParseShots(row.shots_json);
  const firstImage = shots.find((shot) => shot && shot.hasImage && normalizeImageId(shot.imageId));
  return {
    id: row.id,
    name: row.name,
    scene: row.scene,
    aspectRatio: row.aspect_ratio,
    shotCount: shots.filter((shot) => !isSceneDividerShot(shot)).length,
    previewImage: firstImage ? buildImageUrl(row.id, normalizeImageId(firstImage.imageId)) : '',
    updatedAt: row.updated_at
  };
}

function toProjectDetail(row) {
  const shots = safeParseShots(row.shots_json);
  return {
    id: row.id,
    name: row.name,
    scene: row.scene,
    aspectRatio: row.aspect_ratio,
    shots: decorateShotsWithImageUrls(row.id, shots),
    updatedAt: row.updated_at
  };
}

function ensureProjectSummaryCache() {
  if (!Array.isArray(projectSummaryCache)) {
    projectSummaryCache = listStmt.all().map(toProjectSummary);
  }
  return projectSummaryCache;
}

function upsertProjectSummaryFromRow(row) {
  const cache = ensureProjectSummaryCache();
  const summary = toProjectSummary(row);
  const index = cache.findIndex((item) => item.id === summary.id);
  if (index >= 0) {
    cache[index] = summary;
  } else {
    cache.push(summary);
  }
}

function removeProjectSummary(projectId) {
  const cache = ensureProjectSummaryCache();
  const index = cache.findIndex((item) => item.id === projectId);
  if (index >= 0) {
    cache.splice(index, 1);
  }
}

function buildNextNewProjectName() {
  const names = listNamesStmt.all().map((row) => (row.name || '').toString().trim());

  if (!names.includes('新项目')) {
    return '新项目';
  }

  let maxSuffix = 1;
  names.forEach((name) => {
    const match = /^新项目\s+(\d+)$/.exec(name);
    if (!match) {
      return;
    }
    const suffix = Number(match[1]);
    if (Number.isInteger(suffix) && suffix > maxSuffix) {
      maxSuffix = suffix;
    }
  });

  return `新项目 ${maxSuffix + 1}`;
}

function normalizeShotForStorage(projectId, shot, referencedImageIds) {
  if (!shot || typeof shot !== 'object') {
    return shot;
  }

  const normalized = { ...shot };
  if (isSceneDividerShot(shot)) {
    delete normalized.imageId;
    delete normalized.imageSrc;
    delete normalized.hasImage;
    return normalized;
  }

  const imageSrc = typeof shot.imageSrc === 'string' ? shot.imageSrc : '';
  const dataUrlImage = imageSrc.startsWith('data:') ? parseImageDataUrl(imageSrc) : null;
  if (imageSrc.startsWith('data:') && !dataUrlImage) {
    throw new Error('Unsupported image format');
  }

  const imageId = normalizeImageId(shot.imageId) || extractImageIdFromUrl(projectId, imageSrc);
  if (dataUrlImage) {
    const storedImageId = imageId || crypto.randomUUID();
    upsertImageStmt.run(projectId, storedImageId, dataUrlImage.mimeType, dataUrlImage.imageData);
    referencedImageIds.add(storedImageId);
    normalized.imageId = storedImageId;
    normalized.hasImage = true;
    delete normalized.imageSrc;
    return normalized;
  }

  if (shot.hasImage !== false && imageId && imageExistsStmt.get(projectId, imageId)) {
    referencedImageIds.add(imageId);
    normalized.imageId = imageId;
    normalized.hasImage = true;
    delete normalized.imageSrc;
    return normalized;
  }

  delete normalized.imageId;
  delete normalized.imageSrc;
  normalized.hasImage = false;
  return normalized;
}

function normalizeShotsForStorage(projectId, shots) {
  const referencedImageIds = new Set();
  const normalizedShots = shots.map((shot) => (
    normalizeShotForStorage(projectId, shot, referencedImageIds)
  ));

  listImageIdsStmt.all(projectId).forEach(({ image_id: imageId }) => {
    if (!referencedImageIds.has(imageId)) {
      deleteImageStmt.run(projectId, imageId);
    }
  });

  return normalizedShots;
}

const saveProjectTx = db.transaction((id, name, scene, aspectRatio, shots) => {
  const normalizedShots = normalizeShotsForStorage(id, shots);
  const shotsJson = JSON.stringify(normalizedShots);
  updateStmt.run(name, scene, aspectRatio, shotsJson, id);
  return { normalizedShots, shotsJson };
});

const duplicateProjectTx = db.transaction((sourceId, name) => {
  const source = getStmt.get(sourceId);
  if (!source) {
    return null;
  }

  const result = createStmt.run(name);
  const newProjectId = Number(result.lastInsertRowid);
  updateStmt.run(name, source.scene, source.aspect_ratio, source.shots_json, newProjectId);
  copyProjectImagesStmt.run(newProjectId, sourceId);
  return getStmt.get(newProjectId);
});

function migrateLegacyImages() {
  const migrateTx = db.transaction(() => {
    listStmt.all().forEach((row) => {
      const shots = safeParseShots(row.shots_json);
      const hasImageDataToMigrate = shots.some((shot) => (
        shot
        && typeof shot === 'object'
        && Object.prototype.hasOwnProperty.call(shot, 'imageSrc')
      ));
      if (!hasImageDataToMigrate) {
        return;
      }

      const normalizedShots = normalizeShotsForStorage(row.id, shots);
      updateStmt.run(
        row.name,
        row.scene,
        row.aspect_ratio,
        JSON.stringify(normalizedShots),
        row.id
      );
    });
  });

  migrateTx();
}

try {
  migrateLegacyImages();
} catch (error) {
  console.error('Legacy image migration failed:', error);
  throw error;
}

app.use(express.json({ limit: '20mb' }));
app.use(express.static(PUBLIC_DIR));

app.get('/api/projects', (req, res) => {
  const perfStartNs = PERF_LOG_ENABLED ? perfNowNs() : null;
  const search = (req.query.search || '').toString().trim().toLowerCase();
  const sort = (req.query.sort || 'updated_desc').toString();

  let projects = ensureProjectSummaryCache().slice();

  if (search) {
    projects = projects.filter((item) => {
      const hay = `${item.name} ${item.scene}`.toLowerCase();
      return hay.includes(search);
    });
  }

  if (sort === 'name_asc') {
    projects.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  } else if (sort === 'updated_asc') {
    projects.sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
  } else {
    projects.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  if (perfStartNs) {
    logPerf('GET /api/projects', perfStartNs, {
      sort,
      searchLength: search.length,
      projectCount: projects.length
    });
  }
  res.json(projects);
});

app.post('/api/projects', (req, res) => {
  const requestedName = (req.body?.name || '').toString().trim();
  const name = requestedName && requestedName !== '新项目'
    ? requestedName
    : buildNextNewProjectName();
  const sourceProjectId = normalizeProjectId(req.body?.sourceProjectId);
  let row;

  if (sourceProjectId) {
    row = duplicateProjectTx(sourceProjectId, name);
    if (!row) {
      return res.status(404).json({ error: 'Source project not found' });
    }
  } else {
    const result = createStmt.run(name);
    row = getStmt.get(result.lastInsertRowid);
  }

  upsertProjectSummaryFromRow(row);
  res.status(201).json(toProjectDetail(row));
});

app.get('/api/projects/:id', (req, res) => {
  const perfStartNs = PERF_LOG_ENABLED ? perfNowNs() : null;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid project id' });
  }

  const row = getStmt.get(id);
  if (!row) {
    return res.status(404).json({ error: 'Project not found' });
  }

  if (perfStartNs) {
    logPerf('GET /api/projects/:id', perfStartNs, {
      id,
      shotsBytes: Buffer.byteLength(row.shots_json || '', 'utf8')
    });
  }
  res.json(toProjectDetail(row));
});

app.get('/api/projects/:id/images/:imageId', (req, res) => {
  const id = Number(req.params.id);
  const imageId = normalizeImageId(req.params.imageId);
  if (!Number.isInteger(id) || id <= 0 || !imageId) {
    return res.status(400).json({ error: 'Invalid image id' });
  }

  const image = getImageStmt.get(id, imageId);
  if (!image) {
    return res.status(404).json({ error: 'Image not found' });
  }

  res.set('Content-Type', image.mime_type);
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(image.image_data);
});

app.put('/api/projects/:id', (req, res) => {
  const perfStartNs = PERF_LOG_ENABLED ? perfNowNs() : null;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid project id' });
  }

  const current = getStmt.get(id);
  if (!current) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const name = (req.body?.name ?? current.name).toString().trim() || '未命名项目';
  const scene = (req.body?.scene ?? current.scene).toString();
  const aspectRatio = (req.body?.aspectRatio ?? current.aspect_ratio).toString() || '16/9';
  const shots = Array.isArray(req.body?.shots) ? req.body.shots : safeParseShots(current.shots_json);
  const requestBytes = Number(req.get('content-length')) || 0;

  const stringifyStartNs = PERF_LOG_ENABLED ? perfNowNs() : null;
  const incomingShotsJson = PERF_LOG_ENABLED ? JSON.stringify(shots) : '';
  const stringifyMs = stringifyStartNs ? perfDurationMs(stringifyStartNs) : null;
  let savedProject;

  const dbStartNs = PERF_LOG_ENABLED ? perfNowNs() : null;
  try {
    savedProject = saveProjectTx(id, name, scene, aspectRatio, shots);
  } catch (error) {
    console.error('Save project failed:', error);
    return res.status(400).json({ error: error.message || 'Invalid project data' });
  }
  const dbMs = dbStartNs ? perfDurationMs(dbStartNs) : null;

  const row = getStmt.get(id);
  upsertProjectSummaryFromRow(row);
  if (perfStartNs) {
    logPerf('PUT /api/projects/:id', perfStartNs, {
      id,
      requestBytes,
      incomingShots: shots.length,
      shotsJsonBytes: Buffer.byteLength(savedProject.shotsJson, 'utf8'),
      incomingShotsJsonBytes: Buffer.byteLength(incomingShotsJson, 'utf8'),
      stringifyMs: Number((stringifyMs || 0).toFixed(2)),
      dbWriteMs: Number((dbMs || 0).toFixed(2))
    });
  }
  res.json(toProjectDetail(row));
});

app.delete('/api/projects/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid project id' });
  }

  const result = deleteStmt.run(id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Project not found' });
  }

  removeProjectSummary(id);
  res.status(204).end();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, dbPath: DB_PATH });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Storyboard server running at http://localhost:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
  if (PERF_LOG_ENABLED) {
    console.log('Server perf logging: enabled (STORYBOARD_PERF=1)');
  }
});
