import assert from 'node:assert/strict';
import test from 'node:test';
import { concurrentBatch, TaskLimiter } from '../server/concurrency.js';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

test('task limiter admits only its capacity and lowering capacity waits for active work', async () => {
  const limiter = new TaskLimiter(2); const first = gate(); const second = gate(); const third = gate();
  const started: number[] = [];
  const jobs = [first, second, third].map((blocked, index) => limiter.run(async () => { started.push(index); await blocked.promise; return index; }));
  await nextTurn(); assert.deepEqual(started, [0, 1]);
  limiter.setLimit(1); first.release(); await jobs[0]; await nextTurn(); assert.deepEqual(started, [0, 1]);
  second.release(); await jobs[1]; await nextTurn(); assert.deepEqual(started, [0, 1, 2]);
  third.release(); assert.deepEqual(await Promise.all(jobs), [0, 1, 2]);
});

test('aborting queued work removes it without consuming a slot or blocking later jobs', async () => {
  const limiter = new TaskLimiter(1); const first = gate(); const started: string[] = []; const controller = new AbortController();
  const active = limiter.run(async () => { await first.promise; });
  const cancelled = limiter.run(async () => { started.push('cancelled'); }, controller.signal);
  const rejected = assert.rejects(cancelled, /cancel queued/);
  const later = limiter.run(async () => { started.push('later'); });
  controller.abort(new Error('cancel queued')); await rejected;
  first.release(); await Promise.all([active, later]); assert.deepEqual(started, ['later']);
  assert.equal(await limiter.run(async () => 7), 7);
});

test('increasing capacity releases queued work and action failures release their slots', async () => {
  const limiter = new TaskLimiter(1); const first = gate(); let started = false;
  const active = limiter.run(async () => { await first.promise; });
  const failed = limiter.run(async () => { started = true; throw new Error('fixture failure'); });
  const rejected = assert.rejects(failed, /fixture failure/);
  limiter.setLimit(2); await nextTurn(); assert.equal(started, true); await rejected;
  assert.equal(await limiter.run(async () => 'next'), 'next'); first.release(); await active;
});

test('bounded batches preserve input ordering despite completion order', async () => {
  const first = gate(); let active = 0; let peak = 0; const started: number[] = [];
  const task = concurrentBatch([0, 1, 2], 2, async value => {
    started.push(value); peak = Math.max(peak, ++active);
    if (!value) await first.promise;
    active--; return value + 10;
  });
  await nextTurn(); assert.equal(peak, 2); assert.deepEqual(started, [0, 1, 2]); first.release();
  assert.deepEqual(await task, [10, 11, 12]);
});

test('a failed batch stops queued work and waits for all already started actions', async () => {
  const blocked = gate(); const started: number[] = []; let finished = false;
  const task = concurrentBatch([0, 1, 2, 3], 2, async value => {
    started.push(value);
    if (!value) { await blocked.promise; finished = true; return value; }
    throw new Error('batch failure');
  });
  const rejected = assert.rejects(task, /batch failure/);
  await nextTurn(); assert.deepEqual(started, [0, 1]); assert.equal(finished, false);
  blocked.release(); await rejected; assert.equal(finished, true);
});

test('aborted batches do not start pending work and invalid capacities fail explicitly', async () => {
  const controller = new AbortController(); controller.abort(new Error('stopped'));
  const started: number[] = [];
  await assert.rejects(concurrentBatch([1, 2], 2, async value => { started.push(value); }, controller.signal), /stopped/);
  assert.deepEqual(started, []);
  assert.throws(() => new TaskLimiter(0)); assert.throws(() => new TaskLimiter(1.5));
});
