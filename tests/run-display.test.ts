import assert from 'node:assert/strict';
import test from 'node:test';
import type { Run } from '../shared/types.js';
import { discoveredProgress, errorCategory, formatRunDuration, hasRunIssues, isRunActive, runFailureCount } from '../web/components/run-display.js';

const run: Run = { id: 'test', sourceId: 'source', sourceName: '测试源', status: 'running', startedAt: '2026-11-04T15:00:00Z', finishedAt: null, scanned: 8, added: 5, updated: 3, resourceCount: 10, errors: [], message: '' };
const progress = { discoveredMovies: 20, completedMovies: 8, activeMovies: 4, activeMovieTitles: [], concurrency: 4, currentPage: 2, paginationComplete: false, probes: { active: 2, queued: 6, passed: 12, failed: 0 }, failures: { collection: 0, probe: 0, poster: 0, runtime: 0, total: 0 } };

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
