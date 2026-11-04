import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, sourceDefaults } from '../server/defaults.js';
import { upsertMovie } from '../server/catalog.js';
import { nextScheduledAt, localMinute } from '../server/scheduler.js';
import { sourceSchema, settingsSchema } from '../server/validation.js';
import { parseJsonMovie } from '../server/collector.js';

test('resource Referer follows the original page and ignores legacy source overrides', () => {
  const state = initialState();
  const source = { ...sourceDefaults({ baseUrl: 'https://example.com' }), referer: 'https://custom.example/' };
  const input = { externalId: 'referer', pageUrl: 'https://example.com/detail/1', title: '原页面', resources: [{ name: '线路', episode: '正片', url: 'https://cdn.example.com/video.m3u8' }] };
  const resource = upsertMovie(state, source, input).resources[0];
  assert.equal(resource.referer, input.pageUrl);
  resource.referer = source.referer;
  assert.equal(upsertMovie(state, source, input).resources[0].referer, input.pageUrl);
  const playPage = 'https://example.com/play/1';
  assert.equal(upsertMovie(state, source, { ...input, resources: [{ ...input.resources[0], referer: playPage }] }).resources[0].referer, playPage);
});

test('empty episode labels from JSON collection keep a stable resource identity', () => {
  // Lookup and insertion must use the same default episode, including a channel with no episode label.
  const state = initialState(); const source = sourceDefaults({ name: 'Fixture', baseUrl: 'https://example.com' });
  const input = parseJsonMovie({ vod_id: 1, vod_name: '电影', vod_play_url: '$https://example.com/video.m3u8' }, source, source.baseUrl)!;
  const first = upsertMovie(state, source, input).resources[0];
  const second = upsertMovie(state, source, input).resources[0];
  assert.equal(state.resources.length, 1);
  assert.equal(second.id, first.id);
  assert.equal(second.episode, '正片');
});

test('resource identity trims names and episode labels before applying defaults', () => {
  const state = initialState(); const source = sourceDefaults({ name: 'Fixture', baseUrl: 'https://example.com' });
  const input = { externalId: 'blank', pageUrl: source.baseUrl, title: '电影', resources: [{ name: '  ', episode: '\t', url: 'https://example.com/video.m3u8' }] };
  const first = upsertMovie(state, source, input).resources[0];
  const repeated = upsertMovie(state, source, { ...input, resources: [{ ...input.resources[0], name: ' Fixture ', episode: ' 正片 ' }] }).resources[0];
  assert.equal(state.resources.length, 1);
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.name, 'Fixture');
  assert.equal(repeated.episode, '正片');
  upsertMovie(state, source, { ...input, resources: [{ ...input.resources[0], name: 'Other line', episode: '第2集' }] });
  assert.equal(state.resources.length, 2);
});

for (const [storedName, storedEpisode, name, episode] of [
  [' Line ', ' 第1集 ', 'Line', '第1集'],
  [' \t ', ' \t ', 'Fixture', '正片'],
] as const) {
  test(`legacy resource labels ${JSON.stringify([storedName, storedEpisode])} retain identity and history when normalized`, () => {
    // Existing rows written before normalization must match incoming normalized labels.
    const state = initialState(); const source = sourceDefaults({ name: 'Fixture', baseUrl: 'https://example.com' });
    const input = { externalId: 'legacy', pageUrl: source.baseUrl, title: '电影', resources: [{ name, episode, url: 'https://example.com/old.m3u8', resolvedAt: '2026-11-01T00:00:00Z' }] };
    const original = upsertMovie(state, source, input).resources[0];
    original.name = storedName; original.episode = storedEpisode;
    Object.assign(original.probe, { status: 'ok', checkedAt: '2026-11-01T00:01:00Z', width: 1280, height: 720 });
    const updated = upsertMovie(state, source, { ...input, resources: [{ ...input.resources[0], url: 'https://example.com/new.m3u8', resolvedAt: '2026-11-04T00:00:00Z' }] }).resources[0];
    assert.equal(state.resources.length, 1);
    assert.equal(updated.id, original.id);
    assert.equal(updated.name, name);
    assert.equal(updated.episode, episode);
    assert.ok(updated.urlHistory?.some(entry => entry.url === 'https://example.com/old.m3u8'));
    assert.ok(updated.probeHistory?.some(entry => entry.checkedAt === '2026-11-01T00:01:00Z' && entry.width === 1280));
  });
}

test('repeat collection updates expiring URLs and preserves movie/resource identity', () => {
  const state = initialState(); const source = sourceDefaults({ baseUrl: 'https://example.com' });
  const first = upsertMovie(state, source, { externalId: '1', pageUrl: 'https://example.com/vod/1', title: '电影', year: '2026', type: '电影', resources: [{ name: '线路一', episode: '正片', url: 'https://cdn.example.com/index.m3u8?token=old' }] });
  first.resources[0].probe.status = 'ok';
  const second = upsertMovie(state, source, { externalId: '1', pageUrl: 'https://new.example.com/vod/1', title: '电影', year: '2026', type: '电影', resources: [{ name: '线路一', episode: '正片', url: 'https://cdn.example.com/index.m3u8?token=new' }] });
  assert.equal(second.added, false); assert.equal(state.movies.length, 1); assert.equal(state.resources.length, 1);
  assert.equal(second.movie.id, first.movie.id); assert.equal(second.resources[0].probe.status, 'pending');
});

test('replacing a resource retains its previously archived URL and measured probe', () => {
  const state = initialState(); const source = sourceDefaults({ baseUrl: 'https://example.com' });
  const input = { externalId: 'history', pageUrl: 'https://example.com/detail/1', title: '历史', resources: [{ name: '线路', episode: '正片', url: 'https://cdn.example.com/old.m3u8', resolvedAt: '2026-11-01T00:00:00Z' }] };
  const resource = upsertMovie(state, source, input).resources[0];
  Object.assign(resource.probe, { status: 'ok', checkedAt: '2026-11-01T00:01:00Z', width: 1920, height: 1080, speedMbps: 8.5 });
  upsertMovie(state, source, { ...input, resources: [{ ...input.resources[0], url: 'https://cdn.example.com/new.m3u8', resolvedAt: '2026-11-04T00:00:00Z' }] });
  assert.ok(resource.urlHistory?.some(entry => entry.url === 'https://cdn.example.com/old.m3u8'));
  assert.ok(resource.probeHistory?.some(entry => entry.width === 1920 && entry.speedMbps === 8.5));
  assert.equal(resource.probe.status, 'pending');
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
