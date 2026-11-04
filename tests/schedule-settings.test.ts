import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSettings, initialState, settingsDefaults } from '../server/defaults.js';
import { settingsSchema } from '../server/validation.js';
import { BEIJING_TIMEZONE } from '../shared/schedule-settings.js';

test('new and legacy persisted schedules use Beijing time and retain the configured wall time', () => {
  assert.deepEqual(initialState().settings.dailyTimes, ['03:00']);
  const legacy = settingsDefaults({ dailyTime: '06:15', timezone: 'UTC' });
  assert.deepEqual(legacy.dailyTimes, ['06:15']);
  assert.equal(legacy.dailyTime, '06:15');
  assert.equal(legacy.timezone, BEIJING_TIMEZONE);
});

test('persisted daily times normalize in order without duplicates and retain the legacy first time', () => {
  const settings = settingsDefaults({ dailyTimes: ['23:59', '00:00', '12:30', '00:00'], dailyTime: '03:00' });
  assert.deepEqual(settings.dailyTimes, ['00:00', '12:30', '23:59']);
  assert.equal(settings.dailyTime, '00:00');
  const fallback = settingsDefaults({ dailyTimes: [], dailyTime: '07:00' });
  assert.deepEqual(fallback.dailyTimes, ['07:00']);
  assert.deepEqual(settingsDefaults({ dailyTime: 'invalid', dailyTimes: ['invalid'] }).dailyTimes, ['03:00']);
});

test('default daily time arrays are independent between settings instances', () => {
  const first = settingsDefaults();
  first.dailyTimes!.push('04:00');
  assert.deepEqual(settingsDefaults().dailyTimes, ['03:00']);
  assert.deepEqual(defaultSettings.dailyTimes, ['03:00']);
});

test('settings validation accepts multiple times, sorts them and fixes any supplied timezone to Beijing', () => {
  for (const timezone of [undefined, 'UTC', 'America/New_York', 'Asia/Shanghai']) {
    const result = settingsSchema.parse({ ...defaultSettings, timezone, dailyTimes: ['18:45', '00:00', '18:45', '08:30'] });
    assert.deepEqual(result.dailyTimes, ['00:00', '08:30', '18:45']);
    assert.equal(result.dailyTime, '00:00');
    assert.equal(result.timezone, BEIJING_TIMEZONE);
  }
});

test('settings validation accepts legacy dailyTime requests and new requests without dailyTime', () => {
  const { dailyTimes: _dailyTimes, ...legacy } = defaultSettings;
  const oldRequest = settingsSchema.parse({ ...legacy, dailyTime: '10:20' });
  assert.deepEqual(oldRequest.dailyTimes, ['10:20']);
  const { dailyTime: _dailyTime, ...modern } = defaultSettings;
  const newRequest = settingsSchema.parse({ ...modern, dailyTimes: ['22:10', '08:00'] });
  assert.equal(newRequest.dailyTime, '08:00');
  assert.deepEqual(newRequest.dailyTimes, ['08:00', '22:10']);
});

test('invalid, empty and excessive schedules are rejected before replacing stored settings', () => {
  for (const dailyTimes of [[], [''], ['9:30'], ['24:00'], ['12:60'], ['00:00:00'], ['03:00\n'], [3], Array.from({ length: 25 }, () => '03:00')]) {
    assert.equal(settingsSchema.safeParse({ ...defaultSettings, dailyTimes }).success, false, JSON.stringify(dailyTimes));
  }
  const { dailyTime: _dailyTime, dailyTimes: _dailyTimes, ...missingSchedule } = defaultSettings;
  assert.equal(settingsSchema.safeParse(missingSchedule).success, false);
  assert.equal(settingsSchema.safeParse({ ...defaultSettings, dailyTimes: Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`) }).success, true);
});
