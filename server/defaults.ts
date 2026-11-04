import { randomUUID } from 'node:crypto';
import type { ProbeResult, Settings, Source, State } from '../shared/types.js';
export const defaultSettings: Settings = {
  dailyTime: '03:00', timezone: 'Asia/Shanghai', schedulerEnabled: true,
  probeEnabled: true, sampleSegments: 1, sampleBytes: 262144,
  probeTimeoutMs: 15000, preferredQuality: 'highest', maxRetries: 2,
  resourceRefreshHours: 168,
  userAgent: 'CloudMedia/0.1 (+local media catalog; public pages only)',
};
export const emptyProbe = (): ProbeResult => ({ status: 'pending', checkedAt: null,
  width: null, height: null, bandwidth: null, speedMbps: null, latencyMs: null,
  bytesRead: 0, durationMs: 0, sampledSegments: 0, playlistUrl: null, error: null });
export function sourceDefaults(input: Partial<Source> = {}): Source {
  // Recognize the bundled update feed on load as well as on first setup, so an
  // existing installation gains today's scope without changing its source ID.
  const bundledUpdates = input.adapter !== 'json' && input.adapter !== 'maccms' && /^555\s*影视$/.test(input.name || '') && input.listPath === '/label/new.html';
  return { id: randomUUID(), name: '', baseUrl: '', adapter: 'html', enabled: true,
    listPath: '/', detailLinkSelector: 'a[href*="/voddetail/"]', titleSelector: 'h1',
    posterSelector: '.module-item-pic img, .vodlist_thumb img', descriptionSelector: '.module-info-introduction, .vod_content',
    resourceSelector: 'a[href*="/vodplay/"], a[href$=".m3u8"]', nextPageSelector: 'a[title="下一页"]',
    jsonItemsPath: 'list', jsonTitleField: 'vod_name', jsonUrlField: 'vod_play_url',
    requestIntervalMs: 2500, maxPages: 2, maxItems: 30, maxResourcePages: 30, respectRobots: true,
    referer: '', createdAt: new Date().toISOString(), lastRunAt: null, lastError: null,
    collectionMode: bundledUpdates ? 'updates' : 'all', updatesSortedDescending: bundledUpdates,
    ...input,
    ...(bundledUpdates && input.detailLinkSelector === 'a[href*="/voddetail/"]' ? { detailLinkSelector: '.module-poster-item[href*="/voddetail/"]' } : {}),
  };
}
export const initialState = (): State => ({ sources: [
  sourceDefaults({ name: '555 影视', baseUrl: 'https://www.555k03.com', listPath: '/label/new.html', enabled: false }),
  sourceDefaults({ name: 'zc0577', baseUrl: 'https://m.zc0577.com', enabled: false }),
], movies: [], resources: [], runs: [], settings: { ...defaultSettings } });
