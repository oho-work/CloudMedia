import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { CollectedMovie, CollectionContext, DateRange, Source } from '../shared/types.js';
import { collectSource } from '../server/collector.js';
import { defaultSettings, sourceDefaults } from '../server/defaults.js';
import { resolveDateRange, sourceDate, validDate } from '../server/dates.js';

test('today follows the configured timezone at midnight and a range remains an inclusive pair of calendar dates', () => {
  const beforeMidnight = new Date('2026-11-02T15:59:59.999Z');
  const midnight = new Date('2026-11-02T16:00:00.000Z');
  assert.deepEqual(resolveDateRange({}, 'Asia/Shanghai', beforeMidnight), { startDate: '2026-11-02', endDate: '2026-11-02', timezone: 'Asia/Shanghai' });
  assert.deepEqual(resolveDateRange({}, 'Asia/Shanghai', midnight), { startDate: '2026-11-03', endDate: '2026-11-03', timezone: 'Asia/Shanghai' });
  assert.equal(resolveDateRange({}, 'America/Los_Angeles', midnight).startDate, '2026-11-02');
  assert.deepEqual(resolveDateRange({ startDate: '2026-11-01', endDate: '2026-11-03' }, 'Asia/Shanghai', midnight), { startDate: '2026-11-01', endDate: '2026-11-03', timezone: 'Asia/Shanghai' });
  assert.equal(resolveDateRange({ startDate: '2026-10-31' }, 'Asia/Shanghai', midnight).endDate, '2026-10-31');
  assert.equal(resolveDateRange({ endDate: '2026-10-31' }, 'Asia/Shanghai', midnight).startDate, '2026-10-31');
});

test('date validation rejects malformed dates, non-leap days, and reversed ranges', () => {
  assert.equal(validDate('2024-02-29'), true);
  for (const value of ['2026-02-29', '2026-02-30', '2026-11-31', '2026-13-01', '2026-1-01', 'today', '']) {
    assert.equal(validDate(value), false, value);
    assert.throws(() => resolveDateRange({ startDate: value }, 'Asia/Shanghai'), /有效/);
  }
  assert.throws(() => resolveDateRange({ startDate: '2026-11-04', endDate: '2026-11-03' }, 'Asia/Shanghai'), /开始日期/);
});

test('source dates retain local calendar dates and convert offset or Unix timestamps using the selected timezone', () => {
  assert.equal(sourceDate('2026年11月3日 00:30:00'), '2026-11-03');
  assert.equal(sourceDate('2026/11/03 00:30:00', 'America/Los_Angeles'), '2026-11-03');
  assert.equal(sourceDate('2026-11-02T16:00:00Z', 'Asia/Shanghai'), '2026-11-03');
  assert.equal(sourceDate('2026-11-02T16:00:00Z', 'UTC'), '2026-11-02');
  const milliseconds = Date.parse('2026-11-02T16:00:00Z');
  assert.equal(sourceDate(milliseconds, 'Asia/Shanghai'), '2026-11-03');
  assert.equal(sourceDate(String(milliseconds / 1000), 'Asia/Shanghai'), '2026-11-03');
  assert.equal(sourceDate('2026-02-30'), undefined);
  assert.equal(sourceDate('昨天'), undefined);
});

let origin = '';
const events: string[] = [];
const previousPrivate = process.env.ALLOW_PRIVATE_UPSTREAM;
const dates: Record<string, string> = { newer: '2026-11-05', a: '2026-11-04', b: '2026-11-03', c: '2026-11-02', older: '2026-11-01', instant: '2026-11-02T16:00:00Z' };
const links = (...ids: string[]) => ids.map(id => `<a href="/voddetail/${id}">${id}</a>`).join('');
const next = (href: string) => `<a title="下一页" href="${href}">下一页</a>`;
const server = createServer((request, response) => {
  const url = new URL(request.url!, 'http://fixture');
  events.push(`request:${url.pathname}`);
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (url.pathname === '/range-1') return response.end(links('newer', 'a', 'b') + '<a href="/voddetail/a#duplicate">duplicate</a>' + next('/range-2'));
  if (url.pathname === '/range-2') return response.end(links('a', 'c', 'older') + next('/range-3'));
  if (url.pathname === '/range-3') return response.end(links('older'));
  if (url.pathname === '/duplicate-1') return response.end(links('a') + next('/duplicate-2'));
  if (url.pathname === '/duplicate-2') return response.end(links('a') + next('/duplicate-3'));
  if (url.pathname === '/duplicate-3') return response.end(links('b'));
  if (url.pathname === '/cycle-1') return response.end(links('a') + next('/cycle-2'));
  if (url.pathname === '/cycle-2') return response.end(links('b') + next('/cycle-1'));
  if (url.pathname === '/missing-list') return response.end(links('missing'));
  if (url.pathname === '/unsorted-list') return response.end(links('older', 'c'));
  if (url.pathname === '/instant-list') return response.end(links('instant'));
  if (url.pathname.startsWith('/voddetail/')) {
    const id = url.pathname.split('/').at(-1)!;
    const update = dates[id] ? `<div class="module-info-item"><span class="module-info-item-title">更新：</span><div class="module-info-item-content">${dates[id]}</div></div>` : '';
    const title = id === 'a' || id === 'b' ? '同名影片' : `影片${id}`;
    return response.end(`<h1>${title}</h1>${update}<div class="module-play-list">${[1, 2].map(episode => `<a href="/vodplay/${id}-${episode}">第${episode}集</a>`).join('')}</div>`);
  }
  if (url.pathname.startsWith('/vodplay/')) return response.end(`<script>var player_fixture=${JSON.stringify({ url: `${origin}${url.pathname}.m3u8` })}</script>`);
  response.writeHead(404); response.end();
});

