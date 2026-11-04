import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import type { CollectedMovie } from '../shared/types.js';
import { collectSource, extractPlayerUrls, orderPlaybackPages, parseHtmlMovie, parseJsonMovie, parsePlayUrls, parseRobots, resolvePlaybackPage, robotsAllows } from '../server/collector.js';
import { defaultSettings, sourceDefaults } from '../server/defaults.js';
import { isPublicAddress, readTextLimited, safeFetch, safeUrlLabel } from '../server/upstream.js';

let origin = '';
const calls: string[] = [];
const server = createServer((request, response) => {
  const url = new URL(request.url!, 'http://localhost'); calls.push(url.pathname);
  if (url.pathname === '/robots.txt') return response.end('User-agent: *\nDisallow: /blocked\n');
  if (url.pathname === '/list') return response.end('<a href="/voddetail/1">movie</a><a href="/voddetail/1">duplicate</a>');
  if (url.pathname === '/list-partial') return response.end('<a href="/voddetail/2">movie</a>');
  if (url.pathname === '/list-latest') return response.end('<a href="/voddetail/3">long series</a>');
  if (url.pathname === '/voddetail/3') return response.end('<h1>长篇剧集</h1>' + [1, 2, 3, 4, 5].map(episode => `<a href="/vodplay/3-a-${episode}">第${episode}集</a>`).join(''));
  if (url.pathname === '/unlimited-list') {
    const page = Number(url.searchParams.get('page') || 1);
    return response.end(Array.from({ length: 11 }, (_item, index) => `<a href="/bulkdetail/${(page - 1) * 11 + index + 1}">movie</a>`).join('') + (page < 3 ? `<a title="下一页" href="/unlimited-list?page=${page + 1}">next</a>` : ''));
  }
  if (url.pathname.startsWith('/bulkdetail/')) {
    const id = url.pathname.split('/').at(-1);
    return response.end(`<h1>影片${id}</h1>` + (id === '1' ? Array.from({ length: 31 }, (_item, index) => `<a href="/vodplay/bulk-${index + 1}">第${index + 1}集</a>`).join('') : ''));
  }
  if (url.pathname === '/cycle-list-a' || url.pathname === '/cycle-list-b') {
    const id = url.pathname.endsWith('-a') ? '41' : '42';
    return response.end(`<a href="/bulkdetail/${id}">movie</a><a title="下一页" href="/cycle-list-${id === '41' ? 'b' : 'a'}">next</a>`);
  }
  if (url.pathname === '/json-unlimited') {
    const page = Number(url.searchParams.get('pg') || url.searchParams.get('page') || 1);
    return response.end(JSON.stringify({ pagecount: 3, list: Array.from({ length: 11 }, (_item, index) => ({ vod_id: (page - 1) * 11 + index + 1, vod_name: `API影片${(page - 1) * 11 + index + 1}` })) }));
  }
  if (url.pathname === '/json-repeat') return response.end(JSON.stringify({ pagecount: 1000000, list: [{ vod_id: 1, vod_name: '分页参数被忽略' }] }));
  if (url.pathname === '/json-cycle') {
    const page = Number(url.searchParams.get('page') || 1);
    return response.end(JSON.stringify({ list: [{ vod_id: page, vod_name: `循环影片${page}` }], next: `/json-cycle?page=${page === 1 ? 2 : 1}` }));
  }
  if (url.pathname === '/json-empty-stop') {
    const page = Number(url.searchParams.get('pg') || 1);
    return response.end(JSON.stringify({ list: page < 4 ? [{ vod_id: page, vod_name: `直到空页${page}` }] : [] }));
  }
  if (url.pathname === '/voddetail/2') return response.end('<h1>部分播放页失效</h1><a href="/vodplay/missing">第01集</a><a href="/vodplay/2-a-2">第02集</a>');
  if (url.pathname === '/voddetail/1') return response.end(`
    <h1>测试剧集</h1><div class="module-info-tag"><div class="module-info-tag-link"><a>2026</a></div><div class="module-info-tag-link"><a>中国大陆</a></div><div class="module-info-tag-link"><a>国产剧</a><a>剧情</a></div></div>
    <div class="module-info-item"><span class="module-info-item-title">导演：</span><div class="module-info-item-content">甲/</div></div>
    <div class="module-info-item"><span class="module-info-item-title">主演：</span><div class="module-info-item-content">乙/丙/</div></div>
    <div class="module-info-item"><span class="module-info-item-title">集数：</span><div class="module-info-item-content">更新至2集</div></div>
    <div class="module-info-introduction">公开简介</div><div class="module-item-pic"><img data-original="/poster.jpg"></div>
    <a href="/vodplay/1-a-1">立即播放</a>
    <div class="module-tab-item"><span>蓝光A</span><small>2</small></div><div class="module-tab-item"><span>蓝光B</span><small>2</small></div>
    <div class="module-play-list"><a href="/vodplay/1-a-1">第01集</a><a href="/vodplay/1-a-2">第02集</a></div>
    <div class="module-play-list"><a href="/vodplay/1-b-1">第01集</a></div>`);
  if (url.pathname === '/vodplay/missing') { response.writeHead(404); return response.end('Gone'); }
  if (url.pathname.startsWith('/vodplay/')) return response.end(`<script>var player_aaaa=${JSON.stringify({ encrypt: 0, url: origin + url.pathname + '.m3u8', url_next: origin + '/wrong-next.m3u8' })}</script>`);
  if (url.pathname === '/api') return response.end(JSON.stringify({ pagecount: 1, list: [{ vod_id: 7, vod_name: 'API电影', vod_year: '2025', vod_play_from: '公开源', vod_play_url: '正片$https://cdn.example.org/index.m3u8' }] }));
  if (url.pathname === '/forbidden') { response.writeHead(403); return response.end('Denied'); }
  if (url.pathname === '/challenge') return response.end('<title>Bot detection</title><div id="xcdn-captcha">人机验证</div>');
  if (url.pathname === '/redirect-blocked') { response.writeHead(302, { location: '/blocked' }); return response.end(); }
  if (url.pathname === '/gzip') { response.setHeader('content-encoding', 'gzip'); return response.end(gzipSync('压缩页面')); }
  if (url.pathname === '/large') return response.end('x'.repeat(2048));
  if (url.pathname === '/slow') { response.write('start'); setTimeout(() => response.end('end'), 300); return; }
  response.writeHead(404); response.end();
});

