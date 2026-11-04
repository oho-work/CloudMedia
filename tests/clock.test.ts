import assert from 'node:assert/strict';
import { createSocket, type Socket } from 'node:dgram';
import { getEventListeners } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { NetworkClock, queryNtp, type NtpSample } from '../server/clock.js';

const utc = Date.UTC(2026, 10, 4, 4, 0, 0);
function writeTimestamp(packet: Buffer, offset: number, unixTimeMs: number) {
  const ntpSeconds = unixTimeMs / 1000 + 2_208_988_800;
  packet.writeUInt32BE(Math.floor(ntpSeconds) % 2 ** 32, offset);
  packet.writeUInt32BE(Math.floor((ntpSeconds - Math.floor(ntpSeconds)) * 2 ** 32), offset + 4);
}

test('NTP transport checks responses, handles the 2036 era, and closes every UDP socket', async t => {
  const server = createSocket('udp4');
  let currentTime = utc;
  let mutate = (_response: Buffer): Buffer | null => _response;
  server.on('message', (request, remote) => {
    assert.equal(request.length, 48); assert.equal(request[0], 0x23);
    const response = Buffer.alloc(48);
    response[0] = 0x24; response[1] = 2;
    request.copy(response, 24, 40, 48);
    writeTimestamp(response, 32, currentTime); writeTimestamp(response, 40, currentTime);
    const sent = mutate(response);
    if (sent) server.send(sent, remote.port, remote.address);
  });
  await new Promise<void>(resolve => server.bind(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
  const request = () => {
    let monotonic = 100;
    const controller = new AbortController();
    let socket!: Socket;
    let closed!: Promise<void>;
    const promise = queryNtp(address, { timeoutMs: 1000, signal: controller.signal, monotonicNow: () => { const value = monotonic; monotonic += 20; return value; },
      socketFactory: () => {
        socket = createSocket('udp4');
        closed = new Promise<void>(resolve => socket.once('close', resolve));
        return socket;
      } });
    return { promise, controller, get closed() { return closed; }, get socket() { return socket; } };
  };
  await t.test('valid absolute time uses monotonic network delay and supports the next NTP era', async () => {
    for (const year of [2026, 2037]) {
      currentTime = Date.UTC(year, 10, 4, 4);
      const client = request();
      const sample = await client.promise;
      assert.equal(sample.unixTimeMs, currentTime + 10); assert.equal(sample.monotonicMs, 120);
      assert.equal(sample.source, '127.0.0.1');
      await client.closed;
      assert.equal(getEventListeners(client.controller.signal, 'abort').length, 0);
      assert.throws(() => client.socket.address(), /Not running|not running/i);
    }
    currentTime = utc;
  });
  const invalid: { name: string; change: (packet: Buffer) => Buffer }[] = [
    { name: 'short packet', change: packet => packet.subarray(0, 47) },
    { name: 'unsynchronized server', change: packet => { packet[0] |= 0xc0; return packet; } },
    { name: 'wrong response mode', change: packet => { packet[0] = 0x23; return packet; } },
    { name: 'unsupported version', change: packet => { packet[0] = 0x14; return packet; } },
    { name: 'kiss of death', change: packet => { packet[1] = 0; return packet; } },
    { name: 'invalid stratum', change: packet => { packet[1] = 16; return packet; } },
    { name: 'wrong request cookie', change: packet => { packet[24] ^= 0xff; return packet; } },
    { name: 'missing timestamp', change: packet => { packet.fill(0, 40, 48); return packet; } },
    { name: 'reversed server timestamps', change: packet => { writeTimestamp(packet, 32, utc + 1000); return packet; } },
    { name: 'impossible server processing delay', change: packet => { writeTimestamp(packet, 40, utc + 1000); return packet; } },
  ];
  for (const variant of invalid) {
    await t.test(variant.name, async () => {
      mutate = variant.change;
      const client = request();
      await assert.rejects(client.promise, /NTP/);
      await client.closed;
      assert.equal(getEventListeners(client.controller.signal, 'abort').length, 0);
    });
  }
  await t.test('timeouts and cancellation release the socket and abort listener', async () => {
    mutate = () => null;
    const socket = createSocket('udp4');
    const closed = new Promise<void>(resolve => socket.once('close', resolve));
    const controller = new AbortController();
    await assert.rejects(queryNtp(address, { timeoutMs: 25, signal: controller.signal, socketFactory: () => socket }), /超时/);
    await closed;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    const client = request();
    client.controller.abort();
    await assert.rejects(client.promise, /停止/); await client.closed;
    assert.equal(getEventListeners(client.controller.signal, 'abort').length, 0);
    const preCancelled = new AbortController(); preCancelled.abort();
    assert.throws(() => queryNtp(address, { signal: preCancelled.signal }), /abort/i);
  });
});

test('network clock derives trusted UTC independently of OS wall-clock changes and expires stale synchronization', async t => {
  let monotonic = 100;
  let osTime = Date.UTC(1900, 0, 1);
  t.mock.method(Date, 'now', () => osTime);
  const requested: string[] = [];
  let fail = false;
  const clock = new NetworkClock({ servers: [{ host: 'first' }, { host: 'second' }], monotonicNow: () => monotonic, maxAgeMs: 10000,
    query: async server => {
      requested.push(server.host);
      if (fail || server.host === 'first') throw new Error('fixture NTP unavailable');
      return { unixTimeMs: utc, monotonicMs: monotonic, source: server.host };
    } });
  t.after(() => clock.stop());
  assert.equal(clock.now(), null);
  assert.deepEqual(clock.status(), { now: null, timezone: 'Asia/Shanghai', synchronized: false, lastSyncedAt: null, source: null, error: '尚未完成网络校时' });
  await clock.synchronize();
  assert.deepEqual(requested, ['first', 'second']);
  assert.equal(clock.now()!.getTime(), utc);
  monotonic += 2500; osTime = Date.UTC(2100, 0, 1);
  assert.equal(clock.now()!.getTime(), utc + 2500);
  assert.equal(clock.status().lastSyncedAt, new Date(utc).toISOString());
  assert.equal(clock.status().source, 'second'); assert.equal(clock.status().error, null);
  fail = true; await clock.synchronize();
  assert.equal(clock.status().synchronized, true, 'a fresh trusted anchor survives a temporary resync failure');
  assert.match(clock.status().error!, /unavailable/);
  monotonic = 10101;
  assert.equal(clock.now(), null); assert.equal(clock.status().synchronized, false);
  assert.match(clock.status().error!, /过期/);
});

test('periodic resynchronization stops cleanly and concurrent requests share one exchange', async t => {
  let calls = 0;
  const clock = new NetworkClock({ servers: [{ host: 'fixture' }], syncIntervalMs: 20, retryIntervalMs: 5,
    query: async (server, options) => { calls++; return { unixTimeMs: utc, monotonicMs: options!.monotonicNow!(), source: server.host }; } });
  t.after(() => clock.stop());
  await clock.start();
  await delay(60);
  assert.ok(calls >= 2);
  clock.stop();
  const stoppedCalls = calls;
  await delay(40); assert.equal(calls, stoppedCalls);
  let release!: (value: NtpSample) => void;
  let activeSignal: AbortSignal | undefined;
  const pending = new NetworkClock({ servers: [{ host: 'slow-fixture' }], query: async (_server, options) => {
    activeSignal = options!.signal;
    return new Promise<NtpSample>(resolve => { release = resolve; });
  } });
  const first = pending.synchronize(), second = pending.synchronize();
  assert.equal(first, second);
  pending.stop(); assert.equal(activeSignal?.aborted, true);
  release({ unixTimeMs: utc, monotonicMs: 0, source: 'slow-fixture' });
  await first; assert.equal(pending.now(), null, 'late responses after shutdown must not replace the clock');
});
