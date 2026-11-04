import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { collectSource } from '../server/collector.js';
import { TaskLimiter } from '../server/concurrency.js';
import { defaultSettings, sourceDefaults } from '../server/defaults.js';
import type { CollectedMovie, CollectionContext } from '../shared/types.js';

let previousPrivate: string | undefined;
before(() => { previousPrivate = process.env.ALLOW_PRIVATE_UPSTREAM; process.env.ALLOW_PRIVATE_UPSTREAM = 'true'; });
after(() => { if (previousPrivate === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM; else process.env.ALLOW_PRIVATE_UPSTREAM = previousPrivate; });

async function fixture(route: (path: string, request: IncomingMessage, response: ServerResponse) => void) {
  const requests: { path: string; at: number; referer?: string }[] = [];
  let active = 0; let maximum = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://fixture').pathname;
    requests.push({ path, at: performance.now(), referer: request.headers.referer });
    active++; maximum = Math.max(maximum, active);
    let closed = false;
    const finish = () => { if (!closed) { closed = true; active--; } };
    response.once('finish', finish); response.once('close', finish);
    route(path, request, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, requests, get active() { return active; }, get maximum() { return maximum; },
    source: (concurrency: number) => ({ ...sourceDefaults({ baseUrl: origin, listPath: '/list', requestIntervalMs: 0 }), concurrency }),
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
const context = (extra: Partial<CollectionContext> = {}): CollectionContext => ({ settings: { ...defaultSettings, maxRetries: 0 }, log: () => {}, ...extra });
async function collect(source: Parameters<typeof collectSource>[0], options = context()) {
  const movies: CollectedMovie[] = [];
  for await (const movie of collectSource(source, options)) movies.push(movie);
  return movies;
}
const detailLinks = (count: number) => Array.from({ length: count }, (_, index) => `<a href="/voddetail/${index + 1}">movie</a>`).join('');
const episodeLinks = (id: string, count: number) => Array.from({ length: count }, (_, index) => `<a href="/vodplay/${id}-${index + 1}">第${index + 1}集</a>`).join('');

test('collectors share the injected source request budget across listing, details and playback', { timeout: 5000 }, async () => {
  const f = await fixture((path, _request, response) => {
    if (path === '/list') return void response.end(detailLinks(2));
    if (path.startsWith('/voddetail/')) return void setTimeout(() => response.end(`<h1>${path}</h1>` + episodeLinks(path.split('/').at(-1)!, 3)), 25);
    setTimeout(() => response.end(`<video src="https://cdn.example${path}.m3u8"></video>`), 25);
  });
  const limiter = new TaskLimiter(2);
  const options = context({ runSourceTask: (action, signal) => limiter.run(action, signal) });
  try {
    const results = await Promise.all([collect(f.source(2), options), collect(f.source(2), options)]);
    assert.equal(f.maximum, 2, 'separate clients must share one source-wide hard limit');
    assert.deepEqual(results.map(movies => movies.map(movie => movie.resources.length)), [[3, 3], [3, 3]]);
  } finally { await f.close(); }
});

test('cancelling a collector queued for the shared source budget never starts HTTP work', { timeout: 5000 }, async () => {
  const f = await fixture((_path, _request, response) => response.end(detailLinks(1)));
  const limiter = new TaskLimiter(1);
  let release!: () => void;
  const occupied = limiter.run(() => new Promise<void>(resolve => { release = resolve; }));
  const controller = new AbortController();
  const collection = collect(f.source(2), context({ signal: controller.signal, runSourceTask: (action, signal) => limiter.run(action, signal) }));
  try {
    await delay(20);
    assert.equal(f.requests.length, 0, 'an external source task already owns the only shared permit');
    controller.abort();
    await Promise.race([assert.rejects(collection, /cancel|abort|取消/i), delay(300).then(() => assert.fail('queued collection cancellation must not wait for the external task'))]);
    assert.equal(f.requests.length, 0);
  } finally { controller.abort(); release(); await occupied; await collection.catch(() => {}); await f.close(); }
});

test('detail requests fill the configured concurrency and finish each batch before yielding', { timeout: 5000 }, async () => {
  const waiting: ServerResponse[] = [];
  let resolvePair!: () => void;
  const pair = new Promise<void>(resolve => { resolvePair = resolve; });
  const f = await fixture((path, _request, response) => {
    if (path === '/list') { response.end(detailLinks(4)); return; }
    waiting.push(response);
    if (waiting.length === 2) resolvePair();
  });
  const controller = new AbortController();
  const iterator = collectSource(f.source(2), context({ signal: controller.signal }));
  const first = iterator.next();
  try {
    await Promise.race([pair, delay(300).then(() => assert.fail('two detail requests must overlap'))]);
    assert.equal(f.maximum, 2);
    waiting[1].end('<h1>Second</h1>');
    await delay(15);
    waiting[0].end('<h1>First</h1>');
    assert.equal((await first).value?.title, 'First');
    assert.equal(f.active, 0, 'no collector HTTP work may remain while a movie is yielded');
    assert.equal(f.requests.length, 3, 'later detail batches wait until the consumer resumes');
    await iterator.return(undefined);
    assert.equal(f.requests.length, 3);
  } finally { controller.abort(); await first.catch(() => {}); await iterator.return(undefined).catch(() => {}); await f.close(); }
});

test('one series resolves three episodes together and preserves newest-first resource order', { timeout: 5000 }, async () => {
  const f = await fixture((path, _request, response) => {
    if (path === '/list') return void response.end(detailLinks(1));
    if (path.startsWith('/voddetail/')) return void response.end('<h1>Series</h1>' + episodeLinks('1', 7));
    setTimeout(() => response.end(`<video src="https://cdn.example${path}.m3u8"></video>`), 40);
  });
  try {
    const movies = await collect(f.source(3));
    assert.equal(f.maximum, 3, 'episode requests must fill the source concurrency');
    assert.deepEqual(movies[0].resources.map(resource => resource.episode), ['第7集', '第6集', '第5集', '第4集', '第3集', '第2集', '第1集']);
    assert.ok(f.requests.filter(request => request.path.startsWith('/vodplay/')).every(request => request.referer === f.origin + '/voddetail/1'));
  } finally { await f.close(); }
});

test('several series share one request limit and serialize monotonic resource checkpoints', { timeout: 5000 }, async () => {
  let writes = 0; let maximumWrites = 0;
  const snapshots = new Map<string, number[]>();
  const f = await fixture((path, _request, response) => {
    if (path === '/list') return void response.end(detailLinks(3));
    if (path.startsWith('/voddetail/')) return void response.end(`<h1>${path}</h1>` + episodeLinks(path.split('/').at(-1)!, 8));
    const episode = Number(path.split('-').at(-1));
    setTimeout(() => response.end(`<video src="https://cdn.example${path}.m3u8"></video>`), episode % 3 === 0 ? 45 : 15);
  });
  try {
    const movies = await collect(f.source(3), context({ onCheckpoint: async movie => {
      writes++; maximumWrites = Math.max(maximumWrites, writes);
      await delay(5);
      const counts = snapshots.get(movie.externalId) ?? []; counts.push(movie.resources.length); snapshots.set(movie.externalId, counts);
      writes--;
    } }));
    assert.equal(movies.length, 3);
    assert.equal(f.maximum, 3, 'nested movie and episode work must not multiply the request limit');
    assert.equal(maximumWrites, 1, 'storage checkpoints must never race');
    for (const counts of snapshots.values()) assert.deepEqual(counts, [0, 5, 8]);
    assert.equal(writes, 0);
  } finally { await f.close(); }
});

test('concurrent requests keep global positive spacing through redirects and retries', { timeout: 5000 }, async () => {
  let busyAttempts = 0;
  const f = await fixture((path, _request, response) => {
    if (path === '/list') return void response.end(detailLinks(3));
    if (path.startsWith('/voddetail/')) return void response.end(`<h1>${path}</h1>` + episodeLinks(path.split('/').at(-1)!, 2));
    if (path === '/vodplay/1-2') { response.writeHead(302, { location: '/redirected' }); response.end(); return; }
    if (path === '/vodplay/2-2' && busyAttempts++ === 0) { response.writeHead(503, { 'retry-after': '0' }); response.end(); return; }
    response.end(`<video src="https://cdn.example${path}.m3u8"></video>`);
  });
  try {
    const movies = await collect({ ...f.source(3), requestIntervalMs: 70 }, context({ settings: { ...defaultSettings, maxRetries: 1 } }));
    assert.equal(movies.length, 3);
    assert.ok(f.requests.some(request => request.path === '/redirected'));
    assert.equal(f.requests.filter(request => request.path === '/vodplay/2-2').length, 2);
    for (let index = 1; index < f.requests.length; index++) assert.ok(f.requests[index].at - f.requests[index - 1].at >= 45,
      `request starts ${f.requests[index - 1].path} and ${f.requests[index].path} must remain globally spaced`);
  } finally { await f.close(); }
});

test('cancellation aborts and drains every active episode request without starting another batch', { timeout: 5000 }, async () => {
  const waiting: ServerResponse[] = [];
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let checkpoints = 0;
  const f = await fixture((path, _request, response) => {
    if (path === '/list') return void response.end(detailLinks(1));
    if (path.startsWith('/voddetail/')) return void response.end('<h1>Series</h1>' + episodeLinks('1', 9));
    waiting.push(response); response.write('<html>');
    if (waiting.length === 3) ready();
  });
  const controller = new AbortController();
  const collection = collect(f.source(3), context({ signal: controller.signal, onCheckpoint: async () => { checkpoints++; await delay(10); } }));
  try {
    await Promise.race([started, delay(300).then(() => assert.fail('three playback requests must overlap before cancellation'))]);
    controller.abort();
    await assert.rejects(collection, /cancel|abort|取消/i);
    await delay(30);
    assert.equal(f.active, 0);
    assert.equal(waiting.length, 3);
    const writesAtExit = checkpoints;
    await delay(30);
    assert.equal(checkpoints, writesAtExit, 'no checkpoint writes may happen after the generator exits');
  } finally { controller.abort(); await collection.catch(() => {}); await f.close(); }
});

for (const interruption of ['cancel', '403'] as const) {
  test(`a playback batch checkpoints its successful page before propagating ${interruption}`, { timeout: 5000 }, async () => {
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    let pending: ServerResponse | undefined;
    const snapshots: CollectedMovie[] = [];
    const f = await fixture((path, _request, response) => {
      if (path === '/list') return void response.end(detailLinks(1));
      if (path.startsWith('/voddetail/')) return void response.end('<h1>Series</h1>' + episodeLinks('1', 4));
      if (path === '/vodplay/1-4') return void response.end('<video src="https://cdn.example/success.m3u8"></video>');
      pending = response; ready();
    });
    const controller = new AbortController();
    const collection = collect(f.source(2), context({ signal: controller.signal, onCheckpoint: async movie => { snapshots.push(movie); } }));
    try {
      await started;
      await delay(20); // The first complete response can settle while its sibling remains gated.
      if (interruption === 'cancel') controller.abort();
      else { pending!.writeHead(403); pending!.end('Forbidden'); }
      await assert.rejects(collection, interruption === 'cancel' ? /cancel|abort|取消/i : /403/);
      assert.deepEqual(snapshots.at(-1)?.resources.map(resource => [resource.episode, resource.url]), [['第4集', 'https://cdn.example/success.m3u8']]);
      assert.deepEqual(f.requests.filter(request => request.path.startsWith('/vodplay/')).map(request => request.path), ['/vodplay/1-4', '/vodplay/1-3']);
      await delay(20);
      assert.equal(f.active, 0);
    } finally { controller.abort(); await collection.catch(() => {}); await f.close(); }
  });
}

test('a fatal forbidden page aborts sibling requests and prevents later detail batches', { timeout: 5000 }, async () => {
  const waiting: ServerResponse[] = [];
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const f = await fixture((path, _request, response) => {
    if (path === '/list') return void response.end(detailLinks(6));
    if (path === '/voddetail/3') ready();
    if (path === '/voddetail/2') { setTimeout(() => { response.writeHead(403); response.end('Forbidden'); }, 40); return; }
    waiting.push(response); response.write('<html>');
  });
  const controller = new AbortController();
  const collection = collect(f.source(3), context({ signal: controller.signal }));
  try {
    await Promise.race([started, delay(300).then(() => assert.fail('the forbidden detail must start alongside its siblings'))]);
    await assert.rejects(collection, /403/);
    await delay(30);
    assert.equal(f.active, 0);
    assert.deepEqual(f.requests.map(request => request.path), ['/list', '/voddetail/1', '/voddetail/2', '/voddetail/3']);
  } finally { controller.abort(); await collection.catch(() => {}); await f.close(); }
});

test('a failed checkpoint stops new HTTP work while draining slow final storage writes', { timeout: 5000 }, async () => {
  let failed = false; let requestsAfterFailure = 0; let writes = 0;
  let observeRequest = () => {};
  const f = await fixture((path, _request, response) => {
    observeRequest();
    if (failed) requestsAfterFailure++;
    if (path === '/list') return void response.end(detailLinks(3));
    if (path.startsWith('/voddetail/')) return void response.end(`<h1>${path}</h1>` + episodeLinks(path.split('/').at(-1)!, 9));
    setTimeout(() => response.end(`<video src="https://cdn.example${path}.m3u8"></video>`), 30);
  });
  try {
    await assert.rejects(collect(f.source(3), context({ onCheckpoint: async movie => {
      writes++;
      try {
        if (!failed && movie.resources.length === 5) {
          // Observe every already-started sibling slot before checking for new requests.
          if (f.active < 3) await new Promise<void>(resolve => { observeRequest = () => { if (f.active === 3) resolve(); }; });
          failed = true; throw new Error('checkpoint failed');
        }
        if (failed) await delay(100);
      } finally { writes--; }
    } })), /checkpoint failed/);
    assert.equal(requestsAfterFailure, 0, 'a failed storage write must abort sibling requests before final checkpoints drain');
    assert.equal(writes, 0, 'all storage writes must settle before the generator rejects');
    await delay(20);
    assert.equal(f.active, 0);
  } finally { await f.close(); }
});

test('date early-stop uses listing order when an older concurrent detail finishes first', { timeout: 5000 }, async () => {
  const f = await fixture((path, _request, response) => {
    if (path === '/list') return void response.end(detailLinks(4) + '<a title="下一页" href="/later">next</a>');
    if (path.startsWith('/vodplay/')) return void response.end('<video src="https://cdn.example/dated.m3u8"></video>');
    const id = Number(path.split('/').at(-1));
    const date = id === 1 ? '2026-11-04' : id === 2 ? '2026-11-03' : '2026-11-01';
    setTimeout(() => response.end(`<h1>Movie ${id}</h1><div class="module-info-item"><span class="module-info-item-title">更新：</span><div class="module-info-item-content">${date}</div></div>` + episodeLinks(String(id), 1)), id === 1 ? 60 : id === 2 ? 30 : 0);
  });
  try {
    const movies = await collect({ ...f.source(3), updatesSortedDescending: true }, context({ dateRange: { startDate: '2026-11-03', endDate: '2026-11-04', timezone: 'Asia/Shanghai' } }));
    assert.equal(f.maximum, 3);
    assert.deepEqual(movies.map(movie => movie.title), ['Movie 1', 'Movie 2']);
    assert.ok(!f.requests.some(request => request.path === '/voddetail/4' || request.path === '/later'));
  } finally { await f.close(); }
});
