import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { sourceDefaults } from '../server/defaults.js';
import { Store } from '../server/store.js';
import { Worker } from '../server/worker.js';
import type { Source } from '../shared/types.js';

test('source concurrency survives API updates and restart while invalid values leave storage unchanged', async t => {
  const previous = { DATABASE_URL: process.env.DATABASE_URL, DATA_FILE: process.env.DATA_FILE, APP_AUTH_TOKEN: process.env.APP_AUTH_TOKEN };
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudmedia-concurrency-'));
  delete process.env.DATABASE_URL; delete process.env.APP_AUTH_TOKEN;
  process.env.DATA_FILE = path.join(directory, 'catalog.json');
  const store = new Store(); const worker = new Worker(store, { now: () => new Date() });
  const server = createServer(createApp(store, worker));
  t.after(async () => {
    try {
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
      await worker.stop(); await store.close();
    } finally {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(directory, { recursive: true, force: true });
    }
  });
  await store.init();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (pathname: string, method: string, body?: unknown) => fetch(origin + pathname, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const created = await request('/api/sources', 'POST', sourceDefaults({ name: 'Fixture', baseUrl: 'https://example.invalid', concurrency: 3, requestIntervalMs: 0 }));
  assert.equal(created.status, 201); const source = await created.json() as Source;
  assert.equal(source.concurrency, 3);
  for (const concurrency of [0, 101, 1.5, '5', null]) {
    const invalid = await request(`/api/sources/${source.id}`, 'PUT', { concurrency });
    assert.equal(invalid.status, 400); await invalid.json();
    assert.equal(store.state.sources.find(item => item.id === source.id)?.concurrency, 3);
  }
  const updated = await request(`/api/sources/${source.id}`, 'PUT', { concurrency: 100 });
  assert.equal(updated.status, 200); assert.equal((await updated.json()).concurrency, 100);
  const disk = JSON.parse(await readFile(process.env.DATA_FILE!, 'utf8'));
  assert.equal(disk.sources.find((item: Source) => item.id === source.id).concurrency, 100);
  await store.close();
  const reloaded = new Store();
  try {
    await reloaded.init();
    assert.equal(reloaded.state.sources.find(item => item.id === source.id)?.concurrency, 100);
    assert.equal(reloaded.state.sources.find(item => item.id === source.id)?.requestIntervalMs, 0);
  } finally { await reloaded.close(); }
});
