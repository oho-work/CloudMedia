import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { defaultChromeUserAgent, defaultSettings, initialState, settingsDefaults } from '../server/defaults.js';
import { Store } from '../server/store.js';

const legacyDefaultUserAgent = 'CloudMedia/0.1 (+local media catalog; public pages only)';

test('new settings use the verified modern Windows Chrome stable UA', () => {
  assert.equal(defaultSettings.userAgent, defaultChromeUserAgent);
  assert.equal(initialState().settings.userAgent, defaultChromeUserAgent);
  assert.match(defaultChromeUserAgent, /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\)/);
  assert.match(defaultChromeUserAgent, /Chrome\/157\.0\.0\.0 Safari\/537\.36$/);
});

test('legacy or missing built-in UA upgrades without changing probe budgets or custom settings', () => {
  for (const userAgent of [undefined, '', '   ', legacyDefaultUserAgent]) {
    const settings = settingsDefaults({ userAgent, sampleBytes: 123456, probeTimeoutMs: 23456, schedulerEnabled: false });
    assert.equal(settings.userAgent, defaultChromeUserAgent);
    assert.equal(settings.sampleBytes, 123456);
    assert.equal(settings.probeTimeoutMs, 23456);
    assert.equal(settings.schedulerEnabled, false);
    assert.equal(settings.timezone, defaultSettings.timezone);
  }
});

test('configured custom User-Agent values survive normalization verbatim', () => {
  for (const userAgent of ['Fixture', 'Mozilla/5.0 Custom browser/1.0', 'CloudMedia/2.0 custom installation']) {
    assert.equal(settingsDefaults({ userAgent }).userAgent, userAgent);
  }
});

test('PostgreSQL startup persists migrated UA and legacy schedule while preserving saved budgets', async t => {
  const { dailyTimes: _dailyTimes, ...legacySettings } = defaultSettings;
  const saved = { ...legacySettings, dailyTime: '22:15', timezone: 'UTC', userAgent: legacyDefaultUserAgent, sampleBytes: 345678, probeTimeoutMs: 43210 };
  const persisted: Record<string, unknown>[] = [];
  const client = {
    on() {}, release() {},
    async query(sql: string, values: unknown[] = []) {
      if (sql.startsWith('SELECT pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.startsWith('SELECT data FROM "settings_default_test".settings')) return { rows: [{ data: saved }] };
      if (sql.startsWith('SELECT data FROM ')) return { rows: [] };
      if (sql.startsWith('INSERT INTO "settings_default_test".settings')) persisted.push(JSON.parse(String(values[0])));
      return { rows: [] };
    },
  };
  const pool = { on() {}, async connect() { return client; }, async end() {} };
  t.mock.method(pg, 'Pool', function () { return pool; } as unknown as typeof pg.Pool);
  const previous = { DATABASE_URL: process.env.DATABASE_URL, PGSCHEMA: process.env.PGSCHEMA };
  process.env.DATABASE_URL = 'postgresql://fixture.invalid/settings-defaults';
  process.env.PGSCHEMA = 'settings_default_test';
  const store = new Store();
  t.after(async () => {
    try { await store.close(); }
    finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  await store.init();
  assert.equal(store.state.settings.userAgent, defaultChromeUserAgent);
  assert.equal(store.state.settings.sampleBytes, saved.sampleBytes);
  assert.equal(store.state.settings.probeTimeoutMs, saved.probeTimeoutMs);
  assert.deepEqual(store.state.settings.dailyTimes, ['22:15']);
  assert.equal(store.state.settings.dailyTime, '22:15');
  assert.equal(store.state.settings.timezone, 'Asia/Shanghai');
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].userAgent, defaultChromeUserAgent);
  assert.equal(persisted[0].sampleBytes, saved.sampleBytes);
  assert.deepEqual(persisted[0].dailyTimes, ['22:15']);
  assert.equal(persisted[0].timezone, 'Asia/Shanghai');
});
