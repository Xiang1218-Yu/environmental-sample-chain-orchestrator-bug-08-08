import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessDateOf } from '../dist/domain/time.js';
import { makeApp, sealSample, deliverToLab, runningBatch, ingest, currentResult, resultsFor, unique, TENANT, PROJECT } from './helpers.mjs';

// --- 时区午夜：样本在一个时区午夜前采集，设备离线后在另一个时区上传 ---

test('collectedAt is stored as a UTC instant regardless of the offset the device used', () => {
  const app = makeApp();
  // Collected 23:30 in Los Angeles (before local midnight) = 06:30Z next day.
  const sealed = sealSample(app, { collectedAt: '2026-10-06T23:30:00-07:00' });
  assert.equal(sealed.sample.collectedAt, '2026-10-07T06:30:00.000Z');
  // The local business date is derivable per zone, on demand — never baked in.
  assert.equal(businessDateOf(sealed.sample.collectedAt, 'America/Los_Angeles'), '2026-10-06');
  assert.equal(businessDateOf(sealed.sample.collectedAt, 'Asia/Shanghai'), '2026-10-07');
});

test('the same instant entered through different offsets converges to one stored value', () => {
  const app = makeApp();
  const viaOffset = sealSample(app, { collectedAt: '2026-10-07T00:30:00+08:00' });
  const viaUtc = sealSample(app, { collectedAt: '2026-10-06T16:30:00.000Z' });
  assert.equal(viaOffset.sample.collectedAt, viaUtc.sample.collectedAt);
});

test('naive timestamps without an offset are rejected at the service boundary', () => {
  const app = makeApp();
  assert.throws(
    () => sealSample(app, { collectedAt: '2026-10-06T08:00:00' }),
    (error) => error.code === 'time.invalid_instant',
  );
});

test('sync upload from another timezone stores the same canonical instant and normalizes occurredAt', async () => {
  const app = makeApp();
  const result = await app.sync.apply({
    tenantId: TENANT,
    projectId: PROJECT,
    deviceId: 'device_offline_01',
    clientSequence: 1,
    operationId: unique('op'),
    entityId: 'sample-sync-1',
    baseVersion: 0,
    type: 'CREATE_SAMPLE',
    payloadHash: 'payload-hash-1',
    payload: {
      collectorId: 'collector_02',
      protocolVersion: 'water-v3',
      medium: 'WATER',
      // Collected before midnight in Los Angeles...
      collectedAt: '2026-10-06T23:30:00-07:00',
      location: { latitude: 34.05, longitude: -118.24, siteCode: 'SITE-LA-01' },
      preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
      containerBarcode: unique('CNT'),
      sealCode: unique('SEAL'),
      totalVolumeMl: 100,
    },
    // ...uploaded next morning from Shanghai after the device came back online.
    occurredAt: '2026-10-08T09:00:00+08:00',
  });
  assert.equal(result, 'APPLIED');
  const sample = [...app.store.samples.values()][0];
  assert.equal(sample.collectedAt, '2026-10-07T06:30:00.000Z');
  const syncRecord = [...app.store.syncRecords.values()][0];
  assert.equal(syncRecord.envelope.occurredAt, '2026-10-08T01:00:00.000Z');
  // Server receive time is recorded separately from the client event time.
  assert.ok(syncRecord.appliedAt.endsWith('Z'));
});

test('sync rejects envelopes whose occurredAt lacks an explicit offset', async () => {
  const app = makeApp();
  await assert.rejects(
    () => app.sync.apply({
      tenantId: TENANT,
      projectId: PROJECT,
      deviceId: 'device_03',
      clientSequence: 1,
      operationId: unique('op'),
      entityId: 'x',
      baseVersion: 0,
      type: 'CREATE_SAMPLE',
      payloadHash: 'p',
      payload: {},
      occurredAt: '2026-10-08T09:00:00',
    }),
    (error) => error.code === 'time.invalid_instant',
  );
});

// --- 设备时钟偏差：交接确认时间略早于交出时间不应断链 ---

