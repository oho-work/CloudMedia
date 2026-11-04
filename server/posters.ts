import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Settings } from '../shared/types.js';
import { safeFetch } from './upstream.js';
import type { PosterBinary, PosterStorage } from './poster-storage.js';

export interface PosterFile {
  path: string; sha256: string; mime: string; bytes: number; downloadedAt: string;
}

export const posterDirectory = () => path.resolve(process.env.POSTER_DIR || './data/posters');
const maxBytes = 4 * 1024 * 1024;
const localPattern = /^\/media\/posters\/([a-f0-9]{64})\.(jpg|png|webp|avif|gif)$/;
const formats: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif',
};

function validJpeg(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return false;
  let offset = 2, frame = false, scan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) return frame && scan && offset === bytes.length;
    if (marker === 0x01) continue;
    if (marker === undefined || marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset), end = offset + length;
    if (length < 2 || end > bytes.length) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 11 || bytes[offset + 7] === 0 || length !== 8 + bytes[offset + 7] * 3 ||
        bytes.readUInt16BE(offset + 3) === 0 || bytes.readUInt16BE(offset + 5) === 0) return false;
      frame = true;
    }
    offset = end;
    if (marker === 0xda) {
      const components = bytes[end - length + 2];
      if (!frame || !components || length !== 6 + components * 2) return false;
      let data = 0;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; data++; continue; }
        const next = bytes[offset + 1];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { offset += 2; data++; continue; }
        break;
      }
      if (!data) return false;
      scan = true;
    }
  }
  return false;
}

function validGif(bytes: Buffer): boolean {
  if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) ||
    bytes.readUInt16LE(6) === 0 || bytes.readUInt16LE(8) === 0) return false;
  let offset = 13 + ((bytes[10] & 0x80) ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0), image = false;
  const subblocks = (requireData: boolean) => {
    let total = 0;
    while (offset < bytes.length) {
      const length = bytes[offset++];
      if (!length) return !requireData || total > 0;
      if (offset + length > bytes.length) return false;
      total += length; offset += length;
    }
    return false;
  };
  while (offset < bytes.length) {
    const block = bytes[offset++];
    if (block === 0x3b) return image && offset === bytes.length;
    if (block === 0x21) { offset++; if (!subblocks(false)) return false; continue; }
    if (block !== 0x2c || offset + 9 > bytes.length || bytes.readUInt16LE(offset + 4) === 0 || bytes.readUInt16LE(offset + 6) === 0) return false;
    const packed = bytes[offset + 8];
    offset += 9 + ((packed & 0x80) ? 3 * 2 ** ((packed & 7) + 1) : 0);
    if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) return false;
    offset++;
    if (!subblocks(true)) return false;
    image = true;
  }
  return false;
}

function validWebp(bytes: Buffer): boolean {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.readUInt32LE(4) + 8 !== bytes.length || bytes.toString('ascii', 8, 12) !== 'WEBP') return false;
  const chunks = (start: number, end: number, animation: boolean): boolean => {
    let offset = start, image = false;
    while (offset + 8 <= end) {
      const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), data = offset + 8;
      const next = data + length + (length & 1);
      if (next > end) return false;
      if (type === 'VP8 ') {
        if (length <= 10 || (bytes[data] & 1) !== 0 || bytes.toString('hex', data + 3, data + 6) !== '9d012a' ||
          !(bytes.readUInt16LE(data + 6) & 0x3fff) || !(bytes.readUInt16LE(data + 8) & 0x3fff)) return false;
        image = true;
      } else if (type === 'VP8L') {
        if (length <= 5 || bytes[data] !== 0x2f || bytes.readUInt32LE(data + 1) >>> 29 !== 0) return false;
        image = true;
      } else if (type === 'VP8X') {
        if (length !== 10 || (bytes[data] & 0xc1) !== 0 || bytes.readUIntBE(data + 1, 3) !== 0) return false;
      } else if (type === 'ANMF') {
        if (!animation || length <= 16 || !chunks(data + 16, data + length, false)) return false;
        image = true;
      }
      offset = next;
    }
    return image && offset === end;
  };
  return chunks(12, bytes.length, true);
}

