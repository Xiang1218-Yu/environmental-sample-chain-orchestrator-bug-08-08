import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from '../src/domain/errors.js';
import { makeApp, prepareRunningBatch, resultInput } from './helpers.js';

test('event time, receive time and business revision are stored as distinct fields', () => {
  const app = makeApp();
  const { run, aliquot } = prepareRunningBatch(app);
  const result = app.results.ingestRevision(resultInput(run, aliquot.id, { occurredAt: '2026-10-06T20:05:00+08:00' }));
  assert.equal(result.occurredAt, '2026-10-06T12:05:00.000Z');
  assert.match(result.receivedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(result.receivedAt) >= Date.parse(result.occurredAt));
  assert.equal(result.revisionNumber, 1);
  assert.equal(result.status, 'CURRENT');
});

test('a late revision with a higher business number wins even when its event time is earlier', () => {
  const app = makeApp();
  const { run, aliquot } = prepareRunningBatch(app);
  const rev1 = app.results.ingestRevision(resultInput(run, aliquot.id, { revisionNumber: 1, contentHash: 'hash-rev-1', occurredAt: '2026-10-06T12:00:00+00:00' }));
  // The instrument produced this correction BEFORE rev1 was ingested, but it
  // arrives later and carries a higher business revision number.
  const rev2 = app.results.ingestRevision(resultInput(run, aliquot.id, { revisionNumber: 2, contentHash: 'hash-rev-2', occurredAt: '2026-10-06T11:30:00+00:00', value: 0.15 }));
  assert.equal(rev2.status, 'CURRENT');
  assert.equal(rev2.supersedesRevisionId, rev1.id);
  assert.ok(Date.parse(rev2.occurredAt) < Date.parse(rev1.receivedAt!), 'event time predates rev1 receive time');
  const storedRev1 = app.store.results.get(rev1.id);
  assert.equal(storedRev1?.status, 'SUPERSEDED');
  const current = [...app.store.results.values()].find((result) => result.status === 'CURRENT');
  assert.equal(current?.id, rev2.id);
});

test('a late revision with a lower business number never becomes current but is kept for audit', () => {
  const app = makeApp();
  const { run, aliquot } = prepareRunningBatch(app);
  const rev2 = app.results.ingestRevision(resultInput(run, aliquot.id, { revisionNumber: 2, contentHash: 'hash-rev-2' }));
  assert.equal(rev2.status, 'CURRENT');
  // Revision 1 arrives after revision 2 (offline instrument upload).
  const rev1 = app.results.ingestRevision(resultInput(run, aliquot.id, { revisionNumber: 1, contentHash: 'hash-rev-1', occurredAt: '2026-10-06T11:00:00+00:00' }));
  assert.equal(rev1.status, 'SUPERSEDED');
  assert.equal(rev1.supersedesRevisionId, undefined);
  const current = [...app.store.results.values()].filter((result) => result.status === 'CURRENT');
  assert.equal(current.length, 1);
  assert.equal(current[0]?.id, rev2.id);
  assert.equal(app.store.results.size, 2, 'the stale revision is retained, not discarded');
});

test('receive order does not change the final current revision', () => {
  const orderA = makeApp();
  const a = prepareRunningBatch(orderA);
  orderA.results.ingestRevision(resultInput(a.run, a.aliquot.id, { revisionNumber: 1, contentHash: 'hash-rev-1' }));
  orderA.results.ingestRevision(resultInput(a.run, a.aliquot.id, { revisionNumber: 3, contentHash: 'hash-rev-3' }));
  orderA.results.ingestRevision(resultInput(a.run, a.aliquot.id, { revisionNumber: 2, contentHash: 'hash-rev-2' }));

  const orderB = makeApp();
  const b = prepareRunningBatch(orderB);
  orderB.results.ingestRevision(resultInput(b.run, b.aliquot.id, { revisionNumber: 3, contentHash: 'hash-rev-3' }));
  orderB.results.ingestRevision(resultInput(b.run, b.aliquot.id, { revisionNumber: 2, contentHash: 'hash-rev-2' }));
  orderB.results.ingestRevision(resultInput(b.run, b.aliquot.id, { revisionNumber: 1, contentHash: 'hash-rev-1' }));

  const currentA = [...orderA.store.results.values()].find((result) => result.status === 'CURRENT');
  const currentB = [...orderB.store.results.values()].find((result) => result.status === 'CURRENT');
  assert.equal(currentA?.revisionNumber, 3);
  assert.equal(currentB?.revisionNumber, 3);
  assert.equal(currentA?.contentHash, currentB?.contentHash);
});

test('replaying the same revision is idempotent; the same number with different content conflicts', () => {
  const app = makeApp();
  const { run, aliquot } = prepareRunningBatch(app);
  const rev1 = app.results.ingestRevision(resultInput(run, aliquot.id, { revisionNumber: 1, contentHash: 'hash-rev-1' }));
  const replay = app.results.ingestRevision(resultInput(run, aliquot.id, { revisionNumber: 1, contentHash: 'hash-rev-1' }));
  assert.equal(replay.id, rev1.id);
  assert.equal(app.store.results.size, 1);
  assert.throws(
    () => app.results.ingestRevision(resultInput(run, aliquot.id, { revisionNumber: 1, contentHash: 'hash-other', value: 9.9 })),
    (error: unknown) => error instanceof DomainError && error.code === 'result.revision_conflict',
  );
});

test('revision numbers must be positive integers', () => {
  const app = makeApp();
  const { run, aliquot } = prepareRunningBatch(app);
  for (const revisionNumber of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => app.results.ingestRevision(resultInput(run, aliquot.id, { revisionNumber })),
      (error: unknown) => error instanceof DomainError && error.code === 'result.invalid_revision',
      `revisionNumber=${revisionNumber}`,
    );
  }
});

test('instrument clock skew: event times far ahead of the server clock are rejected', () => {
  const app = makeApp();
  const { run, aliquot } = prepareRunningBatch(app);
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  assert.throws(
    () => app.results.ingestRevision(resultInput(run, aliquot.id, { occurredAt: future })),
    (error: unknown) => error instanceof DomainError && error.code === 'result.clock_skew',
  );
  const slightlyAhead = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  const tolerated = app.results.ingestRevision(resultInput(run, aliquot.id, { occurredAt: slightlyAhead }));
  assert.equal(tolerated.status, 'CURRENT');
});

test('revision chains are independent per analyte', () => {
  const app = makeApp();
  const { run, aliquot } = prepareRunningBatch(app);
  app.results.ingestRevision(resultInput(run, aliquot.id, { analyte: 'lead', revisionNumber: 2, contentHash: 'hash-lead-2' }));
  const arsenic = app.results.ingestRevision(resultInput(run, aliquot.id, { analyte: 'arsenic', revisionNumber: 1, contentHash: 'hash-as-1' }));
  assert.equal(arsenic.status, 'CURRENT', 'a different analyte starts its own chain at revision 1');
});
