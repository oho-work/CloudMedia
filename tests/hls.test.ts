import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Resource } from '../shared/types.js';
import { defaultSettings, emptyProbe } from '../server/defaults.js';
import { dimensionsFromMedia, parseAttributes, parsePlaylist, probeResource, rewritePlaylist } from '../server/hls.js';

const ranges: { path: string; range: string | undefined }[] = [];
let origin = '';
let previousPrivate: string | undefined;
const server = createServer((request, response) => {
  const path = new URL(request.url!, 'http://localhost').pathname;
  if (path === '/master.m3u8') {
    response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"\nhigh/list.m3u8?token=secret\n');
  } else if (path === '/high/list.m3u8' || path === '/low.m3u8') {
    response.end('#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\n' + origin + '/segment.ts?token=abc\n#EXTINF:10,\n' + origin + '/segment2.ts\n#EXT-X-ENDLIST\n');
  } else if (path === '/single.m3u8') {
    response.end('#EXTM3U\n#EXTINF:10,\nsegment.ts\n#EXT-X-ENDLIST\n');
  } else if (path === '/loop.m3u8') {
    response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nloop.m3u8\n');
  } else if (path === '/bad.m3u8') {
    response.setHeader('Content-Type', 'text/html'); response.end('<html>not a manifest</html>');
  } else if (path === '/forbidden.m3u8') {
    response.writeHead(403); response.end('Denied');
  } else if (path === '/init.mp4') {
    response.setHeader('Content-Type', 'video/mp4'); response.end(makeMp4(1280, 720));
  } else if (path === '/fmp4.m3u8') {
    response.end('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:10,\nsegment.ts\n#EXT-X-ENDLIST\n');
  } else if (path === '/stall.m3u8') {
    response.end('#EXTM3U\n#EXTINF:10,\nstall.ts\n#EXT-X-ENDLIST\n');
  } else if (path === '/stall.ts') {
    response.setHeader('Content-Type', 'video/mp2t');
    response.write(Buffer.alloc(128, 0x47)); // Deliberately never complete this sample.
  } else if (path === '/segment.ts' || path === '/segment2.ts') {
    ranges.push({ path, range: request.headers.range });
    const match = request.headers.range?.match(/bytes=(\d+)-(\d+)/);
    const start = Number(match?.[1] ?? 0), end = Math.min(Number(match?.[2] ?? 8191), 8191);
    response.writeHead(206, { 'Content-Type': 'video/mp2t', 'Content-Range': `bytes ${start}-${end}/8192`, 'Content-Length': end - start + 1 });
    const body = Buffer.alloc(end - start + 1, 0xff);
    const half = Math.ceil(body.length / 2);
    response.write(body.subarray(0, half));
    setTimeout(() => response.end(body.subarray(half)), 20);
  } else { response.writeHead(404); response.end(); }
});

