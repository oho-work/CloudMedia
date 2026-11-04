import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { defaultSettings } from '../server/defaults.js';
import * as posters from '../server/posters.js';
import type { PosterBinary, PosterStorage } from '../server/poster-storage.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==', 'base64');
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
// AOMediaCodec/libavif tests/data/white_1x1.avif (305 bytes).
const avif = Buffer.from('AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUEAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAABcAAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgSAAAAAAABNjb2xybmNseAABAA0ABoAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAAB9tZGF0EgAKBzgABhAQ0GkyCh/wP///xAAAr3A=', 'base64');
// AOMediaCodec/libavif tests/data/draw_points_idat.avif uses image data inside meta/idat.
const avifIdat = Buffer.from('AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUEAAAHSbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAADBpbG9jAQAAAEQAAAIAAQABAAAAAQAAABYAAAAqAAIAAQAAAAEAAAAAAAAAFgAAAEJpaW5mAAAAAAACAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAAAaaW5mZQIAAAAAAgAAYXYwMUFscGhhAAAAABppcmVmAAAAAAAAAA5hdXhsAAIAAQABAAAAw2lwcnAAAACdaXBjbwAAABRpc3BlAAAAAAAAACEAAAALAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgSAAAAAAABNjb2xybmNseAABAAQABoAAAAAOcGl4aQAAAAABCAAAAAxhdjFDgQAcAAAAADhhdXhDAAAAAHVybjptcGVnOm1wZWdCOmNpY3A6c3lzdGVtczphdXhpbGlhcnk6YWxwaGEAAAAAHmlwbWEAAAAAAAAAAgABBAECgwQAAgQBBYYHAAAASGlkYXQSAAoFGBTgphUyC0QAAMtWaAlT4lEgEgAKCDgU4KYQEEBpMhxEAAD1S9r83rfmZ1SErhkkwMhtvIoeVOK2dwyA', 'base64');
const emptyFormats = [
  { name: 'JPEG', extension: 'jpg', mime: 'image/jpeg', bytes: Buffer.from('ffd8ffd9', 'hex') },
  { name: 'GIF', extension: 'gif', mime: 'image/gif', bytes: Buffer.from('474946383961010001000000003b', 'hex') },
  { name: 'WebP', extension: 'webp', mime: 'image/webp', bytes: Buffer.from('524946460c000000574542505650382000000000', 'hex') },
  { name: 'AVIF', extension: 'avif', mime: 'image/avif', bytes: Buffer.from('00000010667479706176696600000000', 'hex') },
];
const sha = createHash('sha256').update(png).digest('hex');
const maxBytes = 4 * 1024 * 1024;
let directory = '';
let origin = '';
let server: Server;
let oldDirectory: string | undefined;
let oldPrivate: string | undefined;
let slowStarted: (() => void) | undefined;
const settings = { ...defaultSettings, userAgent: 'PosterArchiveTest/1.0' };

