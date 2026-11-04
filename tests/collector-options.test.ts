import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { collectSource } from '../server/collector.js';
import { defaultSettings, initialState, sourceDefaults } from '../server/defaults.js';
import { resolveDateRange } from '../server/dates.js';
import { upsertMovie } from '../server/catalog.js';
import type { Store } from '../server/store.js';
import { Worker } from '../server/worker.js';
import type { CollectedMovie } from '../shared/types.js';

let origin = '';
let previousPrivate: string | undefined;
const requests: { path: string; referer: string | undefined }[] = [];
const server = createServer((request, response) => {
  const url = new URL(request.url!, 'http://localhost');
  requests.push({ path: url.pathname, referer: request.headers.referer });
  if (url.pathname === '/robots.txt') { response.end('User-agent: *\nDisallow: /\nCrawl-delay: 60'); return; }
  if (url.pathname === '/refresh-list') { response.end('<a href="/voddetail/refresh">Refresh movie</a>'); return; }
  if (url.pathname === '/list/1' || url.pathname === '/list/2') {
    const page = Number(url.pathname.at(-1));
    response.end([page * 2 - 1, page * 2].map(id => `<a href="/voddetail/${id}">${id}</a>`).join('') +
      (page === 1 ? '<a title="下一页" href="/list/2">下一页</a>' : '')); return;
  }
  if (url.pathname.startsWith('/voddetail/')) {
    const id = url.pathname.split('/').at(-1);
    if (id === 'refresh') { response.end('<h1>Refresh movie</h1><a href="/vodplay/refresh">正片</a>'); return; }
    if (id?.startsWith('dated-')) {
      const date = id === 'dated-today' ? resolveDateRange({}, defaultSettings.timezone).startDate : '2000-01-01';
      response.end(`<h1>${id}</h1><div class="module-info-item"><span class="module-info-item-title">更新：</span><div class="module-info-item-content">${date}</div></div>`); return;
    }
    response.end(`<h1>Movie ${id}</h1><a href="/vodplay/${id}-1">第1集</a><a href="/vodplay/${id}-2">第2集</a>`); return;
  }
  if (url.pathname === '/vodplay/refresh' || url.pathname === '/vodplay/root') {
    const referer = url.pathname === '/vodplay/refresh' ? origin + '/voddetail/refresh' : origin + '/';
    if (request.headers.referer !== referer) { response.writeHead(403); response.end('Wrong page referer'); return; }
    response.end(`<video src="${origin}/stream/refresh.m3u8"></video>`); return;
  }
  if (url.pathname === '/stream/refresh.m3u8') { response.end('#EXTM3U\n#EXTINF:10,\n/stream/refresh.ts\n#EXT-X-ENDLIST\n'); return; }
  if (url.pathname === '/stream/refresh.ts') { response.setHeader('content-type', 'video/mp2t'); response.end(Buffer.alloc(1024, 0xff)); return; }
  if (url.pathname === '/vodplay/1-2') { response.writeHead(302, { location: '/redirected-play' }); response.end(); return; }
  if (url.pathname.startsWith('/vodplay/') || url.pathname === '/redirected-play') {
    response.end(`<video src="${origin}/stream/${url.pathname.slice(1)}.m3u8"></video>`); return;
  }
  if (url.pathname === '/json') {
    const page = Number(url.searchParams.get('pg') || url.searchParams.get('page') || 1);
    response.end(JSON.stringify({ pagecount: 2, list: [page * 2 - 1, page * 2].map(id => ({ vod_id: id, vod_name: `Movie ${id}` })) })); return;
  }
  if (url.pathname === '/dated-list') { response.end('<a href="/voddetail/dated-today">today</a><a href="/voddetail/dated-old">old</a>'); return; }
  response.writeHead(404); response.end();
});

