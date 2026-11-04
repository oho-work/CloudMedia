import { load } from 'cheerio';
import { setTimeout as delay } from 'node:timers/promises';
import type { CollectedMovie, CollectedResource, CollectionContext, Source } from '../shared/types.js';
import { readTextLimited, safeFetch, safeUrlLabel } from './upstream.js';
import { resolveDateRange, sourceDate } from './dates.js';

type Json = Record<string, any>;
interface RobotPolicy { rules: { allow: boolean; pattern: string }[]; delayMs: number }

export function parseRobots(text: string, userAgent: string): RobotPolicy {
  const groups: { agents: string[]; rules: RobotPolicy['rules']; delayMs: number }[] = [];
  let group: typeof groups[number] | null = null;
  let directives = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase(); const value = match[2].trim();
    if (key === 'user-agent') {
      if (!group || directives) { group = { agents: [], rules: [], delayMs: 0 }; groups.push(group); directives = false; }
      group.agents.push(value.toLowerCase());
    } else if (group) {
      directives = true;
      if ((key === 'allow' || key === 'disallow') && value) group.rules.push({ allow: key === 'allow', pattern: value });
      if (key === 'crawl-delay' && Number.isFinite(Number(value))) group.delayMs = Math.max(0, Number(value) * 1000);
    }
  }
  const agent = userAgent.toLowerCase();
  const score = (candidate: typeof groups[number]) => Math.max(-1, ...candidate.agents.map(value => value === '*' ? 0 : agent.includes(value) ? value.length : -1));
  const specificity = Math.max(-1, ...groups.map(score));
  return groups.filter(candidate => score(candidate) === specificity && specificity >= 0)
    .reduce<RobotPolicy>((result, candidate) => ({ rules: [...result.rules, ...candidate.rules], delayMs: Math.max(result.delayMs, candidate.delayMs) }), { rules: [], delayMs: 0 });
}

