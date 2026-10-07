import { DomainError } from './errors.js';

/**
 * Time model used across the sample chain. Four concepts are kept distinct:
 *
 * - Event instant (事件发生时间): when something physically happened, reported by
 *   the client with an explicit offset. Stored as canonical UTC ISO so ordering
 *   never depends on the uploading timezone.
 * - Receive instant (接收时间): when the server ingested the record (`Store.now()`).
 *   Never derived from client clocks.
 * - Local business date (本地业务日期): the YYYY-MM-DD date in the offset the
 *   client reported, computed explicitly instead of by truncating strings.
 * - Result revision (结果修订号): a business version number supplied by the
 *   instrument/LIMS, independent of arrival order and of any timestamp.
 */

/** Tolerated difference between client and server clocks before we reject. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

interface InstantParts {
  instantMs: number;
  offsetMs: number;
}

function parseInstantParts(value: string, field: string): InstantParts {
  const match = INSTANT_PATTERN.exec(value);
  if (!match) {
    throw new DomainError('time.invalid_format', `${field} must be an ISO 8601 timestamp with an explicit offset (Z or ±HH:MM): ${value}`);
  }
  const [, year, month, day, hour, minute, second, fraction, zone] = match as unknown as [string, string, string, string, string, string, string, string | undefined, string];
  const offsetMatch = zone === 'Z' ? null : /^([+-])(\d{2}):(\d{2})$/.exec(zone);
  const sign = offsetMatch?.[1] === '-' ? -1 : 1;
  const offsetHours = Number(offsetMatch?.[2] ?? 0);
  const offsetMinutes = Number(offsetMatch?.[3] ?? 0);
  if (offsetHours > 14 || offsetMinutes > 59) {
    throw new DomainError('time.invalid_format', `${field} has an out-of-range zone offset: ${value}`);
  }
  const ms = Number((fraction ?? '.0').slice(1).padEnd(3, '0'));
  const wallClockMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), ms);
  const roundTrip = new Date(wallClockMs);
  const valid =
    roundTrip.getUTCFullYear() === Number(year) &&
    roundTrip.getUTCMonth() === Number(month) - 1 &&
    roundTrip.getUTCDate() === Number(day) &&
    roundTrip.getUTCHours() === Number(hour) &&
    roundTrip.getUTCMinutes() === Number(minute) &&
    roundTrip.getUTCSeconds() === Number(second);
  if (!valid) {
    throw new DomainError('time.invalid_format', `${field} is not a valid calendar time: ${value}`);
  }
  const offsetMs = sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  return { instantMs: wallClockMs - offsetMs, offsetMs };
}

/** Milliseconds of the UTC instant described by an offset-bearing ISO timestamp. */
export function parseInstant(value: string, field: string): number {
  return parseInstantParts(value, field).instantMs;
}

/** Canonical UTC form (`2026-10-07T01:00:00.000Z`) of an offset-bearing ISO timestamp. */
export function toUtcIso(value: string, field: string): string {
  return new Date(parseInstantParts(value, field).instantMs).toISOString();
}

/**
 * Local business date (`YYYY-MM-DD`) in the offset carried by the timestamp.
 * DST is already resolved by the client-supplied offset, so the same instant
 * always yields the same business date regardless of where it is uploaded from.
 */
export function localBusinessDate(value: string, field: string): string {
  const { instantMs, offsetMs } = parseInstantParts(value, field);
  return new Date(instantMs + offsetMs).toISOString().slice(0, 10);
}

/** Rejects client event times that are implausibly far ahead of the server clock. */
export function assertWithinClockSkew(eventUtcIso: string, serverNowIso: string, code: string, field: string): void {
  if (Date.parse(eventUtcIso) - Date.parse(serverNowIso) > MAX_CLOCK_SKEW_MS) {
    throw new DomainError(code, `${field} is more than ${MAX_CLOCK_SKEW_MS / 1000}s ahead of the server clock`);
  }
}
