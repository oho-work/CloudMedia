import { load } from 'cheerio';
import { setTimeout as delay } from 'node:timers/promises';
import type { CollectedMovie, CollectedResource, CollectionContext, Source } from '../shared/types.js';
import { readTextLimited, safeFetch, safeUrlLabel } from './upstream.js';
import { resolveDateRange, sourceDate } from './dates.js';
import { concurrentBatch, TaskLimiter } from './concurrency.js';

function text(value: any): string { return value === undefined || value === null ? '' : String(value).trim(); }
function list(value: any): string[] { return Array.isArray(value) ? value.map(text).filter(Boolean) : text(value).split(/[,，、/]/).map(item => item.trim()).filter(Boolean); }
function absolute(value: string, base: string): string {
  if (!value.trim()) return '';
  try { const url = base ? new URL(value, base) : new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
}
function isHls(value: string): boolean { try { return /\.m3u8(?:$|[?#])/i.test(new URL(value).href); } catch { return false; } }
function pageKey(value: string): string { const url = new URL(value); url.hash = ''; return url.href; }

/** Extract only literal player data, never execute page JavaScript. */
export function extractPlayerUrls(html: string, base: string, includeAnchors = true): string[] {
  const found = new Set<string>();
  const add = (value: string) => { const url = absolute(value.replace(/\\\//g, '/').replace(/&amp;/g, '&'), base); if (isHls(url)) found.add(url); };
  const playerPattern = /(?:var\s+)?player_[\w$]+\s*=\s*/g;
  for (let match = playerPattern.exec(html); match; match = playerPattern.exec(html)) {
    const start = playerPattern.lastIndex;
    if (html[start] !== '{') continue;
    let depth = 0; let quote = ''; let escaped = false; let end = start;
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = ''; continue; }
      if (char === '"') quote = char;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) break;
    }
    try {
      const data = JSON.parse(html.slice(start, end + 1));
      if (typeof data.url !== 'string') continue;
      let value = data.url;
      if (String(data.encrypt) === '2') value = Buffer.from(value, 'base64').toString('utf8');
      if (String(data.encrypt) === '1' || String(data.encrypt) === '2') { try { value = decodeURIComponent(value); } catch {} }
      add(value);
    } catch { /* Unsupported executable or non-JSON player data is intentionally ignored. */ }
  }
  const $ = load(html);
  $(includeAnchors ? 'a[href], video[src], source[src]' : 'video[src], source[src]').each((_index, element) => add($(element).attr('href') ?? $(element).attr('src') ?? ''));
  // Do not scan every URL in player JSON: url_next belongs to a different episode.
  return [...found];
}

function playbackResponseUrls(content: { body: string; url: string }): string[] {
  return content.body.trimStart().startsWith('#EXTM3U') ? [content.url] : extractPlayerUrls(content.body, content.url);
}

class SourceClient {
  private lastRequest = 0;
  private requestStart: Promise<void> = Promise.resolve();
  private requests: TaskLimiter;
  readonly limit: number;
  constructor(private source: Source, private context: CollectionContext, private abort: (reason: unknown) => void = () => {}) {
    this.limit = Math.max(1, Math.min(20, Math.floor(source.concurrency || 1)));
    this.requests = new TaskLimiter(this.limit);
  }
  private headers(referer: string) {
    return { 'user-agent': this.context.settings.userAgent, accept: 'text/html,*/*;q=0.5', referer: new URL(referer).href };
  }
  async get(value: string, referer = this.source.baseUrl): Promise<{ body: string; url: string }> {
    return this.requests.run(() => this.context.runSourceTask
      ? this.context.runSourceTask(() => this.request(value, referer), this.context.signal)
      : this.request(value, referer), this.context.signal);
  }
  stop(reason: unknown) { this.abort(reason); }
  private async request(value: string, referer: string): Promise<{ body: string; url: string }> {
    const url = new URL(value);
    const interval = Math.max(0, this.source.requestIntervalMs);
    for (let attempt = 0; attempt <= this.context.settings.maxRetries; attempt++) {
      try {
        const response = await safeFetch(url, { headers: this.headers(referer), signal: this.context.signal }, {
          timeoutMs: 15000 + Math.max(this.source.requestIntervalMs, 0),
          beforeRequest: async () => {
            const start = this.requestStart.then(async () => {
              this.context.signal?.throwIfAborted();
              const wait = Math.max(0, interval - (Date.now() - this.lastRequest));
              if (wait) await delay(wait, undefined, { signal: this.context.signal });
              this.context.signal?.throwIfAborted();
              this.lastRequest = Date.now();
            });
            this.requestStart = start.catch(() => {});
            await start;
          },
        });
        if ([401, 403].includes(response.status)) { await response.body?.cancel(); throw new StopError(`源站返回 HTTP ${response.status}，停止采集，请检查源站访问要求`); }
        if ([408, 429].includes(response.status) || response.status >= 500) {
          const retryAfter = response.headers.get('retry-after'); await response.body?.cancel();
          if (attempt >= this.context.settings.maxRetries) throw new StopError(`源站返回 HTTP ${response.status}，本次任务已停止`);
          const waitMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : interval * 2 ** (attempt + 1);
          this.context.log(`源站繁忙，等待 ${Math.min(waitMs, 60000)}ms 后重试`);
          await delay(Math.min(waitMs, 60000), undefined, { signal: this.context.signal }); continue;
        }
        if (!response.ok) { await response.body?.cancel(); throw new PageError(`请求失败 HTTP ${response.status}: ${safeUrlLabel(value)}`); }
        const body = await readTextLimited(response);
        if (/cf-chl-|id=["']challenge-form|verify you are human|人机验证|完成安全验证|captcha-container/i.test(body)) throw new StopError('源站要求人机验证，已停止采集');
        return { body, url: response.url || url.href };
      } catch (error) {
        if (error instanceof StopError) this.abort(error);
        if (error instanceof StopError || error instanceof PageError || this.context.signal?.aborted || attempt >= this.context.settings.maxRetries) throw error;
        this.context.log(`网络请求失败，将退避后重试 (${attempt + 1})`);
        await delay(interval * 2 ** attempt, undefined, { signal: this.context.signal });
      }
    }
    throw new Error('请求重试失败');
  }
}
class StopError extends Error {}
class PageError extends Error {}
/** Its individual failures have already been reported through onCollectionError. */
export class IncompleteCollectionError extends Error {}

/** Refresh one stored public player page without executing its scripts. */
export async function resolvePlaybackPage(source: Source, pageUrl: string, context: CollectionContext, referer = source.baseUrl): Promise<CollectedResource[]> {
  const target = absolute(pageUrl, source.baseUrl);
  if (!target || new URL(target).origin !== new URL(source.baseUrl).origin) throw new Error('播放页必须位于当前采集源域名下');
  const content = await new SourceClient(source, context).get(target, referer);
  const urls = playbackResponseUrls(content);
  if (!urls.length) throw new Error('播放页未发现公开 m3u8 地址；可能已失效或需要更新采集规则');
  const resolvedAt = new Date().toISOString();
  return urls.map(url => ({ name: source.name, episode: '正片', url, referer: content.url, pageUrl: content.url, resolvedAt }));
}

/** Recover an old poster's URL without resolving or requesting video resources. */
export async function resolvePosterPage(source: Source, pageUrl: string, context: CollectionContext): Promise<string> {
  const target = absolute(pageUrl, source.baseUrl);
  if (!target || new URL(target).origin !== new URL(source.baseUrl).origin) throw new Error('详情页必须位于当前采集源域名下');
  const content = await new SourceClient(source, context).get(target);
  return parseHtmlMovie(content.body, source, content.url, context.settings.timezone)?.poster || '';
}

/** Only explicit format/category names identify a series. 剧情 and 喜剧 are genres. */
function categoryType(value: string): string | undefined {
  const name = value.replace(/[\s/|>›»：:]+/g, '');
  if (/^(?:动漫|动画|动画片|动画剧集|动漫剧集|国产动漫|中国动漫|日本动漫|日韩动漫|欧美动漫|港台动漫|海外动漫|韩国动漫)$/.test(name)) return '动漫';
  if (/^(?:电视剧|连续剧|剧集|电视连续剧|国产剧|大陆剧|内地剧|日韩剧|韩剧|韩国剧|日剧|日本剧|欧美剧|美剧|英剧|港剧|台剧|香港剧|台湾剧|港台剧|泰剧|泰国剧|海外剧|短剧|网络剧|网剧)$/.test(name)) return '电视剧';
  if (/^(?:综艺|大陆综艺|内地综艺|日韩综艺|欧美综艺|港台综艺|海外综艺|综艺节目|综艺纪录)$/.test(name)) return '综艺';
  if (/^(?:电影|影片|剧情片|喜剧片|动作片|爱情片|科幻片|恐怖片|惊悚片|悬疑片|犯罪片|战争片|纪录片|记录片|动画电影|动漫电影|网络电影|院线电影)$/.test(name)) return '电影';
  return undefined;
}

export function parseHtmlMovie(html: string, source: Source, pageUrl: string, timezone = 'Asia/Shanghai'): CollectedMovie | null {
  const $ = load(html);
  const title = $(source.titleSelector || 'h1').first().text().trim() || $('meta[property="og:title"]').attr('content') || '';
  if (!title) return null;
  $('script,style,noscript').remove();
  const body = $('body').text().replace(/\s+/g, ' ');
  const labels = new Map<string, string>();
  $('.module-info-item').each((_index, element) => {
    const name = $(element).find('.module-info-item-title').text().replace(/[：:\s]/g, '');
    if (name) labels.set(name, $(element).find('.module-info-item-content').text().replace(/\s+/g, ' ').replace(/\/+\s*$/, '').trim() || $(element).text().replace(/^[^：:]+[：:]/, '').trim());
  });
  const label = (name: string) => labels.get(name) ?? body.match(new RegExp(`${name}[：:]\\s*([^\\n]{1,100}?)(?=\\s+(?:导演|编剧|主演|类型|地区|年份|上映|语言|更新|集数|状态|评分|豆瓣)[：:]|$)`))?.[1]?.trim() ?? '';
  const tags = $('.module-info-tag-link');
  const year = label('年份').match(/(?:19|20)\d{2}/)?.[0] || tags.eq(0).text().match(/(?:19|20)\d{2}/)?.[0] || label('上映').match(/(?:19|20)\d{2}/)?.[0] || '';
  const genres = tags.eq(2).find('a').map((_index, item) => $(item).text().trim()).get();
  // Breadcrumbs are scoped to this title; page-wide navigation contains every
  // category and cannot identify a movie without matching its category ID.
  const breadcrumbTypes = $('.breadcrumb a,.breadcrumbs a,.bread a,.crumb a,.position a,[aria-label="breadcrumb"] a,[aria-label="Breadcrumb"] a')
    .map((_index, element) => categoryType($(element).text())).get().filter(Boolean);
  let type = breadcrumbTypes.at(-1) || categoryType(label('分类')) || categoryType(label('频道')) || categoryType(label('类型'));
  if (!type) {
    const categoryId = (href: string) => {
      try { return new URL(href, pageUrl).pathname.match(/\/vod(?:type|show)\/(\d+)(?:[.\-/]|$)/)?.[1]; } catch { return undefined; }
    };
    const detailIds = new Set(tags.find('a[href]').map((_index, element) => categoryId($(element).attr('href') || '')).get().filter(Boolean));
    const namesById = new Map<string, string>();
    $('a[href*="/vodtype/"],a[href*="/vodshow/"]').each((_index, element) => {
      const href = $(element).attr('href') || '';
      const id = categoryId(href); const candidate = categoryType($(element).text());
      if (id && candidate && !$(element).closest('.module-info-tag').length) namesById.set(id, candidate);
    });
    for (const id of detailIds) if (namesById.has(id)) { type = namesById.get(id); break; }
  }
  const genreTypes = (genres.length ? genres : list(label('类型'))).map(categoryType).filter(Boolean);
  type ||= genreTypes.includes('动漫') ? '动漫' : genreTypes.includes('电视剧') ? '电视剧' : genreTypes.includes('综艺') ? '综艺' : genreTypes.includes('电影') ? '电影' : label('类型') || '电影';
  const image = $(source.posterSelector || 'img').first();
  const poster = image.attr('data-original') || image.attr('data-src') || image.attr('src') || $('meta[property="og:image"]').attr('content') || '';
  return { externalId: new URL(pageUrl).pathname, pageUrl, title,
    year, region: label('地区') || tags.eq(1).text().trim(),
    type, genres: genres.length ? genres : list(label('类型')), director: label('导演'), actors: list(label('主演')),
    description: $(source.descriptionSelector).first().text().replace(/\s+/g, ' ').trim(),
    poster: absolute(poster, pageUrl), status: label('状态') || label('集数'), rating: label('豆瓣').match(/[\d.]+/)?.[0] || '',
    sourceUpdatedOn: sourceDate(label('更新') || label('更新时间'), timezone), resources: [] };
}

function episodeOrder(label: string): { kind: string; value: number } | undefined {
  const value = label.normalize('NFKC').replace(/\s+/g, '');
  const episode = value.match(/^第?(\d{1,6})(集|话|回|期)(?:(?:已)?完结|全|完整版|[（(]?[上中下][）)]?)?$/);
  if (episode) return { kind: episode[2] === '期' ? 'issue' : 'episode', value: Number(episode[1]) };
  const date = value.match(/^((?:19|20)\d{2})(?:[-/.年]?)(\d{2})(?:[-/.月]?)(\d{2})(?:日|期)?$/);
  if (date) {
    const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day) return { kind: 'date', value: year * 10000 + month * 100 + day };
  }
  return undefined;
}

/** Unknown pages first; recognize episode/date labels without ranking trailers,
 * quality labels or line names. Unranked labels retain their original slots. */
export function orderPlaybackPages<T extends { url: string; episode: string }>(pages: T[], knownPages: Set<string>): T[] {
  const newestFirst = (items: T[]) => {
    const result = [...items];
    const groups = new Map<string, { slots: number[]; items: { item: T; value: number }[] }>();
    items.forEach((item, index) => {
      const rank = episodeOrder(item.episode); if (!rank) return;
      const group = groups.get(rank.kind) ?? { slots: [], items: [] };
      group.slots.push(index); group.items.push({ item, value: rank.value }); groups.set(rank.kind, group);
    });
    for (const group of groups.values()) {
      group.items.sort((a, b) => b.value - a.value);
      group.slots.forEach((slot, index) => { result[slot] = group.items[index].item; });
    }
    return result;
  };
  return [...newestFirst(pages.filter(item => !knownPages.has(item.url))), ...newestFirst(pages.filter(item => knownPages.has(item.url)))];
}


interface HtmlPlan {
  movie: CollectedMovie;
  resources: Map<string, CollectedResource>;
  playPages: Map<string, { url: string; episode: string; name: string }>;
}

function htmlPlan(movie: CollectedMovie, detail: { body: string; url: string }, source: Source): HtmlPlan {
  const doc = load(detail.body); const resources = new Map<string, CollectedResource>();
  for (const url of extractPlayerUrls(detail.body, detail.url, false)) resources.set(`${url}|正片`, { name: '默认线路', episode: '正片', url, referer: detail.url, pageUrl: detail.url, resolvedAt: new Date().toISOString() });
  const playPages = new Map<string, { url: string; episode: string; name: string }>();
  const groups = doc('.module-play-list,.playlist,.stui-content__playlist,.myui-content__list').toArray();
  const groupFor = (element: any) => doc(element).closest('.module-play-list,.playlist,.stui-content__playlist,.myui-content__list');
  doc(source.resourceSelector).each((_index, element) => {
    const url = absolute(doc(element).attr('href') ?? doc(element).attr('data-url') ?? '', detail.url);
    if (!url) return;
    let selected = doc(element);
    // Desktop/mobile "play now" buttons duplicate an actual episode link.
    // Prefer that episode's label and group so they cannot replace its identity.
    if (!groupFor(element).length) {
      const matching = doc('.module-play-list a[href],.playlist a[href],.stui-content__playlist a[href],.myui-content__list a[href]').filter((_i, item) => absolute(doc(item).attr('href') ?? '', detail.url) === url).first();
      if (matching.length) selected = matching;
    }
    const group = groupFor(selected[0]); const groupIndex = groups.findIndex(candidate => candidate === group[0]);
    const episode = selected.text().trim() || '正片';
    const tabName = groupIndex >= 0 ? doc('.module-tab-item').eq(groupIndex).find('span').first().text().trim() : '';
    const name = selected.closest('[data-name]').attr('data-name') || tabName || (groupIndex >= 0 ? `线路 ${groupIndex + 1}` : '默认线路');
    if (isHls(url)) resources.set(`${url}|${episode}|${name}`, { name, episode, url, referer: detail.url, pageUrl: detail.url, resolvedAt: new Date().toISOString() });
    else if (new URL(url).origin === new URL(detail.url).origin) playPages.set(url, { url, episode, name });
  });
  return { movie, resources, playPages };
}

async function populateHtmlResources(plan: HtmlPlan, client: SourceClient, context: CollectionContext): Promise<CollectedMovie> {
  const { movie, resources, playPages } = plan;
  const freshByPage = new Map<string, CollectedResource[]>();
  for (const resource of context.existingResources?.(movie.externalId) ?? []) {
    if (!resource.pageUrl) continue;
    const pageResources = freshByPage.get(resource.pageUrl) ?? [];
    pageResources.push(resource); freshByPage.set(resource.pageUrl, pageResources);
  }
  const knownPages = new Set(context.knownPageUrls?.(movie.externalId) ?? freshByPage.keys());
  const pending: { url: string; episode: string; name: string }[] = [];
  for (const play of playPages.values()) {
    const cached = freshByPage.get(play.url);
    if (cached?.length) for (const resource of cached) resources.set(`${resource.url}|${resource.episode}|${resource.name}`, resource);
    else pending.push(play);
  }
  // New episodes win over old pages whose cached URLs need periodic refresh.
  const orderedPending = orderPlaybackPages(pending, knownPages);
  const resolvedPages = new Map<number, CollectedResource[]>();
  let lastCheckpoint = '';
  const snapshotResources = () => {
    const current = new Map(resources);
    // Preserve episode order even when a later page finishes first.
    for (let index = 0; index < orderedPending.length; index++) {
      for (const resource of resolvedPages.get(index) ?? []) current.set(`${resource.url}|${resource.episode}|${resource.name}`, resource);
    }
    return [...current.values()];
  };
  const checkpoint = async () => {
    if (!context.onCheckpoint) return;
    const snapshot = { ...movie, resources: snapshotResources() };
    const identity = JSON.stringify(snapshot);
    if (identity === lastCheckpoint) return;
    lastCheckpoint = identity;
    await context.onCheckpoint(structuredClone(snapshot));
  };
  await checkpoint();
  try {
    // A worker owns a movie slot through probing; one playback-page producer per
    // movie keeps a long series from filling the entire shared HTTP queue.
    await concurrentBatch(orderedPending, context.onMovie ? 1 : client.limit, async (play, index) => {
      try {
        context.log(`正在采集「${movie.title}」${play.name} / ${play.episode}（${index + 1}/${orderedPending.length} 个播放页）`);
        let content: { body: string; url: string } | undefined;
        try { content = await client.get(play.url, movie.pageUrl); }
        catch (error) { if (error instanceof StopError || context.signal?.aborted) throw error; }
        if (content) {
          const urls = playbackResponseUrls(content);
          if (!urls.length) {
            const message = `「${movie.title}」${play.name} / ${play.episode} 未发现公开 m3u8，保留影片资料及已有资源`;
            context.log(message); context.onCollectionError?.(message);
          }
          resolvedPages.set(index, urls.map(url => ({ name: play.name, episode: play.episode, url, referer: content!.url, pageUrl: content!.url, resolvedAt: new Date().toISOString() })));
        } else {
          const message = `「${movie.title}」${play.episode} 播放页请求失败，保留影片资料及已有资源：${safeUrlLabel(play.url)}`;
          context.log(message); context.onCollectionError?.(message);
        }
        // Publish this page as soon as it is resolved, before waiting for any
        // sibling page or movie, so its measurements can start immediately.
        await checkpoint();
      } catch (error) {
        client.stop(error);
        throw error;
      }
    }, context.signal);
  } finally { await checkpoint(); }
  movie.resources = snapshotResources();
  if (!movie.resources.length) {
    if (!playPages.size) {
      const message = `「${movie.title}」未匹配到播放链接，请检查播放链接 CSS 选择器或源站页面；已保留影片资料`;
      context.log(message); context.onCollectionError?.(message);
    } else context.log(`「${movie.title}」未发现公开 m3u8 地址，已保留影片资料`);
  }
  return movie;
}

export async function* collectSource(source: Source, context: CollectionContext): AsyncGenerator<CollectedMovie> {
  const controller = new AbortController();
  const parentSignal = context.signal;
  const abort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener('abort', abort, { once: true });
  const writeCheckpoint = context.onCheckpoint;
  let checkpoints: Promise<void> = Promise.resolve();
  context = { ...context, signal: controller.signal, onCheckpoint: writeCheckpoint ? movie => {
    const snapshot = structuredClone(movie);
    const write = checkpoints.then(() => writeCheckpoint(snapshot)).catch(error => { controller.abort(error); throw error; });
    checkpoints = write.catch(() => {});
    return write;
  } : undefined };
  try { yield* collectSourcePages(source, context, reason => controller.abort(reason)); }
  finally {
    controller.abort();
    parentSignal?.removeEventListener('abort', abort);
    await checkpoints;
  }
}

async function* collectSourcePages(source: Source, context: CollectionContext, abort: (reason: unknown) => void): AsyncGenerator<CollectedMovie> {
  let dateRange = context.dateRange;
  if (!dateRange) {
    if (source.collectionMode === 'updates' || source.collectionMode === 'today') dateRange = resolveDateRange({}, context.settings.timezone);
    else if (source.collectionMode === 'range') {
      if (!source.startDate || !source.endDate) throw new Error('区间采集需要开始日期和结束日期');
      dateRange = resolveDateRange({ startDate: source.startDate, endDate: source.endDate }, context.settings.timezone);
    }
  }
  let incompletePages = 0;
  if (dateRange) {
    const reportError = context.onCollectionError;
    context = { ...context, dateRange, onCollectionError: message => { incompletePages++; reportError?.(message); } };
    context.log(`采集更新日期 ${dateRange.startDate} 至 ${dateRange.endDate}（${dateRange.timezone}）`);
  }
  const client = new SourceClient(source, context, abort);
  let listingReferer = source.baseUrl;
  let pageUrl = absolute(source.listPath || '/', source.baseUrl);
  if (!pageUrl) throw new Error('源站列表地址无效');
  let count = 0;
  let completedMovies = 0; let currentPage = 0; let paginationComplete = false;
  const activeTitles = new Map<number, string>();
  let reachedStart = false;
  const visited = new Set<string>();
  const visitedPages = new Set<string>();
  const visitedMovies = new Set<string>();
  const active = new Set<Promise<void>>();
  const reportProgress = () => context.onProgress?.({ discoveredMovies: count, completedMovies,
    activeMovies: active.size, concurrency: client.limit, currentPage, paginationComplete,
    activeMovieTitles: [...activeTitles.values()].filter(Boolean).slice(0, client.limit).map(title => title.slice(0, 160)) });
  const completed = new Map<number, CollectedMovie | null>();
  const ready: CollectedMovie[] = [];
  let scheduled = 0; let nextResult = 0; let finished = false;
  let failure: unknown; let failed = false; let fatal = false;
  let notify!: () => void;
  let changed = new Promise<void>(resolve => { notify = resolve; });
  let decisions = Promise.resolve();
  const wake = () => { notify(); changed = new Promise<void>(resolve => { notify = resolve; }); };
  context.signal?.addEventListener('abort', wake);
  const stop = (error: unknown) => {
    if (!failed) { failed = true; failure = error; }
    fatal = true;
    abort(error); wake();
  };
  const capacity = async () => {
    while (active.size + (context.onMovie ? ready.length : completed.size) >= client.limit) {
      await changed;
      context.signal?.throwIfAborted();
    }
  };
  const schedule = (detailUrl: string, referer: string) => {
    const sequence = scheduled++;
    const previousDecision = decisions;
    let releaseDecision!: () => void;
    decisions = new Promise<void>(resolve => { releaseDecision = resolve; });
    const task = (async () => {
      let detail: { body: string; url: string } | undefined;
      let detailError: unknown;
      try { detail = await client.get(detailUrl, referer); }
      catch (error) {
        if (error instanceof StopError || context.signal?.aborted) throw error;
        detailError = error;
      }
      // Range decisions alone follow listing order. Playback and measurements
      // remain independent once a movie has been accepted.
      await previousDecision;
      let plan: HtmlPlan;
      try {
        context.signal?.throwIfAborted();
        if (reachedStart) return null;
        if (!detail) {
          const message = `详情页请求失败，已记录后继续采集其他影片：${safeUrlLabel(detailUrl)}（${detailError instanceof Error ? detailError.message : '请求错误'}）`;
          context.log(message); context.onCollectionError?.(message);
          return null;
        }
        const movie = parseHtmlMovie(detail.body, source, detail.url, dateRange?.timezone ?? context.settings.timezone);
        if (!movie) {
          if (dateRange) throw new Error(`详情页没有匹配片名，无法完成日期范围采集：${safeUrlLabel(detailUrl)}`);
          const message = `详情页没有匹配片名，已跳过：${safeUrlLabel(detailUrl)}`;
          context.log(message); context.onCollectionError?.(message); return null;
        }
        if (dateRange) {
          const updatedOn = movie.sourceUpdatedOn;
          if (!updatedOn) throw new Error(`「${movie.title}」没有有效的源站更新时间，无法按日期筛选`);
          if (updatedOn < dateRange.startDate) {
            if (source.updatesSortedDescending) reachedStart = true;
            return null;
          }
          if (updatedOn > dateRange.endDate) return null;
        }
        if (visitedMovies.has(movie.externalId)) return null;
        visitedMovies.add(movie.externalId);
        plan = htmlPlan(movie, detail, source);
        count++;
        activeTitles.set(sequence, movie.title);
        reportProgress();
        if (dateRange) context.log(`已发现 ${count} 部日期范围内影片，正在补齐播放资源`);
      } finally { releaseDecision(); }
      const movie = await populateHtmlResources(plan, client, context);
      await context.onMovie?.(movie);
      context.signal?.throwIfAborted();
      completedMovies++;
      return movie;
    })().then(movie => {
      if (context.onMovie) { if (movie) ready.push(movie); }
      else completed.set(sequence, movie);
    }, error => {
      releaseDecision(); if (!context.onMovie) completed.set(sequence, null); stop(error);
    }).finally(() => { active.delete(task); activeTitles.delete(sequence); reportProgress(); wake(); });
    active.add(task);
    reportProgress();
  };
  const produce = async () => {
    for (let page = 1; pageUrl && !reachedStart; page++) {
      if (page > 1) await capacity();
      context.signal?.throwIfAborted();
      const key = pageKey(pageUrl);
      if (visitedPages.has(key)) {
        if (dateRange) throw new Error('更新列表分页形成循环，日期范围采集未完成');
        context.log('列表分页地址重复，已停止翻页'); break;
      }
      visitedPages.add(key);
      currentPage = page; reportProgress();
      context.log(`读取页面第 ${page} 页`);
      const response = await client.get(pageUrl, listingReferer); const $ = load(response.body);
      listingReferer = response.url;
      const finalKey = pageKey(response.url);
      if (finalKey !== key && visitedPages.has(finalKey)) {
        if (dateRange) throw new Error('更新列表重定向形成循环，日期范围采集未完成');
        context.log('列表重定向至已访问页面，已停止翻页'); break;
      }
      visitedPages.add(finalKey);
      const details = new Set<string>();
      $(source.detailLinkSelector).each((_index, element) => {
        const absoluteUrl = absolute($(element).attr('href') ?? '', response.url);
        const url = absoluteUrl ? pageKey(absoluteUrl) : '';
        if (url && new URL(url).origin === new URL(response.url).origin && !visited.has(url)) details.add(url);
      });
      if (!details.size && page === 1) {
        if (dateRange && /暂无数据|暂无影片|没有找到|无相关内容/.test($('body').text())) break;
        throw new Error('未发现影片详情链接，请检查详情链接 CSS 选择器');
      }
      if (!details.size && !dateRange) { context.log('列表没有新的影片链接，已停止翻页'); break; }
      for (const detailUrl of details) {
        await capacity();
        context.signal?.throwIfAborted();
        if (reachedStart) break;
        visited.add(detailUrl);
        schedule(detailUrl, response.url);
      }
      // Preserve ordered date early-stop before fetching the next listing,
      // without waiting for accepted movies to finish their resource/probe work.
      if (dateRange) await decisions;
      if (reachedStart) { context.log('已到达开始日期之前的记录，停止翻页'); break; }
      const nextHref = source.nextPageSelector ? $(source.nextPageSelector).first().attr('href') : undefined;
      const next = nextHref ? absolute(nextHref, response.url) : '';
      pageUrl = next && new URL(next).origin === new URL(response.url).origin && next !== pageUrl ? next : '';
    }
    // Listing exhaustion alone does not make the accepted movie count final:
    // the last page's details may still be awaiting their ordered decisions.
    await decisions;
    context.signal?.throwIfAborted();
    paginationComplete = true; reportProgress();
  };
  const producer = produce().catch(error => {
    if (error instanceof StopError || context.signal?.aborted) stop(error);
    else if (!failed) {
      // A broken later listing must not discard accepted movies' playback
      // resources. Stop discovery, finish their pipelines, then report failure.
      failed = true; failure = error;
    }
  }).finally(async () => {
    await Promise.all(active);
    finished = true; wake();
  });
  try {
    while (!finished || (context.onMovie ? ready.length > 0 : nextResult < scheduled)) {
      if (failed && fatal) throw failure;
      if (context.onMovie && ready.length) {
        const movie = ready.shift()!;
        wake();
        yield movie;
      }
      else if (!context.onMovie && completed.has(nextResult)) {
        const movie = completed.get(nextResult)!;
        completed.delete(nextResult++);
        wake();
        if (movie) yield movie;
      } else await changed;
    }
    if (failed) throw failure;
  } finally {
    if (!finished) { abort(new Error('采集结果读取已停止')); wake(); }
    await producer;
    context.signal?.removeEventListener('abort', wake);
  }
  context.log(`本次读取 ${count} 部影片`);
  if (dateRange && incompletePages) throw new IncompleteCollectionError(`已读取 ${count} 部影片；${incompletePages} 个页面未完整取得内容，详见任务错误，可重新采集补齐`);
}
