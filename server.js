const crypto = require('node:crypto');
const { createReadStream, existsSync, mkdirSync, statSync } = require('node:fs');
const { createServer } = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_PORT = 5188;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'storyboard.db');
const DEFAULT_PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const IMAGE_DATA_URL_PATTERN = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i;
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2']
]);

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function perfNowNs() {
  return process.hrtime.bigint();
}

function perfDurationMs(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

function logPerf(enabled, label, startNs, meta = {}) {
  if (!enabled) {
    return;
  }
  const durationMs = perfDurationMs(startNs);
  console.log(`[perf] ${label} ${JSON.stringify({
    ...meta,
    durationMs: Number(durationMs.toFixed(2))
  })}`);
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

function createStoryboardStore(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });

  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
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

    CREATE INDEX IF NOT EXISTS project_images_project_id_idx
    ON project_images(project_id);
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

  function withTransaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
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

  function migrateLegacyImages() {
    withTransaction(() => {
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
  }

  migrateLegacyImages();

  return {
    listProjects(search, sort) {
      let projects = ensureProjectSummaryCache().slice();
      if (search) {
        const normalizedSearch = search.toLowerCase();
        projects = projects.filter((item) => (
          `${item.name} ${item.scene}`.toLowerCase().includes(normalizedSearch)
        ));
      }

      if (sort === 'name_asc') {
        projects.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      } else if (sort === 'updated_asc') {
        projects.sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
      } else {
        projects.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      }
      return projects;
    },

    createProject(payload = {}) {
      const requestedName = (payload.name || '').toString().trim();
      const name = requestedName && requestedName !== '新项目'
        ? requestedName
        : buildNextNewProjectName();
      const sourceProjectId = normalizeProjectId(payload.sourceProjectId);
      let row;

      if (sourceProjectId) {
        row = withTransaction(() => {
          const source = getStmt.get(sourceProjectId);
          if (!source) {
            return null;
          }
          const result = createStmt.run(name);
          const newProjectId = Number(result.lastInsertRowid);
          updateStmt.run(name, source.scene, source.aspect_ratio, source.shots_json, newProjectId);
          copyProjectImagesStmt.run(newProjectId, sourceProjectId);
          return getStmt.get(newProjectId);
        });
        if (!row) {
          return null;
        }
      } else {
        const result = createStmt.run(name);
        row = getStmt.get(Number(result.lastInsertRowid));
      }

      upsertProjectSummaryFromRow(row);
      return toProjectDetail(row);
    },

    getProject(projectId) {
      const row = getStmt.get(projectId);
      return row ? toProjectDetail(row) : null;
    },

    getProjectRow(projectId) {
      return getStmt.get(projectId) || null;
    },

    getImage(projectId, imageId) {
      return getImageStmt.get(projectId, imageId) || null;
    },

    saveProject(projectId, payload, current) {
      const name = (payload.name ?? current.name).toString().trim() || '未命名项目';
      const scene = (payload.scene ?? current.scene).toString();
      const aspectRatio = (payload.aspectRatio ?? current.aspect_ratio).toString() || '16/9';
      const shots = Array.isArray(payload.shots) ? payload.shots : safeParseShots(current.shots_json);

      let savedProject;
      withTransaction(() => {
        const normalizedShots = normalizeShotsForStorage(projectId, shots);
        const shotsJson = JSON.stringify(normalizedShots);
        updateStmt.run(name, scene, aspectRatio, shotsJson, projectId);
        savedProject = { normalizedShots, shotsJson };
      });

      const row = getStmt.get(projectId);
      upsertProjectSummaryFromRow(row);
      return {
        detail: toProjectDetail(row),
        shots,
        shotsJson: savedProject.shotsJson
      };
    },

    deleteProject(projectId) {
      const result = deleteStmt.run(projectId);
      if (Number(result.changes) === 0) {
        return false;
      }
      removeProjectSummary(projectId);
      return true;
    },

    close() {
      db.close();
    }
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(payload));
}

function sendEmpty(response, statusCode) {
  response.writeHead(statusCode);
  response.end();
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        exceeded = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (exceeded) {
        reject(new HttpError(413, 'Request body exceeds the 20 MB limit'));
        return;
      }
      if (size === 0) {
        resolve({});
        return;
      }

      const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim();
      if (contentType !== 'application/json') {
        reject(new HttpError(415, 'Request must use application/json'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Request body is not valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function safeStaticFile(publicDir, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relativePath = decodedPath.replace(/^\/+/, '');
  const filePath = path.resolve(publicDir, relativePath);
  const publicRoot = path.resolve(publicDir);
  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${path.sep}`)) {
    return null;
  }
  return filePath;
}

function sendStaticFile(request, response, filePath) {
  response.writeHead(200, {
    'Content-Type': MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

function createStoryboardApplication({
  databasePath = DEFAULT_DB_PATH,
  publicDir = DEFAULT_PUBLIC_DIR,
  perfLogEnabled = false
} = {}) {
  const store = createStoryboardStore(databasePath);
  const server = createServer(async (request, response) => {
    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    } catch {
      sendJson(response, 400, { error: 'Invalid request URL' });
      return;
    }

    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true, dbPath: databasePath });
        return;
      }

      if (url.pathname === '/api/projects') {
        if (request.method === 'GET') {
          const perfStartNs = perfLogEnabled ? perfNowNs() : null;
          const search = (url.searchParams.get('search') || '').toString().trim();
          const sort = (url.searchParams.get('sort') || 'updated_desc').toString();
          const projects = store.listProjects(search, sort);
          if (perfStartNs) {
            logPerf(perfLogEnabled, 'GET /api/projects', perfStartNs, {
              sort,
              searchLength: search.length,
              projectCount: projects.length
            });
          }
          sendJson(response, 200, projects);
          return;
        }

        if (request.method === 'POST') {
          const payload = await readJson(request);
          const created = store.createProject(payload);
          if (!created) {
            throw new HttpError(404, 'Source project not found');
          }
          sendJson(response, 201, created);
          return;
        }
      }

      const imageMatch = /^\/api\/projects\/([^/]+)\/images\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && imageMatch) {
        const projectId = normalizeProjectId(imageMatch[1]);
        let decodedImageId;
        try {
          decodedImageId = decodeURIComponent(imageMatch[2]);
        } catch {
          throw new HttpError(400, 'Invalid image id');
        }
        const imageId = normalizeImageId(decodedImageId);
        if (!projectId || !imageId) {
          throw new HttpError(400, 'Invalid image id');
        }
        const image = store.getImage(projectId, imageId);
        if (!image) {
          throw new HttpError(404, 'Image not found');
        }
        response.writeHead(200, {
          'Content-Type': image.mime_type,
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff'
        });
        response.end(Buffer.from(image.image_data));
        return;
      }

      const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(url.pathname);
      if (projectMatch) {
        const projectId = normalizeProjectId(projectMatch[1]);
        if (!projectId) {
          throw new HttpError(400, 'Invalid project id');
        }

        if (request.method === 'GET') {
          const perfStartNs = perfLogEnabled ? perfNowNs() : null;
          const row = store.getProjectRow(projectId);
          if (!row) {
            throw new HttpError(404, 'Project not found');
          }
          if (perfStartNs) {
            logPerf(perfLogEnabled, 'GET /api/projects/:id', perfStartNs, {
              id: projectId,
              shotsBytes: Buffer.byteLength(row.shots_json || '', 'utf8')
            });
          }
          sendJson(response, 200, toProjectDetail(row));
          return;
        }

        if (request.method === 'PUT') {
          const perfStartNs = perfLogEnabled ? perfNowNs() : null;
          const current = store.getProjectRow(projectId);
          if (!current) {
            throw new HttpError(404, 'Project not found');
          }
          const payload = await readJson(request);
          const requestBytes = Number(request.headers['content-length']) || 0;
          const stringifyStartNs = perfLogEnabled ? perfNowNs() : null;
          const incomingShots = Array.isArray(payload.shots)
            ? payload.shots
            : safeParseShots(current.shots_json);
          const incomingShotsJson = perfLogEnabled ? JSON.stringify(incomingShots) : '';
          const stringifyMs = stringifyStartNs ? perfDurationMs(stringifyStartNs) : null;
          const dbStartNs = perfLogEnabled ? perfNowNs() : null;
          let saved;
          try {
            saved = store.saveProject(projectId, payload, current);
          } catch (error) {
            console.error('Save project failed:', error);
            throw new HttpError(400, error.message || 'Invalid project data');
          }
          const dbMs = dbStartNs ? perfDurationMs(dbStartNs) : null;
          if (perfStartNs) {
            logPerf(perfLogEnabled, 'PUT /api/projects/:id', perfStartNs, {
              id: projectId,
              requestBytes,
              incomingShots: incomingShots.length,
              shotsJsonBytes: Buffer.byteLength(saved.shotsJson, 'utf8'),
              incomingShotsJsonBytes: Buffer.byteLength(incomingShotsJson, 'utf8'),
              stringifyMs: Number((stringifyMs || 0).toFixed(2)),
              dbWriteMs: Number((dbMs || 0).toFixed(2))
            });
          }
          sendJson(response, 200, saved.detail);
          return;
        }

        if (request.method === 'DELETE') {
          if (!store.deleteProject(projectId)) {
            throw new HttpError(404, 'Project not found');
          }
          sendEmpty(response, 204);
          return;
        }
      }

      if (url.pathname.startsWith('/api/')) {
        throw new HttpError(404, 'API endpoint not found');
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new HttpError(405, 'Method not allowed');
      }

      const requestedFile = safeStaticFile(publicDir, url.pathname);
      if (requestedFile && existsSync(requestedFile) && statSync(requestedFile).isFile()) {
        sendStaticFile(request, response, requestedFile);
        return;
      }

      const indexFile = path.join(publicDir, 'index.html');
      if (!existsSync(indexFile)) {
        throw new HttpError(404, 'Frontend entry file not found');
      }
      sendStaticFile(request, response, indexFile);
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, error.statusCode || 500, {
          error: error.message || 'Internal server error'
        });
      } else {
        response.destroy();
      }
    }
  });

  return {
    server,
    store,
    close() {
      return new Promise((resolve, reject) => {
        if (!server.listening) {
          store.close();
          resolve();
          return;
        }
        server.close((error) => {
          store.close();
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const host = process.env.HOST || DEFAULT_HOST;
  const databasePath = path.resolve(process.env.STORYBOARD_DATA_FILE || DEFAULT_DB_PATH);
  const perfLogEnabled = process.env.STORYBOARD_PERF === '1';
  const application = createStoryboardApplication({
    databasePath,
    publicDir: DEFAULT_PUBLIC_DIR,
    perfLogEnabled
  });

  application.server.listen(port, host, () => {
    console.log(`Storyboard server running at http://${host}:${port}`);
    console.log(`SQLite database: ${databasePath}`);
    if (perfLogEnabled) {
      console.log('Server perf logging: enabled (STORYBOARD_PERF=1)');
    }
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) {
      return;
    }
    closing = true;
    try {
      await application.close();
      process.exit(0);
    } catch (error) {
      console.error('Server shutdown failed:', error);
      process.exit(1);
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = {
  createStoryboardApplication
};
