import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { PosterArchiver } from '../server/poster-archive.js';
import { upsertMovie } from '../server/catalog.js';
import { initialState, sourceDefaults } from '../server/defaults.js';
import { Store } from '../server/store.js';
import type { PosterBinary, PosterStorage } from '../server/poster-storage.js';

async function withoutTimerAdvance(t: TestContext, run: (signal: AbortSignal) => Promise<void>) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const controller = new AbortController();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1793750400000 });
  const task = run(controller.signal);
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([task, new Promise<never>((_resolve, reject) => {
      watchdog = realSetTimeout(() => reject(new Error('zero poster interval must not wait for timer advancement')), 2000);
    })]);
  } finally {
    realClearTimeout(watchdog);
    controller.abort();
    await task.catch(() => {});
    t.mock.timers.reset();
  }
}

test('poster archive persists local files, failures and recovered legacy images', async t => {
  const keys = ['DATABASE_URL', 'DATA_FILE', 'POSTER_DIR', 'ALLOW_PRIVATE_UPSTREAM'] as const;
  const previous = keys.map(key => process.env[key]);
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudmedia-archive-'));
  delete process.env.DATABASE_URL;
  process.env.DATA_FILE = path.join(directory, 'catalog.json');
  process.env.POSTER_DIR = path.join(directory, 'posters');
  process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1kAAAAASUVORK5CYII=', 'base64');
  let origin = ''; let fail = true; let releaseSlow: (() => void) | undefined; let releaseDetail: (() => void) | undefined; const requests: string[] = [];
  const requestTimes: { url: string; at: number }[] = [];
  const upstream = createServer((request, response) => {
    requests.push(request.url || '');
    requestTimes.push({ url: request.url || '', at: performance.now() });
    if (request.url === '/redirect.png') { response.writeHead(302, { location: origin + '/poster.png' }); response.end(); return; }
    if (request.url === '/slow.png') { releaseSlow = () => { response.setHeader('content-type', 'image/png'); response.end(png); }; return; }
    if (request.url === '/slow-detail') { releaseDetail = () => response.end('<h1>旧详情</h1><img class="cover" src="/poster.png">'); return; }
    if (request.url === '/poster.png' || (request.url === '/retry.png' && !fail)) {
      response.setHeader('content-type', 'image/png'); response.end(png); return;
    }
    if (request.url === '/detail') { response.end('<h1>旧电影</h1><img class="cover" src="/poster.png">'); return; }
    if (request.url === '/no-poster-detail') { response.end('<h1>没有海报的电影</h1>'); return; }
    response.writeHead(503); response.end('temporarily unavailable');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const store = new Store(); await store.init();
  const source = sourceDefaults({ baseUrl: origin, posterSelector: '.cover', respectRobots: false, requestIntervalMs: 0 }); store.state.sources = [source];
  const archiver = new PosterArchiver(store);
  const movie = (id: string, poster: string) => upsertMovie(store.state, source, { externalId: id, pageUrl: origin + '/detail', title: id, poster, resources: [] }).movie;
  t.after(async () => {
    await archiver.stop(); await store.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    for (let index = 0; index < keys.length; index++) { if (previous[index] === undefined) delete process.env[keys[index]]; else process.env[keys[index]] = previous[index]; }
    await rm(directory, { recursive: true, force: true });
  });
  await t.test('remote images become local files and database snapshots record their provenance', async () => {
    const item = movie('download', origin + '/poster.png');
    await archiver.archiveMovie(item);
    assert.match(item.poster, /^\/media\/posters\/[a-f0-9]{64}\.png$/);
    assert.equal(item.posterArchive?.status, 'saved');
    assert.equal(item.posterArchive?.originalUrl, origin + '/poster.png');
    assert.equal(item.posterArchive?.bytes, png.length);
    assert.deepEqual(await readFile(path.join(process.env.POSTER_DIR!, path.basename(item.poster))), png);
    const snapshot = JSON.parse(await readFile(process.env.DATA_FILE!, 'utf8'));
    assert.equal(snapshot.movies.find((entry: {id:string}) => entry.id === item.id).posterArchive.status, 'saved');
  });
  await t.test('failed downloads never remain remote display URLs and explicit retry can recover', async () => {
    const item = movie('retry', origin + '/retry.png');
    await archiver.archiveMovie(item);
    assert.equal(item.poster, ''); assert.equal(item.posterArchive?.status, 'error');
    assert.ok(item.posterArchive?.error); assert.ok(item.posterArchive?.nextRetryAt);
    fail = false;
    await archiver.archiveMovie(item, origin + '/retry.png', origin + '/detail', undefined, true);
    assert.equal(item.posterArchive?.status, 'saved'); assert.match(item.poster, /^\/media\/posters\//);
  });
  await t.test('missing legacy local files recover from the stored detail page instead of silently passing', async () => {
    const item = movie('legacy', '/media/posters/' + 'a'.repeat(64) + '.png');
    await archiver.archiveMovie(item);
    assert.equal(item.posterArchive?.status, 'saved');
    assert.equal(item.posterArchive?.originalUrl, origin + '/poster.png');
    assert.ok(requests.includes('/detail'));
  });
  await t.test('missing files without a recoverable original page have an explicit persisted missing state', async () => {
    const item = movie('unrecoverable', '/media/posters/' + 'b'.repeat(64) + '.png'); item.sourceRefs = [];
    await archiver.archiveMovie(item);
    assert.equal(item.poster, ''); assert.equal(item.posterArchive?.status, 'missing'); assert.ok(item.posterArchive?.error);
  });
  await t.test('a good local image survives a failing replacement download', async () => {
    const item = store.state.movies[0]; const savedPath = item.poster;
    await archiver.archiveMovie(item, origin + '/unavailable.png');
    assert.equal(item.poster, savedPath); assert.equal(item.posterArchive?.status, 'error');
    assert.deepEqual(await readFile(path.join(process.env.POSTER_DIR!, path.basename(item.poster))), png);
  });
  await t.test('deleted archived files are detected and restored from saved origin information', async () => {
    const item = store.state.movies.find(entry => entry.title === 'legacy')!;
    await unlink(path.join(process.env.POSTER_DIR!, path.basename(item.poster)));
    await archiver.archiveMovie(item);
    assert.equal(item.posterArchive?.status, 'saved'); assert.deepEqual(await readFile(path.join(process.env.POSTER_DIR!, path.basename(item.poster))), png);
  });
  await t.test('new poster information queued during a download is archived after the existing task', async () => {
    const item = movie('concurrent', origin + '/slow.png');
    const first = archiver.archiveMovie(item);
    while (!releaseSlow) await new Promise(resolve => setTimeout(resolve, 10));
    const next = archiver.archiveMovie(item, origin + '/poster.png', origin + '/detail');
    releaseSlow(); await Promise.all([first, next]);
    assert.equal(item.posterArchive?.originalUrl, origin + '/poster.png');
    assert.equal(item.posterArchive?.status, 'saved');
  });
  await t.test('legacy recovery tries another saved source when the first reference is unavailable', async () => {
    const item = movie('multi-source', '/media/posters/' + 'c'.repeat(64) + '.png');
    item.sourceRefs.unshift({ sourceId: source.id, externalId: 'bad', pageUrl: origin + '/missing-detail' });
    const previousRetries = store.state.settings.maxRetries; store.state.settings.maxRetries = 0;
    try { await archiver.archiveMovie(item); }
    finally { store.state.settings.maxRetries = previousRetries; }
    assert.equal(item.posterArchive?.status, 'saved');
  });
  await t.test('checkpoint provenance survives independently of a completed download', async () => {
    const item = movie('checkpoint', '/media/posters/' + 'd'.repeat(64) + '.png');
    archiver.recordPoster(item, origin + '/poster.png', origin + '/detail'); await store.save();
    const snapshot = JSON.parse(await readFile(process.env.DATA_FILE!, 'utf8'));
    assert.equal(snapshot.movies.find((entry: {id:string}) => entry.id === item.id).posterArchive.originalUrl, origin + '/poster.png');
    assert.equal(item.posterArchive?.status, 'pending');
  });
  await t.test('restoring a missing file from backup makes it visible even during failed-download backoff', async () => {
    fail = false;
    const item = movie('restore', origin + '/retry.png'); await archiver.archiveMovie(item);
    const savedPath = item.poster; const filename = path.join(process.env.POSTER_DIR!, path.basename(savedPath));
    await unlink(filename); fail = true; await archiver.archiveMovie(item);
    assert.equal(item.poster, ''); assert.equal(item.posterArchive?.status, 'error');
    await writeFile(filename, png); await archiver.archiveMovie(item);
    assert.equal(item.poster, savedPath);
  });
  await t.test('zero source interval downloads images and redirects without advancing timer time', async t => {
    const zeroArchiver = new PosterArchiver(store);
    const unrelated = sourceDefaults({ baseUrl: 'https://other-zero.fixture.example', requestIntervalMs: 1000 });
    const cdnSource = sourceDefaults({ baseUrl: 'https://zero-catalog.fixture.example', requestIntervalMs: 0 });
    store.state.sources.push(unrelated, cdnSource);
    const detailPage = cdnSource.baseUrl + '/detail';
    try {
      await withoutTimerAdvance(t, async signal => {
        for (const id of ['zero-redirect-first', 'zero-redirect-second']) {
          const item = upsertMovie(store.state, cdnSource, { externalId: id, pageUrl: detailPage, title: id, poster: origin + '/redirect.png', resources: [] }).movie;
          item.sourceRefs.unshift({ sourceId: unrelated.id, externalId: id, pageUrl: unrelated.baseUrl + '/detail' });
          await zeroArchiver.archiveMovie(item, '', detailPage, signal);
          assert.equal(item.posterArchive?.status, 'saved');
        }
      });
    } finally { await zeroArchiver.stop(); }
  });
  await t.test('zero source interval recovers repeated legacy pages without advancing timer time', async t => {
    const zeroArchiver = new PosterArchiver(store);
    const start = requests.length;
    try {
      await withoutTimerAdvance(t, async signal => {
        for (const digit of ['6', '7', '8', '9']) {
          const item = movie('zero-recovery-' + digit, '/media/posters/' + digit.repeat(64) + '.png');
          item.sourceRefs[0].pageUrl = origin + '/no-poster-detail';
          await zeroArchiver.archiveMovie(item, '', '', signal);
          assert.equal(item.posterArchive?.status, 'missing');
        }
      });
      assert.deepEqual(requests.slice(start), ['/no-poster-detail', '/no-poster-detail', '/no-poster-detail', '/no-poster-detail']);
    } finally { await zeroArchiver.stop(); }
  });
  await t.test('redirected CDN image requests use the interval of their recorded source', async () => {
    const unrelated = sourceDefaults({ baseUrl: 'https://other-catalog.fixture.example', requestIntervalMs: 1000 });
    const cdnSource = sourceDefaults({ baseUrl: 'https://catalog.fixture.example', requestIntervalMs: 300 });
    store.state.sources.push(unrelated, cdnSource);
    const detailPage = cdnSource.baseUrl + '/detail';
    const item = upsertMovie(store.state, cdnSource, { externalId: 'redirect', pageUrl: detailPage, title: 'CDN poster', poster: origin + '/redirect.png', resources: [] }).movie;
    item.sourceRefs.unshift({ sourceId: unrelated.id, externalId: 'unrelated', pageUrl: unrelated.baseUrl + '/detail' });
    const start = requestTimes.length;
    await archiver.archiveMovie(item, '', detailPage);
    const attempts = requestTimes.slice(start);
    assert.deepEqual(attempts.map(entry => entry.url), ['/redirect.png', '/poster.png']);
    const elapsed = attempts[1].at - attempts[0].at;
    assert.ok(elapsed >= 250, 'the redirect target must retain its source interval');
    assert.equal(item.posterArchive?.status, 'saved');
  });
  await t.test('image redirects retain the fallback interval when their source is no longer available', async () => {
    const item = movie('orphan-redirect', origin + '/redirect.png'); item.sourceRefs = [];
    const start = requestTimes.length;
    await archiver.archiveMovie(item);
    const attempts = requestTimes.slice(start);
    assert.deepEqual(attempts.map(entry => entry.url), ['/redirect.png', '/poster.png']);
    assert.ok(attempts[1].at - attempts[0].at >= 950, 'an orphaned image retains the fallback one-second interval');
    assert.equal(item.posterArchive?.status, 'saved');
  });
  await t.test('a stale detail recovery cannot overwrite newer checkpoint poster provenance', async () => {
    const item = movie('stale-recovery', '/media/posters/' + 'e'.repeat(64) + '.png'); item.sourceRefs[0].pageUrl = origin + '/slow-detail';
    const pending = archiver.archiveMovie(item);
    while (!releaseDetail) await new Promise(resolve => setTimeout(resolve, 10));
    archiver.recordPoster(item, origin + '/poster.png?new', origin + '/new-detail');
    releaseDetail(); await pending;
    assert.equal(item.posterArchive?.originalUrl, origin + '/poster.png?new');
    assert.equal(item.posterArchive?.referer, origin + '/new-detail');
  });
});

test('database-mode archiver stores and reuses binary posters without creating a local image directory', async t => {
  const previous = { POSTER_DIR: process.env.POSTER_DIR, ALLOW_PRIVATE_UPSTREAM: process.env.ALLOW_PRIVATE_UPSTREAM };
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudmedia-database-posters-'));
  const unusedPosters = path.join(directory, 'must-not-be-created');
  process.env.POSTER_DIR = unusedPosters; process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1kAAAAASUVORK5CYII=', 'base64');
  const upstream = createServer((_request, response) => { response.setHeader('content-type', 'image/png'); response.end(png); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const images = new Map<string, PosterBinary>();
  let failWrite = false, writes = 0, snapshots = 0;
  const posterStorage: PosterStorage = {
    async get(key) { return images.get(key) || null; },
    async put(value) { if (failWrite) throw new Error('database write failed'); writes++; images.set(value.path, value); },
  };
  const state = initialState();
  const source = sourceDefaults({ baseUrl: origin, requestIntervalMs: 0, respectRobots: false }); state.sources = [source];
  const store = { state, posterStorage, async save() { snapshots++; } } as unknown as Store;
  const archiver = new PosterArchiver(store);
  t.after(async () => {
    await archiver.stop();
    if (upstream.listening) await new Promise<void>(resolve => upstream.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  });
  const movie = upsertMovie(state, source, { externalId: 'database', pageUrl: origin + '/detail', title: '数据库海报', poster: origin + '/poster.png', resources: [] }).movie;
  await archiver.archiveMovie(movie);
  assert.equal(movie.posterArchive?.status, 'saved');
  assert.deepEqual(images.get(movie.poster)?.data, png);
  assert.equal(writes, 1); assert.ok(snapshots >= 2);
  await assert.rejects(readdir(unusedPosters), { code: 'ENOENT' });

  images.clear(); failWrite = true;
  const failed = upsertMovie(state, source, { externalId: 'failed', pageUrl: origin + '/detail', title: '数据库写入失败', poster: origin + '/other.png', resources: [] }).movie;
  await archiver.archiveMovie(failed);
  assert.equal(failed.posterArchive?.status, 'error'); assert.match(failed.posterArchive?.error || '', /database write failed/);
  assert.equal(failed.poster, '');
  await assert.rejects(readdir(unusedPosters), { code: 'ENOENT' });

  failWrite = false;
  await archiver.archiveMovie(movie, '', '', undefined, true);
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  await archiver.archiveMovie(movie);
  assert.equal(movie.posterArchive?.status, 'saved'); assert.deepEqual(images.get(movie.poster)?.data, png);
  await assert.rejects(readdir(unusedPosters), { code: 'ENOENT' });
});