test('custody receipt slightly before handover is tolerated as clock skew', () => {
  const app = makeApp();
  const sealed = sealSample(app, { collectedAt: '2026-10-06T08:00:00.000Z' });
  const transfer = app.custody.handOver({
    tenantId: TENANT,
    projectId: PROJECT,
    containerId: sealed.container.id,
    fromHolderId: 'collector_01',
    toHolderId: 'courier_01',
    fromLocation: 'SITE-01',
    toLocation: 'LAB-A',
    handedOverAt: '2026-10-06T08:30:00.000Z',
    temperatureCelsius: 5,
    sealStatus: 'INTACT',
    clientOperationId: unique('handover'),
  });
  // Receiver's clock is 3 minutes behind the sender's — within tolerance.
  const confirmed = app.custody.confirmReceipt(transfer.id, { receiverId: 'courier_01', receivedAt: '2026-10-06T08:27:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT' });
  assert.equal(confirmed.status, 'CONFIRMED');
  assert.equal(confirmed.receivedAt, '2026-10-06T08:27:00.000Z');
});

test('custody receipt far before handover exceeds the skew window and is rejected', () => {
  const app = makeApp();
  const sealed = sealSample(app, { collectedAt: '2026-10-06T08:00:00.000Z' });
  const transfer = app.custody.handOver({
    tenantId: TENANT,
    projectId: PROJECT,
    containerId: sealed.container.id,
    fromHolderId: 'collector_01',
    toHolderId: 'courier_01',
    fromLocation: 'SITE-01',
    toLocation: 'LAB-A',
    handedOverAt: '2026-10-06T08:30:00.000Z',
    temperatureCelsius: 5,
    sealStatus: 'INTACT',
    clientOperationId: unique('handover'),
  });
  // 30 minutes "before" the handover is not clock drift, it is bad data.
  assert.throws(
    () => app.custody.confirmReceipt(transfer.id, { receiverId: 'courier_01', receivedAt: '2026-10-06T08:00:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT' }),
    (error) => error.code === 'custody.receipt_before_handover',
  );
});

// --- 保存期限临界点：期限判断只比较 UTC 瞬间，与接收日期/客户端日期无关 ---

test('holding time is evaluated between UTC instants with an inclusive deadline', () => {
  const app = makeApp();
  // Collected 08:00Z, 48h transit window → deadline 2026-10-08T08:00:00Z.
  const onTime = sealSample(app, { collectedAt: '2026-10-06T08:00:00.000Z', maxTransitHours: 48 });
  const record = deliverToLab(app, onTime.container.id, {
    handedOverAt: '2026-10-06T09:00:00.000Z',
    confirmedAt: '2026-10-06T10:00:00.000Z',
    labReceivedAt: '2026-10-08T08:00:00.000Z', // exactly at the deadline
  });
  assert.equal(record.transitDeadlineAt, '2026-10-08T08:00:00.000Z');
  assert.equal(record.withinHoldingTime, true);

  const late = sealSample(app, { collectedAt: '2026-10-06T08:00:00.000Z', maxTransitHours: 48 });
  const lateRecord = deliverToLab(app, late.container.id, {
    handedOverAt: '2026-10-06T09:00:00.000Z',
    confirmedAt: '2026-10-06T10:00:00.000Z',
    labReceivedAt: '2026-10-08T08:00:00.001Z', // 1ms past the deadline
  });
  assert.equal(lateRecord.withinHoldingTime, false);
});

test('holding time does not depend on which local date the client or server is in', () => {
  const app = makeApp();
  // Collected 00:30 +08:00 (= 16:30Z), 8h window → deadline 2026-10-07T00:30:00Z,
  // which is 08:30 next morning in Shanghai but still 2026-10-06 in UTC.
  const sealed = sealSample(app, { collectedAt: '2026-10-07T00:30:00+08:00', maxTransitHours: 8 });
  const record = deliverToLab(app, sealed.container.id, {
    handedOverAt: '2026-10-07T01:00:00+08:00',
    confirmedAt: '2026-10-07T02:00:00+08:00',
    labReceivedAt: '2026-10-07T08:30:00+08:00', // exactly the deadline instant
  });
  assert.equal(record.receivedAt, '2026-10-07T00:30:00.000Z');
  assert.equal(record.transitDeadlineAt, '2026-10-07T00:30:00.000Z');
  assert.equal(record.withinHoldingTime, true);
});

