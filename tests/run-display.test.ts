import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import type { Run } from '../shared/types.js';
import { discoveredProgress, errorCategory, formatRunDuration, hasRunIssues, isRunActive, runFailureCount } from '../web/components/run-display.js';

// Node does not render styles; keep the real component and ignore only its CSS import.
register(`data:text/javascript,${encodeURIComponent("export async function load(url, context, nextLoad) { if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }; return nextLoad(url, context); }")}`, import.meta.url);
const { RunCard } = await import('../web/components/RunCards.js');

const run: Run = { id: 'test', sourceId: 'source', sourceName: '测试源', status: 'running', startedAt: '2026-11-04T15:00:00Z', finishedAt: null, scanned: 8, added: 5, updated: 3, resourceCount: 10, errors: [], message: '' };
const progress = { discoveredMovies: 20, completedMovies: 8, activeMovies: 4, activeMovieTitles: [], concurrency: 4, currentPage: 2, paginationComplete: false, probes: { active: 2, queued: 6, passed: 12, failed: 0 }, failures: { collection: 0, probe: 0, poster: 0, runtime: 0, total: 0 } };
const renderCard = (value: Run) => load(renderToStaticMarkup(createElement(RunCard, { run: value, now: Date.parse('2026-11-04T15:01:12Z'), expanded: true, canceling: false, deleting: false, onExpand() {}, onCancel() {}, onDelete() {} })));

test('legacy task display keeps unknown totals and failure counts unknown', () => {
  assert.equal(discoveredProgress(run), null);
  assert.equal(runFailureCount(run), null);
  assert.equal(discoveredProgress({ ...run, status: 'success' }), null);
  assert.equal(hasRunIssues({ ...run, errors: ['sample'] }), true);
  assert.equal(hasRunIssues({ ...run, status: 'error' }), true);
});

test('progress remains indeterminate during discovery and counts full movie pipelines after paging', () => {
  assert.equal(discoveredProgress({ ...run, progress }), null);
  assert.equal(discoveredProgress({ ...run, progress: { ...progress, completedMovies: 20 } }), null);
  assert.equal(discoveredProgress({ ...run, progress: { ...progress, paginationComplete: true } }), 40);
  assert.equal(discoveredProgress({ ...run, progress: { ...progress, discoveredMovies: 40, paginationComplete: true } }), 20);
  assert.equal(discoveredProgress({ ...run, progress: { ...progress, discoveredMovies: 0 } }), null);
  assert.equal(discoveredProgress({ ...run, progress: { ...progress, completedMovies: 25, paginationComplete: true } }), 100);
  assert.equal(discoveredProgress({ ...run, status: 'interrupted', progress }), null);
});

test('concurrency dots cap at twenty and only light complete proportional slots', () => {
  for (const [activeMovies, concurrency, dots, lit] of [[0, 100, 20, 0], [4, 100, 20, 0], [5, 100, 20, 1], [99, 100, 20, 19], [100, 100, 20, 20], [3, 10, 10, 3]]) {
    const $ = renderCard({ ...run, progress: { ...progress, activeMovies, concurrency } });
    assert.equal($('.activity-slots i').length, dots, `${activeMovies}/${concurrency} dot count`);
    assert.equal($('.activity-slots i.used').length, lit, `${activeMovies}/${concurrency} lit dots`);
    assert.equal($('.activity-slots').attr('aria-label'), `${activeMovies} 个使用中，上限 ${concurrency}`);
    assert.equal($('.activity-slots i:not([aria-hidden="true"])').length, 0);
  }
});

test('ended tasks release display slots and invalid concurrency does not render misleading occupancy', () => {
  const ended = renderCard({ ...run, status: 'success', progress: { ...progress, concurrency: 100, activeMovies: 80 } });
  assert.equal(ended('.activity-slots i.used').length, 0);
  assert.equal(ended('.activity-slots').attr('aria-label'), '0 个使用中，上限 100');
  for (const concurrency of [0, -1, NaN, Infinity]) {
    const $ = renderCard({ ...run, progress: { ...progress, activeMovies: 3, concurrency } });
    assert.equal($('.activity-slots i').length, 0);
    assert.equal($('.activity-slots').attr('aria-label'), '0 个使用中，上限 0');
  }
});

