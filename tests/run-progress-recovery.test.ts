import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { initialState } from '../server/defaults.js';
import { Store } from '../server/store.js';
import type { Run, RunProgress, State } from '../shared/types.js';

test('PostgreSQL startup clears interrupted live activity while preserving completed work and legacy history', async t => {
  const state = initialState();
  const timestamp = '2026-11-04T15:55:00.000Z';
  const progress: RunProgress = {
    discoveredMovies: 12, completedMovies: 4, activeMovies: 3, concurrency: 3,
    currentPage: 2, paginationComplete: false, activeMovieTitles: ['正在处理甲', '正在处理乙'],
    probes: { queued: 8, active: 2, passed: 16, failed: 3 },
    failures: { collection: 2, probe: 3, poster: 1, runtime: 0, total: 6 },
  };
  const base: Run = {
    id: 'running', sourceId: state.sources[0].id, sourceName: state.sources[0].name,
    status: 'running', startedAt: timestamp, finishedAt: null,
    scanned: 12, added: 7, updated: 5, resourceCount: 49,
    errors: ['已记录的错误样本'], message: '采集过程中', progress: structuredClone(progress),
  };
  const endedProgress = structuredClone(progress);
  endedProgress.activeMovies = 0; endedProgress.activeMovieTitles = [];
  endedProgress.probes.queued = endedProgress.probes.active = 0;
  state.runs = [base,
    { ...structuredClone(base), id: 'queued', status: 'queued' },
    { ...structuredClone(base), id: 'ended', status: 'error', finishedAt: timestamp, progress: endedProgress },
    { ...structuredClone(base), id: 'legacy', progress: undefined },
  ];
  const before = structuredClone(state);
  const upserts: { table: string; id: string; data: Record<string, any> }[] = [];
  const client = {
    on() {}, release() {},
    async query(sql: string, values: unknown[] = []) {
      if (sql.startsWith('SELECT pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      const select = sql.match(/^SELECT data FROM "progress_recovery_test"\.(settings|sources|movies|resources|runs)/);
      if (select) {
        const items = select[1] === 'settings' ? [state.settings] : state[select[1] as keyof Pick<State, 'sources' | 'movies' | 'resources' | 'runs'>];
        return { rows: items.map(data => ({ data: structuredClone(data) })) };
      }
      const insert = sql.match(/^INSERT INTO "progress_recovery_test"\.(settings|sources|movies|resources|runs) /);
      if (insert) upserts.push({ table: insert[1], id: insert[1] === 'settings' ? 'global' : String(values[0]), data: JSON.parse(String(values[insert[1] === 'settings' ? 0 : 1])) });
      return { rows: [] };
    },
  };
  const pool = { on() {}, async connect() { return client; }, async end() {} };
  t.mock.method(pg, 'Pool', function () { return pool; } as unknown as typeof pg.Pool);
  const previous = { DATABASE_URL: process.env.DATABASE_URL, PGSCHEMA: process.env.PGSCHEMA };
  process.env.DATABASE_URL = 'postgresql://fixture.invalid/progress-recovery';
  process.env.PGSCHEMA = 'progress_recovery_test';
  const store = new Store();
  t.after(async () => {
    try { await store.close(); }
    finally {
      for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  await store.init();
  for (const id of ['running', 'queued']) {
    const recovered = store.state.runs.find(run => run.id === id)!;
    assert.equal(recovered.status, 'interrupted');
    assert.ok(Number.isFinite(Date.parse(recovered.finishedAt!)));
    assert.match(recovered.message, /服务重启/);
    assert.deepEqual(recovered.progress, { ...progress, activeMovies: 0, activeMovieTitles: [], probes: { ...progress.probes, active: 0, queued: 0 } });
    assert.equal(recovered.scanned, 12); assert.equal(recovered.added, 7); assert.equal(recovered.updated, 5); assert.equal(recovered.resourceCount, 49);
    assert.deepEqual(recovered.errors, base.errors);
    assert.deepEqual(upserts.find(row => row.table === 'runs' && row.id === id)?.data.progress, recovered.progress, 'reset activity must be committed at startup');
  }
  assert.deepEqual(store.state.runs.find(run => run.id === 'ended'), before.runs.find(run => run.id === 'ended'));
  const legacy = store.state.runs.find(run => run.id === 'legacy')!;
  assert.equal(legacy.status, 'interrupted'); assert.equal(legacy.progress, undefined);
  assert.equal(Object.hasOwn(upserts.find(row => row.id === 'legacy')!.data, 'progress'), false, 'legacy runs must not acquire invented progress');
  assert.deepEqual(store.state.movies, before.movies); assert.deepEqual(store.state.resources, before.resources);
  upserts.length = 0;
  await store.save();
  assert.ok(upserts.every(row => row.table === 'settings'), 'startup recovery must not repeatedly rewrite unchanged run rows');
});