before(async () => {
  previousPrivate = process.env.ALLOW_PRIVATE_UPSTREAM;
  process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (previousPrivate === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM;
  else process.env.ALLOW_PRIVATE_UPSTREAM = previousPrivate;
});

function resource(path: string): Resource {
  return { id: 'resource', movieId: 'movie', sourceId: 'source', name: '线路1', episode: '正片',
    url: origin + path, referer: origin, probe: emptyProbe(), createdAt: '', updatedAt: '' };
}

function makeMp4(width: number, height: number): Buffer {
  const tkhd = Buffer.alloc(92);
  tkhd.writeUInt32BE(92, 0); tkhd.write('tkhd', 4);
  tkhd.writeUInt32BE(width * 65536, 84); tkhd.writeUInt32BE(height * 65536, 88);
  const moov = Buffer.alloc(100); moov.writeUInt32BE(100, 0); moov.write('moov', 4); tkhd.copy(moov, 8);
  return moov;
}

test('attributes preserve quoted commas and parse master variant metadata', () => {
  assert.equal(parseAttributes('BANDWIDTH=2500000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1280x720').CODECS, 'avc1.640028,mp4a.40.2');
  const parsed = parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720\n../720.m3u8?token=x\n', 'https://example.com/path/master.m3u8');
  assert.deepEqual(parsed.variants[0], { url: 'https://example.com/720.m3u8?token=x', width: 1280, height: 720, bandwidth: 2500000 });
});

test('byte-range segments track implicit offsets for the same object', () => {
  const parsed = parsePlaylist('#EXTM3U\n#EXT-X-BYTERANGE:2000@40\nfile.mp4\n#EXT-X-BYTERANGE:3000\nfile.mp4\n', 'https://example.com/index.m3u8');
  assert.deepEqual(parsed.segments.map(item => item.range), [{ length: 2000, offset: 40 }, { length: 3000, offset: 2040 }]);
});

test('playlist rewriting preserves tags and rewrites segments and all quoted URI attributes', () => {
  const original = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/index.m3u8?x=1,2",GROUP-ID="audio"\n#EXT-X-KEY:METHOD=AES-128,URI="/key.bin"\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="200@0"\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframe.m3u8"\nsegment.ts\n';
  const rewritten = rewritePlaylist(original, 'https://cdn.example.com/video/main.m3u8', url => `/proxy?u=${encodeURIComponent(url)}`);
  assert.match(rewritten, /TYPE=AUDIO,URI="\/proxy\?u=https%3A%2F%2Fcdn.example.com%2Fvideo%2Faudio%2Findex.m3u8%3Fx%3D1%2C2",GROUP-ID="audio"/);
  assert.match(rewritten, /URI="\/proxy\?u=https%3A%2F%2Fcdn.example.com%2Fkey.bin"/);
  assert.match(rewritten, /BYTERANGE="200@0"/);
  assert.match(rewritten, /iframe.m3u8/);
  assert.match(rewritten, /\/proxy\?u=https%3A%2F%2Fcdn.example.com%2Fvideo%2Fsegment.ts/);
});

test('probe follows chosen master variant, measures one bounded sample, and separates declared bandwidth', async () => {
  ranges.length = 0;
  const result = await probeResource(resource('/master.m3u8'), { ...defaultSettings, sampleBytes: 2048 });
  assert.equal(result.status, 'ok', result.error ?? '');
  assert.equal(result.width, 1920); assert.equal(result.height, 1080);
  assert.equal(result.bandwidth, 4000000); assert.equal(result.sampledSegments, 1);
  assert.equal(result.bytesRead, 2048); assert.ok(result.durationMs >= 15);
  assert.ok(result.speedMbps !== null && result.speedMbps > 0);
  assert.equal(ranges.length, 1); assert.equal(ranges[0].range, 'bytes=0-2047');
  assert.equal(result.playlistUrl, `${origin}/high/list.m3u8?token=secret`);
});

test('probe honors low quality and configurable multiple segment samples', async () => {
  ranges.length = 0;
  const result = await probeResource(resource('/master.m3u8'), { ...defaultSettings, preferredQuality: 'lowest', sampleSegments: 2, sampleBytes: 1024 });
  assert.equal(result.status, 'ok', result.error ?? '');
  assert.equal(result.width, 640); assert.equal(result.height, 360);
  assert.equal(result.bytesRead, 2048); assert.equal(result.sampledSegments, 2);
  assert.equal(ranges.length, 2);
});

test('unknown dimensions remain null instead of inventing resolution', async () => {
  const result = await probeResource(resource('/single.m3u8'), { ...defaultSettings, sampleBytes: 1024 });
  assert.equal(result.status, 'ok'); assert.equal(result.width, null); assert.equal(result.height, null);
});

test('reads dimensions from a bounded MP4 initialization segment when master has no resolution', async () => {
  const result = await probeResource(resource('/fmp4.m3u8'), { ...defaultSettings, sampleBytes: 1024 });
  assert.equal(result.status, 'ok', result.error ?? '');
  assert.equal(result.width, 1280); assert.equal(result.height, 720);
  assert.equal(result.sampledSegments, 1); assert.equal(result.bytesRead, 1024);
  assert.deepEqual(dimensionsFromMedia(makeMp4(1920, 1080)), { width: 1920, height: 1080 });
});

test('derives clear MPEG-TS video dimensions from H.264 SPS without decoding the video', () => {
  const packets = Buffer.alloc(376, 0xff);
  packets.set([0x47, 0x41, 0x00, 0x10], 0); // PID 256, video PES start.
  packets.set([0, 0, 1, 0xe0, 0, 0, 0x80, 0, 0], 4);
  // Baseline-profile SPS: 80 macroblocks wide, 45 high, progressive, no cropping.
  packets.set(Buffer.from('0000016742001ef402802dc8', 'hex'), 13);
  packets.set([0x47, 0x01, 0x00, 0x11], 188);
  assert.deepEqual(dimensionsFromMedia(packets), { width: 1280, height: 720 });
  assert.equal(dimensionsFromMedia(Buffer.alloc(100, 0xff)), null);
});

test('invalid content, forbidden responses, and cyclic manifests produce actionable failures', async () => {
  const bad = await probeResource(resource('/bad.m3u8'), defaultSettings);
  assert.equal(bad.status, 'error'); assert.match(bad.error!, /有效的 M3U8/);
  const forbidden = await probeResource(resource('/forbidden.m3u8'), defaultSettings);
  assert.equal(forbidden.status, 'error'); assert.match(forbidden.error!, /403/);
  const loop = await probeResource(resource('/loop.m3u8'), defaultSettings);
  assert.equal(loop.status, 'error'); assert.match(loop.error!, /循环/);
  assert.throws(() => parsePlaylist('#EXTM3U\nfile:///etc/passwd\n', 'https://example.com/'), /协议/);
});

test('probe cancellation aborts an active segment and never starts remaining samples', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60);
  const started = Date.now();
  const result = await probeResource(resource('/stall.m3u8'), { ...defaultSettings, sampleSegments: 20 }, controller.signal);
  clearTimeout(timer);
  assert.equal(result.status, 'error'); assert.ok(Date.now() - started < 500);
  assert.equal(result.sampledSegments, 0); assert.equal(result.speedMbps, null);
  assert.match(result.error!, /取消|abort/i);
  const alreadyAborted = await probeResource(resource('/master.m3u8'), defaultSettings, controller.signal);
  assert.equal(alreadyAborted.status, 'error'); assert.equal(alreadyAborted.bytesRead, 0);
});

test('a server that stalls after headers cannot bypass the configured body timeout', async () => {
  const started = Date.now();
  const result = await probeResource(resource('/stall.m3u8'), { ...defaultSettings, probeTimeoutMs: 80 });
  assert.equal(result.status, 'error'); assert.ok(Date.now() - started < 500);
  assert.equal(result.sampledSegments, 0); assert.equal(result.speedMbps, null);
  assert.match(result.error!, /超时|abort/i);
});