before(async () => { process.env.ALLOW_PRIVATE_UPSTREAM = 'true'; await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); delete process.env.ALLOW_PRIVATE_UPSTREAM; });
const context = (logs: string[] = []) => ({ settings: { ...defaultSettings, maxRetries: 0 }, log: (message: string) => logs.push(message) });
const fixtureSource = (extra: Parameters<typeof sourceDefaults>[0] = {}) => sourceDefaults({ baseUrl: origin, listPath: '/list', requestIntervalMs: 500, maxItems: 1, maxPages: 1, maxResourcePages: 10, ...extra });

test('robots uses specific user-agent groups, allow precedence, wildcard and query anchors', () => {
  const policy = parseRobots('User-agent: *\nDisallow: /\nUser-agent: CloudMedia\nDisallow: /private/*\nAllow: /private/public\nDisallow: /*?token=secret$\nCrawl-delay: 2', 'CloudMedia/0.1');
  assert.equal(policy.delayMs, 2000);
  assert.equal(robotsAllows(policy, new URL('https://example.com/')), true);
  assert.equal(robotsAllows(policy, new URL('https://example.com/private/a')), false);
  assert.equal(robotsAllows(policy, new URL('https://example.com/private/public/a')), true);
  assert.equal(robotsAllows(policy, new URL('https://example.com/a?token=secret')), false);
});

