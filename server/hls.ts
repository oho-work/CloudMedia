import { performance } from 'node:perf_hooks';
import type { ProbeResult, Resource, Settings } from '../shared/types.js';
import { emptyProbe } from './defaults.js';
import { readTextLimited, safeFetch } from './upstream.js';

export interface HlsVariant { url: string; width: number | null; height: number | null; bandwidth: number | null }
export interface HlsSegment { url: string; range?: { length: number; offset: number } }
export interface HlsPlaylist { variants: HlsVariant[]; segments: HlsSegment[]; map: HlsSegment | null; encrypted: boolean }

/** Quoted HLS attributes may contain commas (CODECS and signed URI values). */
export function parseAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))(?:,|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) attributes[match[1].toUpperCase()] = match[2] ?? match[3];
  return attributes;
}

function httpUrl(value: string, base: string): string {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('播放清单包含不支持的地址协议');
  return url.href;
}

export function parsePlaylist(text: string, baseUrl: string): HlsPlaylist {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(line => line.trim());
  if (lines[0] !== '#EXTM3U') throw new Error('响应不是有效的 M3U8 清单');
  const result: HlsPlaylist = { variants: [], segments: [], map: null, encrypted: false };
  let variant: Record<string, string> | null = null;
  let rangeValue: string | null = null;
  const rangeEnds = new Map<string, number>();
  for (const line of lines.slice(1)) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) { variant = parseAttributes(line.slice(18)); continue; }
    if (line.startsWith('#EXT-X-BYTERANGE:')) { rangeValue = line.slice(17); continue; }
    if (line.startsWith('#EXT-X-KEY:')) {
      result.encrypted ||= parseAttributes(line.slice(11)).METHOD !== 'NONE';
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attributes = parseAttributes(line.slice(11));
      if (attributes.URI) {
        result.map = { url: httpUrl(attributes.URI, baseUrl) };
        if (attributes.BYTERANGE) result.map.range = parseRange(attributes.BYTERANGE, 0);
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    const url = httpUrl(line, baseUrl);
    if (variant) {
      const resolution = variant.RESOLUTION?.match(/^(\d+)x(\d+)$/i);
      const bandwidth = Number(variant['AVERAGE-BANDWIDTH'] ?? variant.BANDWIDTH);
      result.variants.push({ url,
        width: resolution ? Number(resolution[1]) : null,
        height: resolution ? Number(resolution[2]) : null,
        bandwidth: Number.isFinite(bandwidth) && bandwidth > 0 ? bandwidth : null });
      variant = null;
    } else {
      const segment: HlsSegment = { url };
      if (rangeValue) {
        segment.range = parseRange(rangeValue, rangeEnds.get(url) ?? 0);
        rangeEnds.set(url, segment.range.offset + segment.range.length);
      }
      rangeValue = null;
      result.segments.push(segment);
    }
  }
  if (!result.variants.length && !result.segments.length) throw new Error('M3U8 清单没有可用的视频分片或码率版本');
  return result;
}

function parseRange(value: string, defaultOffset: number): { length: number; offset: number } {
  const match = value.match(/^(\d+)(?:@(\d+))?$/);
  if (!match || Number(match[1]) < 1) throw new Error('无效的 HLS 字节范围');
  return { length: Number(match[1]), offset: match[2] ? Number(match[2]) : defaultOffset };
}

/** Rewrite every URI, including key/init/media/rendition attributes, for same-origin playback. */
export function rewritePlaylist(text: string, baseUrl: string, rewrite: (url: string) => string): string {
  if (!text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) throw new Error('响应不是有效的 M3U8 清单');
  return text.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (!trimmed.startsWith('#')) return rewrite(httpUrl(trimmed, baseUrl));
    return line.replace(/(\bURI\s*=\s*")([^"]*)(")/g, (_match, prefix, uri, suffix) =>
      `${prefix}${rewrite(httpUrl(uri, baseUrl))}${suffix}`);
  }).join('\n');
}

