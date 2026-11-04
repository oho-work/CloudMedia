import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesToMegabytes, megabytesToBytes, millisecondsToSeconds, secondsToMilliseconds } from '../shared/settings-units.js';

test('displaying and saving existing detection budgets retains every millisecond and byte', () => {
  for (const value of [1000, 1001, 15000, 45678, 60000]) {
    assert.equal(secondsToMilliseconds(millisecondsToSeconds(value)), value);
  }
  for (const value of [16384, 16385, 262144, 1000000, 4194303, 4194304]) {
    assert.equal(megabytesToBytes(bytesToMegabytes(value)), value);
  }
  assert.equal(millisecondsToSeconds(15000), '15');
  assert.equal(bytesToMegabytes(262144), '0.262144');
});

test('fractional seconds and decimal megabytes convert to integer API units without binary unit ambiguity', () => {
  assert.equal(secondsToMilliseconds('1.025'), 1025);
  assert.equal(secondsToMilliseconds(' 15 '), 15000);
  assert.equal(secondsToMilliseconds('1.2345'), 1235);
  assert.equal(megabytesToBytes('0.5'), 500000);
  assert.equal(megabytesToBytes('1'), 1000000);
  assert.equal(megabytesToBytes('0.016384'), 16384);
  assert.equal(megabytesToBytes('4.194304'), 4194304);
});

test('empty, malformed and out-of-range form values cannot silently overwrite a saved budget', () => {
  for (const value of ['', ' ', 'NaN', 'Infinity', '0x10', '1,5', '-1', '0.99999', '60.00001']) {
    assert.throws(() => secondsToMilliseconds(value), /1 至 60 秒/);
  }
  for (const value of ['', ' ', 'NaN', 'Infinity', '0x10', '1,5', '-1', '0.0163839', '4.1943041']) {
    assert.throws(() => megabytesToBytes(value), /0.016384 至 4.194304 MB/);
  }
});