before(async () => {
  oldDirectory = process.env.POSTER_DIR;
  oldPrivate = process.env.ALLOW_PRIVATE_UPSTREAM;
  directory = await mkdtemp(path.join(os.tmpdir(), 'cloudmedia-posters-'));
  process.env.POSTER_DIR = directory;
  process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  server = createServer((request, response) => {
    const empty = emptyFormats.find(format => request.url === `/empty-${format.extension}`);
    if (empty) { response.writeHead(200, { 'content-type': empty.mime }); response.end(empty.bytes); return; }
    switch (request.url) {
      case '/png':
      case '/same-bytes':
        if (request.headers['user-agent'] !== settings.userAgent || request.headers.referer !== 'https://source.example/movie') {
          response.writeHead(403); response.end(); return;
        }
        response.writeHead(200, { 'content-type': 'image/png' }); response.end(png); return;
      case '/gif': response.writeHead(200, { 'content-type': 'image/gif' }); response.end(gif); return;
      case '/jpeg': response.writeHead(200, { 'content-type': 'image/jpeg' }); response.end(jpeg); return;
      case '/webp': response.writeHead(200, { 'content-type': 'image/webp' }); response.end(webp); return;
      case '/avif': response.writeHead(200, { 'content-type': 'image/avif' }); response.end(avif); return;
      case '/avif-idat': response.writeHead(200, { 'content-type': 'image/avif' }); response.end(avifIdat); return;
      case '/html-as-png': response.writeHead(200, { 'content-type': 'image/png' }); response.end('<html>login required</html>'); return;
      case '/wrong-mime': response.writeHead(200, { 'content-type': 'text/html' }); response.end(png); return;
      case '/empty': response.writeHead(200, { 'content-type': 'image/png' }); response.end(); return;
      case '/truncated': response.writeHead(200, { 'content-type': 'image/png' }); response.end(png.subarray(0, 8)); return;
      case '/oversize-header': response.writeHead(200, { 'content-type': 'image/png', 'content-length': maxBytes + 1 }); response.end(); return;
      case '/oversize-stream': response.writeHead(200, { 'content-type': 'image/png' }); response.write(png); response.end(Buffer.alloc(maxBytes)); return;
      case '/slow': response.writeHead(200, { 'content-type': 'image/png' }); response.write(png.subarray(0, 8)); slowStarted?.(); return;
      default: response.writeHead(404); response.end('missing');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  for (const filename of await readdir(directory)) await rm(path.join(directory, filename), { force: true });
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
  if (oldDirectory === undefined) delete process.env.POSTER_DIR; else process.env.POSTER_DIR = oldDirectory;
  if (oldPrivate === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM; else process.env.ALLOW_PRIVATE_UPSTREAM = oldPrivate;
});

const referer = 'https://source.example/movie';

test('cachePoster rejects an HTML body disguised as an image instead of exposing the upstream URL', async () => {
  await assert.rejects(posters.cachePoster(origin + '/html-as-png', referer, settings));
  assert.deepEqual(await readdir(directory), []);
});

test('archivePoster saves bytes under their content digest and inspectPoster reads them after upstream disappears', async () => {
  const standalone = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'image/png' }); response.end(png); });
  await new Promise<void>(resolve => standalone.listen(0, '127.0.0.1', resolve));
  let archived: Awaited<ReturnType<typeof posters.archivePoster>>;
  try { archived = await posters.archivePoster(`http://127.0.0.1:${(standalone.address() as AddressInfo).port}/image`, referer, settings); }
  finally { await new Promise<void>((resolve, reject) => standalone.close(error => error ? reject(error) : resolve())); }
  assert.equal(archived.path, `/media/posters/${sha}.png`);
  assert.equal(archived.sha256, sha);
  assert.equal(archived.mime, 'image/png');
  assert.equal(archived.bytes, png.length);
  assert.ok(Number.isFinite(Date.parse(archived.downloadedAt)));
  assert.deepEqual(await readFile(path.join(directory, `${sha}.png`)), png);
  assert.deepEqual(await posters.inspectPoster(archived.path), archived);
});

test('different upstream URLs with identical bytes share one permanent file', async () => {
  const first = await posters.archivePoster(origin + '/png', referer, settings);
  const second = await posters.archivePoster(origin + '/same-bytes', referer, settings);
  assert.equal(first.path, second.path);
  assert.equal(await posters.cachePoster(first.path, referer, settings), first.path);
  assert.deepEqual(await readdir(directory), [`${sha}.png`]);
});

test('GIF bytes retain the detected file format', async () => {
  const result = await posters.archivePoster(origin + '/gif', referer, settings);
  assert.equal(result.mime, 'image/gif');
  assert.match(result.path, /^\/media\/posters\/[a-f0-9]{64}\.gif$/);
  assert.deepEqual(await readFile(path.join(directory, path.basename(result.path))), gif);
});

