import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { collectSource } from '../server/collector.js';
import { upsertMovie } from '../server/catalog.js';
import { defaultSettings, initialState, sourceDefaults } from '../server/defaults.js';
import type { CollectedMovie, CollectionContext, CollectionProgress, Source } from '../shared/types.js';

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), message);
}

async function fixture(t: TestContext, route: (path: string, response: ServerResponse) => void, sourceOptions: Partial<Source> = {}) {
  const previousPrivate = process.env.ALLOW_PRIVATE_UPSTREAM;
  process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://fixture').pathname;
    requests.push(path); route(path, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const source = sourceDefaults({ baseUrl: origin, listPath: '/list', collectionMode: 'all', concurrency: 3, requestIntervalMs: 0, ...sourceOptions });
  const controller = new AbortController();
  const reports: CollectionProgress[] = [];
  const pending: Promise<CollectedMovie[]>[] = [];
  const collect = (extra: Partial<CollectionContext> = {}, concurrency = 3) => {
    const collection = (async () => {
      const movies: CollectedMovie[] = [];
      for await (const movie of collectSource({ ...source, concurrency }, {
        settings: { ...defaultSettings, maxRetries: 0 }, signal: controller.signal,
        log: () => {}, onProgress: report => reports.push(report), ...extra,
      })) movies.push(movie);
      return movies;
    })();
    pending.push(collection); return collection;
  };
  t.after(async () => {
    controller.abort(); await Promise.allSettled(pending);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousPrivate === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM; else process.env.ALLOW_PRIVATE_UPSTREAM = previousPrivate;
  });
  return { origin, source, requests, reports, controller, collect };
}

const episodes = '<a href="/vodplay/1">第1集</a><a href="/vodplay/2">第2集</a><a href="/vodplay/3">第3集</a>';

// Catches counting the queue index as completed work and returning mutable reports.
test('movie progress reports one of three completed pages when the last queued page finishes first', async t => {
  let detail: ServerResponse | undefined;
  const pages = new Map<string, ServerResponse>();
  const f = await fixture(t, (path, response) => {
    if (path === '/list') return void response.end('<a href="/voddetail/1">movie</a>');
    if (path === '/voddetail/1') { detail = response; return; }
    pages.set(path, response);
  });
  const messages: string[] = [];
  const collection = f.collect({ log: message => messages.push(message) });
  await waitFor(() => Boolean(detail), 'detail request must be held before parsing');
  const reading = f.reports.at(-1)!;
  assert.equal(reading.activeMovies, 1);
  assert.equal(reading.activeMovieProgress?.length, 1, 'a movie must appear while its detail request is still pending');
  const id = reading.activeMovieProgress![0].id;
  assert.ok(id);
  assert.deepEqual(reading.activeMovieProgress?.[0], {
    id, title: '读取影片资料…', stage: 'detail', completedPages: 0, totalPages: null,
    cachedPages: 0, failedPages: 0, resourceCount: 0,
  });
  detail!.end('<h1>并发剧集</h1>' + episodes);
  await waitFor(() => pages.size === 3, 'three playback requests must be held together');
  assert.ok(messages.filter(message => message.includes('正在采集')).every(message => message.includes('已完成 0/3')), 'starting concurrent requests must not log queue positions as completed page counts');
  const unresolved = f.reports.at(-1)!;
  assert.equal(unresolved.activeMovieProgress?.[0].totalPages, 3);
  pages.get('/vodplay/1')!.end('<video src="https://cdn.example/one.m3u8"></video><source src="https://cdn.example/one-backup.m3u8">');
  await waitFor(() => f.reports.at(-1)?.activeMovieProgress?.[0].completedPages === 1, 'finishing one page must publish one completion');
  const partial = f.reports.at(-1)!;
  assert.deepEqual(partial.activeMovieProgress?.[0], {
    id, title: '并发剧集', stage: 'resources', completedPages: 1, totalPages: 3,
    cachedPages: 0, failedPages: 0, resourceCount: 1,
  });
  pages.get('/vodplay/2')!.end('<video src="https://cdn.example/two.m3u8"></video>');
  pages.get('/vodplay/3')!.end('<video src="https://cdn.example/three.m3u8"></video>');
  assert.equal((await collection)[0].resources.length, 4);
  assert.equal(reading.activeMovieProgress?.[0].stage, 'detail', 'later parsing must not mutate earlier reports');
  assert.equal(unresolved.activeMovieProgress?.[0].completedPages, 0);
  assert.equal(partial.activeMovieProgress?.[0].completedPages, 1);
  assert.equal(partial.activeMovieProgress?.[0].resourceCount, 1, 'alternative URLs for one line and episode form one stored resource');
  assert.deepEqual(f.reports.at(-1)?.activeMovieProgress, []);
});

// Catches treating cached pages as pending HTTP work or failures as resources.
for (const failure of ['http', 'empty'] as const) {
  test(`movie progress counts cached pages and an ordinary ${failure} failure separately`, async t => {
    let failedPage: ServerResponse | undefined;
    const f = await fixture(t, (path, response) => {
      if (path === '/list') return void response.end('<a href="/voddetail/1">movie</a>');
      if (path === '/voddetail/1') return void response.end('<h1>缓存剧集</h1>' + episodes);
      if (path === '/vodplay/2') { failedPage = response; return; }
      response.end('<video src="https://cdn.example/three.m3u8"></video>');
    });
    const collection = f.collect({ existingResources: () => [
      { name: '默认线路', episode: '第1集', url: 'https://cdn.example/cached.m3u8', pageUrl: f.origin + '/vodplay/1' },
      { name: '备用线路', episode: '第1集', url: 'https://cdn.example/cached-backup.m3u8', pageUrl: f.origin + '/vodplay/1' },
    ] });
    await waitFor(() => Boolean(failedPage) && f.reports.some(report => report.activeMovieProgress?.[0]?.completedPages === 2), 'cache and successful page must finish before the held failure');
    const partial = f.reports.at(-1)?.activeMovieProgress?.[0];
    assert.equal(partial?.completedPages, 2); assert.equal(partial?.totalPages, 3);
    assert.equal(partial?.cachedPages, 1); assert.equal(partial?.failedPages, 0); assert.equal(partial?.resourceCount, 3);
    assert.ok(!f.requests.includes('/vodplay/1'), 'fresh cached pages must not be fetched');
    if (failure === 'http') failedPage!.writeHead(404);
    failedPage!.end('no public player');
    assert.equal((await collection)[0].resources.length, 3);
    const finishedPages = f.reports.find(report => report.activeMovieProgress?.[0]?.completedPages === 3)?.activeMovieProgress?.[0];
    assert.equal(finishedPages?.cachedPages, 1); assert.equal(finishedPages?.failedPages, 1); assert.equal(finishedPages?.resourceCount, 3);
    assert.deepEqual(f.reports.at(-1)?.activeMovieProgress, []);
  });
}

// Catches releasing the movie slot or removing its progress before storage/poster work finishes.
test('saving progress and its movie slot remain active until onMovie settles', async t => {
  const f = await fixture(t, (path, response) => {
    if (path === '/list') return void response.end('<a href="/voddetail/1">movie</a>');
    response.end('<h1>保存中影片</h1><a href="https://cdn.example/direct.m3u8">正片</a>');
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let saving = false;
  const collection = f.collect({ onMovie: async () => { saving = true; await gate; } }, 1);
  try {
    await waitFor(() => saving, 'final movie storage must reach the save gate');
    const progress = f.reports.at(-1)!;
    assert.equal(progress.activeMovies, 1); assert.equal(progress.completedMovies, 0);
    assert.equal(progress.activeMovieProgress?.length, 1);
    assert.deepEqual(progress.activeMovieProgress?.[0], {
      id: progress.activeMovieProgress![0].id, title: '保存中影片', stage: 'saving', completedPages: 0, totalPages: 0,
      cachedPages: 0, failedPages: 0, resourceCount: 1,
    });
  } finally { release(); }
  await collection;
  assert.equal(f.reports.at(-1)?.completedMovies, 1);
  assert.deepEqual(f.reports.at(-1)?.activeMovieProgress, []);
});

// Catches leaving the final checkpoint at resources/100%, including no-HTTP paths.
for (const kind of ['playback', 'direct', 'cached'] as const) {
  test(`${kind} enters saving before its final checkpoint and keeps the slot through onMovie`, async t => {
    const f = await fixture(t, (path, response) => {
      if (path === '/list') return void response.end('<a href="/voddetail/1">movie</a>');
      if (path === '/voddetail/1') return void response.end('<h1>归档阶段</h1>' + (kind === 'direct'
        ? '<a href="https://cdn.example/direct.m3u8">正片</a>'
        : '<a href="/vodplay/1">第1集</a><a href="/vodplay/2">第2集</a>'));
      response.end(`<video src="https://cdn.example${path}.m3u8"></video>`);
    });
    let releasePartial!: () => void; let releaseFinal!: () => void; let releaseMovie!: () => void;
    const partialGate = new Promise<void>(resolve => { releasePartial = resolve; });
    const finalGate = new Promise<void>(resolve => { releaseFinal = resolve; });
    const movieGate = new Promise<void>(resolve => { releaseMovie = resolve; });
    let partialHeld = false; let finalHeld = false; let movieHeld = false;
    const finalResources = kind === 'direct' ? 1 : 2;
    const collection = f.collect({
      existingResources: kind === 'cached' ? () => [
        { name: '默认线路', episode: '第1集', url: 'https://cdn.example/cached-1.m3u8', pageUrl: f.origin + '/vodplay/1' },
        { name: '默认线路', episode: '第2集', url: 'https://cdn.example/cached-2.m3u8', pageUrl: f.origin + '/vodplay/2' },
      ] : undefined,
      onCheckpoint: async movie => {
        if (movie.resources.length === finalResources) { finalHeld = true; await finalGate; }
        else if (kind === 'playback' && movie.resources.length === 1) { partialHeld = true; await partialGate; }
      },
      onMovie: async () => { movieHeld = true; await movieGate; },
    }, 1);
    try {
      if (kind === 'playback') {
        await waitFor(() => partialHeld, 'the first completed page must reach its partial checkpoint');
        const partial = f.reports.at(-1)?.activeMovieProgress?.[0];
        assert.equal(partial?.stage, 'resources', 'saving a partial result must not end resource collection');
        assert.equal(partial?.completedPages, 1); assert.equal(partial?.totalPages, 2);
        releasePartial();
      }
      await waitFor(() => finalHeld, 'the complete resource snapshot must reach its final checkpoint');
      const progress = f.reports.at(-1)!;
      const movie = progress.activeMovieProgress?.[0];
      assert.equal(movie?.stage, 'saving', 'the UI must identify storage while the final checkpoint is still held');
      assert.equal(progress.activeMovies, 1); assert.equal(progress.completedMovies, 0);
      assert.equal(movie?.resourceCount, finalResources);
      assert.equal(movie?.completedPages, kind === 'direct' ? 0 : 2);
      assert.equal(movie?.totalPages, kind === 'direct' ? 0 : 2);
      assert.equal(movie?.cachedPages, kind === 'cached' ? 2 : 0);
      assert.equal(movieHeld, false, 'onMovie must wait for the final checkpoint');
      if (kind !== 'playback') assert.ok(!f.requests.some(path => path.startsWith('/vodplay/')), 'direct and fresh cached resources need no playback requests');
      releaseFinal();
      await waitFor(() => movieHeld, 'onMovie must run after the final checkpoint is released');
      assert.equal(f.reports.at(-1)?.activeMovieProgress?.[0].stage, 'saving');
      assert.equal(f.reports.at(-1)?.activeMovies, 1);
      assert.equal(f.reports.at(-1)?.completedMovies, 0);
    } finally { releasePartial(); releaseFinal(); releaseMovie(); }
    await collection;
    assert.equal(f.reports.at(-1)?.completedMovies, 1);
    assert.deepEqual(f.reports.at(-1)?.activeMovieProgress, []);
  });
}

// Catches counting one embedded/anchor resource twice while preserving distinct lines.
for (const extraLine of [false, true]) {
  test(`embedded and anchor duplicates report the stored resource count${extraLine ? ' with a separate backup line' : ''}`, async t => {
    const f = await fixture(t, (path, response) => {
      if (path === '/list') return void response.end('<a href="/voddetail/1">movie</a>');
      response.end('<h1>重复播放器</h1><video src="https://cdn.example/same.m3u8"></video>'
        + (extraLine ? '<div data-name=" 默认线路 "><a href="https://cdn.example/same.m3u8">正片</a></div>' : '<a href="https://cdn.example/same.m3u8">正片</a>')
        + (extraLine ? '<div data-name="备用线路"><a href="https://cdn.example/same.m3u8">正片</a></div>' : ''));
    }, { resourceSelector: 'a[href]' });
    const state = initialState();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let stored = false;
    const collection = f.collect({ onCheckpoint: async movie => {
      upsertMovie(state, f.source, movie);
      stored = true;
      await gate;
    } });
    try {
      await waitFor(() => stored, 'real resource persistence must reach the checkpoint gate');
      const expected = extraLine ? 2 : 1;
      assert.equal(state.resources.length, expected);
      assert.equal(f.reports.at(-1)?.activeMovieProgress?.[0].resourceCount, expected, 'resource progress must not double count the same URL, episode and line');
      assert.deepEqual(state.resources.map(resource => resource.name), extraLine ? ['默认线路', '备用线路'] : ['默认线路']);
    } finally { release(); }
    assert.equal((await collection)[0].resources.length, extraLine ? 3 : 2, 'logical progress counting must preserve raw resource snapshots');
  });
}

// Catches conflating duplicate titles into one activity row.
test('movies with the same title keep distinct stable progress ids', async t => {
  const held: ServerResponse[] = [];
  const f = await fixture(t, (path, response) => {
    if (path === '/list') return void response.end('<a href="/voddetail/1">one</a><a href="/voddetail/2">two</a>');
    if (path.startsWith('/voddetail/')) return void response.end(`<h1>重名影片</h1><a href="/vodplay/${path.at(-1)}">正片</a>`);
    held.push(response);
  });
  const collection = f.collect({}, 2);
  await waitFor(() => held.length === 2, 'both movies must reach playback');
  const progress = f.reports.at(-1)?.activeMovieProgress;
  assert.equal(progress?.length, 2);
  assert.deepEqual(progress?.map(movie => movie.title), ['重名影片', '重名影片']);
  assert.equal(new Set(progress?.map(movie => movie.id)).size, 2);
  assert.ok(progress?.every(movie => movie.id));
  held.forEach(response => response.end('<video src="https://cdn.example/movie.m3u8"></video>'));
  await collection;
});

// Catches counting interrupted requests as completed/failed and leaking active rows.
for (const interruption of ['cancel', 'fatal'] as const) {
  test(`${interruption} clears movie progress without completing unfinished playback pages`, async t => {
    const held: ServerResponse[] = [];
    const f = await fixture(t, (path, response) => {
      if (path === '/list') return void response.end('<a href="/voddetail/1">movie</a>');
      if (path === '/voddetail/1') return void response.end('<h1>中断剧集</h1>' + episodes);
      held.push(response);
    });
    const collection = f.collect();
    void collection.catch(() => {});
    await waitFor(() => held.length === 3, 'all playback pages must be held before interruption');
    assert.equal(f.reports.at(-1)?.activeMovieProgress?.[0].totalPages, 3);
    if (interruption === 'cancel') f.controller.abort();
    else { held[0].writeHead(403); held[0].end('Forbidden'); }
    await assert.rejects(collection, interruption === 'cancel' ? /abort|cancel|取消/i : /403/);
    assert.ok(f.reports.every(report => (report.activeMovieProgress ?? []).every(movie => movie.completedPages === 0 && movie.failedPages === 0)));
    assert.equal(f.reports.at(-1)?.activeMovies, 0);
    assert.deepEqual(f.reports.at(-1)?.activeMovieProgress, []);
  });
}
