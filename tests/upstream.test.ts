import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { readTextLimited, safeFetch } from '../server/upstream.js';

let origin = '';
let cancelledRequests = 0;
let activeClosed: (() => void) | undefined;
const message = 'compressed upstream response';
const upstream = createServer((request, response) => {
  if (request.url?.startsWith('/bodyless/')) {
    response.writeHead(Number(request.url.split('/').at(-1)), { 'Content-Encoding': 'gzip' });
    response.end(); return;
  }
  if (request.url === '/cancel-before-request') {
    cancelledRequests++; response.end('must not be requested'); return;
  }
  if (request.url === '/active') {
    response.write('first chunk'); response.once('close', () => activeClosed?.()); return;
  }
  response.setHeader('Content-Encoding', 'gzip'); response.end(gzipSync(message));
});

before(async () => {
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
after(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
});

for (const response of [{ method: 'HEAD', status: 200 }, { method: 'GET', status: 204 }, { method: 'GET', status: 205 }, { method: 'GET', status: 304 }]) {
  test(`${response.method} ${response.status} with gzip headers leaves no unused decoder that can crash the process`, async () => {
    // Decoder errors are unhandled EventEmitter errors; isolate the real process failure.
    const script = `
      import { safeFetch } from ${JSON.stringify(new URL('../server/upstream.ts', import.meta.url).href)};
      const response = await safeFetch(${JSON.stringify(origin + '/bodyless/' + response.status)},
        { method: ${JSON.stringify(response.method)} }, { allowPrivate: true });
      if (response.status !== ${response.status} || response.body !== null) throw new Error('Expected a bodyless response');
      await new Promise(resolve => setTimeout(resolve, 30));
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { error += chunk; });
    const timeout = setTimeout(() => child.kill(), 5000);
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    clearTimeout(timeout);
    assert.equal(exitCode, 0, error);
  });
}

test('cancellation while awaiting beforeRequest prevents the HTTP request from starting', async () => {
  const controller = new AbortController();
  const requestsBefore = cancelledRequests;
  await assert.rejects(async () => {
    const response = await safeFetch(origin + '/cancel-before-request', { signal: controller.signal }, {
      allowPrivate: true,
      beforeRequest: async () => { await Promise.resolve(); controller.abort(); },
    });
    await readTextLimited(response);
  }, /abort|取消/i);
  assert.equal(cancelledRequests, requestsBefore);
});

test('ordinary compressed GET responses still decode their content', async () => {
  const response = await safeFetch(origin + '/gzip', {}, { allowPrivate: true });
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(await readTextLimited(response), message);
});

test('cancelling a GET body closes the active upstream response', async () => {
  const controller = new AbortController();
  const closed = new Promise<void>(resolve => { activeClosed = resolve; });
  const response = await safeFetch(origin + '/active', { signal: controller.signal }, { allowPrivate: true });
  const reader = response.body!.getReader();
  assert.ok((await reader.read()).value!.byteLength > 0);
  controller.abort();
  await assert.rejects(reader.read(), /取消|关闭|abort/i);
  await reader.cancel().catch(() => {}); reader.releaseLock();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([closed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('upstream remained open')), 1000); })]);
  } finally { clearTimeout(timer); activeClosed = undefined; }
});