test('player extraction ignores next episode, handles ordinary URL encodings, and never evaluates scripts', () => {
  const url = 'https://cdn.example.com/movie/index.m3u8?token=a&b=2';
  const base64 = Buffer.from(encodeURIComponent(url)).toString('base64');
  assert.deepEqual(extractPlayerUrls(`<script>var player_aaaa={"encrypt":2,"url":"${base64}","url_next":"https://cdn.example.com/next.m3u8"}</script>`, 'https://site.example'), [url]);
  assert.deepEqual(extractPlayerUrls(`<script>var player_bad={"url":fetch('https://bad.example')};</script>`, 'https://site.example'), []);
  assert.deepEqual(extractPlayerUrls(`<script>var player_one={"encrypt":1,"url":"${encodeURIComponent(url)}"};</script>`, 'https://site.example'), [url]);
});

test('MacCMS channel parsing preserves every episode and excludes wrapper player pages', () => {
  assert.deepEqual(parsePlayUrls('第1集$https://a.example/1.m3u8#第2集$https://a.example/2.m3u8$$$正片$https://b.example/player?id=1', '蓝光$$$包装页'), [
    { name: '蓝光', episode: '第1集', url: 'https://a.example/1.m3u8' },
    { name: '蓝光', episode: '第2集', url: 'https://a.example/2.m3u8' },
  ]);
  const movie = parseJsonMovie({ vod_id: 1, vod_name: '标题', vod_content: '<p>简介</p>', vod_pic: '/p.jpg', vod_play_url: 'https://cdn.example/1.m3u8' }, fixtureSource(), origin);
  assert.equal(movie?.description, '简介'); assert.equal(movie?.poster, origin + '/p.jpg');
});

test('HTML collection deduplicates detail/play links and preserves stable line and episode identity', async () => {
  calls.length = 0; const movies = [];
  for await (const movie of collectSource(fixtureSource(), context())) movies.push(movie);
  assert.equal(movies.length, 1); const movie = movies[0];
  assert.equal(movie.title, '测试剧集'); assert.equal(movie.year, '2026'); assert.equal(movie.type, '电视剧');
  assert.equal(movie.region, '中国大陆'); assert.equal(movie.director, '甲'); assert.deepEqual(movie.actors, ['乙', '丙']);
  assert.equal(movie.resources.length, 3);
  assert.deepEqual(movie.resources.map(resource => [resource.name, resource.episode]), [['蓝光A', '第02集'], ['蓝光A', '第01集'], ['蓝光B', '第01集']]);
  assert.equal(calls.filter(path => path === '/vodplay/1-a-1').length, 1);
  assert.ok(movie.resources.every(resource => !resource.url.includes('wrong-next')));
});

test('per-film playback page cap is honored and reports partial collection', async () => {
  const logs: string[] = []; const movies = [];
  for await (const movie of collectSource(fixtureSource({ maxResourcePages: 1 }), context(logs))) movies.push(movie);
  assert.equal(movies[0].resources.length, 1); assert.ok(logs.some(message => message.includes('前 1 个')));
});

test('MacCMS collection reads public JSON without requesting unrelated pages', async () => {
  const movies = []; for await (const movie of collectSource(fixtureSource({ adapter: 'maccms', listPath: '/api' }), context())) movies.push(movie);
  assert.equal(movies[0].title, 'API电影'); assert.equal(movies[0].resources[0].name, '公开源');
});

test('forbidden, challenge and robots-disallowed targets stop rather than bypass protections', async () => {
  for (const path of ['/forbidden', '/challenge', '/blocked', '/redirect-blocked']) {
    await assert.rejects(async () => { for await (const _movie of collectSource(fixtureSource({ listPath: path }), context())) {} }, /403|人机验证|robots/);
  }
  assert.ok(!calls.includes('/blocked'));
});

test('upstream blocks private IPs, credentials and non-HTTP URLs and redacts query values in log labels', async () => {
  assert.equal(isPublicAddress('127.0.0.1'), false); assert.equal(isPublicAddress('::1'), false); assert.equal(isPublicAddress('::ffff:127.0.0.1'), false);
  assert.equal(isPublicAddress('192.168.1.110'), false); assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(safeUrlLabel('https://a.example/movie?token=secret#frag'), 'https://a.example/movie');
  await assert.rejects(safeFetch(origin, {}, { allowPrivate: false }), /已阻止/);
  await assert.rejects(safeFetch('file:///etc/passwd'), /HTTP/);
  await assert.rejects(safeFetch('http://user:pass@example.com'), /用户名/);
});

