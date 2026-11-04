import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Settings } from '../shared/types.js';
import { safeFetch } from './upstream.js';

export const posterDirectory = () => path.resolve(process.env.POSTER_DIR || './data/posters');
const formats: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif' };
export async function cachePoster(url: string, referer: string, settings: Settings): Promise<string> {
  if (!url || url.startsWith('/media/posters/')) return url;
  const digest = createHash('sha256').update(url).digest('hex');
  const folder = posterDirectory();
  for (const extension of Object.values(formats)) {
    try { await access(path.join(folder, `${digest}.${extension}`)); return `/media/posters/${digest}.${extension}`; } catch {}
  }
  const response = await safeFetch(url, { headers: { 'User-Agent': settings.userAgent, ...(referer ? { Referer: referer } : {}) } }, { timeoutMs: 10000 });
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
  const extension = formats[mime];
  if (!response.ok || !extension) { await response.body?.cancel(); return url; }
  const maxBytes = 4 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); return url; }
  const reader = response.body?.getReader(); if (!reader) return url;
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > maxBytes) return url;
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!total) return url;
  await mkdir(folder, { recursive: true });
  const filename = `${digest}.${extension}`;
  await writeFile(path.join(folder, filename), Buffer.concat(chunks));
  return `/media/posters/${filename}`;
}
