import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { initialState } from '../server/defaults.js';
import type { PosterBinary } from '../server/poster-storage.js';
import type { Store } from '../server/store.js';
import type { Worker } from '../server/worker.js';

test('PostgreSQL poster routes serve binary data with caching and never read the local archive', async t => {
  const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=', 'base64');
  const sha256 = createHash('sha256').update(data).digest('hex');
  const poster: PosterBinary = { path: `/media/posters/${sha256}.png`, sha256, mime: 'image/png', data, downloadedAt: new Date().toISOString() };
  const lookups: string[] = [];
  let unavailable = false;
  const store = {
    mode: 'postgres', healthy: true, state: initialState(),
    posterStorage: { async get(key: string) { lookups.push(key); if (unavailable) throw new Error('Poster database unavailable'); return key === poster.path ? poster : null; } },
  } as unknown as Store;
  const server = createApp(store, {} as Worker).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); }); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const image = await fetch(origin + poster.path);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('content-length'), String(data.length));
  assert.equal(image.headers.get('cache-control'), 'public, max-age=2592000, immutable');
  assert.equal(image.headers.get('etag'), `"${sha256}"`);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), data);
  // Node fetch defaults conditional requests to no-cache; use a normal HTTP
  // validation request to check the browser-cache response independently.
  const cached = await new Promise<{ status: number; bytes: number }>((resolve, reject) => {
    get(origin + poster.path, { headers: { 'if-none-match': `"${sha256}"` } }, response => {
      let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; });
      response.on('end', () => resolve({ status: response.statusCode!, bytes }));
    }).on('error', reject);
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.bytes, 0);
  const head = await fetch(origin + poster.path, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(data.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const beforeInvalid = lookups.length;
  for (const invalid of ['/media/posters/example.png', '/media/posters/' + 'a'.repeat(64) + '.svg', '/media/posters/' + 'a'.repeat(64) + '.png%2Fsecret']) {
    assert.equal((await fetch(origin + invalid)).status, 404);
  }
  assert.equal(lookups.length, beforeInvalid, 'invalid paths must never reach storage');
  assert.equal((await fetch(origin + '/media/posters/' + 'b'.repeat(64) + '.png')).status, 404);
  unavailable = true;
  assert.equal((await fetch(origin + poster.path)).status, 500, 'database errors must not fall back to filesystem or remote images');
});
