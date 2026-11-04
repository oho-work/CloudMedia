import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { Store } from '../server/store.js';
import type { State } from '../shared/types.js';

const timestamp = '2026-11-01T00:00:00.000Z';

function storedState(): State {
  return {
    sources: [{
      id: 'shared', name: 'Fixture', baseUrl: 'https://example.com', adapter: 'html', enabled: false,
      listPath: '/', detailLinkSelector: 'a[href*="/voddetail/"]', titleSelector: 'h1',
      posterSelector: '.module-item-pic img, .vodlist_thumb img', descriptionSelector: '.module-info-introduction, .vod_content',
      resourceSelector: 'a[href*="/vodplay/"], a[href$=".m3u8"]', nextPageSelector: 'a[title="下一页"]',
      requestIntervalMs: 2500, concurrency: 1, maxPages: 0, maxItems: 0, maxResourcePages: 0, respectRobots: false,
      referer: '', createdAt: timestamp, lastRunAt: null, lastError: null,
      collectionMode: 'all', updatesSortedDescending: false,
    }],
    movies: [{
      id: 'shared', title: 'Stored film', originalTitle: '', year: '2026', region: '', type: '电影',
      genres: [], director: '', actors: [], description: '', poster: '', rating: '', status: '',
      externalIds: {}, sourceRefs: [{ sourceId: 'shared', externalId: '1', pageUrl: 'https://example.com/voddetail/1' }],
      createdAt: timestamp, updatedAt: timestamp,
    }],
    resources: [{
      id: 'shared', movieId: 'shared', sourceId: 'shared', name: 'Fixture stream', episode: '正片',
      url: 'https://example.com/video.m3u8', referer: '',
      probe: { status: 'pending', checkedAt: null, width: null, height: null, bandwidth: null,
        speedMbps: null, latencyMs: null, bytesRead: 0, durationMs: 0, sampledSegments: 0, playlistUrl: null, error: null },
      createdAt: timestamp, updatedAt: timestamp,
    }],
    runs: [{
      id: 'shared', sourceId: 'shared', sourceName: 'Fixture', status: 'success',
      startedAt: timestamp, finishedAt: timestamp, scanned: 1, added: 1, updated: 0,
      resourceCount: 1, errors: [], message: 'Completed',
    }],
    settings: {
      dailyTime: '03:00', timezone: 'Asia/Shanghai', schedulerEnabled: true,
      probeEnabled: true, sampleSegments: 1, sampleBytes: 262144, probeTimeoutMs: 15000,
      preferredQuality: 'highest', maxRetries: 2, resourceRefreshHours: 168, userAgent: 'Fixture',
    },
  };
}

