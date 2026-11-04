import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { upsertMovie } from '../server/catalog.js';
import { sourceDefaults } from '../server/defaults.js';
import { Store } from '../server/store.js';
import { Worker } from '../server/worker.js';
import type { AppClock } from '../server/clock.js';
import type { Run } from '../shared/types.js';

test('deleting task history persists only terminal record removal and retains collected data', async t => {
  const keys = ['DATABASE_URL', 'DATA_FILE', 'APP_AUTH_TOKEN', 'PGSCHEMA'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudmedia-run-delete-'));
  delete process.env.DATABASE_URL; delete process.env.APP_AUTH_TOKEN;
  process.env.DATA_FILE = path.join(directory, 'catalog.json');
  process.env.PGSCHEMA = 'cloudmedia_test';
  const store = new Store();
  await store.init();
  const source = sourceDefaults({ id: 'source-fixture', name: '任务删除测试源', baseUrl: 'https://fixture.example', collectionMode: 'all' });
  store.state.sources = [source];
  const movie = upsertMovie(store.state, source, {
    externalId: 'film', title: '保留的影片', pageUrl: 'https://fixture.example/film',
    resources: [{ name: '主线', episode: '正片', url: 'https://fixture.example/video.m3u8', pageUrl: 'https://fixture.example/film' }],
  }).movie;
  const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=', 'base64');
  const sha256 = createHash('sha256').update(data).digest('hex');
  const poster = { path: `/media/posters/${sha256}.png`, sha256, mime: 'image/png', data, downloadedAt: new Date().toISOString() };
  await store.posterStorage!.put(poster);
  movie.poster = poster.path;
  const startedAt = '2026-11-04T04:00:00.000Z';
  const clock: AppClock = {
    now: () => new Date(startedAt),
    status: () => ({ now: startedAt, timezone: 'Asia/Shanghai', synchronized: true, lastSyncedAt: startedAt, source: 'fixture', error: null }),
  };
  const run = (status: Run['status']): Run => ({
    id: 'run-' + status, sourceId: source.id, sourceName: source.name, status, startedAt,
    finishedAt: ['queued', 'running'].includes(status) ? null : startedAt,
    scanned: 1, added: 1, updated: 0, resourceCount: 1, errors: [], message: status,
  });
  store.state.runs = ['success', 'error', 'interrupted', 'running', 'queued'].map(status => run(status as Run['status']));
  await store.save();
  const collectedBefore = structuredClone({ movies: store.state.movies, resources: store.state.resources });
  const worker = new Worker(store, clock);
  const server = createApp(store, worker, clock).listen(0, '127.0.0.1');
  let reloaded: Store | undefined;
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => {
    try {
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
      await worker.stop(); await store.close(); await reloaded?.close();
    } finally {
      for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      const target = path.resolve(directory);
      assert.ok(target.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(target).startsWith('cloudmedia-run-delete-'));
      await rm(target, { recursive: true, force: true, maxRetries: 3 });
    }
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const remove = (id: string) => fetch(`${origin}/api/runs/${id}`, { method: 'DELETE' });

  await t.test('unknown IDs return 404 and active tasks return 409 without changing history', async () => {
    const before = structuredClone(store.state);
    const missing = await remove('missing');
    assert.equal(missing.status, 404); assert.match((await missing.json()).error, /不存在/);
    for (const id of ['run-running', 'run-queued']) {
      const response = await remove(id);
      assert.equal(response.status, 409); assert.match((await response.json()).error, /取消|结束/);
    }
    assert.deepEqual(store.state, before);
  });

  await t.test('a failed deletion save restores history and schedule markers in memory', async t => {
    const before = structuredClone(store.state);
    const diskBefore = await readFile(process.env.DATA_FILE!, 'utf8');
    const save = t.mock.method(store, 'save', async () => { throw new Error('fixture storage failure'); });
    const response = await remove('run-success');
    assert.equal(response.status, 500); assert.match((await response.json()).error, /storage failure/);
    save.mock.restore();
    assert.deepEqual(store.state, before, 'polling must still show a task whose durable deletion failed');
    assert.equal(await readFile(process.env.DATA_FILE!, 'utf8'), diskBefore);
    const list = await fetch(origin + '/api/runs').then(result => result.json()) as Run[];
    assert.ok(list.some(item => item.id === 'run-success'));
  });

  await t.test('success, failure and interrupted records are independently removed before success is returned', async () => {
    for (const id of ['run-success', 'run-error', 'run-interrupted']) {
      const response = await remove(id);
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
      assert.ok(!store.state.runs.some(item => item.id === id));
      const disk = JSON.parse(await readFile(process.env.DATA_FILE!, 'utf8'));
      assert.ok(!disk.runs.some((item: Run) => item.id === id), 'successful response must follow durable deletion');
      assert.deepEqual({ movies: store.state.movies, resources: store.state.resources }, collectedBefore);
      assert.deepEqual({ movies: disk.movies, resources: disk.resources }, collectedBefore);
      assert.equal(disk.sources.length, 1); assert.equal(disk.sources[0].id, source.id);
      assert.deepEqual((await store.posterStorage!.get(poster.path))?.data, data);
    }
    assert.deepEqual(store.state.runs.map(item => item.id), ['run-running', 'run-queued']);
    const image = await fetch(origin + poster.path);
    assert.equal(image.status, 200); assert.deepEqual(Buffer.from(await image.arrayBuffer()), data);
    const list = await fetch(origin + '/api/runs').then(response => response.json()) as Run[];
    assert.deepEqual(list.map(item => item.id).sort(), ['run-queued', 'run-running']);
  });

  await t.test('deleted task history and its daily deduplication marker survive a Store reload', async () => {
    assert.equal(source.lastRunAt, null, 'deleting history must not forge a new collection completion time');
    assert.ok(source.deletedRunScopes?.length, 'today\'s completed scope must remain claimed independently of task history');
    reloaded = new Store(); await reloaded.init();
    assert.deepEqual(reloaded.state.runs.map(item => item.id), ['run-running', 'run-queued']);
    assert.deepEqual(reloaded.state.sources[0].deletedRunScopes, source.deletedRunScopes);
    assert.deepEqual({ movies: reloaded.state.movies, resources: reloaded.state.resources }, collectedBefore);
  });
});
