import { randomBytes } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { performance } from 'node:perf_hooks';
import { BEIJING_TIMEZONE } from '../shared/schedule-settings.js';

export interface ClockStatus {
  now: string | null;
  timezone: typeof BEIJING_TIMEZONE;
  synchronized: boolean;
  lastSyncedAt: string | null;
  source: string | null;
  error: string | null;
}
export interface AppClock {
  now(): Date | null;
  status(): ClockStatus;
}
export interface NtpServer { host: string; port?: number }
export interface NtpSample { unixTimeMs: number; monotonicMs: number; source: string }
export interface NtpRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  monotonicNow?: () => number;
  socketFactory?: () => Socket;
}
export type NtpQuery = (server: NtpServer, options?: NtpRequestOptions) => Promise<NtpSample>;

const ntpUnixOffset = 2_208_988_800;
const ntpEraSeconds = 2 ** 32;
const earliestSupportedTime = Date.UTC(2020, 0, 1);
const supportedEraLength = ntpEraSeconds * 1000;
function readNtpTime(packet: Buffer, offset: number): number {
  const seconds = packet.readUInt32BE(offset);
  const fraction = packet.readUInt32BE(offset + 4);
  if (!seconds && !fraction) throw new Error('NTP 时间戳为空');
  let unixTimeMs = (seconds - ntpUnixOffset) * 1000 + fraction / ntpEraSeconds * 1000;
  // Resolve the 2036 NTP era rollover from a fixed software baseline, never the OS clock.
  if (unixTimeMs < earliestSupportedTime) unixTimeMs += supportedEraLength;
  return unixTimeMs;
}

/** Obtain absolute UTC from NTP; round trips and subsequent elapsed time use a monotonic clock. */
export function queryNtp(server: NtpServer, options: NtpRequestOptions = {}): Promise<NtpSample> {
  const { timeoutMs = 2500, signal, monotonicNow = () => performance.now(), socketFactory = () => createSocket('udp4') } = options;
  signal?.throwIfAborted();
  return new Promise<NtpSample>((resolve, reject) => {
    const socket = socketFactory();
    const packet = Buffer.alloc(48);
    packet[0] = 0x23; // NTP v4, client mode.
    const cookie = randomBytes(8);
    cookie.copy(packet, 40);
    let settled = false;
    let sentAt = 0;
    const finish = (error?: Error, sample?: NtpSample) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { socket.close(); } catch { /* The socket can fail before it binds. */ }
      if (error) reject(error); else resolve(sample!);
    };
    const onAbort = () => finish(new Error('网络校时已停止'));
    const timer = setTimeout(() => finish(new Error(`NTP 校时超时（${server.host}）`)), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('error', () => finish(new Error(`NTP 服务连接失败（${server.host}）`)));
    socket.once('message', response => {
      const receivedAt = monotonicNow();
      try {
        if (response.length < 48) throw new Error('NTP 响应长度无效');
        const leap = response[0] >>> 6, version = (response[0] >>> 3) & 7, mode = response[0] & 7;
        if (leap === 3 || ![3, 4].includes(version) || mode !== 4 || response[1] < 1 || response[1] > 15) throw new Error('NTP 服务尚未同步或响应模式无效');
        if (!response.subarray(24, 32).equals(cookie)) throw new Error('NTP 响应请求标识不匹配');
        const receivedTime = readNtpTime(response, 32), transmittedTime = readNtpTime(response, 40);
        const roundTrip = receivedAt - sentAt, serverElapsed = transmittedTime - receivedTime;
        if (!Number.isFinite(roundTrip) || roundTrip < 0 || roundTrip > timeoutMs || serverElapsed < 0 || serverElapsed > roundTrip + 1) throw new Error('NTP 响应时间戳无效');
        const unixTimeMs = transmittedTime + Math.max(0, roundTrip - serverElapsed) / 2;
        if (!Number.isFinite(unixTimeMs)) throw new Error('NTP 校时时间无效');
        finish(undefined, { unixTimeMs, monotonicMs: receivedAt, source: server.host });
      } catch (error) { finish(error instanceof Error ? error : new Error('NTP 响应无效')); }
    });
    // A connected UDP socket only accepts datagrams from the chosen server/port.
    try {
      socket.connect(server.port ?? 123, server.host, () => {
        if (settled) return;
        sentAt = monotonicNow();
        socket.send(packet, error => { if (error) finish(new Error(`NTP 请求发送失败（${server.host}）`)); });
      });
    } catch { finish(new Error(`NTP 服务地址无效（${server.host}）`)); }
  });
}

