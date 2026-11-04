import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { sourceDefaults } from '../server/defaults.js';
import { upsertMovie } from '../server/catalog.js';
import { Store } from '../server/store.js';
import { Worker } from '../server/worker.js';

test('catalogue pagination rejects non-integer and non-finite queries without losing page boundaries', async t => {
  const previous = { DATABASE_URL: process.env.DATABASE_URL, DATA_FILE: process.env.DATA_FILE, APP_AUTH_TOKEN: process.env.APP_AUTH_TOKEN };
  const folder = await mkdtemp(path.join(tmpdir(), 'cloudmedia-query-'));
  delete process.env.DATABASE_URL; delete process.env.APP_AUTH_TOKEN; process.env.DATA_FILE = path.join(folder, 'catalog.json');
  const store = new Store(); await store.init();
  const source = sourceDefaults({ baseUrl: 'https://catalog.example' });
  for (let index = 1; index <= 3; index++) upsertMovie(store.state, source, { externalId: String(index), pageUrl: '/', title: String(index), resources: [] });
  const worker = new Worker(store, { now: () => new Date() }); const server = createApp(store, worker).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/movies`;
  t.after(async () => {
    await worker.stop(); await store.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(folder, { recursive: true, force: true });
  });
  for (const query of ['page=1.5', 'page=Infinity', 'page=NaN', 'page=9007199254740992', 'page=1&page=2', 'limit=2.5', 'limit=Infinity', 'page=0', 'limit=-1']) {
    const response = await fetch(base + '?' + query);
    assert.equal(response.status, 400, query); assert.ok((await response.json()).error);
  }
  const first = await fetch(base + '?page=1&limit=2').then(response => response.json());
  const second = await fetch(base + '?page=2&limit=2').then(response => response.json());
  assert.equal(first.items.length, 2); assert.equal(second.items.length, 1);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 3);
  assert.equal((await fetch(base).then(response => response.json())).limit, 24);
  assert.equal((await fetch(base + '?limit=500').then(response => response.json())).limit, 100);
});
