import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { collectSource } from '../server/collector.js';
import { defaultSettings, initialState, sourceDefaults } from '../server/defaults.js';
import type { Store } from '../server/store.js';
import { Worker } from '../server/worker.js';
import type { CollectedMovie } from '../shared/types.js';

test('a missing playback selector records an actionable error while retaining metadata', async t => {
  const previousPrivate = process.env.ALLOW_PRIVATE_UPSTREAM;
  process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  const requests: string[] = [];
  const upstream = createServer((request, response) => {
    requests.push(request.url!);
    if (request.url === '/list') return response.end('<a href="/voddetail/1">影片</a>');
    if (request.url === '/voddetail/1') return response.end('<h1>待补齐影片</h1><a href="/vodplay/1">正片</a>');
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const source = sourceDefaults({ baseUrl, listPath: '/list', collectionMode: 'all', requestIntervalMs: 0, resourceSelector: '.missing-player a' });
  let worker: Worker | undefined;
  t.after(async () => {
    try { await worker?.stop(); }
    finally {
      await new Promise<void>((resolve, reject) => { upstream.close(error => error ? reject(error) : resolve()); upstream.closeIdleConnections(); });
      if (previousPrivate === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM; else process.env.ALLOW_PRIVATE_UPSTREAM = previousPrivate;
    }
  });

  const errors: string[] = [];
  const movies: CollectedMovie[] = [];
  for await (const movie of collectSource(source, { settings: { ...defaultSettings, maxRetries: 0 }, log: () => {}, onCollectionError: message => errors.push(message) })) movies.push(movie);
  assert.equal(movies[0].title, '待补齐影片');
  assert.equal(movies[0].resources.length, 0);
  assert.equal(errors.length, 1, 'missing playback links must not silently count as complete collection');
  assert.match(errors[0], /待补齐影片/);
  assert.match(errors[0], /播放链接.*CSS|CSS.*播放链接/);
  assert.ok(!requests.includes('/vodplay/1'), 'the unmatched selector must not resolve unselected pages');

  const state = initialState();
  state.sources = [source];
  Object.assign(state.settings, { schedulerEnabled: false, probeEnabled: false, maxRetries: 0 });
  const store = { state, async save() {} } as unknown as Store;
  worker = new Worker(store, { now: () => new Date() });
  const run = worker.enqueue(source);
  const deadline = Date.now() + 3000;
  while (['queued', 'running'].includes(run.status) && Date.now() < deadline) await delay(5);
  assert.equal(run.status, 'error', 'a task with unresolved playback links must not report success');
  assert.equal(state.movies.length, 1, 'failed resource extraction retains the already archived metadata');
  assert.equal(state.resources.length, 0);
  assert.match(run.errors[0], /播放链接.*CSS|CSS.*播放链接/);
});