interface Sample { bytes: Uint8Array; elapsedMs: number; latencyMs: number }
async function readSample(segment: HlsSegment, resource: Resource, settings: Settings, signal?: AbortSignal): Promise<Sample> {
  signal?.throwIfAborted();
  const offset = segment.range?.offset ?? 0;
  const limit = Math.min(settings.sampleBytes, segment.range?.length ?? settings.sampleBytes);
  const headers: Record<string, string> = {
    'User-Agent': settings.userAgent, Range: `bytes=${offset}-${offset + limit - 1}`,
    'Accept-Encoding': 'identity',
  };
  if (resource.referer) headers.Referer = resource.referer;
  const started = performance.now();
  const response = await safeFetch(segment.url, { headers, signal }, { timeoutMs: settings.probeTimeoutMs });
  const latencyMs = performance.now() - started;
  if (!response.ok) { await response.body?.cancel(); throw new Error(`视频分片请求失败（HTTP ${response.status}）`); }
  if (offset > 0 && response.status !== 206) {
    await response.body?.cancel();
    throw new Error('播放源不支持所需的分片字节范围');
  }
  if (response.status === 206) {
    const actualOffset = response.headers.get('content-range')?.match(/^bytes\s+(\d+)-/i)?.[1];
    if (actualOffset !== undefined && Number(actualOffset) !== offset) {
      await response.body?.cancel(); throw new Error('播放源返回了错误的分片字节范围');
    }
  }
  if (/text\/html|application\/(json|xml)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel(); throw new Error('视频分片响应是网页或错误信息');
  }
  if (!response.body) throw new Error('视频分片响应为空');
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (total < limit) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      const bytes = value.subarray(0, Math.min(value.byteLength, limit - total));
      chunks.push(bytes); total += bytes.byteLength;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!total) throw new Error('视频分片没有返回数据');
  return { bytes: Buffer.concat(chunks), elapsedMs: Math.max(performance.now() - started, 0.1), latencyMs };
}

/** Samples a bounded prefix of N actual segments; manifest bandwidth is kept separate from measured speed. */
export async function probeResource(resource: Resource, settings: Settings, signal?: AbortSignal): Promise<ProbeResult> {
  const result: ProbeResult = { ...emptyProbe(), checkedAt: new Date().toISOString() };
  let playlistUrl = resource.url;
  const visited = new Set<string>();
  try {
    signal?.throwIfAborted();
    if (!Number.isInteger(settings.sampleSegments) || settings.sampleSegments < 1 || settings.sampleSegments > 20 ||
      !Number.isInteger(settings.sampleBytes) || settings.sampleBytes < 1024 || settings.sampleBytes > 4 * 1024 * 1024) {
      throw new Error('检测配置超出限制：分片数 1–20，每片 1KB–4MB');
    }
    let playlist: HlsPlaylist | null = null;
    for (let depth = 0; depth < 5; depth++) {
      signal?.throwIfAborted();
      if (visited.has(playlistUrl)) throw new Error('M3U8 清单出现循环引用');
      visited.add(playlistUrl);
      const headers: Record<string, string> = { 'User-Agent': settings.userAgent, 'Accept-Encoding': 'identity' };
      if (resource.referer) headers.Referer = resource.referer;
      const response = await safeFetch(playlistUrl, { headers, signal }, { timeoutMs: settings.probeTimeoutMs });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`M3U8 请求失败（HTTP ${response.status}）`); }
      playlistUrl = response.url || playlistUrl;
      result.playlistUrl = playlistUrl;
      playlist = parsePlaylist(await readTextLimited(response, 1024 * 1024), playlistUrl);
      if (!playlist.variants.length) break;
      const variants = [...playlist.variants].sort((a, b) =>
        ((a.width ?? 0) * (a.height ?? 0) - (b.width ?? 0) * (b.height ?? 0)) ||
        ((a.bandwidth ?? 0) - (b.bandwidth ?? 0)));
      const selected = settings.preferredQuality === 'lowest' ? variants[0] : variants[variants.length - 1];
      result.width = selected.width ?? result.width;
      result.height = selected.height ?? result.height;
      result.bandwidth = selected.bandwidth ?? result.bandwidth;
      playlistUrl = selected.url;
      playlist = null;
    }
    if (!playlist) throw new Error('M3U8 清单嵌套层数超过限制');
    for (const segment of playlist.segments.slice(0, settings.sampleSegments)) {
      signal?.throwIfAborted();
      const sample = await readSample(segment, resource, settings, signal);
      result.bytesRead += sample.bytes.byteLength;
      result.durationMs += sample.elapsedMs;
      result.latencyMs ??= sample.latencyMs;
      result.sampledSegments++;
      if (!result.width && !playlist.encrypted) {
        const dimensions = dimensionsFromMedia(sample.bytes);
        if (dimensions) { result.width = dimensions.width; result.height = dimensions.height; }
      }
    }
    // A fragmented MP4's dimensions usually live in its small init segment, not a media fragment.
    // This extra bounded request is made only when neither master nor sampled media gave dimensions.
    if (!result.width && playlist.map && !playlist.encrypted) {
      try {
        const init = await readSample(playlist.map, resource, settings, signal);
        const dimensions = dimensionsFromMedia(init.bytes);
        if (dimensions) { result.width = dimensions.width; result.height = dimensions.height; }
      } catch {
        signal?.throwIfAborted();
        /* Missing optional init metadata does not invalidate the successfully sampled stream. */
      }
    }
    result.status = 'ok';
  } catch (error) {
    result.status = 'error';
    result.error = error instanceof Error ? error.message : '播放源检测失败';
  }
  if (result.durationMs > 0) result.speedMbps = Number((result.bytesRead * 8 / result.durationMs / 1000).toFixed(3));
  result.durationMs = Math.round(result.durationMs);
  if (result.latencyMs !== null) result.latencyMs = Math.round(result.latencyMs);
  return result;
}

