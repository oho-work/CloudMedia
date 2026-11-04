import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { initialState, sourceDefaults } from '../server/defaults.js';
import type { Store } from '../server/store.js';
import { Worker } from '../server/worker.js';
import type { State } from '../shared/types.js';

async function fixture(t: TestContext, failingSaves: number[], beforeSave?: (attempt: number) => Promise<void>) {
  const previousPrivate = process.env.ALLOW_PRIVATE_UPSTREAM;
  process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  const upstream = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.end('{"list":[]}');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const state = initialState();
  state.sources = ['first', 'second'].map(id => sourceDefaults({ id, name: id, baseUrl: origin, adapter: 'json', listPath: '/catalog', respectRobots: false }));
  Object.assign(state.settings, { schedulerEnabled: false, probeEnabled: false, maxRetries: 0 });
  let saveCount = 0;
  let durable: State | undefined;
  const store = { state, async save() {
    const snapshot = structuredClone(state); const attempt = ++saveCount;
    await beforeSave?.(attempt);
    if (failingSaves.includes(attempt)) throw new Error('fixture storage unavailable');
    durable = snapshot;
  } } as unknown as Store;
  const worker = new Worker(store);
  t.mock.method(console, 'error', () => {});
  t.after(async () => {
    try { await worker.stop(); }
    finally {
      await new Promise<void>((resolve, reject) => { upstream.close(error => error ? reject(error) : resolve()); upstream.closeIdleConnections(); });
      if (previousPrivate === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM; else process.env.ALLOW_PRIVATE_UPSTREAM = previousPrivate;
    }
  });
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await delay(10);
    assert.ok(predicate(), `worker did not reach a durable terminal state: ${JSON.stringify(state.runs)}`);
  };
  return { worker, state, waitFor, durable: () => durable };
}

for (const [name, failingSave] of [['initial', 1], ['final', 2]] as const) {
  test(`a transient ${name} run save failure records an error and continues queued work`, async t => {
    // A failed boundary write must not leave an uncancellable active run or abandon queued work.
    const { worker, state, waitFor, durable } = await fixture(t, [failingSave]);
    const first = worker.enqueue(state.sources[0]);
    const second = worker.enqueue(state.sources[1]);
    await waitFor(() => Boolean(durable()?.runs.find(run => run.id === second.id && run.status === 'success')));
    assert.equal(first.status, 'error');
    assert.ok(first.finishedAt);
    assert.match(first.message, /fixture storage unavailable/);
    assert.ok(first.errors.some(message => message.includes('fixture storage unavailable')));
    assert.equal(durable()!.runs.find(run => run.id === first.id)!.status, 'error');
    assert.equal(state.sources[0].lastError, first.message);

    const retry = worker.enqueue(state.sources[0]);
    assert.notEqual(retry.id, first.id);
    await worker.cancel(retry.id);
    await waitFor(() => Boolean(durable()?.runs.find(run => run.id === retry.id && run.status === 'interrupted')));
    assert.equal(retry.status, 'interrupted');
    assert.ok(retry.finishedAt);
  });
}

test('repeated terminal save failures explicitly interrupt queued work and persist its reason', async t => {
  // Exhausting the terminal-write retry must not leave queued runs with no consumer.
  const { worker, state, waitFor, durable } = await fixture(t, [2, 3]);
  const first = worker.enqueue(state.sources[0]);
  const second = worker.enqueue(state.sources[1]);
  await waitFor(() => Boolean(durable()?.runs.find(run => run.id === second.id && run.status === 'interrupted')));
  assert.equal(first.status, 'error');
  assert.equal(durable()!.runs.find(run => run.id === first.id)!.status, 'error');
  assert.ok(second.finishedAt);
  assert.match(second.message, /保存|写入|存储/);
  assert.ok(second.errors.some(message => message.includes('fixture storage unavailable')));
  assert.equal(state.runs.some(run => run.status === 'queued' || run.status === 'running'), false);
});

test('a retry enqueued while the storage error is being saved is processed after recovery', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let savingErrorState = false;
  t.after(() => release());
  const { worker, state, waitFor, durable } = await fixture(t, [2, 3], async attempt => {
    if (attempt === 4) { savingErrorState = true; await gate; }
  });
  worker.enqueue(state.sources[0]);
  const second = worker.enqueue(state.sources[1]);
  await waitFor(() => savingErrorState);
  const retry = worker.enqueue(state.sources[1]);
  assert.notEqual(retry.id, second.id);
  release();
  await waitFor(() => Boolean(durable()?.runs.find(run => run.id === retry.id && run.status === 'success')));
});
