import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { initialState, sourceDefaults } from '../server/defaults.js';
import type { Store } from '../server/store.js';
import { Worker } from '../server/worker.js';
import type { State } from '../shared/types.js';

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 4000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), message);
}

async function pipeline(t: TestContext, concurrency: number, count: number, pageSize: number, playbackPages = false) {
  const previousPrivate = process.env.ALLOW_PRIVATE_UPSTREAM;
  process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  let hold = true; let origin = ''; let activeRequests = 0; let peakRequests = 0;
  const requests: string[] = [];
  const probes: string[] = [];
  const blocked = new Map<string, ServerResponse>();
  let blockedPlayback: ServerResponse | undefined;
  const probeBody = (name: string) => `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\n/streams/${name}.m3u8\n`;
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://fixture').pathname;
    requests.push(path); activeRequests++; peakRequests = Math.max(peakRequests, activeRequests);
    let ended = false;
    const end = () => { if (!ended) { ended = true; activeRequests--; } };
    response.once('finish', end); response.once('close', end);
    if (path === '/list' || path.startsWith('/list/')) {
      const page = path === '/list' ? 1 : Number(path.split('/').at(-1));
      const start = (page - 1) * pageSize + 1;
      const last = Math.min(count, start + pageSize - 1);
      response.end(Array.from({ length: last - start + 1 }, (_, index) => `<a href="/voddetail/${start + index}">movie</a>`).join('')
        + (last < count ? `<a title="下一页" href="/list/${page + 1}">next</a>` : ''));
      return;
    }
    if (path.startsWith('/voddetail/')) {
      const id = Number(path.split('/').at(-1));
      const episodes = id === 1 ? playbackPages ? 2 : 5 : 1;
      response.end(`<h1>Movie ${id}</h1>` + Array.from({ length: episodes }, (_, index) =>
        `<a href="${playbackPages && id === 1 ? `/vodplay/${id}-${index + 1}` : `/probe/${id}-${index + 1}.m3u8`}">第${index + 1}集</a>`).join(''));
      return;
    }
    if (path.startsWith('/vodplay/')) {
      if (path === '/vodplay/1-1' && hold) { blockedPlayback = response; return; }
      response.end(`<video src="${origin}/probe/${path.split('/').at(-1)}.m3u8"></video>`); return;
    }
    if (path.startsWith('/probe/')) {
      const name = path.split('/').at(-1)!.replace('.m3u8', '');
      probes.push(name);
      if (hold && (!playbackPages || name.startsWith('1-'))) { blocked.set(name, response); response.once('close', () => blocked.delete(name)); }
      else response.end(probeBody(name));
      return;
    }
    if (path.startsWith('/streams/')) { response.end('#EXTM3U\n#EXTINF:1,\n/segment.ts\n#EXT-X-ENDLIST\n'); return; }
    if (path === '/segment.ts') { response.end(Buffer.alloc(1024, 0x47)); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const state = initialState();
  state.sources = [sourceDefaults({ name: 'Pipeline', baseUrl: origin, listPath: '/list', concurrency, requestIntervalMs: 0 })];
  Object.assign(state.settings, { schedulerEnabled: false, probeEnabled: true, maxRetries: 0, sampleBytes: 1024 });
  let durable = structuredClone(state);
  const store = { state, async save() { durable = structuredClone(state); } } as unknown as Store;
  const worker = new Worker(store, { now: () => new Date('2026-11-04T08:00:00Z') });
  const releaseProbe = (id: number, episode = 1) => {
    const name = `${id}-${episode}`;
    const response = blocked.get(name);
    assert.ok(response, `${name} must have an active held probe`);
    blocked.delete(name); response.end(probeBody(name));
  };
  const release = () => {
    hold = false;
    for (const [name, response] of blocked) response.end(probeBody(name));
    blocked.clear();
    blockedPlayback?.end(`<video src="${origin}/probe/1-1.m3u8"></video>`); blockedPlayback = undefined;
  };
  t.after(async () => {
    release();
    try { await worker.stop(); }
    finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previousPrivate === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM;
      else process.env.ALLOW_PRIVATE_UPSTREAM = previousPrivate;
    }
  });
  return { state, worker, requests, probes, releaseProbe, release, durable: (): State => durable,
    playbackBlocked: () => Boolean(blockedPlayback && !blockedPlayback.writableEnded), peakRequests: () => peakRequests };
}