export interface Dimensions { width: number; height: number }
function validDimensions(width: number, height: number): Dimensions | null {
  return Number.isInteger(width) && Number.isInteger(height) && width >= 16 && height >= 16 && width <= 16384 && height <= 16384
    ? { width, height } : null;
}

/** Read clear H.264 SPS from MPEG-TS or dimensions from an MP4 initialization segment. */
export function dimensionsFromMedia(bytes: Uint8Array): Dimensions | null {
  try { return dimensionsFromMp4(bytes) ?? dimensionsFromH264(extractTsVideo(bytes)); }
  catch { return null; }
}

function dimensionsFromMp4(bytes: Uint8Array): Dimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
  function walk(start: number, end: number, depth: number): Dimensions | null {
    if (depth > 8) return null;
    for (let offset = start; offset + 8 <= end;) {
      let size = view.getUint32(offset);
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) break;
        const high = view.getUint32(offset + 8), low = view.getUint32(offset + 12);
        size = high * 4294967296 + low; header = 16;
      } else if (size === 0) size = end - offset;
      if (size < header || offset + size > end) break;
      if (type === 'tkhd' && size >= header + 84) {
        const found = validDimensions(view.getUint32(offset + size - 8) / 65536, view.getUint32(offset + size - 4) / 65536);
        if (found) return found;
      }
      if (containers.has(type)) {
        const found = walk(offset + header, offset + size, depth + 1);
        if (found) return found;
      }
      offset += size;
    }
    return null;
  }
  return walk(0, bytes.byteLength, 0);
}

function extractTsVideo(bytes: Uint8Array): Uint8Array {
  // Only reconstruct payloads of the video PID discovered from a PES start.
  // Other PIDs (audio, PAT, PMT) must not be mixed into SPS bytes across packet boundaries.
  let start = -1;
  for (let i = 0; i < Math.min(188, bytes.length - 188); i++) {
    if (bytes[i] === 0x47 && bytes[i + 188] === 0x47) { start = i; break; }
  }
  if (start < 0) return bytes;
  const payloads: Uint8Array[] = [];
  let videoPid: number | null = null;
  for (let offset = start; offset + 188 <= bytes.length; offset += 188) {
    if (bytes[offset] !== 0x47 || (bytes[offset + 1] & 0x80)) continue;
    const pid = ((bytes[offset + 1] & 0x1f) << 8) | bytes[offset + 2];
    const control = (bytes[offset + 3] >> 4) & 3;
    if (!(control & 1)) continue;
    let payload = offset + 4;
    if (control & 2) payload += 1 + bytes[payload];
    if (payload >= offset + 188) continue;
    if (bytes[offset + 1] & 0x40) {
      if (bytes[payload] !== 0 || bytes[payload + 1] !== 0 || bytes[payload + 2] !== 1) continue;
      const streamId = bytes[payload + 3];
      if (streamId >= 0xe0 && streamId <= 0xef) {
        videoPid ??= pid;
        payload += 9 + bytes[payload + 8];
      } else continue;
    }
    if (pid === videoPid && payload < offset + 188) payloads.push(bytes.subarray(payload, offset + 188));
  }
  return payloads.length ? Buffer.concat(payloads) : bytes;
}

