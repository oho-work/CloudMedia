import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import express from 'express';
import { playbackRouter } from '../server/playback.js';
import { Store } from '../server/store.js';
import { emptyProbe } from '../server/defaults.js';

let origin = '', proxyOrigin = '', proxyServer: Server;
let previousPrivate: string | undefined;
const requests: { path: string; referer?: string; range?: string }[] = [];
let slowClosed: Promise<void> | undefined;
const store = new Store();
const upstream = createServer((request, response) => {
  const path = new URL(request.url!, 'http://localhost').pathname;
  requests.push({ path, referer: request.headers.referer, range: request.headers.range });
  if (path === '/catalog/master') {
    response.setHeader('Content-Type', 'text/plain');
    response.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="/audio/list"\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,AUDIO="audio"\n../hls/high?token=abc\n');
  } else if (path === '/hls/high') {
    // An extensionless manifest, deliberately lacking a useful content type.
    response.setHeader('Content-Type', 'application/octet-stream');
    response.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../key?token=a,b"\n#EXT-X-MAP:URI="/init.mp4"\n#EXTINF:10,\nsegment.ts?token=abc\n#EXT-X-ENDLIST\n');
  } else if (path === '/audio/list') {
    response.end('#EXTM3U\n#EXTINF:10,\n/audio/chunk.aac\n#EXT-X-ENDLIST\n');
  } else if (path === '/slow/list') {
    response.end('#EXTM3U\n#EXTINF:10,\nsegment.ts\n#EXT-X-ENDLIST\n');
  } else if (path === '/slow/segment.ts') {
    response.setHeader('Content-Type', 'video/mp2t');
    const timer = setInterval(() => response.write(Buffer.alloc(1024, 0x47)), 10);
    slowClosed = new Promise(resolve => response.on('close', () => { clearInterval(timer); resolve(); }));
  } else if (path === '/hls/segment.ts') {
    if (request.headers.range === 'bytes=2-5') {
      response.writeHead(206, { 'Content-Type': 'video/mp2t', 'Content-Range': 'bytes 2-5/10', 'Content-Length': 4, 'Accept-Ranges': 'bytes' });
      response.end(Buffer.from([2, 3, 4, 5]));
    } else { response.setHeader('Content-Type', 'video/mp2t'); response.end(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])); }
  } else if (path === '/key') {
    response.setHeader('Content-Type', 'application/octet-stream'); response.end(Buffer.alloc(16, 0x2a));
  } else if (path === '/init.mp4') {
    response.setHeader('Content-Type', 'video/mp4'); response.end(Buffer.from('initialization bytes'));
  } else { response.writeHead(404); response.end('not found'); }
});

before(async () => {
  previousPrivate = process.env.ALLOW_PRIVATE_UPSTREAM;
  process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  store.state.resources.push({ id: 'resource', movieId: 'movie', sourceId: 'source', name: '线路', episode: '正片',
    url: `${origin}/catalog/master`, referer: `${origin}/movie/123`, probe: emptyProbe(), createdAt: '', updatedAt: '' });
  store.state.resources.push({ ...store.state.resources[0], id: 'slow', url: `${origin}/slow/list` });
  const app = express(); app.use('/api/play', playbackRouter(store));
  app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(500).json({ error: error.message }));
  await new Promise<void>(resolve => { proxyServer = app.listen(0, '127.0.0.1', resolve); });
  proxyOrigin = `http://127.0.0.1:${(proxyServer.address() as AddressInfo).port}`;
});

after(async () => {
  await Promise.all([new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve())),
    new Promise<void>((resolve, reject) => proxyServer.close(error => error ? reject(error) : resolve()))]);
  if (previousPrivate === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM;
  else process.env.ALLOW_PRIVATE_UPSTREAM = previousPrivate;
});

async function masterUrl(): Promise<string> {
  const response = await fetch(`${proxyOrigin}/api/play/resource/index.m3u8`);
  assert.equal(response.status, 200);
  const text = await response.text();
  return text.split('\n').find(line => line.startsWith('/api/play/'))!;
}