for (const format of emptyFormats) {
  test(`${format.name} signature without a complete image structure is rejected during download`, async () => {
    await assert.rejects(posters.archivePoster(origin + `/empty-${format.extension}`, referer, settings));
    assert.deepEqual(await readdir(directory), []);
  });
  test(`${format.name} signature without a complete image structure is rejected during local inspection`, async () => {
    const filename = `${'0'.repeat(64)}.${format.extension}`;
    await writeFile(path.join(directory, filename), format.bytes);
    assert.equal(await posters.inspectPoster(`/media/posters/${filename}`), null);
  });
}

for (const format of [{ route: '/jpeg', mime: 'image/jpeg', extension: 'jpg', bytes: jpeg }, { route: '/webp', mime: 'image/webp', extension: 'webp', bytes: webp }, { route: '/avif', mime: 'image/avif', extension: 'avif', bytes: avif }]) {
  test(`complete ${format.extension} images remain archivable`, async () => {
    const archived = await posters.archivePoster(origin + format.route, referer, settings);
    assert.equal(archived.mime, format.mime);
    assert.ok(archived.path.endsWith(`.${format.extension}`));
    assert.deepEqual(await readFile(path.join(directory, path.basename(archived.path))), format.bytes);
    assert.deepEqual(await posters.inspectPoster(archived.path), archived);
  });
}

test('AVIF with valid metadata and embedded idat image data remains archivable', async () => {
  const archived = await posters.archivePoster(origin + '/avif-idat', referer, settings);
  assert.equal(archived.mime, 'image/avif');
  assert.deepEqual(await readFile(path.join(directory, path.basename(archived.path))), avifIdat);
});

for (const route of ['/wrong-mime', '/empty', '/truncated', '/oversize-header', '/oversize-stream', '/missing']) {
  test(`archivePoster rejects ${route} without saving a partial or fallback file`, async () => {
    await assert.rejects(posters.archivePoster(origin + route, referer, settings));
    assert.deepEqual(await readdir(directory), []);
  });
}

test('inspectPoster refuses unsafe paths and missing or corrupt local files', async () => {
  for (const value of ['', '/media/posters/../../secret', `https://upstream.example/${sha}.png`, `/media/posters/${sha}.png?x=1`, `/media/posters/${sha.toUpperCase()}.png`, `/media/posters/${sha}.png`]) {
    assert.equal(await posters.inspectPoster(value), null);
  }
  await writeFile(path.join(directory, `${sha}.png`), '<html>not an image</html>');
  assert.equal(await posters.inspectPoster(`/media/posters/${sha}.png`), null);
  await writeFile(path.join(directory, `${sha}.png`), png.subarray(0, 8));
  assert.equal(await posters.inspectPoster(`/media/posters/${sha}.png`), null);
  await writeFile(path.join(directory, `${sha}.png`), Buffer.alloc(maxBytes + 1));
  assert.equal(await posters.inspectPoster(`/media/posters/${sha}.png`), null);
});

test('inspectPoster accepts legacy URL-hashed names and reports the actual content digest', async () => {
  const oldName = '0'.repeat(64);
  await writeFile(path.join(directory, `${oldName}.png`), png);
  const result = await posters.inspectPoster(`/media/posters/${oldName}.png`);
  assert.equal(result?.path, `/media/posters/${oldName}.png`);
  assert.equal(result?.sha256, sha);
  assert.equal(result?.bytes, png.length);
});

test('cancelling an active download rejects without leaving a partial file', async () => {
  const controller = new AbortController();
  const started = new Promise<void>(resolve => { slowStarted = resolve; });
  const download = posters.archivePoster(origin + '/slow', referer, settings, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(download, /取消|abort/i);
  slowStarted = undefined;
  assert.deepEqual(await readdir(directory), []);
});

test('a pre-cancelled download never creates a file', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(posters.archivePoster(origin + '/png', referer, settings, controller.signal));
  assert.deepEqual(await readdir(directory), []);
});

