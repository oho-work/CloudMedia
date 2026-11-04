import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, sourceDefaults } from '../server/defaults.js';
import { upsertMovie } from '../server/catalog.js';
import { nextScheduledAt, localMinute } from '../server/scheduler.js';
import { sourceSchema, settingsSchema } from '../server/validation.js';

test('repeat collection updates expiring URLs and preserves movie/resource identity', () => {
  const state = initialState(); const source = sourceDefaults({ baseUrl: 'https://example.com' });
  const first = upsertMovie(state, source, { externalId: '1', pageUrl: 'https://example.com/vod/1', title: '电影', year: '2026', type: '电影', resources: [{ name: '线路一', episode: '正片', url: 'https://cdn.example.com/index.m3u8?token=old' }] });
  first.resources[0].probe.status = 'ok';
  const second = upsertMovie(state, source, { externalId: '1', pageUrl: 'https://new.example.com/vod/1', title: '电影', year: '2026', type: '电影', resources: [{ name: '线路一', episode: '正片', url: 'https://cdn.example.com/index.m3u8?token=new' }] });
  assert.equal(second.added, false); assert.equal(state.movies.length, 1); assert.equal(state.resources.length, 1);
  assert.equal(second.movie.id, first.movie.id); assert.equal(second.resources[0].probe.status, 'pending');
});
test('different sources merge explicit title/year/type matches and retain both references', () => {
  const state = initialState(); const one = sourceDefaults({ baseUrl: 'https://one.example' }); const two = sourceDefaults({ baseUrl: 'https://two.example' });
  upsertMovie(state, one, { externalId: '1', pageUrl: '/', title: '同名电影', year: '2020', type: '电影', resources: [] });
  upsertMovie(state, two, { externalId: '2', pageUrl: '/', title: '同名电影', year: '2020', type: '电影', resources: [] });
  upsertMovie(state, two, { externalId: '3', pageUrl: '/', title: '同名电影', year: '2026', type: '电影', resources: [] });
  assert.equal(state.movies.length, 2); assert.equal(state.movies[0].sourceRefs.length, 2);
});
test('reused playback-page cache preserves resolution time and a fresh resolution resets stale probes', () => {
  const state = initialState(); const source = sourceDefaults({ baseUrl: 'https://example.com' });
  const input = { externalId: 'cached', pageUrl: 'https://example.com/detail/1', title: '缓存测试', resources: [{ name: '蓝光', episode: '第1集', url: 'https://cdn.example.com/video.m3u8', pageUrl: 'https://example.com/play/1', resolvedAt: '2026-11-01T00:00:00.000Z' }] };
  const first = upsertMovie(state, source, input); first.resources[0].probe.status = 'ok';
  const cached = upsertMovie(state, source, input).resources[0];
  assert.equal(cached.resolvedAt, '2026-11-01T00:00:00.000Z'); assert.equal(cached.probe.status, 'ok');
  const refreshed = upsertMovie(state, source, { ...input, resources: [{ ...input.resources[0], resolvedAt: '2026-11-03T00:00:00.000Z' }] }).resources[0];
  assert.equal(refreshed.id, cached.id); assert.equal(refreshed.probe.status, 'pending');
});
test('scheduler uses configured Shanghai timezone even on another host timezone', () => {
  const state = initialState();
  assert.deepEqual(localMinute(new Date('2026-11-02T19:00:00Z'), 'Asia/Shanghai'), { day: '2026-11-03', time: '03:00' });
  assert.equal(nextScheduledAt(state.settings, new Date('2026-11-02T18:59:30Z')), '2026-11-02T19:00:00.000Z');
  assert.equal(nextScheduledAt({ ...state.settings, schedulerEnabled: false }), null);
});
test('configuration rejects unsafe schemes, extreme probing, and invalid timezone', () => {
  assert.equal(sourceSchema.safeParse(sourceDefaults({ baseUrl: 'file:///etc/passwd' })).success, false);
  assert.equal(sourceSchema.safeParse(sourceDefaults({ baseUrl: 'https://example.com', requestIntervalMs: 0 })).success, false);
  assert.equal(settingsSchema.safeParse({ ...initialState().settings, sampleSegments: 100 }).success, false);
  assert.equal(settingsSchema.safeParse({ ...initialState().settings, timezone: 'unknown' }).success, false);
});