function dimensionsFromH264(bytes: Uint8Array): Dimensions | null {
  for (let i = 0; i + 5 < bytes.length; i++) {
    const prefix = bytes[i] === 0 && bytes[i + 1] === 0
      ? (bytes[i + 2] === 1 ? 3 : bytes[i + 2] === 0 && bytes[i + 3] === 1 ? 4 : 0) : 0;
    if (!prefix || (bytes[i + prefix] & 0x1f) !== 7) continue;
    let end = i + prefix + 1;
    while (end + 3 < bytes.length && !(bytes[end] === 0 && bytes[end + 1] === 0 &&
      (bytes[end + 2] === 1 || (bytes[end + 2] === 0 && bytes[end + 3] === 1)))) end++;
    if (end + 3 >= bytes.length) end = bytes.length;
    const found = parseSps(bytes.subarray(i + prefix + 1, end));
    if (found) return found;
  }
  return null;
}

function parseSps(escaped: Uint8Array): Dimensions | null {
  const rbsp: number[] = [];
  for (let i = 0; i < escaped.length; i++) {
    if (i >= 2 && escaped[i] === 3 && escaped[i - 1] === 0 && escaped[i - 2] === 0) continue;
    rbsp.push(escaped[i]);
  }
  let position = 0;
  const bits = (count: number) => {
    if (position + count > rbsp.length * 8) throw new Error('SPS 数据不足');
    let value = 0;
    for (let i = 0; i < count; i++, position++) value = value * 2 + ((rbsp[position >> 3] >> (7 - (position & 7))) & 1);
    return value;
  };
  const ue = () => {
    let zeros = 0;
    while (bits(1) === 0) if (++zeros > 31) throw new Error('无效的 SPS 数据');
    return 2 ** zeros - 1 + bits(zeros);
  };
  const se = () => { const value = ue(); return value & 1 ? (value + 1) / 2 : -value / 2; };
  const profile = bits(8); bits(16); ue();
  let chroma = 1;
  let separateColorPlane = 0;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = ue();
    if (chroma === 3) separateColorPlane = bits(1);
    ue(); ue(); bits(1);
    if (bits(1)) for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
      if (!bits(1)) continue;
      let lastScale = 8, nextScale = 8;
      for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
        if (nextScale !== 0) nextScale = (lastScale + se() + 256) % 256;
        lastScale = nextScale === 0 ? lastScale : nextScale;
      }
    }
  }
  ue();
  const picOrder = ue();
  if (picOrder === 0) ue();
  else if (picOrder === 1) { bits(1); se(); se(); const count = ue(); if (count > 256) return null; for (let i = 0; i < count; i++) se(); }
  ue(); bits(1);
  const widthMbs = ue() + 1, heightMapUnits = ue() + 1;
  const frameMbsOnly = bits(1);
  if (!frameMbsOnly) bits(1);
  bits(1);
  let left = 0, right = 0, top = 0, bottom = 0;
  if (bits(1)) { left = ue(); right = ue(); top = ue(); bottom = ue(); }
  const chromaArray = separateColorPlane ? 0 : chroma;
  const cropX = chromaArray === 0 || chromaArray === 3 ? 1 : 2;
  const cropY = (chromaArray === 1 ? 2 : 1) * (2 - frameMbsOnly);
  return validDimensions(widthMbs * 16 - cropX * (left + right), heightMapUnits * 16 * (2 - frameMbsOnly) - cropY * (top + bottom));
}
