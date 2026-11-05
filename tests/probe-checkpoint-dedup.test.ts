import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { upsertMovie } from '../server/catalog.js';
import { emptyProbe, initialState, sourceDefaults } from '../server/defaults.js';
import type { Store } from '../server/store.js';
import { Worker } from '../server/worker.js';
import type { State } from '../shared/types.js';

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 2000;
  while (!predicate() && performance.now() < deadline) await delay(5);
  assert.ok(predicate(), message);
}

test('repeated checkpoints with multiple URLs for one logical episode preserve its last URL and measurement', () => {
  const state = initialState();
  const source = sourceDefaults({ id: 'fixture', name: 'fixture', baseUrl: 'https://fixture.example' });
  const input = { externalId: 'one', title: '同一剧集多个地址', pageUrl: source.baseUrl + '/detail', resources: [
    { name: '线路', episode: '第2集', url: source.baseUrl + '/a.m3u8', resolvedAt: '2026-11-04T04:00:00.000Z' },
    { name: '线路', episode: '第2集', url: source.baseUrl + '/b.m3u8', resolvedAt: '2026-11-04T04:00:01.000Z' },
  ] };
  const first = upsertMovie(state, source, input);
  assert.equal(first.resources.length, 1); assert.equal(state.resources.length, 1);
  const resource = first.resources[0];
  assert.equal(resource.url, source.baseUrl + '/b.m3u8');
  resource.probe = { ...emptyProbe(), status: 'ok', checkedAt: '2026-11-04T04:00:02.000Z', bytesRead: 16384, sampledSegments: 1, speedMbps: 5 };
  const measurement = structuredClone(resource.probe);
  const repeated = upsertMovie(state, source, structuredClone(input));
  assert.equal(repeated.resources.length, 1); assert.equal(repeated.resources[0].id, resource.id);
  assert.equal(resource.url, source.baseUrl + '/b.m3u8');
  assert.deepEqual(resource.probe, measurement, 'an unchanged final address must not become pending during a cumulative checkpoint');
});

test('an explicit playback check survives later collection checkpoints without automatic media requests', { timeout: 5000 }, async t => {
  const previousPrivate = process.env.ALLOW_PRIVATE_UPSTREAM;
  process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  let origin = '';
  let secondPage: ServerResponse | undefined;
  const requests: string[] = [];
  const upstream = createServer((request, response) => {
    requests.push(request.url || '');
    if (request.url === '/list') return response.end('<a href="/voddetail/one">one</a>');
    if (request.url === '/voddetail/one') return response.end('<h1>多地址剧集</h1><a href="/vodplay/a">第2集</a><a href="/vodplay/z">第1集</a>');
    if (request.url === '/vodplay/a') return response.end(`<script>var player_a={"url":"${origin}/a.m3u8"};var player_b={"url":"${origin}/b.m3u8"};</script>`);
    if (request.url === '/vodplay/z') { secondPage = response; return; }
    if (request.url?.endsWith('.m3u8')) return response.end('#EXTM3U\n#EXTINF:1,\n/segment.ts\n#EXT-X-ENDLIST\n');
    if (request.url === '/segment.ts') return response.end(Buffer.alloc(1024, 0x47));
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const state = initialState();
  state.sources = [sourceDefaults({ id: 'fixture', name: 'fixture', baseUrl: origin, listPath: '/list', requestIntervalMs: 0, concurrency: 2 })];
  Object.assign(state.settings, { schedulerEnabled: false, probeEnabled: true, maxRetries: 0, sampleBytes: 1024 });
  let durable: State = structuredClone(state);
  const store = { state, async save() { durable = structuredClone(state); } } as unknown as Store;
  const worker = new Worker(store, { now: () => new Date('2026-11-04T04:00:00.000Z') });
  t.after(async () => {
    secondPage?.end();
    try { await worker.stop(); }
    finally {
      await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeIdleConnections(); });
      if (previousPrivate === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM; else process.env.ALLOW_PRIVATE_UPSTREAM = previousPrivate;
    }
  });
  const run = worker.enqueue(state.sources[0]);
  await waitFor(() => Boolean(secondPage) && state.resources.some(resource => resource.episode === '第2集'), 'the first address must persist while the next playback page is gated');
  assert.equal(state.resources.length, 1);
  assert.equal(durable.resources[0].probe.status, 'pending');
  assert.equal(requests.filter(request => request.endsWith('.m3u8')).length, 0, 'collection must not fetch media playlists');
  await worker.checkPlayback(state.resources[0]);
  assert.equal(durable.resources[0].probe.status, 'ok');
  secondPage!.end(`<video src="${origin}/z.m3u8"></video>`);
  await waitFor(() => !['running', 'queued'].includes(run.status), 'movie pipeline must finish');
  assert.equal(run.status, 'success', run.message);
  assert.equal(state.resources.length, 2);
  assert.equal(state.resources.find(resource => resource.episode === '第2集')?.url, origin + '/b.m3u8');
  assert.equal(state.resources.find(resource => resource.episode === '第2集')?.probe.status, 'ok');
  assert.equal(durable.resources.find(resource => resource.episode === '第2集')?.probe.status, 'ok');
  assert.equal(durable.resources.find(resource => resource.episode === '第1集')?.probe.status, 'pending');
  assert.equal(requests.filter(request => request === '/z.m3u8').length, 0);
  assert.equal(requests.filter(request => request === '/b.m3u8').length, 1, 'later checkpoints must keep the existing measurement instead of reprobing unchanged URLs');
  assert.equal(requests.filter(request => request === '/a.m3u8').length, 0, 'superseded duplicate URLs must not start redundant probes');
});
