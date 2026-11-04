import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { sourceDefaults } from '../server/defaults.js';
import { Store } from '../server/store.js';
import { Worker } from '../server/worker.js';
import { localMinute } from '../server/scheduler.js';
import type { Movie, Resource, Run, Source } from '../shared/types.js';

/** Full local fixture: no .env loader, real database, or project data directory. */
test('API, collector, worker, HLS probing and file persistence work together', { timeout: 40000 }, async t => {
  const envKeys = ['DATABASE_URL', 'DATA_FILE', 'POSTER_DIR', 'APP_AUTH_TOKEN', 'ALLOW_PRIVATE_UPSTREAM', 'PGSCHEMA'] as const;
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const temporary = await mkdtemp(path.join(tmpdir(), 'cloudmedia-api-'));
  const snapshotPath = path.join(temporary, 'catalog.json');
  const token = 'fixture-only-token';
  delete process.env.DATABASE_URL;
  process.env.DATA_FILE = snapshotPath;
  process.env.POSTER_DIR = path.join(temporary, 'posters');
  process.env.APP_AUTH_TOKEN = token;
  process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  process.env.PGSCHEMA = 'cloudmedia_test';
  let store: Store | undefined;
  let reloaded: Store | undefined;
  let worker: Worker | undefined;
  let appServer: Server | undefined;
  let upstream: Server | undefined;
  let upstreamOrigin = '';
  let playbackToken = 'initial-signature';
  const upstreamCalls: { path: string; query: string; range?: string }[] = [];
  const close = async (server?: Server) => {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    });
  };
  t.after(async () => {
    try {
      await worker?.stop();
      await close(appServer);
      await close(upstream);
      await store?.close();
      await reloaded?.close();
    } finally {
      for (const key of envKeys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      const resolvedTemporary = path.resolve(temporary);
      assert.ok(resolvedTemporary.startsWith(path.resolve(tmpdir()) + path.sep));
      assert.ok(path.basename(resolvedTemporary).startsWith('cloudmedia-api-'));
      await rm(resolvedTemporary, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  upstream = createServer((request, response) => {
    const url = new URL(request.url!, 'http://fixture');
    upstreamCalls.push({ path: url.pathname, query: url.search, range: request.headers.range });
    if (url.pathname === '/robots.txt') return response.end('User-agent: *\nDisallow:\n');
    if (url.pathname === '/catalog') {
      response.setHeader('Content-Type', 'application/json');
      return response.end(JSON.stringify({ list: [{
        id: 77, vod_name: '集成测试电影', vod_year: '2026', type_name: '电影',
        vod_area: '中国大陆', vod_director: '测试导演', vod_actor: '甲,乙',
        vod_content: '<p>公开影片资料</p>', vod_pic: upstreamOrigin + '/poster.png',
        pageUrl: upstreamOrigin + '/voddetail/77',
        vod_play_from: '测试蓝光', vod_play_url: '正片$' + upstreamOrigin + '/master.m3u8?token=' + playbackToken,
      }] }));
    }
    if (url.pathname === '/cancel-list') return response.end('<a href="/voddetail/cancel">可中断剧集</a>');
    if (url.pathname === '/voddetail/cancel') return response.end('<h1>检查点剧集</h1>' + Array.from({ length: 12 }, (_value, index) => `<a href="/vodplay/cancel-${index + 1}">第${index + 1}集</a>`).join(''));
    if (url.pathname.startsWith('/vodplay/cancel-')) return response.end(`<script>var player_fixture=${JSON.stringify({ url: upstreamOrigin + url.pathname + '.m3u8' })}</script>`);
    if (url.pathname === '/partial-list') return response.end('<a href="/voddetail/partial">部分成功剧集</a>');
    if (url.pathname === '/voddetail/partial') return response.end('<h1>部分成功剧集</h1><div class="module-info-item"><span class="module-info-item-title">更新：</span><div class="module-info-item-content">2026-11-03</div></div><a href="/vodplay/partial-missing">第1集</a><a href="/vodplay/partial-good">第2集</a>');
    if (url.pathname === '/vodplay/partial-good') return response.end(`<script>var player_fixture=${JSON.stringify({ url: upstreamOrigin + '/partial-good.m3u8' })}</script>`);
    if (url.pathname === '/cancel-mid-list') return response.end('<a href="/voddetail/cancel-mid">区间中断剧集</a>');
    if (url.pathname === '/voddetail/cancel-mid') return response.end('<h1>区间中断剧集</h1>' + [1, 2, 3, 4].map(episode => `<a href="/vodplay/mid-${episode}">第${episode}集</a>`).join(''));
    if (url.pathname === '/vodplay/mid-2') {
      response.write('<html>still loading');
      const slowTimer = setTimeout(() => response.end('</html>'), 30000);
      slowTimer.unref(); response.once('close', () => clearTimeout(slowTimer));
      return;
    }
    if (url.pathname.startsWith('/vodplay/mid-')) return response.end(`<script>var player_fixture=${JSON.stringify({ url: upstreamOrigin + url.pathname + '.m3u8' })}</script>`);
    if (url.pathname === '/voddetail/77') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      return response.end(`<h1>集成测试电影</h1><script>var player_aaaa=${JSON.stringify({ encrypt: 0, url: upstreamOrigin + '/master.m3u8?token=' + playbackToken })}</script>`);
    }
    if (url.pathname === '/poster.png') {
      response.setHeader('Content-Type', 'image/png');
      return response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1kAAAAASUVORK5CYII=', 'base64'));
    }
    if (url.pathname === '/master.m3u8') {
      if (url.searchParams.get('token') !== playbackToken) { response.writeHead(403); return response.end('Expired signature'); }
      response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\n/media.m3u8?token=' + playbackToken + '\n');
    }
    if (url.pathname === '/media.m3u8') return response.end('#EXTM3U\n#EXTINF:10,\n/segment.ts?token=' + playbackToken + '\n#EXT-X-ENDLIST\n');
    if (url.pathname === '/segment.ts') {
      const match = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
      const start = Number(match?.[1] || 0), end = Number(match?.[2] || 32767);
      response.writeHead(206, { 'Content-Type': 'video/mp2t', 'Content-Range': `bytes ${start}-${end}/32768`, 'Content-Length': end - start + 1 });
      return response.end(Buffer.alloc(end - start + 1, 0xff));
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => upstream!.listen(0, '127.0.0.1', resolve));
  upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  store = new Store();
  assert.equal(store.mode, 'file', 'tests must never select the live PostgreSQL service');
  await store.init();
  store.state.sources = [];
  store.state.settings.schedulerEnabled = false;
  await store.save();
  worker = new Worker(store);
  appServer = createApp(store, worker).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => appServer!.once('listening', resolve));
  const apiOrigin = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
  async function request(apiPath: string, method = 'GET', body?: unknown, authenticated = true) {
    const response = await fetch(apiOrigin + apiPath, {
      method, headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  }
  let source: Source;
  let firstMovieId = '';
  let firstResourceId = '';
  let refreshedResolvedAt = '';
  const awaitRun = async (id: string) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const { body } = await request('/api/runs');
      const run = (body as Run[]).find(item => item.id === id);
      if (run && !['queued', 'running'].includes(run.status)) return run;
      await delay(30);
    }
    throw new Error('fixture collection did not finish within 10 seconds');
  };

  await t.test('health is public, administrative reads require a valid access token', async () => {
    const health = await request('/api/health', 'GET', undefined, false);
    assert.equal(health.status, 200); assert.equal(health.body.storage, 'file'); assert.equal(health.body.authRequired, true);
    assert.equal((await request('/api/sources', 'GET', undefined, false)).status, 401);
    assert.equal((await request('/api/sources')).status, 200);
  });

  await t.test('invalid configuration is rejected without mutating current settings', async () => {
    const previousCount = store!.state.settings.sampleSegments;
    const invalid = await request('/api/settings', 'PUT', { sampleSegments: 0 });
    assert.equal(invalid.status, 400); assert.match(invalid.body.error, /sampleSegments/);
    assert.equal(store!.state.settings.sampleSegments, previousCount);
    const valid = await request('/api/settings', 'PUT', { sampleSegments: 1, sampleBytes: 16384 });
    assert.equal(valid.status, 200);
  });

  await t.test('a new JSON source can be collected, persisted and probed through the API', async () => {
    const created = await request('/api/sources', 'POST', sourceDefaults({ name: '本地公开测试源', baseUrl: upstreamOrigin, adapter: 'json', listPath: '/catalog', maxPages: 1, maxItems: 1, maxResourcePages: 1, requestIntervalMs: 1000 }));
    assert.equal(created.status, 201); source = created.body;
    const queued = await request(`/api/sources/${source.id}/run`, 'POST');
    assert.equal(queued.status, 202);
    const run = await awaitRun(queued.body.id);
    assert.equal(run.status, 'success', run.message); assert.equal(run.added, 1); assert.equal(run.resourceCount, 1);
    const list = await request('/api/movies');
    assert.equal(list.body.total, 1); firstMovieId = list.body.items[0].id;
    const detail = await request(`/api/movies/${firstMovieId}`);
    const movie = detail.body.movie as Movie; const resource = detail.body.resources[0] as Resource;
    firstResourceId = resource.id;
    assert.equal(movie.title, '集成测试电影'); assert.equal(movie.year, '2026'); assert.deepEqual(movie.actors, ['甲', '乙']);
    assert.match(movie.poster, /^\/media\/posters\//, 'poster must be cached in the isolated temporary directory');
    assert.equal(resource.probe.status, 'ok', resource.probe.error ?? '');
    assert.equal(resource.probe.width, 1920); assert.equal(resource.probe.height, 1080);
    assert.equal(resource.probe.sampledSegments, 1); assert.equal(resource.probe.bytesRead, 16384);
    assert.ok(resource.probe.speedMbps! > 0); assert.ok(resource.probe.checkedAt);
    assert.deepEqual(upstreamCalls.filter(item => item.path === '/segment.ts').map(item => item.range), ['bytes=0-16383']);
    const persisted = JSON.parse(await readFile(snapshotPath, 'utf8'));
    assert.equal(persisted.movies[0].id, firstMovieId); assert.equal(persisted.resources[0].probe.status, 'ok');
  });

  await t.test('repeated collection preserves movie and resource identities', async () => {
    const queued = await request(`/api/sources/${source.id}/run`, 'POST');
    const run = await awaitRun(queued.body.id);
    assert.equal(run.status, 'success', run.message); assert.equal(run.added, 0); assert.equal(run.updated, 1);
    assert.equal(store!.state.movies.length, 1); assert.equal(store!.state.resources.length, 1);
    assert.equal(store!.state.movies[0].id, firstMovieId); assert.equal(store!.state.resources[0].id, firstResourceId);
  });

  await t.test('refresh resolves a changed signed URL from its stable public page and probes it without changing resource identity', async () => {
    const previous = structuredClone(store!.state.resources[0]);
    const previousSampleCount = upstreamCalls.filter(item => item.path === '/segment.ts').length;
    assert.equal(previous.pageUrl, upstreamOrigin + '/voddetail/77');
    playbackToken = 'renewed-signature';
    const expired = await fetch(previous.url);
    assert.equal(expired.status, 403, 'the old signature must actually expire in this fixture');
    await expired.text();
    const refreshed = await request(`/api/resources/${firstResourceId}/refresh`, 'POST');
    assert.equal(refreshed.status, 200, refreshed.body.error ?? '');
    const resource = refreshed.body as Resource;
    assert.equal(resource.id, previous.id); assert.equal(resource.movieId, previous.movieId);
    assert.equal(resource.name, previous.name); assert.equal(resource.episode, previous.episode);
    assert.equal(resource.pageUrl, previous.pageUrl); assert.equal(resource.referer, previous.pageUrl);
    assert.equal(resource.url, upstreamOrigin + '/master.m3u8?token=renewed-signature');
    assert.notEqual(resource.url, previous.url);
    assert.ok(resource.resolvedAt && resource.resolvedAt !== previous.resolvedAt);
    assert.ok(new Date(resource.resolvedAt!).getTime() > new Date(previous.resolvedAt!).getTime());
    refreshedResolvedAt = resource.resolvedAt!;
    assert.equal(resource.probe.status, 'ok', resource.probe.error ?? '');
    assert.equal(resource.probe.width, 1920); assert.equal(resource.probe.sampledSegments, 1);
    assert.ok(resource.probe.checkedAt! > previous.probe.checkedAt!);
    assert.equal(upstreamCalls.filter(item => item.path === '/segment.ts').length, previousSampleCount + 1);
    assert.ok(upstreamCalls.some(item => item.path === '/segment.ts' && item.query === '?token=renewed-signature'));
    const persisted = JSON.parse(await readFile(snapshotPath, 'utf8'));
    assert.equal(persisted.resources[0].url, resource.url); assert.equal(persisted.resources[0].resolvedAt, refreshedResolvedAt);
    assert.equal(persisted.resources[0].probe.status, 'ok');
  });

  await t.test('changing the source domain updates catalog references and retains the independent media URL', async () => {
    const resourceUrl = store!.state.resources[0].url;
    const updated = await request(`/api/sources/${source.id}`, 'PUT', { baseUrl: 'https://new-catalog.fixture.example' });
    assert.equal(updated.status, 200);
    assert.equal(store!.state.movies[0].sourceRefs[0].pageUrl, 'https://new-catalog.fixture.example/voddetail/77');
    assert.equal(store!.state.resources[0].pageUrl, 'https://new-catalog.fixture.example/voddetail/77');
    assert.equal(store!.state.resources[0].referer, 'https://new-catalog.fixture.example/voddetail/77');
    assert.equal(store!.state.resources[0].url, resourceUrl);
  });

  await t.test('deleting a source retains the local movie, resource and cached poster', async () => {
    const deleted = await request(`/api/sources/${source.id}`, 'DELETE');
    assert.equal(deleted.status, 200); assert.equal(store!.state.sources.length, 0);
    const detail = await request(`/api/movies/${firstMovieId}`);
    assert.equal(detail.status, 200); assert.equal(detail.body.resources[0].id, firstResourceId);
    const posterResponse = await fetch(apiOrigin + detail.body.movie.poster);
    assert.equal(posterResponse.status, 200); await posterResponse.arrayBuffer();
  });

  await t.test('date requests validate, conflicting ranges are refused, and cancellation preserves durable checkpoints', async () => {
    store!.state.settings.probeEnabled = false;
    const activeSource = (await request('/api/sources', 'POST', sourceDefaults({ name: '可中断源', baseUrl: upstreamOrigin, listPath: '/cancel-list', maxItems: 1, maxPages: 1, maxResourcePages: 0, requestIntervalMs: 1000 }))).body as Source;
    const active = await request(`/api/sources/${activeSource.id}/run`, 'POST');
    assert.equal(active.status, 202);
    const checkpointDeadline = Date.now() + 15000;
    while (store!.state.resources.filter(item => item.sourceId === activeSource.id).length < 5 && Date.now() < checkpointDeadline) await delay(30);
    const checkpoint = JSON.parse(await readFile(snapshotPath, 'utf8'));
    assert.ok(checkpoint.movies.some((movie: Movie) => movie.title === '检查点剧集'), 'metadata must be saved before the final movie yield');
    assert.equal(checkpoint.resources.filter((item: Resource) => item.sourceId === activeSource.id).length, 5, 'completed playback pages must be saved while the movie is still collecting');
    const queuedSource = (await request('/api/sources', 'POST', sourceDefaults({ name: '日期更新源', baseUrl: upstreamOrigin, adapter: 'html', collectionMode: 'updates', listPath: '/catalog', requestIntervalMs: 1000 }))).body as Source;
    const beforeInvalid = store!.state.runs.length;
    for (const body of [{ startDate: '2026-02-30', endDate: '2026-03-01' }, { startDate: '2026-11-04', endDate: '2026-11-03' }, { startDate: 123 }, { unknown: true }]) {
      assert.equal((await request(`/api/sources/${queuedSource.id}/run`, 'POST', body)).status, 400);
    }
    assert.equal((await request(`/api/sources/${activeSource.id}/run`, 'POST', { startDate: '2026-11-03', endDate: '2026-11-03' })).status, 400);
    assert.equal(store!.state.runs.length, beforeInvalid, 'invalid requests must never create tasks');
    const queued = await request(`/api/sources/${queuedSource.id}/run`, 'POST');
    assert.equal(queued.status, 202); assert.equal(queued.body.status, 'queued');
    const today = localMinute(new Date(), store!.state.settings.timezone).day;
    assert.deepEqual(queued.body.dateRange, { startDate: today, endDate: today, timezone: store!.state.settings.timezone });
    const sameRange = await request(`/api/sources/${queuedSource.id}/run`, 'POST', { startDate: today, endDate: today });
    assert.equal(sameRange.status, 202); assert.equal(sameRange.body.id, queued.body.id);
    assert.equal((await request(`/api/sources/${queuedSource.id}/run`, 'POST', { startDate: '2020-01-01', endDate: '2020-01-02' })).status, 409);
    const canceledQueued = await request(`/api/runs/${queued.body.id}/cancel`, 'POST');
    assert.equal(canceledQueued.status, 200); assert.equal(canceledQueued.body.status, 'interrupted');
    const interval = await request(`/api/sources/${queuedSource.id}/run`, 'POST', { startDate: '2020-01-01', endDate: '2020-01-02' });
    assert.equal(interval.status, 202);
    assert.deepEqual(interval.body.dateRange, { startDate: '2020-01-01', endDate: '2020-01-02', timezone: store!.state.settings.timezone });
    assert.equal((await request(`/api/runs/${interval.body.id}/cancel`, 'POST')).body.status, 'interrupted');
    assert.equal((await request('/api/runs/unknown/cancel', 'POST')).status, 404);
    await request(`/api/runs/${active.body.id}/cancel`, 'POST');
    const finished = await awaitRun(active.body.id);
    assert.equal(finished.status, 'interrupted'); assert.equal(finished.scanned, 1); assert.equal(finished.added, 1); assert.equal(finished.updated, 0); assert.equal(finished.resourceCount, 5);
    const durable = JSON.parse(await readFile(snapshotPath, 'utf8'));
    assert.equal(durable.resources.filter((item: Resource) => item.sourceId === activeSource.id).length, 5);
    assert.equal(durable.runs.find((run: Run) => run.id === active.body.id).status, 'interrupted');
    assert.equal((await request(`/api/sources/${activeSource.id}`, 'DELETE')).status, 200);
    assert.equal((await request(`/api/sources/${queuedSource.id}`, 'DELETE')).status, 200);
    store!.state.settings.probeEnabled = true;
    await store!.save();
  });

  await t.test('partial playback failure keeps the film and valid resource but durably reports an incomplete task', async () => {
    store!.state.settings.probeEnabled = false;
    const created = await request('/api/sources', 'POST', sourceDefaults({ name: '部分成功源', baseUrl: upstreamOrigin, listPath: '/partial-list', collectionMode: 'updates', requestIntervalMs: 1000, maxResourcePages: 1 }));
    assert.equal(created.status, 201);
    const partialSource = created.body as Source;
    const queued = await request(`/api/sources/${partialSource.id}/run`, 'POST', { startDate: '2026-11-03', endDate: '2026-11-03' });
    assert.equal(queued.status, 202);
    const finished = await awaitRun(queued.body.id);
    assert.equal(finished.status, 'error'); assert.equal(finished.scanned, 1); assert.equal(finished.added, 1); assert.equal(finished.resourceCount, 1);
    assert.ok(finished.errors.some(message => message.includes('播放页请求失败')));
    assert.match(finished.message, /1 个页面未完整取得内容/);
    const movie = store!.state.movies.find(item => item.sourceRefs.some(ref => ref.sourceId === partialSource.id));
    assert.ok(movie); assert.equal(movie.title, '部分成功剧集');
    assert.equal(movie.sourceRefs.find(ref => ref.sourceId === partialSource.id)?.updatedOn, '2026-11-03');
    const resources = store!.state.resources.filter(item => item.sourceId === partialSource.id);
    assert.equal(resources.length, 1); assert.equal(resources[0].episode, '第2集'); assert.equal(resources[0].url, upstreamOrigin + '/partial-good.m3u8');
    const durable = JSON.parse(await readFile(snapshotPath, 'utf8'));
    const durableRun = durable.runs.find((run: Run) => run.id === finished.id) as Run;
    assert.equal(durableRun.status, 'error'); assert.deepEqual(durableRun.errors, finished.errors);
    assert.equal(durable.resources.filter((resource: Resource) => resource.sourceId === partialSource.id).length, 1);
    assert.ok(durable.movies.some((item: Movie) => item.id === movie.id));
    assert.equal(durable.sources.find((item: Source) => item.id === partialSource.id).lastError, finished.message);
    assert.equal((await request(`/api/sources/${partialSource.id}`, 'DELETE')).status, 200);
  });

  await t.test('cancellation during a slow playback request saves resources parsed since the last periodic checkpoint', async () => {
    const created = await request('/api/sources', 'POST', sourceDefaults({ name: '中途取消源', baseUrl: upstreamOrigin, listPath: '/cancel-mid-list', requestIntervalMs: 1000, maxResourcePages: 0 }));
    assert.equal(created.status, 201);
    const midSource = created.body as Source;
    const queued = await request(`/api/sources/${midSource.id}/run`, 'POST');
    const deadline = Date.now() + 10000;
    while (!upstreamCalls.some(call => call.path === '/vodplay/mid-2') && Date.now() < deadline) await delay(30);
    assert.ok(upstreamCalls.some(call => call.path === '/vodplay/mid-2'), 'fixture must be blocked in the third playback request');
    assert.ok(upstreamCalls.some(call => call.path === '/vodplay/mid-4'));
    assert.ok(upstreamCalls.some(call => call.path === '/vodplay/mid-3'));
    const beforeCancel = JSON.parse(await readFile(snapshotPath, 'utf8'));
    assert.equal(beforeCancel.resources.filter((item: Resource) => item.sourceId === midSource.id).length, 0, 'two parsed resources have not reached the five-page periodic checkpoint');
    assert.equal((await request(`/api/runs/${queued.body.id}/cancel`, 'POST')).status, 200);
    const finished = await awaitRun(queued.body.id);
    assert.equal(finished.status, 'interrupted'); assert.equal(finished.scanned, 1); assert.equal(finished.added, 1); assert.equal(finished.resourceCount, 2); assert.deepEqual(finished.errors, []);
    const durable = JSON.parse(await readFile(snapshotPath, 'utf8'));
    const saved = durable.resources.filter((item: Resource) => item.sourceId === midSource.id) as Resource[];
    assert.deepEqual(saved.map(item => item.episode).sort(), ['第3集', '第4集']);
    assert.equal(durable.runs.find((run: Run) => run.id === finished.id).status, 'interrupted');
    assert.ok(!upstreamCalls.some(call => call.path === '/vodplay/mid-1'), 'cancel must stop the remaining playback requests');
    assert.equal((await request(`/api/sources/${midSource.id}`, 'DELETE')).status, 200);
    store!.state.settings.probeEnabled = true;
    await store!.save();
  });

  await t.test('a fresh Store restores the durable catalog after worker shutdown', async () => {
    await worker!.stop(); worker = undefined;
    await store!.close(); store = undefined;
    reloaded = new Store(); await reloaded.init();
    assert.equal(reloaded.mode, 'file'); assert.equal(reloaded.state.sources.length, 0);
    assert.equal(reloaded.state.movies[0].id, firstMovieId); assert.equal(reloaded.state.resources[0].id, firstResourceId);
    assert.equal(reloaded.state.resources[0].probe.status, 'ok');
    assert.equal(reloaded.state.resources[0].resolvedAt, refreshedResolvedAt);
    assert.match(reloaded.state.resources[0].url, /token=renewed-signature$/);
    const originalRuns = reloaded.state.runs.filter(run => run.sourceId === source.id);
    assert.equal(originalRuns.length, 2); assert.ok(originalRuns.every(run => run.status === 'success'));
    assert.equal(reloaded.state.runs.filter(run => run.status === 'interrupted').length, 4);
    const failedRuns = reloaded.state.runs.filter(run => run.status === 'error');
    assert.equal(failedRuns.length, 1); assert.ok(failedRuns[0].errors.some(message => message.includes('播放页请求失败')));
  });
});