function memoryPosters() {
  const objects = new Map<string, PosterBinary>();
  let writes = 0;
  const storage: PosterStorage = {
    async get(key) { return objects.get(key) || null; },
    async put(value) { writes++; objects.set(value.path, { ...value, data: Buffer.from(value.data) }); },
  };
  return { storage, objects, get writes() { return writes; } };
}

test('database poster storage keeps bytes and subsequent inspection in memory without creating a filesystem cache', async () => {
  const database = memoryPosters();
  const unusedDirectory = path.join(directory, 'must-not-be-created');
  const previousDirectory = process.env.POSTER_DIR; process.env.POSTER_DIR = unusedDirectory;
  try {
    const saved = await posters.archivePoster(origin + '/png', referer, settings, undefined, undefined, database.storage);
    assert.deepEqual(database.objects.get(saved.path)?.data, png);
    assert.deepEqual(await posters.inspectPoster(saved.path, database.storage), saved);
    assert.equal(await posters.cachePoster(saved.path, referer, settings, database.storage), saved.path);
    await assert.rejects(readdir(unusedDirectory), { code: 'ENOENT' });
  } finally { process.env.POSTER_DIR = previousDirectory; }
});

test('database inspection remains usable after upstream closes and identical content is not rewritten', async () => {
  const database = memoryPosters();
  const standalone = createServer((_req, response) => { response.setHeader('content-type', 'image/png'); response.end(png); });
  await new Promise<void>(resolve => standalone.listen(0, '127.0.0.1', resolve));
  let saved: posters.PosterFile;
  try { saved = await posters.archivePoster(`http://127.0.0.1:${(standalone.address() as AddressInfo).port}/image`, referer, settings, undefined, undefined, database.storage); }
  finally { await new Promise<void>(resolve => standalone.close(() => resolve())); }
  const duplicate = await posters.archivePoster(origin + '/same-bytes', referer, settings, undefined, undefined, database.storage);
  assert.deepEqual(duplicate, saved);
  assert.equal(database.writes, 1);
  assert.deepEqual(await posters.inspectPoster(saved.path, database.storage), saved);
  assert.deepEqual(await readdir(directory), []);
});

test('database failures propagate without writing a local fallback or reusing a local cached file', async () => {
  await writeFile(path.join(directory, `${sha}.png`), png);
  const failedRead: PosterStorage = { async get() { throw new Error('database unavailable'); }, async put() { throw new Error('unexpected write'); } };
  await assert.rejects(posters.inspectPoster(`/media/posters/${sha}.png`, failedRead), /database unavailable/);
  const failedWrite: PosterStorage = { async get() { return null; }, async put() { throw new Error('database unavailable'); } };
  await assert.rejects(posters.archivePoster(origin + '/gif', referer, settings, undefined, undefined, failedWrite), /database unavailable/);
  assert.deepEqual(await readdir(directory), [`${sha}.png`]);
});

test('database inspection rejects corrupt or mismatched image metadata and keeps legacy names readable', async () => {
  const database = memoryPosters();
  const saved = await posters.archivePoster(origin + '/png', referer, settings, undefined, undefined, database.storage);
  const stored = database.objects.get(saved.path)!;
  for (const patch of [{ data: Buffer.from('not an image') }, { sha256: '0'.repeat(64) }, { mime: 'image/gif' }, { downloadedAt: 'invalid' }]) {
    database.objects.set(saved.path, { ...stored, ...patch });
    assert.equal(await posters.inspectPoster(saved.path, database.storage), null);
  }
  const legacyPath = `/media/posters/${'0'.repeat(64)}.png`;
  database.objects.set(legacyPath, { ...stored, path: legacyPath });
  assert.equal((await posters.inspectPoster(legacyPath, database.storage))?.sha256, sha);
  assert.equal(await posters.inspectPoster('/media/posters/../../secret', database.storage), null);
  assert.deepEqual(await readdir(directory), []);
});
