import { SampleChainApplication } from '../src/app.js';
import type { CreateSampleInput } from '../src/services/sampling-service.js';

export const tenantId = 'tenant_test';
export const projectId = 'project_test';

export function makeApp(): SampleChainApplication {
  return new SampleChainApplication();
}

let counter = 0;
function next(): number {
  counter += 1;
  return counter;
}

export function sampleInput(overrides: Partial<CreateSampleInput> = {}): CreateSampleInput {
  const n = next();
  return {
    tenantId,
    projectId,
    collectorId: 'collector_01',
    protocolVersion: 'water-v3',
    medium: 'WATER',
    collectedAt: '2026-10-06T08:00:00+08:00',
    location: { latitude: 31.23, longitude: 121.47, siteCode: 'SITE-SH-01' },
    preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
    clientDeviceId: 'device_01',
    clientSequence: n,
    containerBarcode: `CNT-TEST-${n}`,
    sealCode: `SEAL-${n}`,
    totalVolumeMl: 100,
    ...overrides,
  };
}

/** Creates a sealed sample and hands it over so the container is ready for lab receipt. */
export function prepareInTransitContainer(app: SampleChainApplication, overrides: Partial<CreateSampleInput> = {}, handedOverAt = '2026-10-06T09:00:00+08:00') {
  const sealed = app.sampling.createSealedSample(sampleInput(overrides));
  const n = next();
  const transfer = app.custody.handOver({
    tenantId,
    projectId,
    containerId: sealed.container.id,
    fromHolderId: 'collector_01',
    toHolderId: 'courier_01',
    fromLocation: 'SITE-SH-01',
    toLocation: 'LAB-SH-A',
    handedOverAt,
    temperatureCelsius: 5,
    sealStatus: 'INTACT',
    clientOperationId: `handover-${n}`,
  });
  return { ...sealed, transfer };
}

/** Builds a running batch with one allocated aliquot and a registered instrument run. */
export function prepareRunningBatch(app: SampleChainApplication) {
  const { container } = prepareInTransitContainer(app);
  app.receiving.receive({
    tenantId,
    projectId,
    containerId: container.id,
    receivedBy: 'lab_receiver_01',
    receivedAt: '2026-10-06T10:00:00+08:00',
    temperatureCelsius: 5,
    sealStatus: 'INTACT',
    decision: 'ACCEPTED',
    clientOperationId: `receive-${next()}`,
  });
  const aliquot = app.aliquots.createMany({
    tenantId,
    projectId,
    parentContainerId: container.id,
    protocolVersion: 'water-v3',
    createdBy: 'analyst_01',
    operationId: `aliquot-${next()}`,
    items: [{ barcode: `ALQ-${next()}`, volumeMl: 20, unit: 'ML' }],
  })[0]!;
  const batch = app.batches.create({ tenantId, projectId, protocolVersion: 'water-v3', instrumentType: 'ICP-MS', requiredControls: [], createdBy: 'analyst_01' });
  app.batches.addAliquot(batch.id, aliquot.id);
  app.batches.markReady(batch.id);
  app.batches.start(batch.id, '2026-10-06T11:00:00+08:00');
  const run = app.results.registerRun({
    tenantId,
    projectId,
    batchId: batch.id,
    externalRunId: `RUN-${next()}`,
    rawFileHash: 'raw-hash',
    instrumentSoftwareVersion: 'instrument-7.2',
    startedAt: '2026-10-06T11:10:00+08:00',
  });
  return { batch, run, aliquot, container };
}

export function resultInput(run: { id: string; batchId: string }, aliquotId: string, overrides: Record<string, unknown> = {}) {
  return {
    tenantId,
    projectId,
    batchId: run.batchId,
    runId: run.id,
    aliquotId,
    analyte: 'lead',
    value: 0.12,
    unit: 'mg/L',
    detectionLimit: 0.01,
    qualityFlags: [] as string[],
    instrumentSoftwareVersion: 'instrument-7.2',
    contentHash: 'hash-rev-1',
    revisionNumber: 1,
    occurredAt: '2026-10-06T12:00:00+00:00',
    ...overrides,
  };
}
