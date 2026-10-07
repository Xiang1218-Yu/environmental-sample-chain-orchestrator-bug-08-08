import assert from 'node:assert/strict';
import test from 'node:test';
import { makeApp, prepareRunningBatch, projectId, resultInput, sampleInput, tenantId } from './helpers.js';

function prepareApprovedProject() {
  const app = makeApp();
  const { run, aliquot, batch } = prepareRunningBatch(app);
  const result = app.results.ingestRevision(resultInput(run, aliquot.id));
  app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: result.id, decision: 'APPROVED', reason: 'within protocol limits', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01' });
  app.quality.approveBatch(batch.id, 'reviewer_01');
  return { app, batch, result };
}

test('evidence display times: generatedAt is set at generation, frozenAt only at freeze', () => {
  const { app } = prepareApprovedProject();
  const generated = app.evidence.generate({ tenantId, projectId, requestKey: 'evidence-1' });
  assert.equal(generated.status, 'READY');
  assert.match(generated.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(generated.frozenAt, undefined, 'a ready package is not frozen yet');

  const frozen = app.evidence.freeze(generated.id);
  assert.equal(frozen.status, 'FROZEN');
  assert.ok(frozen.frozenAt);
  assert.ok(Date.parse(frozen.frozenAt!) >= Date.parse(frozen.generatedAt));
});

test('regenerating with the same request key keeps the original display times', () => {
  const { app } = prepareApprovedProject();
  const first = app.evidence.generate({ tenantId, projectId, requestKey: 'evidence-2' });
  const frozen = app.evidence.freeze(first.id);
  const again = app.evidence.generate({ tenantId, projectId, requestKey: 'evidence-2' });
  assert.equal(again.id, first.id);
  assert.equal(again.generatedAt, first.generatedAt);
  assert.equal(again.frozenAt, frozen.frozenAt);
  assert.equal(again.manifestHash, first.manifestHash);
});

test('evidence covers samples collected in different timezones with one consistent instant each', () => {
  const { app } = prepareApprovedProject();
  // Same instant reported from two timezones; both must read identically everywhere.
  const a = app.sampling.createSealedSample(sampleInput({ collectedAt: '2026-10-06T23:30:00+08:00' })).sample;
  const b = app.sampling.createSealedSample(sampleInput({ collectedAt: '2026-10-06T10:30:00-05:00' })).sample;
  const pack = app.evidence.generate({ tenantId, projectId, requestKey: 'evidence-3' });
  assert.ok(pack.sourceIds.sampleIds.includes(a.id));
  assert.ok(pack.sourceIds.sampleIds.includes(b.id));
  const storedA = app.store.samples.get(a.id);
  const storedB = app.store.samples.get(b.id);
  assert.equal(storedA?.collectedAt, '2026-10-06T15:30:00.000Z');
  assert.equal(storedB?.collectedAt, '2026-10-06T15:30:00.000Z');
  assert.equal(storedA?.collectedDateLocal, storedB?.collectedDateLocal);
});
