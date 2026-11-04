import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { initialState, sourceDefaults } from '../server/defaults.js';
import { resolveDateRange } from '../server/dates.js';
import { nextScheduledAt } from '../server/scheduler.js';
import type { Store } from '../server/store.js';
import { Worker, WorkerRequestError } from '../server/worker.js';
import type { Run } from '../shared/types.js';

function fixture(t: TestContext, firstTime = '2026-11-03T18:59:00Z') {
  const state = initialState();
  Object.assign(state.settings, { dailyTimes: ['03:00', '12:00', '18:00'], timezone: 'UTC', schedulerEnabled: true });
  const source = sourceDefaults({ id: 'schedule', name: 'Fixture', baseUrl: 'https://fixture.invalid', enabled: true, collectionMode: 'today' });
  state.sources = [source];
  let instant: Date | null = new Date(firstTime);
  const store = { state, async save() {} } as unknown as Store;
  const worker = new Worker(store, { now: () => instant });
  const starts: string[] = [];
  t.mock.method(worker, 'enqueue', () => {
    assert.ok(instant);
    starts.push(instant.toISOString());
    const run: Run = { id: String(starts.length), sourceId: source.id, sourceName: source.name, status: 'success',
      startedAt: instant.toISOString(), finishedAt: instant.toISOString(), scanned: 0, added: 0, updated: 0,
      resourceCount: 0, errors: [], message: '', dateRange: resolveDateRange({}, 'Asia/Shanghai', instant) };
    state.runs.unshift(run);
    return run;
  });
  t.after(() => worker.stop());
  return { state, source, store, worker, starts, at: (value: string | null) => { instant = value ? new Date(value) : null; } };
}

test('each Beijing daily slot triggers once and deleting history or restarting preserves claims', async t => {
  const f = fixture(t);
  await f.worker.tickScheduler();
  assert.equal(f.starts.length, 0);
  f.at('2026-11-03T19:00:00Z');
  await f.worker.tickScheduler(); await f.worker.tickScheduler();
  assert.equal(f.starts.length, 1);
  f.at('2026-11-04T04:00:00Z');
  await f.worker.tickScheduler();
  assert.equal(f.starts.length, 2, 'the noon slot must not be suppressed by the 03:00 run');
  for (const run of f.state.runs) f.worker.rememberDeletedRun(run);
  f.state.runs = [];
  await f.worker.tickScheduler();
  assert.equal(f.starts.length, 2, 'deleting task rows must not repeat past slots');
  const restarted = new Worker(f.store, { now: () => new Date('2026-11-04T04:30:00Z') });
  let restartedStarts = 0;
  t.mock.method(restarted, 'enqueue', () => { restartedStarts++; throw new Error('past slots must stay claimed'); });
  await restarted.tickScheduler(); await restarted.stop();
  assert.equal(restartedStarts, 0);
  f.at('2026-11-04T10:00:00Z');
  await f.worker.tickScheduler();
  assert.equal(f.starts.length, 3, 'a later slot remains available after history deletion');
  f.at('2026-11-04T19:00:00Z');
  await f.worker.tickScheduler();
  assert.equal(f.starts.length, 4, 'Beijing midnight resets the daily claims');
  assert.deepEqual(f.source.scheduledSlots?.map(slot => [slot.day, slot.time]), [['2026-11-05', '03:00']]);
});

test('downtime coalesces missed slots and an active source waits before the catch-up run', async t => {
  const f = fixture(t, '2026-11-04T12:00:00Z');
  await f.worker.tickScheduler();
  assert.equal(f.starts.length, 1, 'three missed times are combined into one bounded catch-up');
  assert.deepEqual(f.source.scheduledSlots?.map(slot => slot.time), ['03:00', '12:00', '18:00']);
  f.at('2026-11-05T04:00:00Z');
  f.state.runs.unshift({ ...f.state.runs[0], id: 'active', startedAt: '2026-11-04T18:00:00Z', finishedAt: null, status: 'running' });
  await f.worker.tickScheduler();
  assert.equal(f.starts.length, 1);
  f.state.runs[0].status = 'interrupted';
  await f.worker.tickScheduler();
  assert.equal(f.starts.length, 2);
  assert.deepEqual(f.source.scheduledSlots?.map(slot => slot.time), ['03:00', '12:00']);
});

test('unsynchronized time pauses scheduling and manual collection without falling back to OS time', async t => {
  const f = fixture(t);
  f.at(null);
  await f.worker.tickScheduler();
  assert.equal(f.starts.length, 0);
  const worker = new Worker(f.store, { now: () => null });
  assert.throws(() => worker.enqueue(f.source), (error: unknown) => error instanceof WorkerRequestError && error.status === 503);
  await worker.stop();
});

test('different manual scope does not consume a scheduled scope and Beijing time determines today', async t => {
  const f = fixture(t, '2026-11-03T19:00:00Z');
  f.state.runs.push({ id: 'other-scope', sourceId: f.source.id, sourceName: f.source.name, status: 'success',
    startedAt: '2026-11-03T18:59:00Z', finishedAt: '2026-11-03T18:59:01Z', scanned: 0, added: 0, updated: 0,
    resourceCount: 0, errors: [], message: '' });
  await f.worker.tickScheduler();
  assert.equal(f.starts.length, 1);
  assert.equal(f.state.runs[0].dateRange?.startDate, '2026-11-04');
  assert.equal(f.state.runs[0].dateRange?.timezone, 'Asia/Shanghai');
});

test('enqueue freezes the trusted Beijing date rather than host date or configured UTC', async t => {
  const state = initialState(); state.settings.timezone = 'UTC';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const worker = new Worker({ state, async save() { await gate; } } as unknown as Store, { now: () => new Date('2031-02-03T16:05:00Z') });
  t.after(async () => { const stopped = worker.stop(); release(); await stopped; });
  const run = worker.enqueue(state.sources[0], { mode: 'today' });
  assert.equal(run.startedAt, '2031-02-03T16:05:00.000Z');
  assert.deepEqual(run.dateRange, { startDate: '2031-02-04', endDate: '2031-02-04', timezone: 'Asia/Shanghai' });
});

test('next scheduled time selects the nearest of several Beijing times even with a legacy timezone', () => {
  const settings = { ...initialState().settings, dailyTimes: ['03:00', '12:00', '18:00'], timezone: 'America/New_York' };
  assert.equal(nextScheduledAt(settings, new Date('2026-11-04T03:59:00Z')), '2026-11-04T04:00:00.000Z');
  assert.equal(nextScheduledAt(settings, new Date('2026-11-04T10:00:00Z')), '2026-11-04T19:00:00.000Z');
});
