import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PosterArchiver } from '../server/poster-archive.js';
import { upsertMovie } from '../server/catalog.js';
import { sourceDefaults } from '../server/defaults.js';
import { Store } from '../server/store.js';

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
    requestTimes.push({ url: request.url || '', at: Date.now() });
    if (request.url === '/redirect.png') { response.writeHead(302, { location: origin + '/poster.png' }); response.end(); return; }
    if (request.url === '/slow.png') { releaseSlow = () => { response.setHeader('content-type', 'image/png'); response.end(png); }; return; }
    if (request.url === '/slow-detail') { releaseDetail = () => response.end('<h1>旧详情</h1><img class="cover" src="/poster.png">'); return; }
    if (request.url === '/poster.png' || (request.url === '/retry.png' && !fail)) {
      response.setHeader('content-type', 'image/png'); response.end(png); return;
    }
    if (request.url === '/detail') { response.end('<h1>旧电影</h1><img class="cover" src="/poster.png">'); return; }
    response.writeHead(503); response.end('temporarily unavailable');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const store = new Store(); await store.init();
  const source = sourceDefaults({ baseUrl: origin, posterSelector: '.cover', respectRobots: false }); store.state.sources = [source];
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
  await t.test('redirected image requests retain the per-host request interval', async () => {
    const item = movie('redirect', origin + '/redirect.png'); const start = requestTimes.length;
    await archiver.archiveMovie(item);
    const attempts = requestTimes.slice(start);
    assert.deepEqual(attempts.map(entry => entry.url), ['/redirect.png', '/poster.png']);
    assert.ok(attempts[1].at - attempts[0].at >= 950, 'the redirect target must be rate limited as well');
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
