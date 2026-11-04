import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { collectSource, resolvePlaybackPage } from '../server/collector.js';
import { defaultSettings, sourceDefaults } from '../server/defaults.js';
import type { CollectedMovie, Source } from '../shared/types.js';

let origin = '';
let previousPrivate: string | undefined;
const requests: string[] = [];
const server = createServer((request, response) => {
  const url = new URL(request.url!, 'http://fixture');
  requests.push(url.pathname + url.search);
  if (url.pathname === '/list-raw' || url.pathname === '/list-redirect') {
    return response.end(`<a href="/voddetail/${url.pathname.slice(6)}">movie</a>`);
  }
  if (url.pathname === '/voddetail/raw' || url.pathname === '/voddetail/redirect') {
    return response.end(`<h1>清单影片</h1><div class="module-play-list" data-name="清单线路"><a href="/vodplay/${url.pathname.slice(11)}">第01集</a></div>`);
  }
  if (url.pathname === '/vodplay/redirect') {
    response.writeHead(302, { location: '/manifest?signature=retained' }); return response.end();
  }
  if (url.pathname === '/vodplay/raw' || url.pathname === '/manifest') {
    response.setHeader('content-type', 'application/vnd.apple.mpegurl');
    return response.end('\uFEFF\n#EXTM3U\n#EXTINF:10,\n/never-fetch-video.ts\n#EXT-X-ENDLIST\n');
  }
  if (url.pathname === '/list-signed') return response.end('<a href="/voddetail/signed">movie</a>');
  if (url.pathname === '/voddetail/signed') {
    return response.end('<h1>带签名地址</h1><div class="chosen"><a href="https://cdn.example/first.m3u8?token=a&amp;expires=1">正片</a></div><a href="https://cdn.example/second.m3u8#track">预告</a>');
  }
  response.writeHead(404); response.end();
});

before(async () => {
  previousPrivate = process.env.ALLOW_PRIVATE_UPSTREAM;
  process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (previousPrivate === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM; else process.env.ALLOW_PRIVATE_UPSTREAM = previousPrivate;
});
const context = () => ({ settings: { ...defaultSettings, maxRetries: 0 }, log: () => {} });
const source = (extra: Partial<Source> = {}) => sourceDefaults({ baseUrl: origin, requestIntervalMs: 0, ...extra });
async function collect(input: Source) {
  const movies: CollectedMovie[] = [];
  for await (const movie of collectSource(input, context())) movies.push(movie);
  return movies;
}

for (const mode of ['raw', 'redirect']) {
  test(`collection recognizes a ${mode} playback response containing an HLS manifest`, async () => {
    requests.length = 0;
    const movies = await collect(source({ listPath: `/list-${mode}` }));
    assert.equal(movies.length, 1);
    assert.equal(movies[0].resources.length, 1);
    const resource = movies[0].resources[0];
    const finalUrl = origin + (mode === 'raw' ? '/vodplay/raw' : '/manifest?signature=retained');
    assert.equal(resource.url, finalUrl);
    assert.equal(resource.pageUrl, finalUrl);
    assert.equal(resource.referer, finalUrl);
    assert.equal(resource.name, '清单线路');
    assert.equal(resource.episode, '第01集');
    const refreshed = await resolvePlaybackPage(source(), origin + `/vodplay/${mode}`, context());
    assert.equal(refreshed[0].url, finalUrl, 'collection and manual refresh must recognize the same response');
    assert.ok(!requests.some(path => path.includes('.ts')), 'collecting URLs must not fetch video segments');
  });
}

for (const legacy of [false, true]) {
  test(`${legacy ? 'saved legacy' : 'new'} default CSS collects direct HLS links with query strings and fragments`, async () => {
    requests.length = 0;
    const movies = await collect(source({ listPath: '/list-signed', ...(legacy ? { resourceSelector: 'a[href*="/vodplay/"], a[href$=".m3u8"]' } : {}) }));
    assert.equal(movies.length, 1);
    assert.deepEqual(movies[0].resources.map(resource => [resource.episode, resource.url]), [
      ['正片', 'https://cdn.example/first.m3u8?token=a&expires=1'],
      ['预告', 'https://cdn.example/second.m3u8#track'],
    ]);
    assert.deepEqual(requests, ['/list-signed', '/voddetail/signed']);
  });
}

test('a custom CSS selector keeps direct HLS collection scoped to the selected anchors', async () => {
  const movies = await collect(source({ listPath: '/list-signed', resourceSelector: '.chosen a' }));
  assert.deepEqual(movies[0].resources.map(resource => resource.url), ['https://cdn.example/first.m3u8?token=a&expires=1']);
});
