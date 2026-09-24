import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import express from 'express';
import request from 'supertest';
import { buildVersion } from '../shared/build-version';
import { installPublicWeb } from '../server/web-static';

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'stjw-public-release-'));
  assert.equal(dirname(resolve(path)), resolve(tmpdir()));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

test('release identity is deterministic across directories and covers runtime changes, not documentation or output', async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    for (const directory of [first.path, second.path]) {
      for (const folder of ['src', 'server', 'shared', 'public', 'docs', 'dist']) await mkdir(join(directory, folder));
      for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'Dockerfile', '.dockerignore']) await writeFile(join(directory, file), 'same release');
      await writeFile(join(directory, 'server', 'app.ts'), 'server implementation');
      await writeFile(join(directory, 'src', 'App.tsx'), 'client implementation');
      await writeFile(join(directory, 'public', 'icon.png'), Buffer.from([0, 1, 255]));
    }
    const original = buildVersion(first.path);
    assert.match(original, /^[a-f0-9]{64}$/);
    assert.equal(original, buildVersion(second.path));
    await writeFile(join(first.path, 'docs', 'STATUS.md'), 'new delivery evidence');
    await writeFile(join(first.path, 'dist', 'app-version.json'), '{}');
    assert.equal(buildVersion(first.path), original);
    await writeFile(join(first.path, 'server', 'app.ts'), 'new backend behavior');
    assert.notEqual(buildVersion(first.path), original);
    await writeFile(join(first.path, 'server', 'app.ts'), 'server implementation');
    await writeFile(join(first.path, 'public', 'icon.png'), Buffer.from([0, 2, 255]));
    assert.notEqual(buildVersion(first.path), original);
  } finally { await first.cleanup(); await second.cleanup(); }
});

test('public release metadata and every HTML entry avoid stale caches; manifest and icons revalidate', async () => {
  const directory = await fixture();
  try {
    await mkdir(join(directory.path, 'icons'));
    await writeFile(join(directory.path, 'index.html'), '<!doctype html><title>Workspace</title>');
    await writeFile(join(directory.path, 'app-version.json'), JSON.stringify({ version: 'a'.repeat(64) }));
    await writeFile(join(directory.path, 'manifest.webmanifest'), JSON.stringify({ name: 'STJW', display: 'standalone' }));
    await writeFile(join(directory.path, 'icons', 'stjw-192.png'), Buffer.from([0, 1, 255]));
    const app = express();
    installPublicWeb(app, directory.path);
    for (const path of ['/', '/index.html', '/clock', '/app-version.json']) {
      const response = await request(app).get(path).expect(200);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    const version = await request(app).get('/app-version.json').expect('Content-Type', /json/);
    assert.deepEqual(version.body, { version: 'a'.repeat(64) });
    for (const path of ['/manifest.webmanifest', '/icons/stjw-192.png']) {
      const response = await request(app).get(path).expect(200);
      assert.equal(response.headers['cache-control'], 'no-cache');
    }
    await request(app).get('/manifest.webmanifest').expect('Content-Type', /manifest\+json/);
    await rm(join(directory.path, 'app-version.json'));
    const absent = await request(app).get('/app-version.json').expect(503);
    assert.match(absent.body.error, /temporarily unavailable/);
    assert.equal(absent.headers['cache-control'], 'no-store');
  } finally { await directory.cleanup(); }
});
