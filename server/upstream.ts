import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

export interface FetchOptions {
  timeoutMs?: number; maxRedirects?: number; allowPrivate?: boolean;
  beforeRequest?: (url: URL) => Promise<void>;
}

// Node 18.18's Readable.toWeb can close its controller twice when an HTTP body
// is cancelled. Keep cancellation/end/error ownership explicit instead.
function webBody(stream: Readable, incoming: http.IncomingMessage): ReadableStream<Uint8Array> {
  let settled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 0) <= 0) stream.pause();
      });
      stream.once('end', () => { if (!settled) { settled = true; controller.close(); } });
      stream.once('error', error => { if (!settled) { settled = true; controller.error(error); } });
      stream.once('close', () => {
        if (!settled) { settled = true; controller.error(new Error('上游响应提前关闭')); }
      });
      stream.pause();
    },
    pull() { if (!settled) stream.resume(); },
    cancel() { settled = true; stream.destroy(); if (stream !== incoming) incoming.destroy(); },
  });
}

export function isPublicAddress(address: string): boolean {
  const value = address.toLowerCase().split('%')[0];
  if (isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)));
  }
  if (isIP(value) === 6) {
    // Only global-unicast IPv6 is eligible; this excludes loopback, mapped IPv4,
    // ULA, link-local, multicast, and deprecated site-local ranges.
    return /^[23]/.test(value) && !value.startsWith('2001:db8:') && !value.startsWith('2002:');
  }
  return false;
}

export function safeUrlLabel(value: string): string {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; }
  catch { return '无效地址'; }
}

async function validateTarget(value: string | URL, allowPrivate: boolean) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('只允许不含用户名和密码的 HTTP/HTTPS 地址');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || (!allowPrivate && addresses.some(item => !isPublicAddress(item.address)))) {
    throw new Error(`已阻止内网或非公开目标: ${url.hostname}`);
  }
  // Prefer IPv4 on older runtimes; modern Node can attempt every validated record.
  addresses.sort((a, b) => a.family - b.family);
  return { url, address: addresses[0], addresses };
}

/** Public HTTP(S) GET/HEAD with DNS pinning and redirect-by-redirect validation. */
export async function safeFetch(value: string | URL, init: RequestInit = {}, options: FetchOptions = {}): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxRedirects = options.maxRedirects ?? 5;
  const allowPrivate = options.allowPrivate ?? process.env.ALLOW_PRIVATE_UPSTREAM === 'true';
  const method = (init.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(method)) throw new Error('上游请求仅支持 GET / HEAD');
  let deadline = Date.now() + timeoutMs;
  let target = new URL(value);
  let headers = new Headers(init.headers);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    init.signal?.throwIfAborted();
    if (options.beforeRequest) {
      const waitingStarted = Date.now();
      await options.beforeRequest(target);
      deadline += Date.now() - waitingStarted;
    }
    const { url, address, addresses } = await validateTarget(target, allowPrivate);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('上游请求超时');
    const response = await new Promise<Response>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method, headers: Object.fromEntries(headers.entries()),
        lookup: (_host, lookupOptions, callback) => {
          // Node 20+ autoSelectFamily requests all records and expects an array.
          // Return the validated, pinned address in the requested callback shape.
          if (lookupOptions.all) callback(null, addresses);
          else callback(null, address.address, address.family);
        },
      });
      const abort = () => request.destroy(new Error('请求已取消'));
      const timer = setTimeout(() => request.destroy(new Error('上游请求超时')), remaining);
      timer.unref();
      const cleanup = () => { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); };
      init.signal?.addEventListener('abort', abort, { once: true });
      request.on('error', error => { cleanup(); reject(error); });
      request.on('response', incoming => {
        incoming.on('end', cleanup);
        incoming.on('close', cleanup);
        const responseHeaders = new Headers();
        for (const [key, content] of Object.entries(incoming.headers)) {
          if (content !== undefined) responseHeaders.set(key, Array.isArray(content) ? content.join(', ') : content);
        }
        const status = incoming.statusCode ?? 502;
        const encoding = incoming.headers['content-encoding'];
        const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress()
          : encoding === 'deflate' ? createInflate() : null;
        const stream = decoder ? incoming.pipe(decoder) : incoming;
        if (decoder) {
          responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length');
          incoming.on('error', error => decoder.destroy(error));
          decoder.on('close', () => { if (!incoming.complete) incoming.destroy(); });
        }
        const body = method === 'HEAD' || [204, 205, 304].includes(status)
          ? null : webBody(stream, incoming);
        if (!body) incoming.resume();
        const result = new Response(body, { status, headers: responseHeaders });
        Object.defineProperty(result, 'url', { value: url.href });
        resolve(result);
      });
      request.end();
    });
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.get('location')) return response;
    await response.body?.cancel();
    if (hop === maxRedirects) throw new Error('上游重定向次数过多');
    const next = new URL(response.headers.get('location')!, target);
    if (next.origin !== target.origin) {
      headers.delete('authorization'); headers.delete('cookie'); headers.delete('proxy-authorization');
    }
    target = next;
  }
  throw new Error('上游重定向失败');
}

export async function readTextLimited(response: Response, maxBytes = 2 * 1024 * 1024): Promise<string> {
  const length = Number(response.headers.get('content-length'));
  if (length > maxBytes) { await response.body?.cancel(); throw new Error('上游响应超过大小限制'); }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('上游响应超过大小限制');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
  const charset = response.headers.get('content-type')?.match(/charset\s*=\s*([^;\s]+)/i)?.[1]?.replace(/["']/g, '') ?? 'utf-8';
  try { return new TextDecoder(charset).decode(bytes); } catch { return bytes.toString('utf8'); }
}
