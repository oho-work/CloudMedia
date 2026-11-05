import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { createApp } from '../server/app.js';
import { upsertMovie } from '../server/catalog.js';
import { initialState, sourceDefaults } from '../server/defaults.js';
import type { Store } from '../server/store.js';
import type { Worker } from '../server/worker.js';
import type { CollectedMovie } from '../shared/types.js';

async function libraryFixture(t: TestContext) {
  const previousAuth = process.env.APP_AUTH_TOKEN;
  delete process.env.APP_AUTH_TOKEN;
  const state = initialState(); state.sources = [];
  const source = sourceDefaults({ id: 'fixture-source', name: '本地测试源', baseUrl: 'https://fixture.example' });
  const add = (id: number, value: Partial<CollectedMovie>) => {
    const movie = upsertMovie(state, source, {
      externalId: String(id), pageUrl: `https://fixture.example/movie/${id}`, title: `影片${id}`, type: '电影',
      genres: ['剧情'], year: '2023', region: '中国大陆', status: 'HD', resources: [], ...value,
    }).movie;
    const previousId = movie.id;
    Object.assign(movie, { id: `movie-${String(id).padStart(2, '0')}`, createdAt: '2026-11-05T00:00:00.000Z' });
    for (const resource of state.resources) if (resource.movieId === previousId) resource.movieId = movie.id;
    return movie;
  };
  const resource = [{ name: '线路一', episode: '第1集', url: 'https://video.fixture.example/1.m3u8' }];
  add(1, { title: '月光航线', type: '动漫', genres: ['奇幻', '冒险'], region: '中国大陆 / 日本', year: '2026', status: '更新至第12集', director: '测试导演', actors: ['测试演员'], resources: resource });
  add(2, { title: '微光', type: '电视剧', genres: ['短剧', '爱情'], region: '中国大陆', year: '2025', status: '全24集' });
  add(3, { title: '长夜', type: '电视剧', genres: ['悬疑'], region: '中国大陆', year: '2026', status: '第6集', resources: resource });
  add(4, { title: '远方', region: '美国', year: '2024', resources: resource });
  add(5, { title: '周末', type: '综艺', genres: ['真人秀'], region: '韩国', year: '2025', status: '更新中' });
  add(6, { title: '古籍', type: '纪录片', genres: ['历史'], region: '中国台湾', year: '1999', status: '完结' });
  for (let id = 7; id <= 15; id++) add(id, {});
  const last = add(16, { genres: ['西部'], region: '巴西', year: '2001' });
  last.poster = 'https://private.fixture.example/raw-poster.jpg';
  last.posterArchive = { status: 'pending', originalUrl: last.poster, referer: 'https://private.fixture.example/detail', path: '', attempts: 0, lastAttemptAt: null, nextRetryAt: null, error: null };
  const store = { state, healthy: true, mode: 'file' } as unknown as Store;
  const server = createApp(store, {} as Worker).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
    if (previousAuth === undefined) delete process.env.APP_AUTH_TOKEN; else process.env.APP_AUTH_TOKEN = previousAuth;
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/movies`;
  const get = async (query: Record<string, string> = {}) => {
    const response = await fetch(`${base}?${new URLSearchParams(query)}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  return { state, base, get };
}

test('library defaults to twelve films and derives all facets before slicing the page', async t => {
  const { get } = await libraryFixture(t);
  const first = await get(); const second = await get({ page: '2' });
  assert.equal(first.limit, 12); assert.equal(first.total, 16);
  assert.deepEqual(first.items.map((item: { id: string }) => item.id), ['movie-01', 'movie-02', 'movie-03', 'movie-04', 'movie-05', 'movie-06', 'movie-07', 'movie-08', 'movie-09', 'movie-10', 'movie-11', 'movie-12']);
  assert.deepEqual(second.items.map((item: { id: string }) => item.id), ['movie-13', 'movie-14', 'movie-15', 'movie-16']);
  assert.ok(first.genres.includes('西部')); assert.ok(first.regions.includes('巴西')); assert.ok(first.years.includes('2001'));
  assert.ok(first.regions.includes('日本')); assert.ok(!first.regions.includes('中国大陆 / 日本'));
  assert.deepEqual([...first.types].sort(), ['动漫', '电影', '电视剧', '短剧', '纪录片', '综艺'].sort());
  assert.deepEqual(first.updateStatuses, ['ongoing', 'completed', 'unknown']);
  assert.deepEqual(first.resourceAvailability, ['yes', 'no']);
  assert.equal((await get({ limit: '500' })).limit, 100);
});