test('upstream decompresses public responses and enforces body byte and total response time limits', async () => {
  assert.equal(await readTextLimited(await safeFetch(origin + '/gzip')), '压缩页面');
  await assert.rejects(readTextLimited(await safeFetch(origin + '/large'), 1024), /大小限制/);
  await assert.rejects(readTextLimited(await safeFetch(origin + '/slow', {}, { timeoutMs: 40 })), /超时|aborted|关闭/);
});

test('hostname lookup returns the callback shape required by modern Node autoSelectFamily', async () => {
  const localhost = origin.replace('127.0.0.1', 'localhost');
  assert.equal(await readTextLimited(await safeFetch(localhost + '/gzip')), '压缩页面');
});

test('incremental HTML collection reuses fresh URLs without consuming the new-page budget', async () => {
  const source = fixtureSource({ maxResourcePages: 1 });
  const first = []; for await (const movie of collectSource(source, context())) first.push(movie);
  const cached = first[0].resources; const resolvedAt = cached[0].resolvedAt;
  calls.length = 0;
  const second = []; for await (const movie of collectSource(source, { ...context(), existingResources: () => cached, knownPageUrls: () => cached.map(resource => resource.pageUrl!) })) second.push(movie);
  assert.equal(second[0].resources.length, 2);
  assert.equal(second[0].resources[0].resolvedAt, resolvedAt);
  assert.equal(calls.filter(path => path === '/vodplay/1-a-2').length, 0, 'fresh page must not be requested again');
  assert.equal(calls.filter(path => path === '/vodplay/1-a-1').length, 1, 'next unknown page must progress');
});

test('new episodes are resolved before old pages whose cached URLs have expired', async () => {
  calls.length = 0;
  const movies = [];
  for await (const movie of collectSource(fixtureSource({ maxResourcePages: 1 }), {
    ...context(), existingResources: () => [], knownPageUrls: () => [origin + '/vodplay/1-a-1', origin + '/vodplay/1-a-2'],
  })) movies.push(movie);
  assert.equal(movies[0].resources.length, 1); assert.equal(movies[0].resources[0].name, '蓝光B');
  assert.ok(calls.includes('/vodplay/1-b-1')); assert.ok(!calls.includes('/vodplay/1-a-1'));
});

test('a stored public player page can be refreshed with a stable page reference and timestamp', async () => {
  const resources = await resolvePlaybackPage(fixtureSource(), origin + '/vodplay/1-a-1', context());
  assert.equal(resources.length, 1); assert.equal(resources[0].pageUrl, origin + '/vodplay/1-a-1');
  assert.equal(resources[0].url, origin + '/vodplay/1-a-1.m3u8'); assert.ok(resources[0].resolvedAt);
  await assert.rejects(resolvePlaybackPage(fixtureSource(), 'https://unrelated.example/player', context()), /当前采集源/);
});

test('an individual missing playback page does not discard metadata or later working episodes', async () => {
  const movies = []; const logs: string[] = [];
  for await (const movie of collectSource(fixtureSource({ listPath: '/list-partial', maxResourcePages: 2 }), context(logs))) movies.push(movie);
  assert.equal(movies[0].title, '部分播放页失效'); assert.equal(movies[0].resources.length, 1);
  assert.equal(movies[0].resources[0].episode, '第02集');
  assert.ok(logs.some(message => message.includes('播放页请求失败')));
});

