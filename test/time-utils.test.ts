import assert from 'node:assert/strict';
import test from 'node:test';
import { localBusinessDate, parseInstant, toUtcIso } from '../src/domain/time.js';
import { DomainError } from '../src/domain/errors.js';

test('midnight boundary: the same UTC instant keeps one canonical form across offsets', () => {
  // 23:30 in Shanghai and 10:30 in New York are the same instant.
  assert.equal(toUtcIso('2026-10-06T23:30:00+08:00', 't'), '2026-10-06T15:30:00.000Z');
  assert.equal(toUtcIso('2026-10-06T10:30:00-05:00', 't'), '2026-10-06T15:30:00.000Z');
  assert.equal(toUtcIso('2026-10-06T15:30:00Z', 't'), '2026-10-06T15:30:00.000Z');
});

test('midnight boundary: local wall clocks on the same date can straddle a UTC day', () => {
  // Both are "late evening on the 6th" locally, but they are 10 hours apart
  // and fall on different UTC dates. Stripping offsets would order them wrong.
  const shanghai = toUtcIso('2026-10-06T23:30:00+08:00', 't'); // 2026-10-06T15:30:00Z
  const newYork = toUtcIso('2026-10-06T20:00:00-05:00', 't'); // 2026-10-07T01:00:00Z
  assert.ok(Date.parse(newYork) > Date.parse(shanghai), '20:00 in New York is later than 23:30 in Shanghai');
});

test('local business date follows the reporting offset, not the server zone', () => {
  assert.equal(localBusinessDate('2026-10-06T23:30:00+08:00', 't'), '2026-10-06');
  assert.equal(localBusinessDate('2026-10-06T20:00:00-05:00', 't'), '2026-10-06');
  // Just after local midnight: UTC date and business date diverge.
  assert.equal(localBusinessDate('2026-10-07T00:30:00+14:00', 't'), '2026-10-07');
  assert.equal(toUtcIso('2026-10-07T00:30:00+14:00', 't'), '2026-10-06T10:30:00.000Z');
  assert.equal(localBusinessDate('2026-10-06T23:30:00-11:00', 't'), '2026-10-06');
  assert.equal(toUtcIso('2026-10-06T23:30:00-11:00', 't'), '2026-10-07T10:30:00.000Z');
});

test('DST spring forward: instants either side of the gap stay ordered', () => {
  const beforeGap = toUtcIso('2026-03-08T01:30:00-05:00', 't'); // EST
  const afterGap = toUtcIso('2026-03-08T03:30:00-04:00', 't'); // EDT
  assert.equal(beforeGap, '2026-03-08T06:30:00.000Z');
  assert.equal(afterGap, '2026-03-08T07:30:00.000Z');
  assert.ok(Date.parse(afterGap) - Date.parse(beforeGap) === 3_600_000);
  assert.equal(localBusinessDate('2026-03-08T01:30:00-05:00', 't'), '2026-03-08');
  assert.equal(localBusinessDate('2026-03-08T03:30:00-04:00', 't'), '2026-03-08');
});

test('DST fall back: identical wall-clock text stays two distinct instants', () => {
  const firstPass = toUtcIso('2026-11-01T01:30:00-04:00', 't'); // EDT
  const secondPass = toUtcIso('2026-11-01T01:30:00-05:00', 't'); // EST
  assert.equal(firstPass, '2026-11-01T05:30:00.000Z');
  assert.equal(secondPass, '2026-11-01T06:30:00.000Z');
  assert.ok(Date.parse(secondPass) > Date.parse(firstPass));
});

test('fractional seconds and offset forms normalize to canonical UTC', () => {
  assert.equal(toUtcIso('2026-10-06T12:00:00.5Z', 't'), '2026-10-06T12:00:00.500Z');
  assert.equal(toUtcIso('2026-10-06T12:00:00.123+00:00', 't'), '2026-10-06T12:00:00.123Z');
  assert.equal(parseInstant('2026-10-06T12:00:00+00:00', 't'), Date.parse('2026-10-06T12:00:00Z'));
});

test('timestamps without an explicit offset are rejected', () => {
  assert.throws(() => parseInstant('2026-10-06T23:30:00', 'collectedAt'), (error: unknown) => error instanceof DomainError && error.code === 'time.invalid_format');
  assert.throws(() => parseInstant('2026-10-06 23:30:00Z', 'collectedAt'), (error: unknown) => error instanceof DomainError && error.code === 'time.invalid_format');
  assert.throws(() => parseInstant('2026-10-06', 'collectedAt'), (error: unknown) => error instanceof DomainError && error.code === 'time.invalid_format');
});

test('impossible calendar times and out-of-range offsets are rejected', () => {
  for (const value of ['2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-06T24:00:00Z', '2026-10-06T12:00:00+15:00', '2026-10-06T12:00:00+08:60']) {
    assert.throws(() => parseInstant(value, 't'), (error: unknown) => error instanceof DomainError && error.code === 'time.invalid_format', value);
  }
});