async function loadPostgres(t: TestContext, data: State) {
  const upserts: { table: string; id: string; data: Record<string, unknown> }[] = [];
  // PostgreSQL JSONB returns object keys by length then byte order, including nested objects.
  const rows: State = JSON.parse(JSON.stringify(data, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort((a, b) => a.length - b.length || Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(key => [key, value[key]]));
  }));
  // Replace only the external connection boundary; init/save and their SQL stay real.
  const client = {
    on() {}, release() {},
    async query(sql: string, values: unknown[] = []) {
      if (sql.startsWith('SELECT pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      const select = sql.match(/^SELECT data FROM "store_test"\.(settings|sources|movies|resources|runs)/);
      if (select) return { rows: select[1] === 'settings' ? [{ data: rows.settings }]
        : rows[select[1] as 'sources' | 'movies' | 'resources' | 'runs'].map(data => ({ data })) };
      const insert = sql.match(/^INSERT INTO "store_test"\.(settings|sources|movies|resources|runs) /);
      if (insert) {
        const settings = insert[1] === 'settings';
        upserts.push({ table: insert[1], id: settings ? 'global' : String(values[0]),
          data: JSON.parse(String(values[settings ? 0 : 1])) });
        return { rows: [] };
      }
      if (/^(BEGIN|COMMIT|ROLLBACK|CREATE |SELECT pg_advisory_unlock)/.test(sql)) return { rows: [] };
      throw new Error(`Unexpected PostgreSQL statement: ${sql}`);
    },
  };
  const pool = { on() {}, async connect() { return client; }, async end() {} };
  t.mock.method(pg, 'Pool', function () { return pool; } as unknown as typeof pg.Pool);
  const previous = { DATABASE_URL: process.env.DATABASE_URL, PGSCHEMA: process.env.PGSCHEMA };
  process.env.DATABASE_URL = 'postgres://fixture.invalid/cloudmedia';
  process.env.PGSCHEMA = 'store_test';
  const store = new Store();
  t.after(async () => {
    try { await store.close(); }
    finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  await store.init();
  return { store, upserts };
}

test('PostgreSQL startup skips UPSERTs for unchanged loaded catalog rows', async t => {
  // Missing startup baselines would rewrite every row, including equal IDs in different tables.
  const { store, upserts } = await loadPostgres(t, storedState());
  assert.deepEqual(upserts.map(row => row.table), ['settings']);

  upserts.length = 0;
  store.state.movies[0].title = 'Changed film';
  await store.save();
  assert.deepEqual(upserts.map(row => [row.table, row.id]), [['movies', 'shared'], ['settings', 'global']]);
  assert.equal(upserts[0].data.title, 'Changed film');
});

test('PostgreSQL startup persists legacy defaults and interrupted pending runs once', async t => {
  // Seeding after normalization would silently discard the required startup repairs.
  const data = storedState();
  delete data.sources[0].collectionMode;
  delete data.sources[0].updatesSortedDescending;
  delete (data.sources[0] as Partial<typeof data.sources[0]>).concurrency;
  Object.assign(data.sources[0], { maxPages: 2, maxItems: 30, maxResourcePages: 30, respectRobots: true, referer: 'https://custom.example/',
    adapter: 'json', jsonItemsPath: 'data.list', jsonTitleField: 'name', jsonUrlField: 'url' });
  data.runs.push({ ...data.runs[0], id: 'queued', status: 'queued', finishedAt: null },
    { ...data.runs[0], id: 'running', status: 'running', finishedAt: null });
  const { store, upserts } = await loadPostgres(t, data);
  assert.deepEqual(upserts.map(row => [row.table, row.id]), [
    ['sources', 'shared'], ['runs', 'queued'], ['runs', 'running'], ['settings', 'global'],
  ]);
  assert.equal(upserts[0].data.collectionMode, 'all');
  assert.equal(upserts[0].data.updatesSortedDescending, false);
  assert.equal(upserts[0].data.concurrency, 1);
  assert.equal(upserts[0].data.maxPages, 0);
  assert.equal(upserts[0].data.maxItems, 0);
  assert.equal(upserts[0].data.maxResourcePages, 0);
  assert.equal(upserts[0].data.respectRobots, false);
  assert.equal(upserts[0].data.referer, '');
  assert.equal(upserts[0].data.adapter, 'html');
  for (const field of ['jsonItemsPath', 'jsonTitleField', 'jsonUrlField']) assert.equal(field in upserts[0].data, false);
  for (const row of upserts.filter(row => row.table === 'runs')) {
    assert.equal(row.data.status, 'interrupted');
    assert.ok(typeof row.data.finishedAt === 'string' && Number.isFinite(Date.parse(row.data.finishedAt)));
    assert.match(String(row.data.message), /服务重启/);
  }

  upserts.length = 0;
  await store.save();
  assert.deepEqual(upserts.map(row => row.table), ['settings']);
});

test('PostgreSQL saves ignore nested object key ordering and persist array ordering', async t => {
  // Object reconstruction must not write unchanged values; array reordering must still be saved.
  const data = storedState();
  data.movies[0].externalIds = { imdb: 'tt123', tmdb: '456' };
  data.movies[0].actors = ['First actor', 'Second actor'];
  const { store, upserts } = await loadPostgres(t, data);
  upserts.length = 0;
  store.state.movies[0].externalIds = { tmdb: '456', imdb: 'tt123' };
  const probe = store.state.resources[0].probe;
  store.state.resources[0].probe = Object.fromEntries(Object.entries(probe).reverse()) as typeof probe;
  await store.save();
  assert.deepEqual(upserts.map(row => row.table), ['settings']);

  upserts.length = 0;
  store.state.movies[0].actors.reverse();
  await store.save();
  assert.deepEqual(upserts.map(row => [row.table, row.id]), [['movies', 'shared'], ['settings', 'global']]);
  assert.deepEqual(upserts[0].data.actors, ['Second actor', 'First actor']);
});
