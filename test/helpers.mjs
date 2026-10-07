import { SampleChainApplication } from '../dist/app.js';

export const TENANT = 'tenant_test';
export const PROJECT = 'project_test';

let counter = 0;
export function unique(prefix) {
  counter += 1;
  return `${prefix}-${counter.toString().padStart(4, '0')}`;
}

export function makeApp() {
  return new SampleChainApplication();
}

export function sealSample(app, { collectedAt, maxTransitHours = 48, clientDeviceId = 'device_01', clientSequence } = {}) {
  return app.sampling.createSealedSample({
    tenantId: TENANT,
    projectId: PROJECT,
    collectorId: 'collector_01',
    protocolVersion: 'water-v3',
    medium: 'WATER',
    collectedAt,
    location: { latitude: 31.23, longitude: 121.47, siteCode: 'SITE-01' },
    preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours },
    clientDeviceId,
    clientSequence: clientSequence ?? (counter += 1),
    containerBarcode: unique('CNT'),
    sealCode: unique('SEAL'),
    totalVolumeMl: 100,
  });
}

export function deliverToLab(app, containerId, { handedOverAt, confirmedAt, labReceivedAt, businessTimeZone } = {}) {
  const transfer = app.custody.handOver({
    tenantId: TENANT,
    projectId: PROJECT,
    containerId,
    fromHolderId: 'collector_01',
    toHolderId: 'courier_01',
    fromLocation: 'SITE-01',
    toLocation: 'LAB-A',
    handedOverAt,
    temperatureCelsius: 5,
    sealStatus: 'INTACT',
    clientOperationId: unique('handover'),
  });
  app.custody.confirmReceipt(transfer.id, { receiverId: 'courier_01', receivedAt: confirmedAt, temperatureCelsius: 5, sealStatus: 'INTACT' });
  return app.receiving.receive({
    tenantId: TENANT,
    projectId: PROJECT,
    containerId,
    receivedBy: 'lab_receiver_01',
    receivedAt: labReceivedAt,
    ...(businessTimeZone === undefined ? {} : { businessTimeZone }),
    temperatureCelsius: 5,
    sealStatus: 'INTACT',
    decision: 'ACCEPTED',
    clientOperationId: unique('receive'),
  });
}

export function runningBatch(app) {
  const sealed = sealSample(app, { collectedAt: '2026-10-06T08:00:00.000Z' });
  deliverToLab(app, sealed.container.id, {
    handedOverAt: '2026-10-06T08:30:00.000Z',
    confirmedAt: '2026-10-06T09:30:00.000Z',
    labReceivedAt: '2026-10-06T09:45:00.000Z',
  });
  const aliquots = app.aliquots.createMany({
    tenantId: TENANT,
    projectId: PROJECT,
    parentContainerId: sealed.container.id,
    protocolVersion: 'water-v3',
    createdBy: 'analyst_01',
    operationId: unique('aliquot'),
    items: [{ barcode: unique('ALQ'), volumeMl: 20, unit: 'ML' }],
  });
  const batch = app.batches.create({ tenantId: TENANT, projectId: PROJECT, protocolVersion: 'water-v3', instrumentType: 'ICP-MS', requiredControls: [], createdBy: 'analyst_01' });
  app.batches.addAliquot(batch.id, aliquots[0].id);
  app.batches.markReady(batch.id);
  app.batches.start(batch.id, '2026-10-06T10:00:00.000Z');
  const run = app.results.registerRun({
    tenantId: TENANT,
    projectId: PROJECT,
    batchId: batch.id,
    externalRunId: unique('RUN'),
    rawFileHash: 'raw-hash',
    instrumentSoftwareVersion: 'instrument-7.2',
    startedAt: '2026-10-06T10:05:00.000Z',
  });
  return { sealed, aliquots, batch, run };
}

export function ingest(app, batch, run, { revisionNumber, value, contentHash, occurredAt, analyte = 'lead' }) {
  return app.results.ingestRevision({
    tenantId: TENANT,
    projectId: PROJECT,
    batchId: batch.id,
    runId: run.id,
    analyte,
    value,
    unit: 'mg/L',
    detectionLimit: 0.01,
    qualityFlags: [],
    instrumentSoftwareVersion: 'instrument-7.2',
    contentHash,
    revisionNumber,
    occurredAt,
  });
}

export function resultsFor(app, batchId) {
  return [...app.store.results.values()].filter((result) => result.batchId === batchId);
}

export function currentResult(app, batchId) {
  return resultsFor(app, batchId).find((result) => result.status === 'CURRENT');
}