test('active movie rows report processed pages, cache hits, failures and resources without claiming the movie is done', () => {
  const activeMovieProgress = [
    { id: 'detail', title: '读取中的影片', stage: 'detail' as const, completedPages: 0, totalPages: null, cachedPages: 0, failedPages: 0, resourceCount: 0 },
    { id: 'pages', title: '解析中的影片', stage: 'resources' as const, completedPages: 3, totalPages: 6, cachedPages: 1, failedPages: 1, resourceCount: 4 },
    { id: 'unknown', title: '页数待确认', stage: 'resources' as const, completedPages: 0, totalPages: null, cachedPages: 0, failedPages: 0, resourceCount: 0 },
    { id: 'saving', title: '归档中的影片', stage: 'saving' as const, completedPages: 6, totalPages: 6, cachedPages: 1, failedPages: 1, resourceCount: 8 },
  ];
  const $ = renderCard({ ...run, progress: { ...progress, activeMovieTitles: ['旧的影片名称'], activeMovieProgress } });
  const rows = $('[aria-label="正在处理的影片"] li');
  assert.equal(rows.length, 4);
  assert.match(rows.eq(0).text(), /读取影片详情/);
  assert.equal(rows.eq(0).find('[role="progressbar"]').length, 0);
  assert.match(rows.eq(1).text(), /播放页已处理\s*3\s*\/\s*6/);
  assert.match(rows.eq(1).text(), /缓存\s*1/);
  assert.match(rows.eq(1).text(), /失败\s*1/);
  assert.match(rows.eq(1).text(), /已获取资源\s*4/);
  assert.equal(rows.eq(1).find('[role="progressbar"]').attr('aria-valuenow'), '50');
  assert.match(rows.eq(2).text(), /总数待确认/);
  assert.equal(rows.eq(2).find('[role="progressbar"]').length, 0);
  assert.match(rows.eq(3).text(), /保存与海报归档/);
  assert.equal(rows.eq(3).find('[role="progressbar"]').length, 0);
  assert.doesNotMatch($('[aria-label="正在处理的影片"]').text(), /旧的影片名称|100%|影片已完成/);
});

test('legacy active movie titles remain readable while structured empty snapshots do not revive stale titles', () => {
  const legacy = renderCard({ ...run, progress: { ...progress, activeMovieTitles: ['兼容影片'] } });
  assert.match(legacy('.activity-movie-titles').text(), /兼容影片/);
  const empty = renderCard({ ...run, progress: { ...progress, activeMovies: 0, activeMovieTitles: ['过期影片'], activeMovieProgress: [] } });
  assert.match(empty('.activity-movie-titles').text(), /当前没有活动影片槽/);
  assert.doesNotMatch(empty('.activity-movie-titles').text(), /过期影片/);
});

test('known overall totals show a percentage only after discovery finishes', () => {
  const discovering = renderCard({ ...run, progress });
  assert.equal(discovering('.activity-progress [role="progressbar"]').attr('aria-valuenow'), undefined);
  assert.doesNotMatch(discovering('.activity-progress').text(), /%/);
  const known = renderCard({ ...run, progress: { ...progress, paginationComplete: true } });
  assert.equal(known('.activity-progress [role="progressbar"]').attr('aria-valuenow'), '40');
  assert.match(known('.activity-progress').text(), /40%/);
});

test('exact integer page percentages do not lose a point to floating point rounding', () => {
  for (const completedPages of [29, 57, 58]) {
    const activeMovieProgress = [{ id: 'pages', title: '整数进度影片', stage: 'resources' as const, completedPages, totalPages: 100, cachedPages: 0, failedPages: 0, resourceCount: 0 }];
    const $ = renderCard({ ...run, progress: { ...progress, activeMovieProgress } });
    assert.equal($('.activity-movie-progress-list [role="progressbar"]').attr('aria-valuenow'), `${completedPages}`);
    assert.match($('.activity-movie-stage').text(), new RegExp(`${completedPages}%`));
  }
});

test('exact integer overall percentages remain accurate in displayed text and accessibility values', () => {
  for (const completedMovies of [29, 57, 58]) {
    const $ = renderCard({ ...run, progress: { ...progress, discoveredMovies: 100, completedMovies, paginationComplete: true } });
    assert.equal($('.activity-progress [role="progressbar"]').attr('aria-valuenow'), `${completedMovies}`);
    assert.match($('.activity-progress').text(), new RegExp(`${completedMovies}%`));
  }
});

test('failure badges use complete counters even when samples are bounded', () => {
  const withFailures = { ...run, errors: ['one sample'], progress: { ...progress, failures: { ...progress.failures, probe: 35, total: 35 } } };
  assert.equal(runFailureCount(withFailures), 35);
  assert.equal(hasRunIssues(withFailures), true);
  assert.equal(isRunActive({ ...run, status: 'queued' }), true);
  assert.equal(isRunActive({ ...run, status: 'interrupted' }), false);
});

test('elapsed duration accepts synchronized time and finished duration remains stable', () => {
  assert.equal(formatRunDuration(run, Date.parse('2026-11-04T15:01:12Z')), '1 分 12 秒');
  assert.equal(formatRunDuration(run, NaN), '—');
  assert.equal(formatRunDuration({ ...run, finishedAt: '2026-11-04T17:03:00Z' }, NaN), '2 小时 3 分');
});

test('sample categories distinguish TLS from network and timeout failures', () => {
  assert.equal(errorCategory('第1集：上游请求超时'), '请求超时');
  assert.equal(errorCategory('TLS certificate expired'), '证书 / TLS');
  assert.equal(errorCategory('未发现公开 m3u8'), '资源解析');
  assert.equal(errorCategory('socket hang up'), '网络连接');
  assert.equal(errorCategory('保存失败'), '其他异常');
});
