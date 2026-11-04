import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { createApp } from '../server/app.js';
import { initialState, sourceDefaults } from '../server/defaults.js';
import type { Store } from '../server/store.js';
import { Worker, WorkerRequestError } from '../server/worker.js';
import type { CollectionRequest, Source } from '../shared/types.js';

function fixture(t: TestContext, extra: Partial<Source> = {}) {
  const state = initialState();
  state.settings.timezone = 'Asia/Shanghai';
  const source = sourceDefaults({ id: '555', name: '555 影视', baseUrl: 'https://example.invalid', listPath: 'file:///no-network',
    collectionMode: 'today', startDate: '2020-01-01', endDate: '2020-01-02', ...extra });
  state.sources = [source];
  // Keep the real worker before its first network operation; cleanup aborts before releasing writes.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const worker = new Worker({ state, async save() { await gate; } } as unknown as Store);
  t.after(async () => { const stopped = worker.stop(); release(); await stopped; });
  return { source, state, worker };
}

test('the same today source accepts all, today and explicit date range overrides', async t => {
  for (const mode of ['all', 'today', 'range'] as const) await t.test(mode, t => {
    const { source, state, worker } = fixture(t);
    const request: CollectionRequest = mode === 'range'
      ? { mode, startDate: '2026-11-01', endDate: '2026-11-03' } : { mode };
    const run = worker.enqueue(source, request);
    if (mode === 'all') assert.equal(run.dateRange, undefined);
    else if (mode === 'range') assert.deepEqual(run.dateRange, { startDate: '2026-11-01', endDate: '2026-11-03', timezone: 'Asia/Shanghai' });
    else {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      assert.deepEqual(run.dateRange, { startDate: today, endDate: today, timezone: 'Asia/Shanghai' });
    }
    assert.equal(source.collectionMode, 'today');
    assert.equal(source.startDate, '2020-01-01');
    state.settings.timezone = 'UTC'; source.startDate = '2021-01-01';
    if (run.dateRange) assert.equal(run.dateRange.timezone, 'Asia/Shanghai');
  });
});

test('saved range defaults are frozen but today ignores saved date boundaries', async t => {
  await t.test('saved range', t => {
    const { source, worker } = fixture(t, { collectionMode: 'range' });
    const run = worker.enqueue(source);
    assert.deepEqual(run.dateRange, { startDate: '2020-01-01', endDate: '2020-01-02', timezone: 'Asia/Shanghai' });
    source.endDate = '2020-12-31';
    assert.equal(run.dateRange!.endDate, '2020-01-02');
  });
  await t.test('today override', t => {
    const { source, worker } = fixture(t, { collectionMode: 'range' });
    const run = worker.enqueue(source, { mode: 'today' });
    assert.ok(run.dateRange);
    assert.equal(run.dateRange!.startDate, run.dateRange!.endDate);
    assert.notEqual(run.dateRange!.startDate, '2020-01-01');
  });
});

test('the daily scheduler uses each source configured collection scope', async t => {
  for (const mode of ['all', 'today', 'range'] as const) await t.test(mode, t => {
    const { source, state, worker } = fixture(t, { collectionMode: mode, enabled: true });
    state.settings.dailyTime = '00:00';
    worker.startScheduler();
    assert.equal(state.runs.length, 1);
    const run = state.runs[0];
    if (mode === 'all') assert.equal(run.dateRange, undefined);
    else if (mode === 'range') assert.deepEqual(run.dateRange, { startDate: '2020-01-01', endDate: '2020-01-02', timezone: 'Asia/Shanghai' });
    else { assert.ok(run.dateRange); assert.notEqual(run.dateRange.startDate, source.startDate); }
  });
});

test('explicit and saved ranges require two valid ordered dates without creating tasks', t => {
  const { source, state, worker } = fixture(t);
  for (const request of [
    { mode: 'range', startDate: '2026-11-01' },
    { mode: 'range', endDate: '2026-11-03' },
    { mode: 'range', startDate: '2026-02-30', endDate: '2026-03-01' },
    { mode: 'range', startDate: '2026-11-03', endDate: '2026-11-01' },
  ] as CollectionRequest[]) assert.throws(() => worker.enqueue(source, request), (error: unknown) => error instanceof WorkerRequestError && error.status === 400);
  source.collectionMode = 'range'; delete source.startDate;
  assert.throws(() => worker.enqueue(source), (error: unknown) => error instanceof WorkerRequestError && error.status === 400);
  assert.equal(state.runs.length, 0);
});