test('HTML type classification uses title-specific categories and never mistakes 剧情 or 喜剧 for television', () => {
  const html = (genres: string[], categoryMarkup = '', categoryId = '') => `<h1>分类测试</h1>${categoryMarkup}<div class="module-info-tag"><div class="module-info-tag-link"><a>2026</a></div><div class="module-info-tag-link"><a>中国大陆</a></div><div class="module-info-tag-link">${genres.map(genre => `<a${categoryId ? ` href="/vodshow/${categoryId}---${encodeURIComponent(genre)}--------.html"` : ''}>${genre}</a>`).join('')}</div></div>`;
  const source = fixtureSource();
  const classify = (content: string) => parseHtmlMovie(content, source, origin + '/voddetail/type')?.type;
  assert.equal(classify(html(['剧情', '喜剧'])), '电影');
  assert.equal(classify(html(['剧情片', '喜剧'])), '电影');
  assert.equal(classify(html(['国产剧', '剧情', '喜剧'])), '电视剧');
  assert.equal(classify(html(['韩剧', '喜剧'])), '电视剧');
  assert.equal(classify(html(['动画', '喜剧', '剧情'])), '动漫');
  assert.equal(classify(html(['日本动漫', '剧情', '日剧'])), '动漫', 'animation formats precede a conflicting series genre fallback');
  assert.equal(classify(html(['动画', '喜剧'], '<nav class="breadcrumb"><a href="/">首页</a><a href="/vodtype/1.html">电影</a></nav>')), '电影', 'an explicit movie category is stronger evidence than animation genre');
  assert.equal(classify(html(['剧情', '喜剧'], '<nav class="breadcrumb"><a href="/">首页</a><a href="/vodtype/13.html">连续剧</a></nav>')), '电视剧');
  assert.equal(classify(html(['剧情', '喜剧'], '<nav><a href="/vodtype/1.html">电影</a><a href="/vodtype/13.html">连续剧</a><a href="/vodtype/4.html">动漫</a></nav>', '1')), '电影', '555 category IDs must match this title’s tag links');
  assert.equal(classify(html(['动画', '喜剧'], '<nav><a href="/vodtype/1.html">电影</a><a href="/vodtype/13.html">连续剧</a><a href="/vodtype/4.html">动漫</a></nav>', '4')), '动漫');
  assert.equal(classify(html(['剧情', '喜剧'], '<nav><a href="/vodtype/1.html">电影</a><a href="/vodtype/13.html">连续剧</a><a href="/vodtype/4.html">动漫</a></nav>', '13')), '电视剧');
});

test('latest unknown episode is collected first and later runs fill older missing episodes', async () => {
  const source = fixtureSource({ listPath: '/list-latest', maxResourcePages: 1 });
  const first = []; for await (const movie of collectSource(source, context())) first.push(movie);
  assert.equal(first[0].resources[0].episode, '第5集');
  const cached = first[0].resources;
  calls.length = 0;
  const second = []; for await (const movie of collectSource(source, { ...context(), existingResources: () => cached, knownPageUrls: () => [origin + '/vodplay/3-a-5', origin + '/vodplay/3-a-3'] })) second.push(movie);
  assert.deepEqual(second[0].resources.map(resource => resource.episode), ['第5集', '第4集']);
  assert.ok(calls.includes('/vodplay/3-a-4'));
  assert.ok(!calls.includes('/vodplay/3-a-5')); assert.ok(!calls.includes('/vodplay/3-a-3'));
});

test('episode, issue and valid date labels rank newest first without interpreting quality or line-name numbers', () => {
  const order = (labels: string[], known = new Set<string>()) => orderPlaybackPages(labels.map((episode, index) => ({ url: String(index), episode, name: `1080p线路${index}` })), known).map(item => item.episode);
  assert.deepEqual(order(['第2集', '第12集', '第3集']), ['第12集', '第3集', '第2集']);
  assert.deepEqual(order(['20261102', '20261103', '20261031']), ['20261103', '20261102', '20261031']);
  assert.deepEqual(order(['第260104期', '第260105期', '第260103期']), ['第260105期', '第260104期', '第260103期']);
  assert.deepEqual(order(['2026-11-02', '2026-11-03']), ['2026-11-03', '2026-11-02']);
  assert.deepEqual(order(['正片', '预告2026', '1080P', '第2集', '花絮', '第12集']), ['正片', '预告2026', '1080P', '第12集', '花絮', '第2集']);
  assert.deepEqual(order(['第12集', '第2集', '第5集', '第3集'], new Set(['0', '2'])), ['第3集', '第2集', '第12集', '第5集'], 'unknown episodes still precede newer stale pages');
  assert.deepEqual(order(['20261301', '20261103', '20261102']), ['20261301', '20261103', '20261102'], 'invalid calendar labels retain their position');
});

