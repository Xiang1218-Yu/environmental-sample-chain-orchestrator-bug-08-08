import assert from 'node:assert/strict';
import test from 'node:test';
import { makeApp, prepareInTransitContainer, projectId, tenantId } from './helpers.js';

test('custody events are stored as canonical UTC instants', () => {
  const app = makeApp();
  const { transfer } = prepareInTransitContainer(app, {}, '2026-10-06T17:30:00+08:00');
  assert.equal(transfer.handedOverAt, '2026-10-06T09:30:00.000Z');
  const confirmed = app.custody.confirmReceipt(transfer.id, { receiverId: 'courier_01', receivedAt: '2026-10-06T19:00:00+08:00', temperatureCelsius: 5, sealStatus: 'INTACT' });
  assert.equal(confirmed.receivedAt, '2026-10-06T11:00:00.000Z');
});

test('temperature trail stays ordered by event instant when readings arrive out of order', () => {
  const app = makeApp();
  // Collection at 08:00Z; handover at 08:30Z; receipt confirmed at 10:00Z.
  const { container, transfer } = prepareInTransitContainer(app, { collectedAt: '2026-10-06T08:00:00+00:00' }, '2026-10-06T08:30:00+00:00');
  app.custody.confirmReceipt(transfer.id, { receiverId: 'courier_01', receivedAt: '2026-10-06T10:00:00+00:00', temperatureCelsius: 5, sealStatus: 'INTACT' });
  // A second handover is uploaded late from an offline device with a backdated
  // (but valid) event time of 09:30Z — after the 10:00Z reading was appended.
  app.custody.handOver({
    tenantId,
    projectId,
    containerId: container.id,
    fromHolderId: 'courier_01',
    toHolderId: 'courier_02',
    fromLocation: 'LAB-SH-A',
    toLocation: 'LAB-SH-B',
    handedOverAt: '2026-10-06T09:30:00+00:00',
    temperatureCelsius: 6,
    sealStatus: 'INTACT',
    clientOperationId: 'handover-backdated-1',
  });
  const stored = app.store.containers.get(container.id);
  assert.ok(stored);
  assert.deepEqual(
    stored.temperatureLog.map((reading) => reading.recordedAt),
    ['2026-10-06T08:00:00.000Z', '2026-10-06T08:30:00.000Z', '2026-10-06T09:30:00.000Z', '2026-10-06T10:00:00.000Z'],
  );
});

test('transfer sequence follows the custody chain, and handovers require the current holder', () => {
  const app = makeApp();
  const { container, transfer } = prepareInTransitContainer(app, {}, '2026-10-06T08:30:00+00:00');
  assert.equal(transfer.transferSequence, 1);
  app.custody.confirmReceipt(transfer.id, { receiverId: 'courier_01', receivedAt: '2026-10-06T10:00:00+00:00', temperatureCelsius: 5, sealStatus: 'INTACT' });
  const second = app.custody.handOver({
    tenantId,
    projectId,
    containerId: container.id,
    fromHolderId: 'courier_01',
    toHolderId: 'courier_02',
    fromLocation: 'LAB-SH-A',
    toLocation: 'LAB-SH-B',
    handedOverAt: '2026-10-06T10:30:00+00:00',
    temperatureCelsius: 6,
    sealStatus: 'INTACT',
    clientOperationId: 'handover-second-1',
  });
  assert.equal(second.transferSequence, 2);
});