before(async () => {
  process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
  if (previousPrivate === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM;
  else process.env.ALLOW_PRIVATE_UPSTREAM = previousPrivate;
});
const range: DateRange = { startDate: '2026-11-02', endDate: '2026-11-04', timezone: 'Asia/Shanghai' };
const fixtureSource = (extra: Partial<Source> = {}) => sourceDefaults({ baseUrl: origin, listPath: '/range-1', collectionMode: 'updates', updatesSortedDescending: true, requestIntervalMs: 500, respectRobots: false, maxPages: 1, maxItems: 1, maxResourcePages: 1, ...extra });
const fixtureContext = (extra: Partial<CollectionContext> = {}): CollectionContext => ({ settings: { ...defaultSettings, maxRetries: 0 }, dateRange: range, log: () => {}, ...extra });
async function collect(source: Source, context = fixtureContext()) {
  const result: CollectedMovie[] = [];
  for await (const movie of collectSource(source, context)) result.push(movie);
  return result;
}

test('range collection includes both boundaries, bypasses all quantity caps, and archives every matching title before playback', { timeout: 15000 }, async () => {
  events.length = 0;
  const movies = await collect(fixtureSource(), fixtureContext({ onCheckpoint: async movie => { events.push(`checkpoint:${movie.externalId}:${movie.resources.length}`); } }));
  assert.deepEqual(movies.map(movie => movie.externalId), ['/voddetail/a', '/voddetail/b', '/voddetail/c']);
  assert.deepEqual(movies.map(movie => movie.sourceUpdatedOn), ['2026-11-04', '2026-11-03', '2026-11-02']);
  assert.equal(movies[0].title, movies[1].title, 'same titles on distinct source detail pages must remain distinct collected records');
  assert.ok(movies.every(movie => movie.resources.length === 2), 'all playback pages must be read despite a configured per-movie cap of one');
  const firstPlay = events.findIndex(event => event.startsWith('request:/vodplay/'));
  assert.ok(firstPlay > 0);
  for (const id of ['a', 'b', 'c']) assert.ok(events.indexOf(`checkpoint:/voddetail/${id}:0`) < firstPlay, `metadata for ${id} must be checkpointed before any playback request`);
  assert.equal(events.filter(event => event === 'request:/voddetail/a').length, 1, 'repeated and hash-only links must not refetch the same detail page');
  assert.ok(events.includes('request:/range-2'), 'a configured list-page cap of one must not truncate a date range');
  assert.ok(!events.includes('request:/range-3'), 'a descending list can stop at a record older than the inclusive start date');
  assert.ok(!events.some(event => /^request:\/vodplay\/(newer|older)-/.test(event)), 'out-of-range films must not fetch playback pages');
});

test('duplicate-only intermediate pages do not hide later titles', { timeout: 8000 }, async () => {
  events.length = 0;
  const movies = await collect(fixtureSource({ listPath: '/duplicate-1', resourceSelector: 'a.never' }));
  assert.deepEqual(movies.map(movie => movie.externalId), ['/voddetail/a', '/voddetail/b']);
  for (const page of ['/duplicate-1', '/duplicate-2', '/duplicate-3']) assert.equal(events.filter(event => event === `request:${page}`).length, 1);
  assert.equal(events.filter(event => event === 'request:/voddetail/a').length, 1);
});

test('list cycles report incomplete collection without refetching pages or losing discovered metadata', { timeout: 5000 }, async () => {
  events.length = 0;
  const checkpoints: string[] = [];
  await assert.rejects(() => collect(fixtureSource({ listPath: '/cycle-1', resourceSelector: 'a.never' }), fixtureContext({ onCheckpoint: async movie => { checkpoints.push(movie.externalId); } })), /分页形成循环/);
  assert.deepEqual(checkpoints, ['/voddetail/a', '/voddetail/b']);
  for (const page of ['/cycle-1', '/cycle-2']) assert.equal(events.filter(event => event === `request:${page}`).length, 1);
});

test('an unsorted update source continues after older records instead of assuming descending order', { timeout: 5000 }, async () => {
  const movies = await collect(fixtureSource({ listPath: '/unsorted-list', updatesSortedDescending: false, resourceSelector: 'a.never' }));
  assert.deepEqual(movies.map(movie => movie.externalId), ['/voddetail/c']);
});

test('missing source update dates fail the date filter without collecting an undated title', { timeout: 5000 }, async () => {
  events.length = 0;
  const checkpoints: CollectedMovie[] = [];
  await assert.rejects(() => collect(fixtureSource({ listPath: '/missing-list' }), fixtureContext({ onCheckpoint: async movie => { checkpoints.push(movie); } })), /没有有效的源站更新时间/);
  assert.equal(checkpoints.length, 0);
  assert.ok(!events.some(event => event.startsWith('request:/vodplay/')));
});

test('a frozen range timezone controls timestamp classification when current settings use a different timezone', { timeout: 5000 }, async () => {
  const movies = await collect(fixtureSource({ listPath: '/instant-list', resourceSelector: 'a.never' }), fixtureContext({ settings: { ...defaultSettings, timezone: 'UTC', maxRetries: 0 }, dateRange: { startDate: '2026-11-03', endDate: '2026-11-03', timezone: 'Asia/Shanghai' } }));
  assert.equal(movies.length, 1);
  assert.equal(movies[0].sourceUpdatedOn, '2026-11-03');
});
