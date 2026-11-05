import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { createApp } from '../server/app.js';
import { upsertMovie } from '../server/catalog.js';
import { initialState, settingsDefaults, sourceDefaults } from '../server/defaults.js';
import type { Store } from '../server/store.js';
import { settingsSchema, sourceSchema } from '../server/validation.js';
import { Worker } from '../server/worker.js';
import type { Resource, State } from '../shared/types.js';

async function fixture(t: TestContext, concurrency = 2) {
  const previous = { ALLOW_PRIVATE_UPSTREAM: process.env.ALLOW_PRIVATE_UPSTREAM, APP_AUTH_TOKEN: process.env.APP_AUTH_TOKEN };
  process.env.ALLOW_PRIVATE_UPSTREAM = 'true'; delete process.env.APP_AUTH_TOKEN;
  const requests: string[] = [];
  const blocked = new Set<ServerResponse>();
  let hold = true; let active = 0; let peak = 0; let origin = '';
  const playlist = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\n/variant.m3u8\n';
  const upstream = createServer((request, response) => {
    const pathname = new URL(request.url!, 'http://fixture').pathname;
    requests.push(pathname);
    if (pathname === '/player') return response.end(`<video src="${origin}/rotated.m3u8"></video>`);
    if (pathname === '/variant.m3u8') return response.end('#EXTM3U\n#EXTINF:1,\n/segment.ts\n#EXT-X-ENDLIST\n');
    if (pathname === '/segment.ts') return response.end(Buffer.alloc(1024, 0x47));
    active++; peak = Math.max(peak, active); response.once('close', () => { active--; blocked.delete(response); });
    if (pathname === '/broken.m3u8') { response.writeHead(404); return response.end(); }
    if (hold) blocked.add(response); else response.end(playlist);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const state = initialState();
  state.sources = [sourceDefaults({ id: 'source', name: 'source', baseUrl: origin, concurrency, requestIntervalMs: 0 })];
  Object.assign(state.settings, { maxRetries: 0, sampleBytes: 1024 });
  let durable: State = structuredClone(state);
  const store = { state, healthy: true, mode: 'file', async save() { durable = structuredClone(state); } } as unknown as Store;
  const worker = new Worker(store);
  const server = createServer(createApp(store, worker));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const apiOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const release = () => { hold = false; for (const response of blocked) response.end(playlist); blocked.clear(); };
  t.after(async () => {
    release(); await worker.stop();
    server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  const add = (externalId: string, episodes: string[]) => upsertMovie(state, state.sources[0], {
    externalId, title: externalId, pageUrl: origin + '/detail',
    resources: episodes.map((episode, index) => ({ name: 'line ' + index, episode, url: `${origin}/${externalId}-${index}.m3u8`, pageUrl: origin + '/player' })),
  }).resources;
  const post = (pathname: string) => fetch(apiOrigin + pathname, { method: 'POST' });
  return { worker, state, requests, add, post, release, peak: () => peak, durable: () => durable };
}

test('playback checks only the selected movie episode across all lines and retains individual failures', async t => {
  const f = await fixture(t);
  const resources = f.add('selected', ['第01集', 'EP01', '1', '第2集', '第1季第1集', '预告', '第1集上', '第1集下']);
  resources[2].url = resources[2].url.replace('selected-2', 'broken');
  f.add('other', ['第1集']);
  const responsePromise = f.post(`/api/resources/${resources[0].id}/check-playback`);
  f.release();
  const response = await responsePromise;
  assert.equal(response.status, 200);
  const result = await response.json() as { resources: Resource[] };
  assert.deepEqual(result.resources.map(item => item.id).sort(), resources.slice(0, 3).map(item => item.id).sort());
  assert.deepEqual(result.resources.map(item => item.probe.status), ['ok', 'ok', 'error']);
  assert.ok(result.resources.slice(0, 2).every(item => item.probe.width === 1280 && item.probe.height === 720 && item.probe.speedMbps! > 0));
  assert.ok(f.state.resources.filter(item => !resources.slice(0, 3).includes(item)).every(item => item.probe.status === 'pending'));
  assert.ok(!f.requests.some(pathname => /selected-[3-7]|other/.test(pathname)));
  assert.equal(f.durable().resources.filter(item => item.probe.checkedAt).length, 3);
});

test('concurrent playback requests share pending episode checks and the source concurrency budget', async t => {
  const f = await fixture(t, 2);
  const resources = f.add('selected', ['第1集', 'EP01', '01', '第01集']);
  const first = f.post(`/api/resources/${resources[0].id}/check-playback`);
  const second = f.post(`/api/resources/${resources[1].id}/check-playback`);
  const deadline = Date.now() + 1000;
  while (f.requests.length < 2 && Date.now() < deadline) await delay(5);
  assert.equal(f.requests.length, 2, 'the first two lines must start immediately');
  assert.equal(f.peak(), 2);
  f.release();
  const responses = await Promise.all([first, second]);
  for (const response of responses) { assert.equal(response.status, 200); assert.equal((await response.json()).resources.length, 4); }
  assert.equal(f.requests.filter(pathname => /^\/selected-/.test(pathname)).length, 4, 'overlapping requests must reuse pending measurements');
  assert.ok(f.peak() <= 2);
});

test('a playback persistence failure rejects after all other episode lines finish saving', async t => {
  const state = initialState();
  const source = sourceDefaults({ id: 'fixture', name: 'fixture', baseUrl: 'https://fixture.invalid', concurrency: 2 });
  state.sources = [source];
  const resources = upsertMovie(state, source, { externalId: 'movie', title: 'movie', pageUrl: '', resources: [
    { name: 'first', episode: '第1集', url: 'https://fixture.invalid/first.m3u8' },
    { name: 'second', episode: 'EP01', url: 'https://fixture.invalid/second.m3u8' },
  ] }).resources;
  resources.forEach((resource, index) => { resource.url = `file:///fixture-${index}.m3u8`; });
  const failure = new Error('fixture playback storage unavailable');
  let saveCalls = 0;
  let durable = structuredClone(state);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const worker = new Worker({ state, async save() {
    const attempt = ++saveCalls;
    if (attempt === 1) throw failure;
    if (attempt === 2) await gate;
    durable = structuredClone(state);
  } } as unknown as Store);
  t.after(async () => { release(); await worker.stop(); });
  const checking = worker.checkPlayback(resources[0]);
  let settled = false;
  void checking.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(checking, error => error === failure);
  const deadline = Date.now() + 1000;
  while (saveCalls < 2 && Date.now() < deadline) await delay(5);
  assert.equal(saveCalls, 2, 'both same-episode lines must reach persistence');
  assert.equal(settled, false, 'a storage failure must still wait for its active peer');
  release(); await rejected;
  assert.ok(durable.resources.every(resource => resource.probe.status === 'error' && resource.probe.checkedAt));
});

test('the playback API reports a failed persistence write as 500', async t => {
  const previousToken = process.env.APP_AUTH_TOKEN; delete process.env.APP_AUTH_TOKEN;
  const state = initialState();
  const [resource] = upsertMovie(state, state.sources[0], { externalId: 'fixture', title: 'fixture', pageUrl: '', resources: [
    { name: 'line', episode: '正片', url: 'https://fixture.invalid/playlist.m3u8' },
  ] }).resources;
  resource.url = 'file:///fixture.m3u8';
  let failed = false;
  const store = { state, healthy: true, mode: 'file', async save() {
    if (!failed) { failed = true; throw new Error('fixture playback storage unavailable'); }
  } } as unknown as Store;
  const worker = new Worker(store);
  const server = createServer(createApp(store, worker));
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await worker.stop();
    if (previousToken === undefined) delete process.env.APP_AUTH_TOKEN; else process.env.APP_AUTH_TOKEN = previousToken;
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/resources/${resource.id}/check-playback`, { method: 'POST' });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /fixture playback storage unavailable/);
});

test('refresh resolves a playback address without fetching playlists or video segments', async t => {
  const f = await fixture(t);
  const [resource] = f.add('selected', ['正片']);
  resource.updatedAt = new Date(Date.now() + 60000).toISOString();
  const previousUpdatedAt = resource.updatedAt;
  f.release();
  const response = await f.post(`/api/resources/${resource.id}/refresh`);
  assert.equal(response.status, 200);
  const refreshed = await response.json() as Resource;
  assert.ok(refreshed.url.endsWith('/rotated.m3u8'));
  assert.equal(refreshed.probe.status, 'pending'); assert.equal(refreshed.probe.checkedAt, null);
  assert.ok(refreshed.updatedAt > previousUpdatedAt, 'a refreshed address must advance its version even if the saved timestamp is ahead of the clock');
  assert.equal(f.durable().resources[0].updatedAt, refreshed.updatedAt);
  assert.deepEqual(f.requests, ['/player']);
  const repeated = await f.post(`/api/resources/${resource.id}/refresh`);
  assert.equal(repeated.status, 200);
  const refreshedAgain = await repeated.json() as Resource;
  assert.ok(refreshedAgain.updatedAt > refreshed.updatedAt, 'repeated refreshes must remain strictly ordered');
  assert.deepEqual(f.requests, ['/player', '/player']);
  const checked = await f.post(`/api/resources/${resource.id}/check-playback`);
  assert.equal(checked.status, 200);
  const measured = (await checked.json() as { resources: Resource[] }).resources[0];
  assert.equal(measured.probe.status, 'ok');
  assert.ok(measured.updatedAt > refreshedAgain.updatedAt, 'a following measurement must advance the refreshed version');
});

test('legacy probe routes are unavailable and playback checks reject unknown resources', async t => {
  const f = await fixture(t);
  const [resource] = f.add('selected', ['正片']);
  f.release();
  for (const pathname of [`/api/resources/${resource.id}/probe`, `/api/movies/${resource.movieId}/probe`, '/api/resources/missing/check-playback']) {
    const response = await f.post(pathname); assert.equal(response.status, 404); await response.json();
  }
  assert.deepEqual(f.requests, []);
});

test('source validation accepts 100 concurrent tasks and rejects 101', () => {
  const source = sourceDefaults({ name: 'fixture', baseUrl: 'https://fixture.invalid' });
  assert.equal(sourceSchema.safeParse({ ...source, concurrency: 100 }).success, true);
  assert.equal(sourceSchema.safeParse({ ...source, concurrency: 101 }).success, false);
});

test('legacy automatic probe preferences normalize to disabled while keeping playback sample budgets', () => {
  const defaults = settingsDefaults({ probeEnabled: true, sampleBytes: 32768 });
  assert.equal(defaults.probeEnabled, false); assert.equal(defaults.sampleBytes, 32768);
  const parsed = settingsSchema.parse({ ...defaults, probeEnabled: true });
  assert.equal(parsed.probeEnabled, false); assert.equal(parsed.sampleBytes, 32768);
});
