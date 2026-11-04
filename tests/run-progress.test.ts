import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { initialState, sourceDefaults } from '../server/defaults.js';
import type { Store } from '../server/store.js';
import { Worker } from '../server/worker.js';

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), message);
}

async function fixture(t: TestContext, route: (path: string, response: ServerResponse) => void) {
  const previousPrivate = process.env.ALLOW_PRIVATE_UPSTREAM;
  process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  const server = createServer((request, response) => route(new URL(request.url!, 'http://fixture').pathname, response));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const state = initialState();
  state.sources = [sourceDefaults({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, listPath: '/list', concurrency: 2, requestIntervalMs: 0 })];
  Object.assign(state.settings, { schedulerEnabled: false, maxRetries: 0, sampleBytes: 1024 });
  let durable = structuredClone(state);
  let failProgress = false;
  let failedWrite = false;
  const store = { state, async save() {
    if (failProgress && !failedWrite && state.runs[0]?.progress?.activeMovies === 1) {
      failedWrite = true; throw new Error('progress storage unavailable');
    }
    durable = structuredClone(state);
  } } as unknown as Store;
  const worker = new Worker(store, { now: () => new Date('2026-11-05T08:00:00Z') });
  t.after(async () => {
    try { await worker.stop(); }
    finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      if (previousPrivate === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM; else process.env.ALLOW_PRIVATE_UPSTREAM = previousPrivate;
    }
  });
  return { state, worker, durable: () => durable, failProgress: () => { failProgress = true; }, failedWrite: () => failedWrite };
}

test('run progress retains complete collection failure counts beyond the bounded recent samples', async t => {
  const f = await fixture(t, (path, response) => {
    if (path === '/list') return void response.end('<a href="/voddetail/1">movie</a>');
    if (path === '/voddetail/1') return void response.end('<h1>Broken series</h1>' + Array.from({ length: 35 }, (_, index) =>
      `<a href="/vodplay/${index + 1}?secret=must-not-leak">第${index + 1}集</a>`).join(''));
    response.writeHead(404); response.end();
  });
  f.state.settings.probeEnabled = false;
  const run = f.worker.enqueue(f.state.sources[0]);
  await waitFor(() => Boolean(f.durable().runs.find(item => item.id === run.id)?.finishedAt), 'failed collection should reach its durable terminal state');
  assert.equal(run.status, 'error');
  assert.deepEqual(run.progress?.failures, { collection: 35, probe: 0, poster: 0, runtime: 0, total: 35 });
  assert.equal(run.errors.length, 30);
  assert.ok(run.errors.every(message => !message.includes('secret=') && !message.includes('http://')));
  assert.equal(run.progress?.discoveredMovies, 1); assert.equal(run.progress?.completedMovies, 1);
  assert.equal(run.progress?.paginationComplete, true); assert.equal(run.progress?.activeMovies, 0);
  assert.deepEqual(run.progress?.probes, { queued: 0, active: 0, passed: 0, failed: 0 });
  assert.deepEqual(f.durable().runs[0].progress, run.progress);
});

test('probe and poster failures are counted by phase without inventing successful measurements', async t => {
  const f = await fixture(t, (path, response) => {
    if (path === '/list') return void response.end('<a href="/voddetail/1">movie</a>');
    if (path === '/voddetail/1') return void response.end('<h1>Unavailable</h1><img src="/poster.png"><a href="/gone.m3u8?secret=hidden">正片</a>');
    response.writeHead(404); response.end();
  });
  f.state.sources[0].posterSelector = 'img';
  const run = f.worker.enqueue(f.state.sources[0]);
  await waitFor(() => Boolean(f.durable().runs.find(item => item.id === run.id)?.finishedAt), 'measurements should settle durably');
  assert.deepEqual(run.progress?.probes, { queued: 0, active: 0, passed: 0, failed: 1 });
  assert.deepEqual(run.progress?.failures, { collection: 0, probe: 1, poster: 1, runtime: 0, total: 2 });
  assert.equal(run.progress?.completedMovies, 1);
  assert.ok(run.errors.every(message => !message.includes('secret=')));
});

test('a coalesced progress write failure aborts active collection and saves zero terminal activity', async t => {
  const f = await fixture(t, (path, response) => {
    if (path === '/list') return void response.end('<a href="/voddetail/1">movie</a>');
    response.write('<h1>Held detail');
  });
  f.failProgress();
  const run = f.worker.enqueue(f.state.sources[0]);
  await waitFor(() => Boolean(f.durable().runs.find(item => item.id === run.id)?.finishedAt), 'the write failure should interrupt and drain the held request');
  assert.ok(f.failedWrite()); assert.equal(run.status, 'error');
  assert.equal(run.progress?.failures.runtime, 1);
  assert.equal(run.progress?.failures.total, 1);
  assert.equal(run.progress?.paginationComplete, false);
  assert.equal(run.progress?.activeMovies, 0);
  assert.deepEqual(run.progress?.activeMovieTitles, []);
  assert.deepEqual(run.progress?.probes, { queued: 0, active: 0, passed: 0, failed: 0 });
  const finished = JSON.stringify(run);
  await delay(300);
  assert.equal(JSON.stringify(run), finished, 'no delayed telemetry callback may mutate a terminal record');
});
