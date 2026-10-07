import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from '../src/domain/errors.js';
import { makeApp, prepareInTransitContainer, projectId, tenantId } from './helpers.js';

const COLLECTED = '2026-10-06T08:00:00+08:00'; // 2026-10-06T00:00:00.000Z

function receiveInput(containerId: string, receivedAt: string, overrides: Record<string, unknown> = {}) {
  return {
    tenantId,
    projectId,
    containerId,
    receivedBy: 'lab_receiver_01',
    receivedAt,
    temperatureCelsius: 5,
    sealStatus: 'INTACT' as const,
    decision: 'ACCEPTED' as const,
    clientOperationId: `receive-${containerId}-${receivedAt}`,
    ...overrides,
  };
}

test('receiving stores one canonical UTC instant across entry points', () => {
  const app = makeApp();
  const { container, sample } = prepareInTransitContainer(app, { collectedAt: COLLECTED });
  // The lab reports the same instant from its own timezone.
  const record = app.receiving.receive(receiveInput(container.id, '2026-10-05T23:00:00-05:00'));
  assert.equal(record.receivedAt, '2026-10-06T04:00:00.000Z');
  assert.equal(record.receivedDateLocal, '2026-10-05');
  assert.match(record.recordedAt, /Z$/);
  const stored = app.store.samples.get(sample.id);
  assert.ok(stored);
  // Sample view and receiving record can no longer disagree.
  assert.equal(stored.receivedAt, record.receivedAt);
});

test('retention boundary: exactly maxTransitHours passes, one second later fails', () => {
  const app = makeApp();
  const ok = prepareInTransitContainer(app, { collectedAt: COLLECTED, preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 4 } });
  const accepted = app.receiving.receive(receiveInput(ok.container.id, '2026-10-06T12:00:00+08:00')); // exactly 4h after 00:00Z
  assert.equal(accepted.decision, 'ACCEPTED');

  const late = prepareInTransitContainer(app, { collectedAt: COLLECTED, preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 4 } });
  assert.throws(
    () => app.receiving.receive(receiveInput(late.container.id, '2026-10-06T12:00:01+08:00')),
    (error: unknown) => error instanceof DomainError && error.code === 'receiving.transit_expired',
  );
});

test('retention is evaluated on instants, not local dates: receipt before local midnight can still be late', () => {
  const app = makeApp();
  // Collected 23:00 +08:00 (= 15:00Z), limit 2h. Lab receives 00:59 next local
  // day +08:00 (= 16:59Z, 1h59m later) — within limit despite crossing midnight.
  const within = prepareInTransitContainer(app, { collectedAt: '2026-10-06T23:00:00+08:00', preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 2 } }, '2026-10-06T23:30:00+08:00');
  const accepted = app.receiving.receive(receiveInput(within.container.id, '2026-10-07T00:59:00+08:00'));
  assert.equal(accepted.decision, 'ACCEPTED');
  // Same wall-clock receipt time but collected one hour earlier: 2h59m transit, expired.
  const beyond = prepareInTransitContainer(app, { collectedAt: '2026-10-06T22:00:00+08:00', preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 2 } }, '2026-10-06T22:30:00+08:00');
  assert.throws(
    () => app.receiving.receive(receiveInput(beyond.container.id, '2026-10-07T00:59:00+08:00')),
    (error: unknown) => error instanceof DomainError && error.code === 'receiving.transit_expired',
  );
});

test('device clock skew: slightly-behind receive times are tolerated, gross skew is rejected', () => {
  const app = makeApp();
  // Receive event 4 minutes "before" collection: within the 5-minute tolerance.
  const tolerated = prepareInTransitContainer(app, { collectedAt: COLLECTED });
  const record = app.receiving.receive(receiveInput(tolerated.container.id, '2026-10-06T07:56:00+08:00'));
  assert.equal(record.decision, 'ACCEPTED');
  // 6 minutes before collection: beyond tolerance.
  const skewed = prepareInTransitContainer(app, { collectedAt: COLLECTED });
  assert.throws(
    () => app.receiving.receive(receiveInput(skewed.container.id, '2026-10-06T07:54:00+08:00')),
    (error: unknown) => error instanceof DomainError && error.code === 'receiving.clock_skew',
  );
});

test('retention only gates acceptance; isolation of an expired sample is still recorded', () => {
  const app = makeApp();
  const { container } = prepareInTransitContainer(app, { collectedAt: COLLECTED, preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 1 } });
  const record = app.receiving.receive(receiveInput(container.id, '2026-10-06T12:00:00+08:00', { decision: 'ISOLATED', reason: 'transit limit exceeded at intake' }));
  assert.equal(record.decision, 'ISOLATED');
});

test('receiving replay by clientOperationId stays idempotent', () => {
  const app = makeApp();
  const { container } = prepareInTransitContainer(app, { collectedAt: COLLECTED });
  const input = receiveInput(container.id, '2026-10-06T10:00:00+08:00', { clientOperationId: 'receive-replay-1' });
  const first = app.receiving.receive(input);
  const second = app.receiving.receive(input);
  assert.equal(first.id, second.id);
  assert.equal(app.store.receiving.size, 1);
});