before(async () => {
  previousPrivate = process.env.ALLOW_PRIVATE_UPSTREAM; process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (previousPrivate === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM; else process.env.ALLOW_PRIVATE_UPSTREAM = previousPrivate;
});

const source = () => ({ ...sourceDefaults({ baseUrl: origin, listPath: '/list/1', requestIntervalMs: 500 }),
  maxPages: 1, maxItems: 1, maxResourcePages: 1, respectRobots: false, referer: 'https://manual.example/unused' });
const context = () => ({ settings: { ...defaultSettings, maxRetries: 0 }, log: (_message: string) => {} });

test('legacy positive limits do not cap HTML list pages, films or per-film playback pages', async () => {
  const movies: CollectedMovie[] = [];
  for await (const movie of collectSource(source(), context())) movies.push(movie);
  assert.deepEqual(movies.map(movie => movie.title), ['Movie 1', 'Movie 2', 'Movie 3', 'Movie 4']);
  assert.deepEqual(movies.map(movie => movie.resources.length), [2, 2, 2, 2]);
});

test('robots settings never trigger a robots request or block declared-disallowed pages', async () => {
  requests.length = 0;
  const movies: CollectedMovie[] = [];
  for await (const movie of collectSource({ ...source(), respectRobots: true }, context())) movies.push(movie);
  assert.equal(movies.length, 4);
  assert.equal(requests.some(request => request.path === '/robots.txt'), false);
});

test('request Referer follows the source, listing and detail pages and survives playback redirects', async () => {
  requests.length = 0;
  const movies: CollectedMovie[] = [];
  for await (const movie of collectSource(source(), context())) movies.push(movie);
  assert.equal(requests.find(request => request.path === '/list/1')?.referer, origin + '/');
  assert.equal(requests.find(request => request.path === '/list/2')?.referer, origin + '/list/1');
  assert.equal(requests.find(request => request.path === '/voddetail/1')?.referer, origin + '/list/1');
  assert.equal(requests.find(request => request.path === '/voddetail/3')?.referer, origin + '/list/2');
  assert.equal(requests.find(request => request.path === '/vodplay/1-2')?.referer, origin + '/voddetail/1');
  assert.equal(requests.find(request => request.path === '/redirected-play')?.referer, origin + '/voddetail/1');
  assert.equal(requests.some(request => request.referer === 'https://manual.example/unused'), false);
  const redirected = movies[0].resources.find(resource => resource.pageUrl === origin + '/redirected-play');
  assert.equal(redirected?.referer, origin + '/redirected-play');
});

test('refresh uses the saved detail page Referer after an initially successful collection', async t => {
  const fixtureSource = { ...source(), listPath: '/refresh-list' };
  const movies: CollectedMovie[] = [];
  for await (const movie of collectSource(fixtureSource, context())) movies.push(movie);
  assert.equal(movies[0].resources.length, 1);
  const state = initialState(); state.sources = [fixtureSource];
  const result = upsertMovie(state, fixtureSource, movies[0]);
  const resource = result.resources[0];
  const snapshots: string[] = [];
  const worker = new Worker({ state, async save() { snapshots.push(JSON.stringify(state)); } } as unknown as Store);
  t.after(() => worker.stop());
  requests.length = 0;
  const refreshed = await worker.probe(resource, true);
  assert.equal(refreshed.probe.status, 'ok', refreshed.probe.error || 'refresh must succeed');
  assert.equal(requests.find(request => request.path === '/vodplay/refresh')?.referer, origin + '/voddetail/refresh');
  assert.equal(refreshed.referer, origin + '/vodplay/refresh');
  assert.ok(snapshots.some(snapshot => JSON.parse(snapshot).resources[0].probe.status === 'ok'));
});

test('refresh without a saved detail page falls back to the source entry', async t => {
  const fixtureSource = source(); const state = initialState(); state.sources = [fixtureSource];
  const result = upsertMovie(state, fixtureSource, { externalId: 'legacy-root', title: 'Legacy movie', pageUrl: '', resources: [
    { name: 'Line', episode: '正片', url: origin + '/stream/refresh.m3u8', pageUrl: origin + '/vodplay/root' },
  ] });
  result.movie.sourceRefs = [];
  const worker = new Worker({ state, async save() {} } as unknown as Store);
  t.after(() => worker.stop());
  requests.length = 0;
  const refreshed = await worker.probe(result.resources[0], true);
  assert.equal(refreshed.probe.status, 'ok', refreshed.probe.error || 'legacy refresh must succeed');
  assert.equal(requests.find(request => request.path === '/vodplay/root')?.referer, origin + '/');
});

for (const adapter of ['maccms', 'json'] as const) {
  test(`legacy positive limits do not cap ${adapter} pages or titles`, async () => {
    const movies: CollectedMovie[] = [];
    for await (const movie of collectSource({ ...source(), adapter, listPath: '/json' }, context())) movies.push(movie);
    assert.equal(movies.length, 4);
    assert.equal(new Set(movies.map(movie => movie.externalId)).size, 4);
  });
}

test('direct today collection filters today and ignores saved range dates', async () => {
  const movies: CollectedMovie[] = [];
  for await (const movie of collectSource({ ...source(), listPath: '/dated-list', collectionMode: 'today', startDate: '2000-01-01', endDate: '2000-01-01' }, context())) movies.push(movie);
  assert.deepEqual(movies.map(movie => movie.title), ['dated-today']);
});

test('direct range collection uses the source saved date bounds', async () => {
  const movies: CollectedMovie[] = [];
  for await (const movie of collectSource({ ...source(), listPath: '/dated-list', collectionMode: 'range', startDate: '2000-01-01', endDate: '2000-01-01' }, context())) movies.push(movie);
  assert.deepEqual(movies.map(movie => movie.title), ['dated-old']);
});

test('a frozen context range takes precedence over current source collection options', async () => {
  const movies: CollectedMovie[] = [];
  for await (const movie of collectSource({ ...source(), listPath: '/dated-list', collectionMode: 'today' }, {
    ...context(), dateRange: { startDate: '2000-01-01', endDate: '2000-01-01', timezone: defaultSettings.timezone },
  })) movies.push(movie);
  assert.deepEqual(movies.map(movie => movie.title), ['dated-old']);
});

test('a direct range with missing boundaries rejects before any network request', async () => {
  requests.length = 0;
  await assert.rejects(async () => {
    for await (const _movie of collectSource({ ...source(), listPath: '/dated-list', collectionMode: 'range', startDate: '2000-01-01' }, context())) {}
  }, /开始日期|结束日期|区间/);
  assert.equal(requests.length, 0);
});