test('receiving record separates event time, server receive time and business date', () => {
  const app = makeApp();
  const sealed = sealSample(app, { collectedAt: '2026-10-06T08:00:00.000Z' });
  const record = deliverToLab(app, sealed.container.id, {
    handedOverAt: '2026-10-06T09:00:00.000Z',
    confirmedAt: '2026-10-06T10:00:00.000Z',
    labReceivedAt: '2026-10-07T00:15:00+08:00', // = 2026-10-06T16:15:00Z
    businessTimeZone: 'Asia/Shanghai',
  });
  assert.equal(record.receivedAt, '2026-10-06T16:15:00.000Z');
  assert.equal(record.receivedBusinessDate, '2026-10-07'); // local date in Shanghai
  assert.equal(record.businessTimeZone, 'Asia/Shanghai');
  assert.ok(record.serverReceivedAt.endsWith('Z'));
  // The sample mirrors the same canonical instant — one event, one value.
  const sample = app.store.samples.get(sealed.sample.id);
  assert.equal(sample.receivedAt, record.receivedAt);
});

// --- 结果修订号：发生时间早于接收时间但修订号更高的结果必须生效 ---

test('a later-arriving revision with a higher business number wins even with an earlier occurredAt', () => {
  const app = makeApp();
  const { batch, run } = runningBatch(app);
  const rev1 = ingest(app, batch, run, { revisionNumber: 1, value: 0.12, contentHash: 'hash-v1', occurredAt: '2026-10-06T11:00:00.000Z' });
  assert.equal(rev1.status, 'CURRENT');
  // The instrument re-analysed offline at 10:30Z (before rev1's occurredAt)
  // but assigned business revision 2; it uploads only now.
  const rev2 = ingest(app, batch, run, { revisionNumber: 2, value: 0.09, contentHash: 'hash-v2', occurredAt: '2026-10-06T10:30:00.000Z' });
  assert.equal(rev2.status, 'CURRENT');
  assert.equal(rev2.supersedesRevisionId, rev1.id);
  assert.equal(app.store.results.get(rev1.id).status, 'SUPERSEDED');
  assert.equal(currentResult(app, batch.id).id, rev2.id);
});

test('a late-arriving older revision is not discarded silently and never displaces the newer one', () => {
  const app = makeApp();
  const { batch, run } = runningBatch(app);
  const rev2 = ingest(app, batch, run, { revisionNumber: 2, value: 0.09, contentHash: 'hash-v2', occurredAt: '2026-10-06T10:30:00.000Z' });
  // Revision 1 arrives after revision 2 (offline upload, different order).
  const stale = ingest(app, batch, run, { revisionNumber: 1, value: 0.12, contentHash: 'hash-v1', occurredAt: '2026-10-06T11:00:00.000Z' });
  assert.equal(stale.id, rev2.id); // caller gets the winning revision back
  assert.equal(resultsFor(app, batch.id).length, 1); // no new revision row created
  assert.equal(currentResult(app, batch.id).revisionNumber, 2);
  // The stale attempt is auditable.
  assert.ok(app.store.audit.some((entry) => entry.action === 'result.revision_stale' && entry.metadata.rejectedRevision === 1));
});

test('revision identity is the business number plus content, not arrival order', () => {
  const app = makeApp();
  const { batch, run } = runningBatch(app);
  const rev1 = ingest(app, batch, run, { revisionNumber: 1, value: 0.12, contentHash: 'hash-v1', occurredAt: '2026-10-06T11:00:00.000Z' });
  // Replay of the same business revision with the same content: idempotent.
  const replay = ingest(app, batch, run, { revisionNumber: 1, value: 0.12, contentHash: 'hash-v1', occurredAt: '2026-10-06T11:00:00.000Z' });
  assert.equal(replay.id, rev1.id);
  assert.equal(resultsFor(app, batch.id).length, 1);
  // Same business revision but different content: a conflict, not a new revision.
  assert.throws(
    () => ingest(app, batch, run, { revisionNumber: 1, value: 0.99, contentHash: 'hash-other', occurredAt: '2026-10-06T11:00:00.000Z' }),
    (error) => error.code === 'result.revision_conflict',
  );
  assert.equal(resultsFor(app, batch.id).length, 1);
});