test('zero HTML limits traverse every list page, more than thirty titles and every playback page with checkpoints', { timeout: 45000 }, async () => {
  const movies: CollectedMovie[] = []; const firstMovieCheckpoints: number[] = [];
  for await (const movie of collectSource(fixtureSource({ listPath: '/unlimited-list', detailLinkSelector: 'a[href^="/bulkdetail/"]', maxPages: 0, maxItems: 0, maxResourcePages: 0 }), {
    ...context(), onCheckpoint: async movie => { if (movie.externalId === '/bulkdetail/1') firstMovieCheckpoints.push(movie.resources.length); },
  })) movies.push(movie);
  assert.equal(movies.length, 33); assert.equal(movies[0].resources.length, 31);
  assert.deepEqual(firstMovieCheckpoints, [0, 5, 10, 15, 20, 25, 30, 31]);
  assert.equal(new Set(movies.map(movie => movie.externalId)).size, 33);
  assert.equal(new Set(movies[0].resources.map(resource => resource.pageUrl)).size, 31);
});

test('unlimited HTML pagination stops an A to B to A loop without refetching lists or details', async () => {
  calls.length = 0; const movies = [];
  for await (const movie of collectSource(fixtureSource({ listPath: '/cycle-list-a', detailLinkSelector: 'a[href^="/bulkdetail/"]', maxPages: 0, maxItems: 0, maxResourcePages: 0 }), context())) movies.push(movie);
  assert.equal(movies.length, 2);
  assert.equal(calls.filter(path => path === '/cycle-list-a').length, 1); assert.equal(calls.filter(path => path === '/cycle-list-b').length, 1);
});

test('zero MacCMS and JSON limits collect all advertised pages and more than thirty unique titles', async () => {
  for (const adapter of ['maccms', 'json'] as const) {
    const movies = []; for await (const movie of collectSource(fixtureSource({ adapter, listPath: '/json-unlimited', maxPages: 0, maxItems: 0 }), context())) movies.push(movie);
    assert.equal(movies.length, 33); assert.equal(new Set(movies.map(movie => movie.externalId)).size, 33);
  }
});

test('unlimited JSON guards repeated content and explicit next-URL cycles; MacCMS stops on an empty page', async () => {
  const repeated = []; let beforeCount = calls.filter(path => path === '/json-repeat').length;
  for await (const movie of collectSource(fixtureSource({ adapter: 'maccms', listPath: '/json-repeat', maxPages: 0, maxItems: 0 }), context())) repeated.push(movie);
  assert.equal(repeated.length, 1); assert.equal(calls.filter(path => path === '/json-repeat').length - beforeCount, 2);
  const cycle = []; beforeCount = calls.filter(path => path === '/json-cycle').length;
  for await (const movie of collectSource(fixtureSource({ adapter: 'json', listPath: '/json-cycle', maxPages: 0, maxItems: 0 }), context())) cycle.push(movie);
  assert.equal(cycle.length, 2); assert.equal(calls.filter(path => path === '/json-cycle').length - beforeCount, 2);
  const empty = []; beforeCount = calls.filter(path => path === '/json-empty-stop').length;
  for await (const movie of collectSource(fixtureSource({ adapter: 'maccms', listPath: '/json-empty-stop', maxPages: 0, maxItems: 0 }), context())) empty.push(movie);
  assert.equal(empty.length, 3); assert.equal(calls.filter(path => path === '/json-empty-stop').length - beforeCount, 4);
});