export function robotsAllows(policy: RobotPolicy, url: URL): boolean {
  const path = `${url.pathname}${url.search}`;
  const matches = policy.rules.filter(rule => {
    const escaped = rule.pattern.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}`).test(path);
  }).sort((a, b) => b.pattern.replace(/\*/g, '').length - a.pattern.replace(/\*/g, '').length || Number(b.allow) - Number(a.allow));
  return matches[0]?.allow ?? true;
}

function field(value: any, path: string): any {
  if (!path) return value;
  return path.split('.').reduce((item, key) => item?.[key], value);
}
function text(value: any): string { return value === undefined || value === null ? '' : String(value).trim(); }
function cleanHtml(value: any): string { const doc = load(text(value)); doc('script,style').remove(); return doc.root().text().replace(/\s+/g, ' ').trim(); }
function list(value: any): string[] { return Array.isArray(value) ? value.map(text).filter(Boolean) : text(value).split(/[,，、/]/).map(item => item.trim()).filter(Boolean); }
function absolute(value: string, base: string): string {
  if (!value.trim()) return '';
  try { const url = base ? new URL(value, base) : new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
}
function isHls(value: string): boolean { try { return /\.m3u8(?:$|[?#])/i.test(new URL(value).href); } catch { return false; } }
function withinLimit(count: number, maximum: number): boolean { return maximum === 0 || count < maximum; }
function pageKey(value: string): string { const url = new URL(value); url.hash = ''; return url.href; }

export function parsePlayUrls(value: unknown, names: unknown = '', base = ''): CollectedResource[] {
  const channels = text(names).split('$$$');
  const resources: CollectedResource[] = [];
  text(value).split('$$$').forEach((channel, index) => {
    channel.split('#').forEach((entry, number) => {
      const split = entry.indexOf('$');
      const episode = split >= 0 ? entry.slice(0, split).trim() : `正片${number ? ` ${number + 1}` : ''}`;
      const raw = split >= 0 ? entry.slice(split + 1).trim() : entry.trim();
      const url = absolute(raw, base);
      if (isHls(url)) resources.push({ name: channels[index] || `线路 ${index + 1}`, episode, url });
    });
  });
  return resources;
}

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

export function parseJsonMovie(item: Json, source: Source, pageUrl: string): CollectedMovie | null {
  const title = text(field(item, source.jsonTitleField) ?? item.vod_name ?? item.title ?? item.name);
  if (!title) return null;
  const resourceValue = field(item, source.jsonUrlField) ?? item.vod_play_url ?? item.m3u8 ?? item.url;
  let resources = parsePlayUrls(resourceValue, item.vod_play_from, source.baseUrl);
  if (Array.isArray(resourceValue)) resources = resourceValue.flatMap((resource: any, index: number) => {
    const url = absolute(text(resource.url ?? resource.m3u8 ?? resource), source.baseUrl);
    return isHls(url) ? [{ name: text(resource.name) || '默认线路', episode: text(resource.episode) || `第 ${index + 1} 集`, url }] : [];
  });
  const id = text(item.vod_id ?? item.id ?? item.externalId) || `${title}:${text(item.vod_year ?? item.year)}`;
  const detailPage = absolute(text(item.pageUrl ?? item.vod_detail_url), source.baseUrl) || pageUrl;
  resources = resources.map(resource => ({ ...resource, pageUrl: detailPage, resolvedAt: new Date().toISOString() }));
  return { externalId: id, pageUrl: detailPage,
    title, originalTitle: text(item.vod_en ?? item.originalTitle), year: text(item.vod_year ?? item.year),
    region: text(item.vod_area ?? item.region), type: text(item.type_name ?? item.type),
    genres: list(item.vod_class ?? item.genres), director: text(item.vod_director ?? item.director),
    actors: list(item.vod_actor ?? item.actors), description: cleanHtml(item.vod_content ?? item.description),
    poster: absolute(text(item.vod_pic ?? item.poster), source.baseUrl), rating: text(item.vod_douban_score ?? item.rating),
    status: text(item.vod_remarks ?? item.status),
    externalIds: item.vod_douban_id ? { douban: text(item.vod_douban_id) } : {}, resources };
}

class SourceClient {
  private lastRequest = 0;
  private robots = new Map<string, RobotPolicy>();
  constructor(private source: Source, private context: CollectionContext) {}
  private headers() { return { 'user-agent': this.context.settings.userAgent, accept: 'text/html,application/json;q=0.9,*/*;q=0.5', ...(this.source.referer ? { referer: this.source.referer } : {}) }; }
  private async policy(url: URL): Promise<RobotPolicy> {
    if (!this.source.respectRobots) return { rules: [], delayMs: 0 };
    const existing = this.robots.get(url.origin); if (existing) return existing;
    const response = await safeFetch(new URL('/robots.txt', url.origin), { headers: this.headers(), signal: this.context.signal });
    let result: RobotPolicy;
    if ([404, 410].includes(response.status)) { await response.body?.cancel(); result = { rules: [], delayMs: 0 }; }
    else if (!response.ok) {
      await response.body?.cancel();
      const message = `robots.txt 返回 HTTP ${response.status}，停止采集`;
      if ([408, 429].includes(response.status) || response.status >= 500) throw new Error(message);
      throw new StopError(message);
    }
    else result = parseRobots(await readTextLimited(response, 512 * 1024), this.context.settings.userAgent);
    this.lastRequest = Date.now(); this.robots.set(url.origin, result); return result;
  }
  async get(value: string): Promise<{ body: string; url: string }> {
    const url = new URL(value);
    const interval = Math.max(500, this.source.requestIntervalMs);
    for (let attempt = 0; attempt <= this.context.settings.maxRetries; attempt++) {
      try {
        const response = await safeFetch(url, { headers: this.headers(), signal: this.context.signal }, {
          timeoutMs: 15000 + Math.max(this.source.requestIntervalMs, 0),
          beforeRequest: async target => {
            const policy = await this.policy(target);
            if (!robotsAllows(policy, target)) throw new StopError(`robots.txt 禁止访问 ${safeUrlLabel(target.href)}`);
            const wait = Math.max(0, Math.max(interval, policy.delayMs) - (Date.now() - this.lastRequest));
            if (wait) await delay(wait, undefined, { signal: this.context.signal });
            this.lastRequest = Date.now();
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

/** Refresh one stored public player page without executing its scripts. */
export async function resolvePlaybackPage(source: Source, pageUrl: string, context: CollectionContext): Promise<CollectedResource[]> {
  const target = absolute(pageUrl, source.baseUrl);
  if (!target || new URL(target).origin !== new URL(source.baseUrl).origin) throw new Error('播放页必须位于当前采集源域名下');
  const content = await new SourceClient(source, context).get(target);
  const urls = content.body.trimStart().startsWith('#EXTM3U') ? [content.url] : extractPlayerUrls(content.body, content.url);
  if (!urls.length) throw new Error('播放页未发现公开 m3u8 地址；可能已失效或需要更新采集规则');
  const resolvedAt = new Date().toISOString();
  return urls.map(url => ({ name: source.name, episode: '正片', url, referer: content.url, pageUrl: content.url, resolvedAt }));
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

async function populateHtmlResources(plan: HtmlPlan, source: Source, client: SourceClient, context: CollectionContext): Promise<CollectedMovie> {
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
  const maxResourcePages = source.maxResourcePages;
  if (maxResourcePages > 0 && pending.length > maxResourcePages) context.log(`「${movie.title}」本次读取前 ${maxResourcePages} 个待采集播放页，剩余 ${pending.length - maxResourcePages} 个留待后续任务；下次优先最新未采集剧集`);
  const selectedPages = maxResourcePages === 0 ? orderedPending : orderedPending.slice(0, maxResourcePages);
  let attemptedPages = 0;
  const checkpoint = async () => {
    if (context.onCheckpoint) await context.onCheckpoint(structuredClone({ ...movie, resources: [...resources.values()] }));
  };
  await checkpoint();
  try { for (const play of selectedPages) {
    context.signal?.throwIfAborted();
    context.log(`正在采集「${movie.title}」${play.name} / ${play.episode}（${attemptedPages + 1}/${selectedPages.length} 个播放页）`);
    try {
      const content = await client.get(play.url);
      const urls = extractPlayerUrls(content.body, content.url);
      if (!urls.length) {
        const message = `「${movie.title}」${play.name} / ${play.episode} 未发现公开 m3u8，保留影片资料及已有资源`;
        context.log(message); context.onCollectionError?.(message);
      }
      for (const url of urls) resources.set(`${url}|${play.episode}|${play.name}`, { name: play.name, episode: play.episode, url, referer: content.url, pageUrl: content.url, resolvedAt: new Date().toISOString() });
    } catch (error) {
      if (error instanceof StopError || context.signal?.aborted) {
        await checkpoint().catch(() => {});
        throw error;
      }
      const message = `「${movie.title}」${play.episode} 播放页请求失败，保留影片资料及已有资源：${safeUrlLabel(play.url)}`;
      context.log(message); context.onCollectionError?.(message);
    }
    attemptedPages++;
    if (attemptedPages % 5 === 0) await checkpoint();
  } } finally { await checkpoint(); }
  movie.resources = [...resources.values()];
  if (!movie.resources.length) context.log(`「${movie.title}」未发现公开 m3u8 地址，已保留影片资料`);
  return movie;
}

export async function* collectSource(source: Source, context: CollectionContext): AsyncGenerator<CollectedMovie> {
  const dateRange = context.dateRange ?? (source.collectionMode === 'updates' ? resolveDateRange({}, context.settings.timezone) : undefined);
  let incompletePages = 0;
  if (dateRange) {
    if (source.adapter !== 'html') throw new Error('日期范围采集目前仅支持有明确更新时间的 HTML 列表');
    source = { ...source, maxPages: 0, maxItems: 0, maxResourcePages: 0 };
    const reportError = context.onCollectionError;
    context = { ...context, dateRange, onCollectionError: message => { incompletePages++; reportError?.(message); } };
    context.log(`采集更新日期 ${dateRange.startDate} 至 ${dateRange.endDate}（${dateRange.timezone}）`);
  }
  const client = new SourceClient(source, context);
  let pageUrl = absolute(source.listPath || '/', source.baseUrl);
  if (!pageUrl) throw new Error('源站列表地址无效');
  let count = 0;
  if (source.adapter === 'maccms' || source.adapter === 'json') {
    if (source.adapter === 'maccms' && (!source.listPath || source.listPath === '/')) pageUrl = new URL('/api.php/provide/vod/', source.baseUrl).href;
    const visitedPages = new Set<string>();
    const visitedMovies = new Set<string>();
    const seenItemPages = new Set<string>();
    for (let page = 1; withinLimit(page - 1, source.maxPages) && withinLimit(count, source.maxItems); page++) {
      const url = new URL(pageUrl);
      if (source.adapter === 'maccms') { url.searchParams.set('ac', 'detail'); url.searchParams.set('pg', String(page)); }
      const canonical = new URL(url);
      if (source.adapter === 'json' && !canonical.searchParams.has('page')) canonical.searchParams.set('page', '1');
      const key = pageKey(canonical.href);
      if (visitedPages.has(key)) { context.log('JSON 列表分页地址重复，已停止翻页'); break; }
      visitedPages.add(key);
      context.log(`读取列表第 ${page} 页`);
      const response = await client.get(url.href);
      let parsed: any; try { parsed = JSON.parse(response.body); } catch { throw new Error('源站未返回 JSON；请检查适配器和列表路径'); }
      const items = field(parsed, source.jsonItemsPath || 'list');
      if (!Array.isArray(items)) throw new Error(`JSON 列表路径 ${source.jsonItemsPath || 'list'} 没有返回数组`);
      if (!items.length) break;
      const movies = items.filter((item: any) => item && typeof item === 'object').map((item: Json) => parseJsonMovie(item, source, response.url)).filter((movie: CollectedMovie | null): movie is CollectedMovie => Boolean(movie));
      const itemPageKey = JSON.stringify(movies.map((movie: CollectedMovie) => movie.externalId).sort());
      if (seenItemPages.has(itemPageKey)) { context.log('JSON 列表返回重复影片页，已停止翻页'); break; }
      seenItemPages.add(itemPageKey);
      let newMovies = 0;
      for (const movie of movies) {
        if (visitedMovies.has(movie.externalId)) continue;
        visitedMovies.add(movie.externalId); newMovies++;
        yield movie; count++; if (!withinLimit(count, source.maxItems)) break;
      }
      if (!newMovies) { context.log('JSON 列表没有新的影片，已停止翻页'); break; }
      const pageCount = Number(parsed.pagecount ?? parsed.pageCount ?? parsed.total_pages);
      const currentPage = source.adapter === 'maccms' ? page : Number(parsed.page ?? parsed.currentPage ?? url.searchParams.get('page') ?? page);
      if (Number.isFinite(pageCount) && pageCount >= 0 && currentPage >= pageCount) break;
      if (source.adapter === 'json') {
        const next = parsed.next ?? parsed.nextPage;
        if (next === false || next === 0 || next === '' || ('next' in parsed && parsed.next === null) || ('nextPage' in parsed && parsed.nextPage === null)) break;
        if (typeof next === 'string' && !/^\d+$/.test(next)) {
          const nextUrl = absolute(next, response.url);
          if (!nextUrl || new URL(nextUrl).origin !== new URL(response.url).origin) throw new Error('JSON 下一页地址必须位于当前源站');
          pageUrl = nextUrl;
        } else if (next || Number.isFinite(pageCount)) {
          const nextUrl = new URL(response.url);
          nextUrl.searchParams.set('page', String(typeof next === 'number' || (typeof next === 'string' && /^\d+$/.test(next)) ? next : currentPage + 1));
          pageUrl = nextUrl.href;
        } else break;
      }
    }
  } else {
    const updatePlans: HtmlPlan[] = [];
    let reachedStart = false;
    const visited = new Set<string>();
    const visitedPages = new Set<string>();
    const visitedMovies = new Set<string>();
    for (let page = 1; withinLimit(page - 1, source.maxPages) && withinLimit(count, source.maxItems) && pageUrl; page++) {
      const key = pageKey(pageUrl);
      if (visitedPages.has(key)) {
        if (dateRange) throw new Error('更新列表分页形成循环，日期范围采集未完成');
        context.log('列表分页地址重复，已停止翻页'); break;
      }
      visitedPages.add(key);
      context.log(`读取页面第 ${page} 页`);
      const response = await client.get(pageUrl); const $ = load(response.body);
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
        if (!withinLimit(count, source.maxItems)) break;
        visited.add(detailUrl);
        let detail: { body: string; url: string };
        try { detail = await client.get(detailUrl); }
        catch (error) {
          if (error instanceof StopError || context.signal?.aborted) throw error;
          if (dateRange) {
            const message = `详情页请求失败，已记录后继续采集其他影片：${safeUrlLabel(detailUrl)}（${error instanceof Error ? error.message : '请求错误'}）`;
            context.log(message); context.onCollectionError?.(message); continue;
          }
          context.log(`详情页请求失败，已跳过：${safeUrlLabel(detailUrl)}`); continue;
        }
        const movie = parseHtmlMovie(detail.body, source, detail.url, dateRange?.timezone ?? context.settings.timezone);
        if (!movie) {
          if (dateRange) throw new Error(`详情页没有匹配片名，无法完成日期范围采集：${safeUrlLabel(detailUrl)}`);
          context.log('详情页没有匹配片名，已跳过'); continue;
        }
        if (dateRange) {
          const updatedOn = movie.sourceUpdatedOn;
          if (!updatedOn) throw new Error(`「${movie.title}」没有有效的源站更新时间，无法按日期筛选`);
          if (updatedOn < dateRange.startDate) {
            if (source.updatesSortedDescending) { reachedStart = true; break; }
            continue;
          }
          if (updatedOn > dateRange.endDate) continue;
        }
        if (visitedMovies.has(movie.externalId)) continue;
        visitedMovies.add(movie.externalId);
        const plan = htmlPlan(movie, detail, source);
        if (dateRange) {
          // Archive every matching title before long episode/line resolution.
          await context.onCheckpoint?.(structuredClone(movie));
          updatePlans.push(plan); count++;
          context.log(`已发现 ${count} 部日期范围内影片，正在读取影片资料`);
        } else {
          yield await populateHtmlResources(plan, source, client, context); count++;
        }
      }
      if (reachedStart) { context.log('已到达开始日期之前的记录，停止翻页'); break; }
      const nextHref = source.nextPageSelector ? $(source.nextPageSelector).first().attr('href') : undefined;
      const next = nextHref ? absolute(nextHref, response.url) : '';
      pageUrl = next && new URL(next).origin === new URL(response.url).origin && next !== pageUrl ? next : '';
    }
    for (let index = 0; index < updatePlans.length; index++) {
      context.signal?.throwIfAborted();
      context.log(`已归档 ${updatePlans.length} 部影片资料，补齐第 ${index + 1}/${updatePlans.length} 部播放资源`);
      yield await populateHtmlResources(updatePlans[index], source, client, context);
    }
  }
  context.log(`本次读取 ${count} 部影片`);
  if (dateRange && incompletePages) throw new Error(`已读取 ${count} 部影片；${incompletePages} 个页面未完整取得内容，详见任务错误，可重新采集补齐`);
}