test('revisionNumber must be a positive integer and occurredAt must carry an offset', () => {
  const app = makeApp();
  const { batch, run } = runningBatch(app);
  assert.throws(
    () => ingest(app, batch, run, { revisionNumber: 0, value: 0.1, contentHash: 'h', occurredAt: '2026-10-06T11:00:00.000Z' }),
    (error) => error.code === 'result.invalid_revision',
  );
  assert.throws(
    () => ingest(app, batch, run, { revisionNumber: 1, value: 0.1, contentHash: 'h', occurredAt: '2026-10-06T11:00:00' }),
    (error) => error.code === 'time.invalid_instant',
  );
});

// --- 证据包显示时间：瞬间保持 UTC，本地业务日期按包内时区派生 ---

test('evidence timeline keeps UTC instants and derives display dates in the package zone', () => {
  const app = makeApp();
  const { batch, run, sealed } = runningBatch(app);
  const result = ingest(app, batch, run, { revisionNumber: 1, value: 0.12, contentHash: 'hash-v1', occurredAt: '2026-10-06T11:00:00.000Z' });
  app.quality.decide({ tenantId: TENANT, projectId: PROJECT, batchId: batch.id, resultId: result.id, decision: 'APPROVED', reason: 'ok', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01' });
  app.quality.approveBatch(batch.id, 'reviewer_01');

  const shanghai = app.evidence.generate({ tenantId: TENANT, projectId: PROJECT, requestKey: unique('evidence'), displayTimeZone: 'Asia/Shanghai' });
  assert.equal(shanghai.status, 'READY');
  assert.equal(shanghai.displayTimeZone, 'Asia/Shanghai');
  assert.ok(shanghai.frozenAt.endsWith('Z'));
  assert.equal(shanghai.frozenBusinessDate, businessDateOf(shanghai.frozenAt, 'Asia/Shanghai'));

  const collected = shanghai.timeline.find((entry) => entry.kind === 'sample.collected' && entry.id === sealed.sample.id);
  assert.equal(collected.at, '2026-10-06T08:00:00.000Z');
  assert.equal(collected.businessDate, '2026-10-06');
  const occurred = shanghai.timeline.find((entry) => entry.kind === 'result.occurred' && entry.id === result.id);
  assert.equal(occurred.at, '2026-10-06T11:00:00.000Z');
  assert.equal(occurred.businessDate, '2026-10-06');
  // Timeline is sorted by instant.
  const instants = shanghai.timeline.map((entry) => Date.parse(entry.at));
  assert.deepEqual([...instants].sort((a, b) => a - b), instants);

  // Same chain rendered for a Los Angeles reviewer: identical instants,
  // different local dates where the zone boundary falls between them.
  const losAngeles = app.evidence.generate({ tenantId: TENANT, projectId: PROJECT, requestKey: unique('evidence'), displayTimeZone: 'America/Los_Angeles' });
  const laCollected = losAngeles.timeline.find((entry) => entry.kind === 'sample.collected' && entry.id === sealed.sample.id);
  assert.equal(laCollected.at, collected.at);
  assert.equal(laCollected.businessDate, '2026-10-06');

  // Re-generating with the same request key is idempotent.
  const again = app.evidence.generate({ tenantId: TENANT, projectId: PROJECT, requestKey: shanghai.requestKey, displayTimeZone: 'UTC' });
  assert.equal(again.id, shanghai.id);
  assert.equal(again.displayTimeZone, 'Asia/Shanghai');
});

test('evidence generation rejects an unknown display time zone', () => {
  const app = makeApp();
  const { batch, run } = runningBatch(app);
  const result = ingest(app, batch, run, { revisionNumber: 1, value: 0.12, contentHash: 'hash-v1', occurredAt: '2026-10-06T11:00:00.000Z' });
  app.quality.decide({ tenantId: TENANT, projectId: PROJECT, batchId: batch.id, resultId: result.id, decision: 'APPROVED', reason: 'ok', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01' });
  app.quality.approveBatch(batch.id, 'reviewer_01');
  assert.throws(
    () => app.evidence.generate({ tenantId: TENANT, projectId: PROJECT, requestKey: unique('evidence'), displayTimeZone: 'Mars/Olympus' }),
    (error) => error.code === 'time.invalid_timezone',
  );
});
