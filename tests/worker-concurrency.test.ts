import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { upsertMovie } from '../server/catalog.js';
import { emptyProbe, initialState, sourceDefaults } from '../server/defaults.js';
import type { Store } from '../server/store.js';
import { Worker } from '../server/worker.js';
import type { Resource, State } from '../shared/types.js';

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), message);
}

async function fixture(t: TestContext, concurrency = 2, movieCount = 1, episodes = 4) {
  const previousPrivate = process.env.ALLOW_PRIVATE_UPSTREAM;
  process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  let origin = '';
  let held = true;
  let holdDetails = false;
  let holdRefresh = false;
  let active = 0;
  let peak = 0;
  const starts: string[] = [];
  const requestStarts: string[] = [];
  let activeRequests = 0;
  let requestPeak = 0;
  const detailResponses = new Map<ServerResponse, string>();
  const blocked = new Set<ServerResponse>();
  const refreshResponses = new Set<ServerResponse>();
  let refreshStarts = 0;
  let durable: State;
  let beforeSave: (() => Promise<void>) | undefined;
  const snapshots: State[] = [];
  const upstream = createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    requestStarts.push(path); activeRequests++; requestPeak = Math.max(requestPeak, activeRequests);
    response.on('close', () => { activeRequests--; detailResponses.delete(response); });
    if (path === '/list') return response.end(Array.from({ length: movieCount }, (_, index) => `<a href="/voddetail/${index + 1}">movie</a>`).join(''));
    if (path.startsWith('/voddetail/')) {
      const id = path.split('/').at(-1);
      const body = `<h1>Movie ${id}</h1>` + Array.from({ length: episodes }, (_, index) => `<a href="/media/${id}-${index + 1}.m3u8">Episode ${index + 1}</a>`).join('');
      if (holdDetails) detailResponses.set(response, body);
      else response.end(body);
      return;
    }
    if (path.startsWith('/vodplay/')) {
      refreshStarts++;
      if (holdRefresh) { refreshResponses.add(response); response.on('close', () => refreshResponses.delete(response)); }
      else response.end(`<script>var player_aaaa={"url":"${origin}/media/rotated.m3u8"}</script>`);
      return;
    }
    if (path.endsWith('.m3u8')) {
      starts.push(path); active++; peak = Math.max(peak, active);
      response.on('close', () => { active--; blocked.delete(response); });
      if (held) blocked.add(response);
      else response.end('#EXTM3U\n#EXTINF:1,\n/segment.ts\n#EXT-X-ENDLIST\n');
      return;
    }
    if (path === '/segment.ts') { response.setHeader('Content-Type', 'video/mp2t'); return response.end(Buffer.alloc(1024, 0x47)); }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const state = initialState();
  state.sources = [sourceDefaults({ id: 'first', name: 'first', baseUrl: origin, listPath: '/list', requestIntervalMs: 0, concurrency })];
  Object.assign(state.settings, { schedulerEnabled: false, probeEnabled: true, maxRetries: 0, sampleBytes: 1024 });
  durable = structuredClone(state);
  const store = { state, async save() { const snapshot = structuredClone(state); await beforeSave?.(); durable = snapshot; snapshots.push(durable); } } as unknown as Store;
  const worker = new Worker(store, { now: () => new Date() });
  const releaseWave = () => {
    for (const response of blocked) response.end('#EXTM3U\n#EXTINF:1,\n/segment.ts\n#EXT-X-ENDLIST\n');
    blocked.clear();
  };
  const release = () => { held = false; releaseWave(); };
  const releaseDetails = () => {
    holdDetails = false;
    for (const [response, body] of detailResponses) response.end(body);
    detailResponses.clear();
  };
  const releaseRefresh = () => {
    holdRefresh = false;
    for (const response of refreshResponses) response.end(`<script>var player_aaaa={"url":"${origin}/media/rotated.m3u8"}</script>`);
    refreshResponses.clear();
  };
  t.after(async () => {
    release(); releaseDetails(); releaseRefresh();
    try { await worker.stop(); }
    finally {
      await new Promise<void>((resolve, reject) => { upstream.close(error => error ? reject(error) : resolve()); upstream.closeIdleConnections(); });
      if (previousPrivate === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM; else process.env.ALLOW_PRIVATE_UPSTREAM = previousPrivate;
    }
  });
  const resources = (count: number, externalId = 'manual') => upsertMovie(state, state.sources[0], {
    externalId, title: externalId, pageUrl: origin + '/voddetail/manual', resources: Array.from({ length: count }, (_, index) => ({
      name: 'line', episode: String(index + 1), url: `${origin}/media/${externalId}-${index + 1}.m3u8`, pageUrl: origin + '/vodplay/manual', resolvedAt: '2026-01-01T00:00:00Z',
    })),
  }).resources;
  return { state, worker, starts, requestStarts, snapshots, resources, release, releaseWave, releaseDetails, releaseRefresh, hold: () => { held = true; }, holdDetails: () => { holdDetails = true; }, holdRefresh: () => { holdRefresh = true; }, refreshStarts: () => refreshStarts, durable: () => durable, peak: () => peak, requestPeak: () => requestPeak, saveHook: (hook: () => Promise<void>) => { beforeSave = hook; } };
}

test('collector details and manual probes share one source request budget', async t => {
  const f = await fixture(t, 2, 2, 1);
  f.holdDetails();
  const run = f.worker.enqueue(f.state.sources[0]);
  await waitFor(() => f.requestStarts.filter(path => path.startsWith('/voddetail/')).length === 2, 'both detail requests should hold the shared source slots');
  const manual = Promise.allSettled(f.resources(2).map(resource => f.worker.probe(resource)));
  await delay(40);
  assert.equal(f.starts.length, 0, 'manual probes must wait while collector requests occupy the source');
  assert.equal(f.requestPeak(), 2);
  f.releaseDetails(); f.release();
  assert.ok((await manual).every(result => result.status === 'fulfilled'));
  await waitFor(() => Boolean(f.durable().runs.find(item => item.id === run.id && item.status === 'success')), 'collection and manual probes should finish');
  assert.equal(f.requestPeak(), 2, 'the source limit includes all collection and probe requests');
});

test('source concurrency one shares collection and refresh capacity without nesting deadlocks', async t => {
  const f = await fixture(t, 1, 1, 1);
  const [resource] = f.resources(1);
  f.holdRefresh(); f.release();
  const manual = Promise.allSettled([f.worker.probe(resource, true)]);
  await waitFor(() => f.refreshStarts() === 1, 'manual refresh should hold the single source slot');
  const run = f.worker.enqueue(f.state.sources[0]);
  await delay(40);
  assert.equal(f.requestStarts.includes('/list'), false, 'collection waits for the active refresh');
  f.releaseRefresh();
  assert.ok((await manual).every(result => result.status === 'fulfilled'));
  await waitFor(() => Boolean(f.durable().runs.find(item => item.id === run.id && item.status === 'success')), 'single-slot collection, playback refresh, and probes must complete');
  assert.equal(f.requestPeak(), 1);
});

test('stop cancels a collector queued behind a shared manual source slot', async t => {
  const f = await fixture(t, 1);
  const [resource] = f.resources(1);
  f.holdRefresh();
  const manual = Promise.allSettled([f.worker.probe(resource, true)]);
  await waitFor(() => f.refreshStarts() === 1, 'manual refresh should hold the source slot');
  const run = f.worker.enqueue(f.state.sources[0]);
  await delay(30);
  await f.worker.stop();
  assert.equal((await manual)[0].status, 'rejected');
  assert.equal(f.requestStarts.includes('/list'), false, 'cancelled queued collection requests never start');
  assert.equal(f.durable().runs.find(item => item.id === run.id)?.status, 'interrupted');
  assert.ok(f.durable().runs.find(item => item.id === run.id)?.finishedAt);
});

test('manual probes use the source concurrency and do not block another source', async t => {
  const f = await fixture(t);
  const resources = f.resources(4);
  const second = sourceDefaults({ ...f.state.sources[0], id: 'second', concurrency: 1 });
  f.state.sources.push(second);
  const other: Resource = { ...structuredClone(resources[0]), id: 'other', sourceId: second.id };
  f.state.resources.push(other);
  const tasks = [...resources, other].map(resource => f.worker.probe(resource));
  const settled = Promise.allSettled(tasks);
  assert.equal(f.worker.probe(resources[0]), tasks[0], 'matching pending probes retain one promise');
  await waitFor(() => f.starts.length === 3, 'two first-source probes and one independent-source probe should start');
  assert.equal(f.peak(), 3);
  f.release();
  assert.ok((await settled).every(result => result.status === 'fulfilled'));
  assert.equal(f.state.resources.filter(resource => resource.probe.status === 'ok').length, 5);
});

test('collection processes independent movies and probes after saving metadata', async t => {
  const f = await fixture(t, 2, 2, 2);
  const run = f.worker.enqueue(f.state.sources[0]);
  await waitFor(() => f.starts.length === 2, 'collection should begin two probes concurrently');
  assert.equal(f.durable().movies.length, 2);
  assert.equal(f.durable().resources.length, 4);
  assert.ok(f.durable().resources.every(resource => resource.probe.status === 'pending'));
  f.state.sources[0].concurrency = 1;
  const [manual] = f.resources(1, 'during-run');
  const manualSettled = Promise.allSettled([f.worker.probe(manual)]);
  await delay(30);
  assert.equal(f.starts.length, 2, 'manual probes share the running source limit');
  f.releaseWave();
  await waitFor(() => f.starts.length === 4, 'the frozen limit should start two more probes after an edit');
  assert.equal(f.peak(), 2);
  f.release();
  await manualSettled;
  await waitFor(() => Boolean(f.durable().runs.find(item => item.id === run.id && item.status === 'success')), 'collection should finish durably');
  assert.equal(f.peak(), 2, 'the run retains its configured source concurrency');
  assert.equal(run.scanned, 2);
  assert.equal(run.added, 2);
  assert.equal(run.resourceCount, 4);
  assert.ok(f.durable().resources.every(resource => resource.probe.status === 'ok'));
  f.hold();
  const afterRun = Promise.allSettled(f.resources(2, 'after-run').map(resource => f.worker.probe(resource)));
  await waitFor(() => f.starts.length === 6, 'the edited limit applies to the next manual operation');
  await delay(30);
  assert.equal(f.starts.length, 6, 'source concurrency returns to its edited setting after the run');
  f.release(); await afterRun;
});

test('a queued resource operation aborts promptly without starting a refresh', async t => {
  const f = await fixture(t, 1);
  const [resource] = f.resources(1);
  const first = f.worker.probe(resource);
  const firstSettled = Promise.allSettled([first]);
  await waitFor(() => f.starts.length === 1, 'first probe should hold the resource');
  const controller = new AbortController();
  const queued = f.worker.probe(resource, true, controller.signal);
  const aborted = assert.rejects(queued, /cancelled/);
  controller.abort(new Error('cancelled queued refresh'));
  await Promise.race([aborted, delay(500).then(() => { throw new Error('queued cancellation did not settle promptly'); })]);
  assert.equal(resource.url.includes('rotated'), false);
  f.release();
  await firstSettled;
  assert.equal(f.starts.length, 1);
});

test('refresh and probe writes for one resource serialize while other resources run', async t => {
  const f = await fixture(t);
  const [resource, other] = f.resources(2);
  const first = f.worker.probe(resource);
  const refresh = f.worker.probe(resource, true);
  const independent = f.worker.probe(other);
  const settled = Promise.allSettled([first, refresh, independent]);
  await waitFor(() => f.starts.length === 2, 'another resource should run while refresh waits for its resource');
  assert.equal(resource.url.includes('rotated'), false);
  f.release();
  assert.ok((await settled).every(result => result.status === 'fulfilled'));
  assert.ok(resource.url.endsWith('/media/rotated.m3u8'));
  assert.equal(resource.probe.status, 'ok');
  assert.ok(resource.urlHistory!.some(item => item.url.endsWith('/media/manual-1.m3u8')));
  assert.ok(resource.probeHistory!.some(probe => probe.playlistUrl?.endsWith('/media/manual-1.m3u8')));
  assert.ok(resource.probeHistory!.some(probe => probe.playlistUrl?.endsWith('/media/rotated.m3u8')));
});

test('an in-flight probe cannot write measurements after the same URL was resolved again', async t => {
  const f = await fixture(t);
  const [resource] = f.resources(1);
  const task = f.worker.probe(resource);
  const settled = Promise.allSettled([task]);
  await waitFor(() => f.starts.length === 1, 'probe should start');
  resource.resolvedAt = '2026-11-04T12:00:00Z';
  resource.probe = emptyProbe();
  f.release(); await settled;
  assert.equal(resource.probe.status, 'pending');
  assert.equal(resource.probe.checkedAt, null);
});

test('an in-flight manual refresh cannot replace a newer collected resource identity', async t => {
  const f = await fixture(t);
  const [resource] = f.resources(1);
  f.holdRefresh();
  const settled = Promise.allSettled([f.worker.probe(resource, true)]);
  await waitFor(() => f.refreshStarts() === 1, 'refresh should read the player page');
  resource.url = resource.url.replace('manual-1', 'newer-collection');
  resource.resolvedAt = '2026-11-04T12:00:00Z';
  const updated = resource.url;
  f.releaseRefresh();
  assert.ok((await settled).every(result => result.status === 'fulfilled'));
  assert.equal(resource.url, updated);
  assert.equal(resource.resolvedAt, '2026-11-04T12:00:00Z');
  assert.equal(resource.probe.status, 'pending');
  assert.equal(f.starts.length, 0, 'obsolete refresh results do not start a probe');
});

test('cancelled collection drains active probes and retains saved resources without probe results', async t => {
  const f = await fixture(t, 2, 2, 2);
  const run = f.worker.enqueue(f.state.sources[0]);
  await waitFor(() => f.starts.length === 2, 'two episode probes should start');
  await f.worker.cancel(run.id);
  await waitFor(() => Boolean(f.durable().runs.find(item => item.id === run.id && item.finishedAt)), 'cancelled run must become durable only after tasks drain');
  assert.equal(run.status, 'interrupted');
  assert.equal(f.starts.length, 2, 'queued episode probes never start after cancellation');
  assert.equal(f.durable().resources.length, 4);
  assert.ok(f.durable().resources.every(resource => resource.probe.status === 'pending'));
  const progress = f.durable().runs.find(item => item.id === run.id)?.progress;
  assert.equal(progress?.activeMovies, 0);
  assert.equal(progress?.completedMovies, 0, 'cancelled measurements must not mark a movie completed');
  assert.deepEqual(progress?.activeMovieTitles, []);
  assert.deepEqual(progress?.probes, { queued: 0, active: 0, passed: 0, failed: 0 });
  assert.equal(progress?.failures.total, 0, 'user cancellation is not a failed request');
  f.release();
});

test('a parallel probe save failure records an error, drains its peers, and permits a retry', async t => {
  const f = await fixture(t, 2, 2, 2);
  let failed = false;
  f.saveHook(async () => {
    if (!failed && f.state.resources.some(resource => resource.probe.status === 'ok')) {
      failed = true;
      throw new Error('parallel probe storage unavailable');
    }
  });
  const run = f.worker.enqueue(f.state.sources[0]);
  await waitFor(() => f.starts.length === 2, 'parallel probes should hold the first batch');
  f.releaseWave();
  await waitFor(() => Boolean(f.durable().runs.find(item => item.id === run.id && item.finishedAt)), 'failed batch should drain and persist its error');
  assert.equal(run.status, 'error', 'internal error cancellation is not a user interruption');
  assert.match(run.message, /parallel probe storage unavailable/);
  assert.equal(f.starts.length, 2, 'failed batches never start their queued probes');
  assert.equal(f.durable().movies.length, 2);
  assert.equal(f.durable().resources.length, 4);
  f.release();
  const retry = f.worker.enqueue(f.state.sources[0]);
  await waitFor(() => Boolean(f.durable().runs.find(item => item.id === retry.id && item.status === 'success')), 'retry should finish after storage recovers');
  assert.ok(f.durable().resources.every(resource => resource.probe.status === 'ok'));
});

test('stop cancels queued and active manual probes and persists after they drain', async t => {
  const f = await fixture(t);
  const tasks = Promise.allSettled(f.resources(4).map(resource => f.worker.probe(resource)));
  await waitFor(() => f.starts.length === 2, 'manual probes should occupy the source limit');
  await f.worker.stop();
  assert.ok((await tasks).every(result => result.status === 'rejected'));
  assert.equal(f.starts.length, 2);
  assert.ok(f.durable().resources.every(resource => resource.probe.status === 'pending'));
});
