import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PostgresPosterStorage, posterTableSql, type PosterBinary } from '../server/poster-storage.js';

const bytes = Buffer.from('valid bytes are signature-checked by the poster archiver');
const digest = createHash('sha256').update(bytes).digest('hex');
const poster: PosterBinary = {
  path: `/media/posters/${digest}.png`, sha256: digest, mime: 'image/png', data: bytes,
  downloadedAt: '2026-11-04T00:00:00.000Z',
};
function fixture() {
  const rows = new Map<string, Record<string, any>>();
  const calls: { sql: string; values: unknown[] }[] = [];
  const database = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.startsWith('INSERT INTO')) {
        const [path, sha256, mime, data, downloadedAt] = values as [string, string, string, Buffer, string];
        if (rows.has(path)) return { rows: [] };
        rows.set(path, { path, sha256, mime, bytes: Buffer.from(data), downloaded_at: new Date(downloadedAt) });
        return { rows: [{ path }] };
      }
      if (sql.startsWith('SELECT path,')) {
        const row = rows.get(String(values[0]));
        return { rows: row ? [{ ...row, bytes: Buffer.from(row.bytes) }] : [] };
      }
      throw new Error('Unexpected poster query');
    },
  };
  return { storage: new PostgresPosterStorage(database, 'poster_test'), rows, calls };
}

test('PostgreSQL poster bytes round-trip without entering catalog state or changing immutable timestamps', async () => {
  const { storage, rows, calls } = fixture();
  const input = { ...poster, data: Buffer.from(bytes) };
  await storage.put(input);
  input.data.fill(0);
  const saved = await storage.get(poster.path);
  assert.ok(saved);
  assert.deepEqual(saved, poster);
  assert.notEqual(saved.data, poster.data, 'reads return a separate byte buffer');
  await storage.put({ ...poster, downloadedAt: '2026-11-05T00:00:00.000Z' });
  assert.equal(rows.size, 1);
  assert.equal((await storage.get(poster.path))?.downloadedAt, poster.downloadedAt, 'duplicate inserts keep original object metadata');
  assert.ok(calls.every(call => !call.sql.includes(poster.path)), 'paths and image data use query parameters');
  assert.ok(calls.some(call => call.sql.includes('ON CONFLICT(path) DO NOTHING')));
});

test('legacy URL-hash poster paths migrate while conflicting content cannot replace an existing route', async () => {
  const { storage } = fixture();
  const legacyPath = `/media/posters/${'a'.repeat(64)}.png`;
  await storage.put({ ...poster, path: legacyPath });
  assert.deepEqual((await storage.get(legacyPath))?.data, bytes);
  const different = Buffer.from('different payload');
  await assert.rejects(storage.put({ ...poster, path: legacyPath, data: different,
    sha256: createHash('sha256').update(different).digest('hex') }), /拒绝覆盖/);
  assert.deepEqual((await storage.get(legacyPath))?.data, bytes);
});

test('unsafe paths, mismatched metadata, oversize bytes and corrupt digests never reach PostgreSQL', async () => {
  const { storage, calls } = fixture();
  for (const invalid of ['', '/media/posters/../image.png', poster.path + '?token=secret', poster.path + '\n', 'https://example.com/poster.png']) {
    assert.equal(await storage.get(invalid), null);
    await assert.rejects(storage.put({ ...poster, path: invalid }), /路径/);
  }
  await assert.rejects(storage.put({ ...poster, mime: 'image/jpeg' }), /类型/);
  await assert.rejects(storage.put({ ...poster, data: Buffer.alloc(0) }), /为空/);
  await assert.rejects(storage.put({ ...poster, data: Buffer.alloc(4194305) }), /4 MiB/);
  await assert.rejects(storage.put({ ...poster, sha256: 'a'.repeat(64) }), /摘要/);
  await assert.rejects(storage.put({ ...poster, downloadedAt: 'invalid-date' }), /时间/);
  assert.equal(calls.length, 0);
});

test('database failures and corrupted stored poster data propagate without a filesystem fallback', async () => {
  const failure = new Error('database unavailable');
  const storage = new PostgresPosterStorage({ async query() { throw failure; } }, 'poster_test');
  await assert.rejects(storage.get(poster.path), error => error === failure);
  await assert.rejects(storage.put(poster), error => error === failure);
  const fixtureStore = fixture();
  await fixtureStore.storage.put(poster);
  fixtureStore.rows.get(poster.path)!.bytes[0] ^= 1;
  await assert.rejects(fixtureStore.storage.get(poster.path), /摘要/);
});

test('poster DDL constrains binary objects and validates the interpolated schema', () => {
  const ddl = posterTableSql('poster_test');
  assert.match(ddl, /^CREATE TABLE IF NOT EXISTS "poster_test"\.poster_files/);
  assert.match(ddl, /path text PRIMARY KEY/);
  assert.match(ddl, /bytes bytea NOT NULL/);
  assert.match(ddl, /octet_length\(bytes\) <= 4194304/);
  assert.match(ddl, /downloaded_at timestamptz NOT NULL/);
  assert.throws(() => posterTableSql('public;DROP SCHEMA public'), /schema/);
  assert.throws(() => new PostgresPosterStorage({ async query() { return { rows: [] }; } }, 'unsafe.name'), /schema/);
});