test('twenty movie slots refill across pages only after a movie finishes measurements', { timeout: 10000 }, async t => {
  const f = await pipeline(t, 20, 25, 7);
  const run = f.worker.enqueue(f.state.sources[0]);
  await waitFor(() => f.probes.length === 20, 'all twenty movies should reach their held measurements');
  await waitFor(() => f.durable().runs.find(item => item.id === run.id)?.progress?.probes.active === 20, 'live activity should be durably saved even while requests remain held');
  assert.equal(run.progress?.discoveredMovies, 20);
  assert.equal(run.progress?.completedMovies, 0);
  assert.equal(run.progress?.activeMovies, 20);
  assert.equal(run.progress?.concurrency, 20);
  assert.equal(run.progress?.activeMovieTitles.length, 20);
  assert.equal(run.progress?.currentPage, 3);
  assert.equal(run.progress?.paginationComplete, false, 'the undiscovered later movies must not be represented as a known total');
  assert.deepEqual(run.progress?.probes, { queued: 4, active: 20, passed: 0, failed: 0 });
  assert.ok(f.requests.includes('/list/2') && f.requests.includes('/list/3'), 'short first pages must be followed while movie slots remain');
  assert.equal(f.requests.filter(path => path.startsWith('/voddetail/')).length, 20);
  assert.equal(f.durable().movies.length, 20);
  assert.ok(!f.requests.includes('/voddetail/21'), 'saving addresses must not release a movie slot before measurements finish');
  assert.equal(f.durable().resources.filter(resource => resource.probe.status === 'ok').length, 0);

  f.releaseProbe(2);
  await waitFor(() => f.requests.includes('/voddetail/21'), 'one completed movie should immediately admit the twenty-first movie');
  assert.equal(f.requests.filter(path => path.startsWith('/voddetail/')).length, 21);
  assert.ok(!f.requests.includes('/voddetail/22'));
  assert.ok(!f.probes.includes('1-2'), 'the long first series still has unfinished measurements');
  const checked = f.durable().resources.find(resource => resource.url.includes('/probe/2-1.'))!;
  assert.equal(checked.probe.status, 'ok');
  assert.equal(checked.probe.width, 1280); assert.equal(checked.probe.height, 720);
  assert.ok(checked.probe.speedMbps! > 0);
  assert.ok(f.peakRequests() <= 20, 'movie slots must not multiply the shared network request budget');

  f.release();
  await waitFor(() => f.durable().runs.find(item => item.id === run.id)?.status === 'success', 'all pages and all movies should complete');
  assert.equal(run.scanned, 25);
  assert.equal(run.progress?.discoveredMovies, 25);
  assert.equal(run.progress?.completedMovies, 25);
  assert.equal(run.progress?.activeMovies, 0);
  assert.deepEqual(run.progress?.activeMovieTitles, []);
  assert.equal(run.progress?.paginationComplete, true);
  assert.deepEqual(run.progress?.probes, { queued: 0, active: 0, passed: 29, failed: 0 });
  assert.equal(run.progress?.failures.total, 0);
  assert.equal(f.durable().resources.length, 29);
  assert.ok(f.durable().resources.every(resource => resource.probe.status === 'ok'));
});

test('a resource checkpoint starts measurements before a long movie finishes parsing its playback pages', { timeout: 10000 }, async t => {
  const f = await pipeline(t, 2, 3, 3, true);
  const run = f.worker.enqueue(f.state.sources[0]);
  await waitFor(() => f.playbackBlocked() && f.probes.includes('1-2'), 'the resolved episode must be probed while its next playback page remains blocked');
  assert.ok(f.playbackBlocked());
  assert.ok(!f.probes.includes('1-1'));
  f.releaseProbe(1, 2);
  await waitFor(() => f.requests.includes('/voddetail/3'), 'a completed second movie must refill while the first movie remains unfinished');
  assert.ok(f.playbackBlocked());
  assert.equal(f.durable().resources.find(resource => resource.url.includes('/probe/1-2.'))?.probe.status, 'ok');
  assert.ok(f.peakRequests() <= 2);
  f.release();
  await waitFor(() => f.durable().runs.find(item => item.id === run.id)?.status === 'success', 'remaining movie parsing and probes must finish');
  assert.equal(f.durable().resources.length, 4);
  assert.ok(f.durable().resources.every(resource => resource.probe.status === 'ok'));
});
