import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceDefaults } from '../server/defaults.js';
import { collectionRequestSchema, sourceSchema } from '../server/validation.js';

test('source date ranges require valid paired dates and keep the selected scope', () => {
  const source = sourceDefaults({ name: '555 影视', baseUrl: 'https://www.555k03.com', collectionMode: 'range', startDate: '2026-11-01', endDate: '2026-11-04' });
  const range = sourceSchema.parse(source);
  assert.equal(range.collectionMode, 'range'); assert.equal(range.startDate, '2026-11-01'); assert.equal(range.endDate, '2026-11-04');
  for (const overrides of [{ startDate: undefined }, { endDate: undefined }, { startDate: '2026-02-30' }, { startDate: '2026-11-05' }]) assert.equal(sourceSchema.safeParse({ ...source, ...overrides }).success, false);
  assert.equal(sourceSchema.safeParse({ ...source, adapter: 'json' }).success, false);
  assert.equal(sourceSchema.safeParse({ ...source, collectionMode: 'today', startDate: undefined, endDate: undefined }).success, true);
  assert.equal(sourceSchema.safeParse({ ...source, adapter: 'json', collectionMode: 'all', startDate: undefined, endDate: undefined }).success, false);
});

test('CSS is the fixed parser and request intervals accept zero without changing millisecond precision', () => {
  const source = sourceDefaults({ name: 'Fixture', baseUrl: 'https://example.com' });
  for (const requestIntervalMs of [0, 1, 2500, 60000]) assert.equal(sourceSchema.parse({ ...source, requestIntervalMs }).requestIntervalMs, requestIntervalMs);
  for (const requestIntervalMs of [-1, 0.5, 60001, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(sourceSchema.safeParse({ ...source, requestIntervalMs }).success, false);
  for (const adapter of ['json', 'maccms', 'unsupported']) assert.equal(sourceSchema.safeParse({ ...source, adapter }).success, false);
});

test('legacy parser settings become CSS configuration without stale JSON field mappings', () => {
  const source = sourceDefaults({ baseUrl: 'https://example.com' });
  const migrated = sourceDefaults({ ...source, adapter: 'json', jsonItemsPath: 'list', jsonTitleField: 'vod_name', jsonUrlField: 'vod_play_url' } as unknown as Parameters<typeof sourceDefaults>[0]);
  assert.equal(migrated.adapter, 'html');
  assert.equal('jsonItemsPath' in migrated, false);
  assert.equal('jsonTitleField' in migrated, false);
  assert.equal('jsonUrlField' in migrated, false);
});

test('run scope validation accepts today, all and paired date ranges', () => {
  assert.deepEqual(collectionRequestSchema.parse({ mode: 'today' }), { mode: 'today' });
  assert.deepEqual(collectionRequestSchema.parse({ mode: 'all' }), { mode: 'all' });
  assert.deepEqual(collectionRequestSchema.parse({ mode: 'range', startDate: '2026-11-01', endDate: '2026-11-04' }), { mode: 'range', startDate: '2026-11-01', endDate: '2026-11-04' });
  for (const request of [{ mode: 'today', startDate: '2026-11-01' }, { mode: 'all', endDate: '2026-11-01' }, { mode: 'range', startDate: '2026-02-30', endDate: '2026-11-01' }, { mode: 'unsupported' }]) assert.equal(collectionRequestSchema.safeParse(request).success, false);
  assert.equal(collectionRequestSchema.safeParse({ startDate: '2026-11-01' }).success, true);
});

test('obsolete source limits and manual headers cannot re-enable removed collection controls', () => {
  const source = sourceSchema.parse({ ...sourceDefaults({ name: '555 影视', baseUrl: 'https://www.555k03.com' }), maxPages: 1, maxItems: 1, maxResourcePages: 1, respectRobots: true, referer: 'https://unrelated.example/' });
  assert.equal(source.maxPages, 0); assert.equal(source.maxItems, 0); assert.equal(source.maxResourcePages, 0);
  assert.equal(source.respectRobots, false); assert.equal(source.referer, '');
  assert.equal(sourceDefaults({ collectionMode: 'updates' }).collectionMode, 'today');
});