interface ImageBox { type: string; data: number; end: number }
function imageBoxes(bytes: Buffer, start: number, end: number): ImageBox[] | null {
  const result: ImageBox[] = [];
  for (let offset = start; offset < end;) {
    if (offset + 8 > end) return null;
    let size = bytes.readUInt32BE(offset), header = 8;
    if (size === 1) {
      if (offset + 16 > end) return null;
      const largeSize = bytes.readBigUInt64BE(offset + 8);
      if (largeSize > BigInt(end - offset)) return null;
      size = Number(largeSize); header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) return null;
    result.push({ type: bytes.toString('ascii', offset + 4, offset + 8), data: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}

function validAvif(bytes: Buffer): boolean {
  const boxes = imageBoxes(bytes, 0, bytes.length);
  const ftyp = boxes?.[0];
  if (!boxes || !ftyp || ftyp.type !== 'ftyp' || ftyp.end - ftyp.data < 8 || (ftyp.end - ftyp.data) % 4 !== 0) return false;
  let brand = ['avif', 'avis'].includes(bytes.toString('ascii', ftyp.data, ftyp.data + 4));
  for (let offset = ftyp.data + 8; offset + 4 <= ftyp.end; offset += 4) brand ||= ['avif', 'avis'].includes(bytes.toString('ascii', offset, offset + 4));
  const meta = boxes.find(box => box.type === 'meta');
  if (!brand || !meta || meta.end - meta.data < 4) return false;
  const metadata = imageBoxes(bytes, meta.data + 4, meta.end);
  const properties = metadata?.find(box => box.type === 'iprp');
  // HEIF permits either a top-level mdat or image data embedded in meta/idat.
  if (!metadata || !properties || ![...boxes, ...metadata].some(box => ['mdat', 'idat'].includes(box.type) && box.end > box.data)) return false;
  const propertyBoxes = imageBoxes(bytes, properties.data, properties.end);
  const container = propertyBoxes?.find(box => box.type === 'ipco');
  if (!container) return false;
  const values = imageBoxes(bytes, container.data, container.end);
  return !!values?.some(box => box.type === 'ispe' && box.end - box.data === 12 &&
    bytes.readUInt32BE(box.data + 4) > 0 && bytes.readUInt32BE(box.data + 8) > 0) &&
    values.some(box => box.type === 'av1C' && box.end - box.data >= 4 && bytes[box.data] === 0x81);
}

function detectMime(bytes: Buffer): string | null {
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) {
    let sawData = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
      if (end > bytes.length) return null;
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (type === 'IDAT' && length > 0) sawData = true;
      if (type === 'IEND') return sawData && length === 0 && end === bytes.length ? 'image/png' : null;
      offset = end;
    }
    return null;
  }
  if (validJpeg(bytes)) return 'image/jpeg';
  if (validGif(bytes)) return 'image/gif';
  if (validWebp(bytes)) return 'image/webp';
  if (validAvif(bytes)) return 'image/avif';
  return null;
}

/** Validate archived bytes before returning their metadata or serving them. */
export function inspectPosterBinary(value: PosterBinary): PosterFile | null {
  const match = localPattern.exec(value.path);
  if (!match || !Buffer.isBuffer(value.data) || value.data.length <= 0 || value.data.length > maxBytes) return null;
  const mime = detectMime(value.data);
  if (!mime || mime !== value.mime || formats[mime] !== match[2] || !Number.isFinite(Date.parse(value.downloadedAt))) return null;
  const sha256 = createHash('sha256').update(value.data).digest('hex');
  if (value.sha256 !== sha256) return null;
  return { path: value.path, sha256, mime, bytes: value.data.length, downloadedAt: value.downloadedAt };
}

/** Validate an archived poster without contacting its former upstream. */
export async function inspectPoster(localPath: string, storage?: PosterStorage): Promise<PosterFile | null> {
  const match = localPattern.exec(localPath);
  if (!match) return null;
  if (storage) {
    const stored = await storage.get(localPath);
    return stored?.path === localPath ? inspectPosterBinary(stored) : null;
  }
  const filename = path.join(posterDirectory(), `${match[1]}.${match[2]}`);
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes) return null;
    const file = await open(filename, 'r');
    let bytes: Buffer;
    try {
      // Bound reads independently of stat, including when a file changes during inspection.
      const buffer = Buffer.alloc(info.size + 1);
      let total = 0;
      while (total < buffer.length) {
        const chunk = await file.read(buffer, total, buffer.length - total, null);
        if (!chunk.bytesRead) break;
        total += chunk.bytesRead;
      }
      if (total !== info.size) return null;
      bytes = buffer.subarray(0, total);
    } finally { await file.close(); }
    const mime = detectMime(bytes);
    if (!mime || formats[mime] !== match[2]) return null;
    return { path: localPath, sha256: createHash('sha256').update(bytes).digest('hex'), mime,
      bytes: bytes.length, downloadedAt: info.mtime.toISOString() };
  } catch { return null; }
}

/** Download a bounded, signature-checked image into permanent content-addressed storage. */
export async function archivePoster(url: string, referer: string, settings: Settings, signal?: AbortSignal,
  beforeRequest?: (url: URL) => Promise<void>, storage?: PosterStorage): Promise<PosterFile> {
  signal?.throwIfAborted();
  if (url.startsWith('/media/posters/')) {
    const existing = await inspectPoster(url, storage);
    if (!existing) throw new Error('已归档海报不存在或内容无效');
    return existing;
  }
  const downloadSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10000)]);
  const response = await safeFetch(url, {
    headers: { 'User-Agent': settings.userAgent, ...(referer ? { Referer: referer } : {}) }, signal: downloadSignal,
  }, { timeoutMs: 10000, beforeRequest });
  const declaredMime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
  if (!response.ok || !formats[declaredMime] || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('上游海报响应无效或超过 4 MiB 大小限制');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('上游海报为空');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      downloadSignal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('上游海报超过 4 MiB 大小限制');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  downloadSignal.throwIfAborted();
  const bytes = Buffer.concat(chunks);
  const mime = detectMime(bytes);
  if (!mime || mime !== declaredMime) throw new Error('海报内容不是有效的受支持图片');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const filename = `${sha256}.${formats[mime]}`;
  const localPath = `/media/posters/${filename}`;
  const existing = await inspectPoster(localPath, storage);
  if (existing?.sha256 === sha256) return existing;
  if (storage) {
    const downloadedAt = new Date().toISOString();
    await storage.put({ path: localPath, sha256, mime, data: bytes, downloadedAt });
    return { path: localPath, sha256, mime, bytes: bytes.length, downloadedAt };
  }
  const folder = posterDirectory();
  await mkdir(folder, { recursive: true });
  const temporary = path.join(folder, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    downloadSignal.throwIfAborted();
    await rename(temporary, path.join(folder, filename));
  } finally { await unlink(temporary).catch(() => {}); }
  const info = await stat(path.join(folder, filename));
  return { path: localPath, sha256, mime, bytes: bytes.length, downloadedAt: info.mtime.toISOString() };
}

/** Compatibility wrapper: failures reject so callers can never expose remote fallback URLs. */
export async function cachePoster(url: string, referer: string, settings: Settings, storage?: PosterStorage): Promise<string> {
  return (await archivePoster(url, referer, settings, undefined, undefined, storage)).path;
}
