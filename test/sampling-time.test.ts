import assert from 'node:assert/strict';
import test from 'node:test';
import type { SyncEnvelope } from '../src/domain/types.js';
import { DomainError } from '../src/domain/errors.js';
import { makeApp, projectId, sampleInput, tenantId } from './helpers.js';

test('sample collected before local midnight keeps its UTC instant and local business date', () => {
  const app = makeApp();
  const { sample } = app.sampling.createSealedSample(sampleInput({ collectedAt: '2026-10-06T23:30:00+08:00' }));
  assert.equal(sample.collectedAt, '2026-10-06T15:30:00.000Z');
  assert.equal(sample.collectedDateLocal, '2026-10-06');
  assert.match(sample.ingestedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('two entry points with different offsets reach the same conclusion for one instant', () => {
  const app = makeApp();
  // Same physical instant, reported from two timezones through two samples.
  const a = app.sampling.createSealedSample(sampleInput({ collectedAt: '2026-10-06T23:30:00+08:00' })).sample;
  const b = app.sampling.createSealedSample(sampleInput({ collectedAt: '2026-10-06T10:30:00-05:00' })).sample;
  assert.equal(a.collectedAt, b.collectedAt);
  assert.equal(a.collectedDateLocal, b.collectedDateLocal);
  // Wall-clock "20:00 on the 6th" in New York is later than "23:30 on the 6th"
  // in Shanghai; ordering by stored instant must agree regardless of entry point.
  const c = app.sampling.createSealedSample(sampleInput({ collectedAt: '2026-10-06T20:00:00-05:00' })).sample;
  assert.ok(Date.parse(c.collectedAt) > Date.parse(a.collectedAt));
  assert.equal(c.collectedDateLocal, '2026-10-06');
});

test('offline device uploads from another timezone: sync replay is idempotent and keeps the instant', async () => {
  const app = makeApp();
  const envelope: SyncEnvelope = {
    tenantId,
    projectId,
    deviceId: 'device_01',
    clientSequence: 1,
    operationId: 'op-collect-1',
    entityId: 'sample-1',
    baseVersion: 0,
    type: 'CREATE_SAMPLE',
    payloadHash: 'hash-op-collect-1',
    payload: sampleInput({ collectedAt: '2026-10-06T23:30:00+08:00' }),
    // Device uploaded hours later, now physically in another timezone.
    occurredAt: '2026-10-06T12:05:00-05:00',
  };
  const first = await app.sync.apply(envelope);
  assert.equal(first, 'APPLIED');
  const sample = [...app.store.samples.values()][0];
  assert.ok(sample);
  assert.equal(sample.collectedAt, '2026-10-06T15:30:00.000Z');
  assert.equal(sample.collectedDateLocal, '2026-10-06');
  const syncRecord = [...app.store.syncRecords.values()][0];
  assert.ok(syncRecord);
  // Event time (client) and receive time (server) stay distinct.
  assert.equal(syncRecord.envelope.occurredAt, '2026-10-06T12:05:00-05:00');
  assert.match(syncRecord.appliedAt, /Z$/);
  assert.match(sample.ingestedAt, /Z$/);
  const second = await app.sync.apply(envelope);
  assert.equal(second, 'APPLIED');
  assert.equal(app.store.samples.size, 1);
});

test('sync rejects envelopes whose event time has no explicit offset', async () => {
  const app = makeApp();
  const envelope: SyncEnvelope = {
    tenantId,
    projectId,
    deviceId: 'device_01',
    clientSequence: 1,
    operationId: 'op-collect-2',
    entityId: 'sample-2',
    baseVersion: 0,
    type: 'CREATE_SAMPLE',
    payloadHash: 'hash-op-collect-2',
    payload: sampleInput(),
    occurredAt: '2026-10-06T23:30:00',
  };
  await assert.rejects(() => app.sync.apply(envelope), (error: unknown) => error instanceof DomainError && error.code === 'time.invalid_format');
  assert.equal(app.store.syncRecords.size, 0);
  assert.equal(app.store.samples.size, 0);
});

test('sample creation rejects zone-less collection times', () => {
  const app = makeApp();
  assert.throws(
    () => app.sampling.createSealedSample(sampleInput({ collectedAt: '2026-10-06T23:30:00' })),
    (error: unknown) => error instanceof DomainError && error.code === 'time.invalid_format',
  );
});
