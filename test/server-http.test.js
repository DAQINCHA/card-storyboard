const assert = require('node:assert/strict');
const { copyFileSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createStoryboardApplication } = require('../server.js');

const projectRoot = path.dirname(__dirname);

async function withServer(run, databaseInitializer) {
  const directory = mkdtempSync(path.join(tmpdir(), 'card-storyboard-http-'));
  const databasePath = path.join(directory, 'storyboard.db');
  if (databaseInitializer) {
    databaseInitializer(databasePath);
  }
  const application = createStoryboardApplication({
    databasePath,
    publicDir: path.join(projectRoot, 'public')
  });
  await new Promise((resolve) => application.server.listen(0, '127.0.0.1', resolve));
  const address = application.server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`, databasePath);
  } finally {
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('serves the frontend and health endpoint', async () => {
  await withServer(async (baseUrl) => {
    const healthResponse = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthResponse.status, 200);
    assert.equal((await healthResponse.json()).ok, true);

    const indexResponse = await fetch(`${baseUrl}/`);
    assert.equal(indexResponse.status, 200);
    assert.match(await indexResponse.text(), /卡片分镜/);

    const projectRouteResponse = await fetch(`${baseUrl}/project/38`);
    assert.equal(projectRouteResponse.status, 200);
    assert.match(projectRouteResponse.headers.get('content-type'), /text\/html/);
    assert.match(await projectRouteResponse.text(), /卡片分镜/);

    const scriptResponse = await fetch(`${baseUrl}/script.js`);
    assert.equal(scriptResponse.status, 200);
    assert.match(scriptResponse.headers.get('content-type'), /text\/javascript/);

    const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200);
    assert.match(manifestResponse.headers.get('content-type'), /application\/manifest\+json/);
    assert.equal((await manifestResponse.json()).name, '卡片分镜');

    const appIconResponse = await fetch(`${baseUrl}/icons/icon-512.png`);
    assert.equal(appIconResponse.status, 200);
    assert.equal(appIconResponse.headers.get('content-type'), 'image/png');
    assert.ok((await appIconResponse.arrayBuffer()).byteLength > 0);

    const logoResponse = await fetch(`${baseUrl}/icons/logo-mark.svg`);
    assert.equal(logoResponse.status, 200);
    assert.match(logoResponse.headers.get('content-type'), /image\/svg\+xml/);
  });
});

test('creates, saves, reads, duplicates, lists and deletes projects', async () => {
  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/projects`, { method: 'POST' });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.equal(created.name, '新项目');

    const imageData = Buffer.from('small-image').toString('base64');
    const saveResponse = await fetch(`${baseUrl}/api/projects/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'NAS 分镜',
        scene: '室内',
        aspectRatio: '4/3',
        shots: [{
          id: 'shot-1',
          imageId: 'image-1',
          hasImage: true,
          imageSrc: `data:image/png;base64,${imageData}`
        }]
      })
    });
    assert.equal(saveResponse.status, 200);
    const saved = await saveResponse.json();
    assert.equal(saved.name, 'NAS 分镜');
    assert.equal(saved.shots[0].imageSrc, `/api/projects/${created.id}/images/image-1`);

    const imageResponse = await fetch(`${baseUrl}${saved.shots[0].imageSrc}`);
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), Buffer.from('small-image'));

    const duplicateResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'NAS 分镜副本', sourceProjectId: created.id })
    });
    assert.equal(duplicateResponse.status, 201);
    const duplicate = await duplicateResponse.json();
    assert.equal(duplicate.shots[0].imageSrc, `/api/projects/${duplicate.id}/images/image-1`);

    const list = await fetch(`${baseUrl}/api/projects?search=NAS&sort=name_asc`).then((response) => response.json());
    assert.equal(list.length, 2);
    assert.equal(list[0].shotCount, 1);

    const deleteResponse = await fetch(`${baseUrl}/api/projects/${created.id}`, { method: 'DELETE' });
    assert.equal(deleteResponse.status, 204);
    assert.equal((await fetch(`${baseUrl}/api/projects/${created.id}`)).status, 404);
  });
});

test('opens a copy of the existing better-sqlite3 database without migration loss', async () => {
  const sourceDatabase = path.join(projectRoot, 'data', 'storyboard.db');
  await withServer(async (baseUrl, databasePath) => {
    const projectsResponse = await fetch(`${baseUrl}/api/projects`);
    assert.equal(projectsResponse.status, 200);
    assert.ok(Array.isArray(await projectsResponse.json()));
    assert.ok(readFileSync(databasePath).length > 0);
  }, (databasePath) => copyFileSync(sourceDatabase, databasePath));
});
