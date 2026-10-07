import { DomainError } from './errors.js';

/**
 * Canonical time model for the sample chain. Four concepts are kept strictly
 * separate across the codebase:
 *
 * - Event occurrence time (事件发生时间): when something actually happened on the
 *   device or instrument. Stored only as a canonical UTC instant produced by
 *   `normalizeInstant` (ISO 8601, milliseconds, `Z`). The raw wall-clock text
 *   a client typed in its local zone is never stored.
 * - Server receive time (接收时间): when the server processed the record
 *   (`Store.now()`). Recorded for audit; never used to order business events.
 * - Local business date (本地业务日期): the calendar date of an instant in a
 *   declared IANA time zone, derived only via `businessDateOf`. Never parsed
 *   from a client-supplied wall-clock string.
 * - Result revision number (结果修订号): business version assigned by the
 *   instrument. It is the only ordering key for result revisions; timestamps
 *   (occurrence or receive) are never used to decide which revision is current.
 */

export const DEFAULT_BUSINESS_TIME_ZONE = 'UTC';

/**
 * Tolerated device clock skew when one client-reported instant is compared
 * against another (e.g. receipt confirmed slightly "before" the handover).
 * Offline handhelds drift; small discrepancies must not break the chain.
 */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse an ISO 8601 timestamp that carries an explicit offset (`Z` or
 * `±HH:MM`) and return its canonical UTC form (`YYYY-MM-DDTHH:MM:SS.sssZ`).
 *
 * Naive wall-clock strings without an offset are rejected: the server never
 * guesses which zone a device meant. Calendar components are validated
 * explicitly because `Date.parse` silently rolls overflow values (Feb 30,
 * 24:00, ±15:00 offsets) into neighbouring instants.
 */
export function normalizeInstant(value: string, code = 'time.invalid_instant'): string {
  const match = INSTANT_PATTERN.exec(value);
  if (!match) {
    throw new DomainError(code, `timestamp must be ISO 8601 with seconds and an explicit offset (Z or ±HH:MM), got: ${value}`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const valid =
    month >= 1 && month <= 12 &&
    day >= 1 && day <= daysInMonth &&
    hour >= 0 && hour <= 23 &&
    minute >= 0 && minute <= 59 &&
    second >= 0 && second <= 59 &&
    isValidOffset(offsetText ?? 'Z');
  if (!valid) {
    throw new DomainError(code, `timestamp components are out of range: ${value}`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new DomainError(code, `timestamp is not a real calendar instant: ${value}`);
  }
  return new Date(ms).toISOString();
}

function isValidOffset(offset: string): boolean {
  if (offset === 'Z') return true;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  return hours <= 14 && minutes <= 59;
}

/** Milliseconds since the Unix epoch for a canonical or offset timestamp. */
export function instantMs(value: string): number {
  return Date.parse(normalizeInstant(value));
}

/** Comparator for two instants: negative when `a` is earlier, in milliseconds. */
export function compareInstants(a: string, b: string): number {
  return instantMs(a) - instantMs(b);
}

export function addMilliseconds(instant: string, ms: number): string {
  return new Date(instantMs(instant) + ms).toISOString();
}

export function addHours(instant: string, hours: number): string {
  return addMilliseconds(instant, hours * 3_600_000);
}

const businessDateFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Local business date (`YYYY-MM-DD`) of an instant in the given IANA time
 * zone. DST transitions come from the IANA database, so a fixed UTC offset
 * must never be substituted for the zone.
 */
export function businessDateOf(instant: string, timeZone: string = DEFAULT_BUSINESS_TIME_ZONE): string {
  const formatter = formatterFor(timeZone);
  const parts = formatter.formatToParts(new Date(instantMs(instant)));
  const part = (type: string): string => parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function assertTimeZone(timeZone: string): void {
  formatterFor(timeZone);
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = businessDateFormatters.get(timeZone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    throw new DomainError('time.invalid_timezone', `unknown IANA time zone: ${timeZone}`);
  }
  businessDateFormatters.set(timeZone, formatter);
  return formatter;
}