export interface NetworkClockOptions {
  servers?: NtpServer[];
  query?: NtpQuery;
  monotonicNow?: () => number;
  syncIntervalMs?: number;
  retryIntervalMs?: number;
  maxAgeMs?: number;
  timeoutMs?: number;
}

export class NetworkClock implements AppClock {
  private readonly servers: NtpServer[];
  private readonly query: NtpQuery;
  private readonly monotonicNow: () => number;
  private readonly syncIntervalMs: number;
  private readonly retryIntervalMs: number;
  private readonly maxAgeMs: number;
  private readonly timeoutMs: number;
  private anchor: NtpSample | null = null;
  private lastError: string | null = '尚未完成网络校时';
  private lastAttemptAt: number | null = null;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private controller = new AbortController();

  constructor(options: NetworkClockOptions = {}) {
    this.servers = options.servers ?? [{ host: 'ntp.aliyun.com' }, { host: 'ntp.tencent.com' }, { host: 'time.cloudflare.com' }];
    this.query = options.query ?? queryNtp;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.syncIntervalMs = options.syncIntervalMs ?? 30 * 60 * 1000;
    this.retryIntervalMs = options.retryIntervalMs ?? 60 * 1000;
    this.maxAgeMs = options.maxAgeMs ?? 2 * 60 * 60 * 1000;
    this.timeoutMs = options.timeoutMs ?? 2500;
  }

  now(): Date | null {
    if (!this.anchor) return null;
    const elapsed = this.monotonicNow() - this.anchor.monotonicMs;
    if (elapsed < 0 || elapsed > this.maxAgeMs) return null;
    return new Date(this.anchor.unixTimeMs + elapsed);
  }

  status(): ClockStatus {
    const now = this.now();
    return { now: now?.toISOString() ?? null, timezone: BEIJING_TIMEZONE, synchronized: Boolean(now),
      lastSyncedAt: this.anchor ? new Date(this.anchor.unixTimeMs).toISOString() : null,
      source: this.anchor?.source ?? null,
      error: now ? this.lastError : this.anchor ? '网络校时已过期，定时采集已暂停' : this.lastError };
  }

  synchronize(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.controller.signal.aborted) return Promise.resolve();
    this.lastAttemptAt = this.monotonicNow();
    const signal = this.controller.signal;
    this.pending = (async () => {
      let lastError = '没有可用的网络校时服务';
      for (const server of this.servers) {
        if (signal.aborted) return;
        try {
          const sample = await this.query(server, { timeoutMs: this.timeoutMs, signal, monotonicNow: this.monotonicNow });
          if (signal.aborted) return;
          if (!Number.isFinite(sample.unixTimeMs) || !Number.isFinite(sample.monotonicMs) || sample.unixTimeMs < earliestSupportedTime || sample.unixTimeMs >= earliestSupportedTime + supportedEraLength) throw new Error('网络校时返回了无效时间');
          this.anchor = { ...sample };
          this.lastError = null;
          return;
        } catch (error) { lastError = error instanceof Error ? error.message : '网络校时失败'; }
      }
      if (!signal.aborted) this.lastError = lastError;
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async start(): Promise<void> {
    if (this.timer) return this.pending;
    if (this.controller.signal.aborted) this.controller = new AbortController();
    this.timer = setInterval(() => {
      const interval = this.now() ? this.syncIntervalMs : this.retryIntervalMs;
      if (this.lastAttemptAt === null || this.monotonicNow() - this.lastAttemptAt >= interval) void this.synchronize();
    }, Math.min(this.syncIntervalMs, this.retryIntervalMs));
    this.timer.unref();
    await this.synchronize();
  }

  stop(): void {
    clearInterval(this.timer); this.timer = undefined;
    this.controller.abort();
  }
}

export const appClock = new NetworkClock();
