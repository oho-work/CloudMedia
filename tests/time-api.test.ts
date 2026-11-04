import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from '../server/app.js';
import type { AppClock } from '../server/clock.js';
import { initialState } from '../server/defaults.js';
import type { Store } from '../server/store.js';
import type { Worker } from '../server/worker.js';
import type { Settings } from '../shared/types.js';

test('time API exposes trusted Beijing time and schedule updates retain legacy API compatibility', async t => {
  const previousAuth = process.env.APP_AUTH_TOKEN;
  delete process.env.APP_AUTH_TOKEN;
  const state = initialState();
  let saved: Settings | undefined;
  const store = { state, healthy: true, mode: 'file', async save() { saved = structuredClone(state.settings); } } as unknown as Store;
  const instant = '2026-11-04T04:00:00.000Z';
  let synchronized = true;
  const clock: AppClock = {
    now: () => synchronized ? new Date(instant) : null,
    status: () => ({ now: synchronized ? instant : null, timezone: 'Asia/Shanghai', synchronized,
      lastSyncedAt: synchronized ? instant : null, source: synchronized ? 'fixture.ntp' : null, error: synchronized ? null : '尚未完成网络校时' }),
  };
  const server = createApp(store, {} as Worker, clock).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
    if (previousAuth === undefined) delete process.env.APP_AUTH_TOKEN; else process.env.APP_AUTH_TOKEN = previousAuth;
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (pathname: string) => fetch(origin + pathname).then(response => response.json());
  const put = async (settings: Partial<Settings>) => {
    const response = await fetch(origin + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) });
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(await get('/api/time'), clock.status());
  const legacy = await put({ dailyTime: '05:15', timezone: 'UTC' });
  assert.equal(legacy.status, 200); assert.deepEqual(legacy.body.dailyTimes, ['05:15']);
  assert.equal(legacy.body.timezone, 'Asia/Shanghai'); assert.deepEqual(saved?.dailyTimes, ['05:15']);
  const multiple = await put({ dailyTimes: ['20:30', '07:00', '20:30'] });
  assert.equal(multiple.status, 200); assert.deepEqual(multiple.body.dailyTimes, ['07:00', '20:30']);
  assert.equal(multiple.body.dailyTime, '07:00');
  assert.deepEqual(saved?.dailyTimes, ['07:00', '20:30']);
  assert.equal((await get('/api/dashboard')).schedulerNextAt, '2026-11-04T12:30:00.000Z');
  const before = structuredClone(state.settings);
  for (const invalid of [{ dailyTimes: [] }, { dailyTime: '25:00' }, { dailyTimes: ['01:00', 'invalid'] }]) {
    const result = await put(invalid);
    assert.equal(result.status, 400); assert.deepEqual(state.settings, before);
  }
  synchronized = false;
  assert.deepEqual(await get('/api/time'), clock.status());
  assert.equal((await get('/api/dashboard')).schedulerNextAt, null, 'unsynchronized services must not forecast from the OS clock');
});
