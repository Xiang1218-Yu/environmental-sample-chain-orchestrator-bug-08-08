import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessDateOf, compareInstants, normalizeInstant } from '../dist/domain/time.js';

test('normalizeInstant converts any explicit offset to the same canonical UTC instant', () => {
  // The same instant expressed in three zones must collapse to one value,
  // so cross-time-zone records can never disagree downstream.
  assert.equal(normalizeInstant('2026-10-07T00:30:00+08:00'), '2026-10-06T16:30:00.000Z');
  assert.equal(normalizeInstant('2026-10-06T16:30:00Z'), '2026-10-06T16:30:00.000Z');
  assert.equal(normalizeInstant('2026-10-06T09:30:00-07:00'), '2026-10-06T16:30:00.000Z');
  assert.equal(normalizeInstant('2026-10-06T16:30:00.123+00:00'), '2026-10-06T16:30:00.123Z');
});

test('normalizeInstant rejects naive wall-clock text instead of guessing a zone', () => {
  for (const bad of ['2026-10-06T16:30:00', '2026-10-06 16:30:00', '2026-10-06', 'not-a-time', '']) {
    assert.throws(() => normalizeInstant(bad), (error) => error.code === 'time.invalid_instant');
  }
});

test('normalizeInstant rejects overflow components that Date.parse would roll over', () => {
  for (const bad of ['2026-02-30T00:00:00Z', '2026-04-31T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-06T24:00:00Z', '2026-10-06T00:00:00+15:00', '2026-10-06T00:00:00+08:60']) {
    assert.throws(() => normalizeInstant(bad), (error) => error.code === 'time.invalid_instant');
  }
  // Leap day is valid in a leap year.
  assert.equal(normalizeInstant('2024-02-29T12:00:00Z'), '2024-02-29T12:00:00.000Z');
});

test('businessDateOf splits the same instant across a time-zone midnight', () => {
  // 2026-10-07 00:30 in Shanghai is still 2026-10-06 in UTC and Los Angeles.
  const instant = '2026-10-06T16:30:00.000Z';
  assert.equal(businessDateOf(instant, 'Asia/Shanghai'), '2026-10-07');
  assert.equal(businessDateOf(instant, 'UTC'), '2026-10-06');
  assert.equal(businessDateOf(instant, 'America/Los_Angeles'), '2026-10-06');
});

test('businessDateOf uses IANA DST rules, not a fixed offset (spring forward)', () => {
  // 2026-03-08 04:30Z is 23:30 EST on 03-07 (still standard time).
  assert.equal(businessDateOf('2026-03-08T04:30:00.000Z', 'America/New_York'), '2026-03-07');
  // 2026-03-08 08:30Z is 04:30 EDT on 03-08 (daylight time already started).
  assert.equal(businessDateOf('2026-03-08T08:30:00.000Z', 'America/New_York'), '2026-03-08');
});

test('businessDateOf uses IANA DST rules, not a fixed offset (fall back)', () => {
  // 2026-11-01 04:30Z is 00:30 EDT on 11-01. A fixed UTC-5 offset would
  // wrongly report 10-31; the IANA zone knows daylight time still applies.
  assert.equal(businessDateOf('2026-11-01T04:30:00.000Z', 'America/New_York'), '2026-11-01');
  // After the fall-back, EST (UTC-5) applies.
  assert.equal(businessDateOf('2026-11-01T06:30:00.000Z', 'America/New_York'), '2026-11-01');
  assert.equal(businessDateOf('2026-11-01T04:59:59.000Z', 'America/New_York'), '2026-11-01');
});

test('businessDateOf rejects unknown time zones', () => {
  assert.throws(() => businessDateOf('2026-10-06T16:30:00.000Z', 'Mars/Olympus'), (error) => error.code === 'time.invalid_timezone');
});

test('compareInstants orders by instant, not by wall-clock text', () => {
  // Textually "2026-10-07T00:30+08:00" looks later than "2026-10-06T23:00Z"
  // on the calendar date, but as instants it is 30 minutes earlier.
  assert.ok(compareInstants('2026-10-07T00:30:00+08:00', '2026-10-06T23:00:00Z') < 0);
  assert.ok(compareInstants('2026-10-06T16:30:00Z', '2026-10-07T00:30:00+08:00') === 0);
});