test('library filters intersect metadata, normalized legacy short dramas, sources and resource presence', async t => {
  const { get } = await libraryFixture(t);
  const cases: [Record<string, string>, string[]][] = [
    [{ type: '短剧' }, ['movie-02']], [{ type: '电视剧' }, ['movie-03']],
    [{ genre: '悬疑' }, ['movie-03']], [{ region: '日本' }, ['movie-01']],
    [{ year: '2025' }, ['movie-02', 'movie-05']],
    [{ updateStatus: 'ongoing' }, ['movie-01', 'movie-05']],
    [{ updateStatus: 'completed' }, ['movie-02', 'movie-06']],
    [{ hasResources: 'yes' }, ['movie-01', 'movie-03', 'movie-04']],
    [{ type: '动漫', genre: '奇幻', region: '日本', year: '2026', updateStatus: 'ongoing', hasResources: 'yes', sourceId: 'fixture-source', search: '测试演员' }, ['movie-01']],
    [{ type: '动漫', genre: '爱情' }, []], [{ sourceId: 'missing-source' }, []],
  ];
  for (const [query, ids] of cases) {
    const result = await get(query);
    assert.deepEqual(result.items.map((item: { id: string }) => item.id), ids, JSON.stringify(query));
    assert.equal(result.total, ids.length);
    assert.ok(result.genres.includes('西部'), 'changing filters must retain full-library facet choices');
  }
  const unknown = await get({ updateStatus: 'unknown', limit: '100' });
  assert.deepEqual(unknown.items.map((item: { id: string }) => item.id), ['movie-03', 'movie-04', 'movie-07', 'movie-08', 'movie-09', 'movie-10', 'movie-11', 'movie-12', 'movie-13', 'movie-14', 'movie-15', 'movie-16']);
  assert.equal((await get({ hasResources: 'no' })).total, 13);
  const short = await get({ type: '短剧' });
  assert.equal(short.items[0].libraryType, '短剧'); assert.equal(short.items[0].updateStatus, 'completed');
  assert.equal(short.items[0].resourceCount, 0);
});

test('library clamps pages after filtering or deletion and keeps creation order stable', async t => {
  const { state, get } = await libraryFixture(t);
  const before = structuredClone(state);
  assert.equal((await get({ page: '999', type: '动漫' })).page, 1);
  const last = await get({ page: '999' });
  assert.equal(last.page, 2); assert.equal(last.items.length, 4);
  assert.deepEqual(state, before, 'list requests must not mutate storage or normalized legacy types');
  state.movies = state.movies.slice(0, 3).reverse();
  const after = await get({ page: '2' });
  assert.equal(after.page, 1); assert.equal(after.total, 3);
  assert.deepEqual(after.items.map((item: { id: string }) => item.id), ['movie-01', 'movie-02', 'movie-03']);
  const empty = await get({ search: '不存在的影片', page: '9' });
  assert.equal(empty.page, 1); assert.equal(empty.total, 0); assert.deepEqual(empty.items, []);
});

test('library rejects non-scalar filters and invalid fixed-semantics choices', async t => {
  const { base } = await libraryFixture(t);
  for (const key of ['search', 'type', 'genre', 'region', 'year', 'sourceId', 'updateStatus', 'hasResources']) {
    for (const query of [`${key}=a&${key}=b`, `${key}[nested]=a`]) {
      const response = await fetch(`${base}?${query}`);
      assert.equal(response.status, 400, query); assert.ok((await response.json()).error);
    }
  }
  for (const query of ['updateStatus=finished', 'hasResources=maybe', 'page=1.2', 'page=0', 'limit=NaN', 'page=1&page=2']) {
    const response = await fetch(`${base}?${query}`);
    assert.equal(response.status, 400, query); assert.ok((await response.json()).error);
  }
});

test('library lists local poster paths without leaking the remote poster archive URL', async t => {
  const { get } = await libraryFixture(t);
  const result = await get({ page: '2', limit: '12' });
  const last = result.items.find((item: { id: string }) => item.id === 'movie-16');
  assert.equal(last.poster, '');
  assert.ok(!JSON.stringify(result).includes('private.fixture.example'));
});

test('library update status remains unknown for quality or episode labels without completion evidence', async t => {
  const { state, get } = await libraryFixture(t);
  const cases = [
    ['HD中字', 'unknown'], ['第24集', 'unknown'], ['更新：2026-11-05', 'unknown'],
    ['更新至12集 / 全24集', 'ongoing'], ['全24集', 'completed'], ['第24集完结', 'completed'],
    ['未完结', 'ongoing'], ['', 'unknown'],
  ];
  for (const [status, expected] of cases) {
    state.movies[0].status = status;
    const result = await get({ search: '月光航线' });
    assert.equal(result.items[0].updateStatus, expected, status);
  }
});
