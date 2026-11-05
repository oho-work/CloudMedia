import { randomUUID } from 'node:crypto';
import type { ProbeResult, Settings, Source, State } from '../shared/types.js';
import { BEIJING_TIMEZONE, DEFAULT_DAILY_TIME, normalizedDailyTimes } from '../shared/schedule-settings.js';
const defaultResourceSelector = 'a[href*="/vodplay/"], a[href$=".m3u8"], a[href*=".m3u8?"], a[href*=".m3u8#"]';
// Chrome Stable 157.0.8103.38, verified against Google's Chrome for Testing feed
// on 2026-11-04. Modern desktop Chrome reduces the minor/build/patch UA fields.
export const defaultChromeUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const legacyDefaultUserAgent = 'CloudMedia/0.1 (+local media catalog; public pages only)';
export const defaultSettings: Settings = {
  dailyTime: DEFAULT_DAILY_TIME, dailyTimes: [DEFAULT_DAILY_TIME], timezone: BEIJING_TIMEZONE, schedulerEnabled: true,
  probeEnabled: false, sampleSegments: 1, sampleBytes: 262144,
  probeTimeoutMs: 15000, preferredQuality: 'highest', maxRetries: 2,
  resourceRefreshHours: 168,
  userAgent: defaultChromeUserAgent,
};
/** Normalize old schedules and the former built-in UA while retaining custom browser strings. */
export function settingsDefaults(input: Partial<Settings> = {}): Settings {
  const userAgent = !input.userAgent?.trim() || input.userAgent.trim() === legacyDefaultUserAgent
    ? defaultChromeUserAgent : input.userAgent;
  const dailyTimes = normalizedDailyTimes(input);
  return { ...defaultSettings, ...input, probeEnabled: false, userAgent, dailyTimes, dailyTime: dailyTimes[0], timezone: BEIJING_TIMEZONE };
}
export const emptyProbe = (): ProbeResult => ({ status: 'pending', checkedAt: null,
  width: null, height: null, bandwidth: null, speedMbps: null, latencyMs: null,
  bytesRead: 0, durationMs: 0, sampledSegments: 0, playlistUrl: null, error: null });
export function sourceDefaults(input: Partial<Source> = {}): Source {
  const normalized = { ...input } as Partial<Source> & Record<string, unknown>;
  delete normalized.jsonItemsPath; delete normalized.jsonTitleField; delete normalized.jsonUrlField;
  if (normalized.resourceSelector === 'a[href*="/vodplay/"], a[href$=".m3u8"]') normalized.resourceSelector = defaultResourceSelector;
  // Recognize the bundled update feed on load as well as on first setup, so an
  // existing installation gains today's scope without changing its source ID.
  const bundledUpdates = /^555\s*影视$/.test(input.name || '') && input.listPath === '/label/new.html';
  return { id: randomUUID(), name: '', baseUrl: '', enabled: true,
    listPath: '/', detailLinkSelector: 'a[href*="/voddetail/"]', titleSelector: 'h1',
    posterSelector: '.module-item-pic img, .vodlist_thumb img', descriptionSelector: '.module-info-introduction, .vod_content',
    resourceSelector: defaultResourceSelector, nextPageSelector: 'a[title="下一页"]',
    requestIntervalMs: 2500, concurrency: 1,
    createdAt: new Date().toISOString(), lastRunAt: null, lastError: null,
    updatesSortedDescending: bundledUpdates,
    ...normalized,
    adapter: 'html',
    collectionMode: input.collectionMode === 'updates' ? 'today' : input.collectionMode || (bundledUpdates ? 'today' : 'all'),
    maxPages: 0, maxItems: 0, maxResourcePages: 0, respectRobots: false, referer: '',
    ...(bundledUpdates && input.detailLinkSelector === 'a[href*="/voddetail/"]' ? { detailLinkSelector: '.module-poster-item[href*="/voddetail/"]' } : {}),
  };
}
export const initialState = (): State => ({ sources: [
  sourceDefaults({ name: '555 影视', baseUrl: 'https://www.555k03.com', listPath: '/label/new.html', enabled: false }),
], movies: [], resources: [], runs: [], settings: settingsDefaults() });
