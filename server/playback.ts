import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import type { Store } from './store.js';
import { safeFetch, readTextLimited } from './upstream.js';
import { rewritePlaylist } from './hls.js';

/** Some CDNs serve extensionless manifests as text/plain or octet-stream. Peek a
 * bounded prefix and restore it so binary assets retain every original byte. */
async function sniffResponse(response: Response): Promise<{ response: Response; playlist: boolean }> {
  if (!response.body) return { response, playlist: false };
  const reader = response.body.getReader();
  const prefix: Uint8Array[] = [];
  let size = 0, ended = false;
  try {
    while (size < 16 && !ended) {
      const item = await reader.read();
      ended = item.done;
      if (item.value) { prefix.push(item.value); size += item.value.byteLength; }
    }
  } catch (error) { await reader.cancel().catch(() => {}); reader.releaseLock(); throw error; }
  const playlist = new TextDecoder().decode(Buffer.concat(prefix).subarray(0, 256)).trimStart().startsWith('#EXTM3U');
  let index = 0, released = false;
  const release = () => { if (!released) { released = true; reader.releaseLock(); } };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (index < prefix.length) { controller.enqueue(prefix[index++]); return; }
        if (ended) { release(); controller.close(); return; }
        const item = await reader.read();
        if (item.done) { ended = true; release(); controller.close(); }
        else controller.enqueue(item.value);
      } catch (error) { release(); controller.error(error); }
    },
    async cancel(reason) { try { if (!released) await reader.cancel(reason); } finally { release(); } },
  });
  return { response: new Response(body, { status: response.status, headers: response.headers }), playlist };
}

export function playbackRouter(store: Store) {
  const router = Router();
  const secret = randomBytes(32);
  const sign = (id: string, url: string, expires: string) => createHmac('sha256', secret).update(`${id}\n${url}\n${expires}`).digest('hex');
  const validSignature = (id: string, url: string, expires: string, signature: string) => {
    if (!/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;
    const expected = sign(id, url, expires);
    return /^[a-f0-9]{64}$/.test(signature) && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  };
  router.get('/:id/:file', async (req, res, next) => {
    const resource = store.state.resources.find(item => item.id === req.params.id);
    if (!resource) { res.status(404).json({ error: '播放资源不存在' }); return; }
    const isEntry = req.params.file === 'index.m3u8';
    if (!isEntry && req.params.file !== 'asset') { res.sendStatus(404); return; }
    const url = isEntry ? resource.url : String(req.query.url || '');
    if (!isEntry && !validSignature(resource.id, url, String(req.query.expires || ''), String(req.query.sig || ''))) { res.status(403).json({ error: '播放链接已过期，请重新打开影片' }); return; }
    const headers: Record<string, string> = { 'User-Agent': store.state.settings.userAgent };
    if (resource.referer) headers.Referer = resource.referer;
    if (typeof req.headers.range === 'string') {
      const range = req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
      if (!range || (!range[1] && !range[2]) || (range[1] && range[2] && Number(range[1]) > Number(range[2]))) {
        res.status(416).json({ error: '只支持有效的单个字节范围' }); return;
      }
      headers.Range = req.headers.range;
    }
    const controller = new AbortController();
    req.on('aborted', () => controller.abort());
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      let upstream = await safeFetch(url, { headers, signal: controller.signal }, { timeoutMs: 60000 });
      if (!upstream.ok) { await upstream.body?.cancel(); res.status(502).json({ error: `播放源返回 HTTP ${upstream.status}` }); return; }
      const contentType = upstream.headers.get('content-type') || '';
      const finalUrl = upstream.url || url;
      let playlist = isEntry || /mpegurl/i.test(contentType) || /\.m3u8(?:$|\?)/i.test(finalUrl);
      if (!playlist) {
        const sniffed = await sniffResponse(upstream);
        playlist = sniffed.playlist; upstream = sniffed.response;
      }
      res.setHeader('Cache-Control', 'private, no-store');
      if (playlist) {
        const text = await readTextLimited(upstream, 2 * 1024 * 1024);
        if (!text.trimStart().startsWith('#EXTM3U')) { res.status(502).json({ error: '播放源未返回有效的 m3u8 清单' }); return; }
        const expires = String(Date.now() + 6 * 60 * 60 * 1000);
        const rewritten = rewritePlaylist(text, finalUrl, target => `/api/play/${resource.id}/asset?${new URLSearchParams({ url: target, expires, sig: sign(resource.id, target, expires) })}`);
        res.type('application/vnd.apple.mpegurl').send(rewritten);
      } else {
        res.status(upstream.status);
        for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
          const value = upstream.headers.get(header); if (value) res.setHeader(header, value);
        }
        let bytes = 0;
        const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; callback(bytes > 64 * 1024 * 1024 ? new Error('资源分片超过 64MB 限制') : null, chunk); } });
        if (!upstream.body) { res.end(); return; }
        await pipeline(Readable.fromWeb(upstream.body as never), limit, res);
      }
    } catch (error) { if (!res.headersSent) next(error); else res.destroy(); }
  });
  return router;
}