test('legacy date-only requests select a single-day range on an all source', t => {
  const { source, worker } = fixture(t, { collectionMode: 'all' });
  const run = worker.enqueue(source, { startDate: '2026-11-03' });
  assert.deepEqual(run.dateRange, { startDate: '2026-11-03', endDate: '2026-11-03', timezone: 'Asia/Shanghai' });
  assert.equal(worker.enqueue(source, { mode: 'range', startDate: '2026-11-03', endDate: '2026-11-03' }).id, run.id);
});

test('all and date scopes conflict while an identical frozen scope reuses the task', t => {
  const { source, worker } = fixture(t);
  const run = worker.enqueue(source, { mode: 'all' });
  assert.equal(worker.enqueue(source, { mode: 'all' }).id, run.id);
  assert.throws(() => worker.enqueue(source, { mode: 'today' }), (error: unknown) => error instanceof WorkerRequestError && error.status === 409);
  assert.throws(() => worker.enqueue(source, { mode: 'range', startDate: '2026-11-01', endDate: '2026-11-03' }), (error: unknown) => error instanceof WorkerRequestError && error.status === 409);
});

test('non-HTML sources accept all but reject date filters with HTTP 400 semantics', async t => {
  for (const adapter of ['json', 'maccms'] as const) await t.test(adapter, t => {
    const { source, worker, state } = fixture(t, { adapter, collectionMode: 'all' });
    for (const request of [{ mode: 'today' }, { mode: 'range', startDate: '2026-11-01', endDate: '2026-11-03' }, { startDate: '2026-11-03' }] as CollectionRequest[])
      assert.throws(() => worker.enqueue(source, request), (error: unknown) => error instanceof WorkerRequestError && error.status === 400);
    assert.equal(state.runs.length, 0);
    assert.equal(worker.enqueue(source, { mode: 'all' }).dateRange, undefined);
  });
});

test('the task API accepts each scope on an all source and rejects invalid date requests', async t => {
  const state = initialState();
  const source = sourceDefaults({ id: 'scope-api', name: 'Fixture', baseUrl: 'https://example.invalid', listPath: 'file:///no-network', collectionMode: 'all' });
  state.sources = [source];
  const store = { state, healthy: true, mode: 'file', async save() {} } as unknown as Store;
  const worker = new Worker(store);
  const previousToken = process.env.APP_AUTH_TOKEN;
  process.env.APP_AUTH_TOKEN = 'collection-options-fixture';
  const server = createServer(createApp(store, worker));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    try { await worker.stop(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }); }
    finally { if (previousToken === undefined) delete process.env.APP_AUTH_TOKEN; else process.env.APP_AUTH_TOKEN = previousToken; }
  });
  const post = async (body: unknown) => {
    const response = await fetch(`${origin}/api/sources/${source.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer collection-options-fixture' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as { dateRange?: { startDate: string; endDate: string; timezone: string } } };
  };
  for (const request of [{ mode: 'all' }, { mode: 'today' }, { mode: 'range', startDate: '2026-11-01', endDate: '2026-11-03' }]) {
    const response = await post(request);
    assert.equal(response.status, 202, JSON.stringify(response.body));
    if (request.mode === 'all') assert.equal(response.body.dateRange, undefined);
    else if (request.mode === 'range') assert.deepEqual(response.body.dateRange, { startDate: '2026-11-01', endDate: '2026-11-03', timezone: 'Asia/Shanghai' });
    else assert.equal(response.body.dateRange?.startDate, response.body.dateRange?.endDate);
    await new Promise(resolve => setImmediate(resolve));
  }
  const beforeInvalid = state.runs.length;
  for (const request of [{ mode: 'range' }, { mode: 'range', startDate: '2026-11-01' },
    { mode: 'range', startDate: '2026-02-30', endDate: '2026-03-01' },
    { mode: 'range', startDate: '2026-11-03', endDate: '2026-11-01' },
    { mode: 'all', startDate: '2026-11-01', endDate: '2026-11-03' }, { mode: 'today', startDate: '2026-11-01' }])
    assert.equal((await post(request)).status, 400, JSON.stringify(request));
  source.adapter = 'json';
  assert.equal((await post({ mode: 'today' })).status, 400);
  assert.equal((await post({ mode: 'range', startDate: '2026-11-01', endDate: '2026-11-03' })).status, 400);
  assert.equal(state.runs.length, beforeInvalid);
});