test('playback proxy rewrites master and extensionless child manifests with signed relative URLs', async () => {
  const response = await fetch(`${proxyOrigin}/api/play/resource/index.m3u8`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /mpegurl/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const text = await response.text();
  const audioUrl = text.match(/#EXT-X-MEDIA:[^\n]*URI="([^"]+)"/)?.[1];
  assert.ok(audioUrl); assert.ok(audioUrl.startsWith('/api/play/resource/asset?'));
  const audio = await fetch(proxyOrigin + audioUrl);
  assert.equal(audio.status, 200); assert.match(await audio.text(), /url=http%3A/);
  const childUrl = text.split('\n').find(line => line.startsWith('/api/play/'))!;
  const child = await fetch(proxyOrigin + childUrl);
  assert.equal(child.status, 200); assert.match(child.headers.get('content-type')!, /mpegurl/);
  const childText = await child.text();
  assert.match(childText, /#EXT-X-KEY:METHOD=AES-128,URI="\/api\/play\/resource\/asset\?/);
  assert.match(childText, /#EXT-X-MAP:URI="\/api\/play\/resource\/asset\?/);
  assert.ok(!childText.includes(origin));
  const keyUrl = childText.match(/#EXT-X-KEY:[^\n]*URI="([^"]+)"/)?.[1];
  const key = await fetch(proxyOrigin + keyUrl);
  assert.deepEqual(Buffer.from(await key.arrayBuffer()), Buffer.alloc(16, 0x2a));
  const initUrl = childText.match(/#EXT-X-MAP:[^\n]*URI="([^"]+)"/)?.[1];
  const init = await fetch(proxyOrigin + initUrl);
  assert.equal(await init.text(), 'initialization bytes');
});

test('playback proxy preserves binary bytes and forwards single ranges and referer', async () => {
  const child = await fetch(proxyOrigin + await masterUrl());
  const childText = await child.text();
  const segmentUrl = childText.split('\n').find(line => line.startsWith('/api/play/'))!;
  const partial = await fetch(proxyOrigin + segmentUrl, { headers: { Range: 'bytes=2-5' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(partial.headers.get('content-length'), '4');
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), Buffer.from([2, 3, 4, 5]));
  const observed = requests.filter(item => item.path === '/hls/segment.ts').at(-1)!;
  assert.equal(observed.range, 'bytes=2-5'); assert.equal(observed.referer, `${origin}/movie/123`);
  const full = await fetch(proxyOrigin + segmentUrl);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
});

test('unsigned, tampered, expired, and wrong-resource proxy URLs are refused before upstream fetch', async () => {
  const signed = new URL(await masterUrl(), proxyOrigin);
  const originalRequestCount = requests.length;
  const missing = new URL(signed); missing.searchParams.delete('sig');
  assert.equal((await fetch(missing)).status, 403);
  const tampered = new URL(signed); tampered.searchParams.set('url', `${origin}/key`);
  assert.equal((await fetch(tampered)).status, 403);
  const expired = new URL(signed); expired.searchParams.set('expires', '1');
  assert.equal((await fetch(expired)).status, 403);
  const changedSignature = new URL(signed); changedSignature.searchParams.set('sig', 'a'.repeat(64));
  assert.equal((await fetch(changedSignature)).status, 403);
  const wrongResource = new URL(signed); wrongResource.pathname = '/api/play/other/asset';
  assert.equal((await fetch(wrongResource)).status, 404);
  assert.equal(requests.length, originalRequestCount);
});

test('proxy rejects malformed ranges and unsupported paths', async () => {
  const signed = await masterUrl();
  assert.equal((await fetch(proxyOrigin + signed, { headers: { Range: 'bytes=-' } })).status, 416);
  assert.equal((await fetch(proxyOrigin + signed, { headers: { Range: 'bytes=5-2' } })).status, 416);
  assert.equal((await fetch(proxyOrigin + signed, { headers: { Range: 'bytes=0-1,4-5' } })).status, 416);
  assert.equal((await fetch(`${proxyOrigin}/api/play/resource/arbitrary`)).status, 404);
});

test('closing the player cancels the active upstream segment transfer', async () => {
  const list = await fetch(`${proxyOrigin}/api/play/slow/index.m3u8`);
  const segmentUrl = (await list.text()).split('\n').find(line => line.startsWith('/api/play/'))!;
  const controller = new AbortController();
  const segment = await fetch(proxyOrigin + segmentUrl, { signal: controller.signal });
  const reader = segment.body!.getReader();
  assert.ok((await reader.read()).value!.byteLength > 0);
  controller.abort();
  await reader.cancel().catch(() => {}); reader.releaseLock();
  assert.ok(slowClosed);
  const result = await Promise.race([slowClosed.then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('timeout'), 500))]);
  assert.equal(result, 'closed');
});
