import { assertCondition, assertFound } from '../domain/errors.js';
import { assertWithinClockSkew, toUtcIso } from '../domain/time.js';
export class ResultService {
    store;
    constructor(store) {
        this.store = store;
    }
    registerRun(input) {
        const existing = [...this.store.runs.values()].find((run) => run.projectId === input.projectId && run.externalRunId === input.externalRunId);
        if (existing) {
            assertCondition(existing.rawFileHash === input.rawFileHash, 'result.run_conflict', 'external run id has a different raw file');
            return existing;
        }
        const batch = assertFound(this.store.batches.get(input.batchId), 'batch.not_found', 'batch not found');
        assertCondition(batch.tenantId === input.tenantId && batch.projectId === input.projectId, 'scope.forbidden', 'batch is outside the requested project');
        assertCondition(batch.status === 'RUNNING' || batch.status === 'RESULTS_PENDING', 'result.batch_not_running', 'batch is not accepting instrument runs');
        const run = { id: this.store.nextId('run'), tenantId: input.tenantId, projectId: input.projectId, batchId: input.batchId, externalRunId: input.externalRunId, rawFileHash: input.rawFileHash, instrumentSoftwareVersion: input.instrumentSoftwareVersion, startedAt: toUtcIso(input.startedAt, 'startedAt'), status: 'REGISTERED', version: 1 };
        this.store.runs.set(run.id, run);
        batch.status = 'RESULTS_PENDING';
        batch.version += 1;
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'instrument.run_registered', entity: 'run', entityId: run.id, metadata: { batchId: batch.id, externalRunId: input.externalRunId } });
        return run;
    }
    completeRun(runId, completedAt, status) {
        const run = assertFound(this.store.runs.get(runId), 'result.run_not_found', 'instrument run not found');
        assertCondition(run.status === 'REGISTERED' || run.status === 'RUNNING', 'result.run_closed', 'instrument run is already closed');
        run.status = status;
        run.completedAt = toUtcIso(completedAt, 'completedAt');
        run.version += 1;
        return run;
    }
    /**
     * Ingests one business revision. Ordering is driven by the client-supplied
     * revision number, never by arrival order or wall-clock time:
     * - a replay of an already-seen revision (same number, same content) is idempotent;
     * - the same revision number with different content is a conflict;
     * - a higher revision supersedes the current one, even if it arrives late;
     * - a lower revision is kept for the audit trail but never becomes current.
     */
    ingestRevision(input) {
        const run = assertFound(this.store.runs.get(input.runId), 'result.run_not_found', 'instrument run not found');
        const batch = assertFound(this.store.batches.get(input.batchId), 'batch.not_found', 'batch not found');
        assertCondition(run.batchId === batch.id && run.projectId === input.projectId && batch.projectId === input.projectId, 'scope.forbidden', 'result does not belong to the requested batch');
        assertCondition(Number.isInteger(input.revisionNumber) && input.revisionNumber >= 1, 'result.invalid_revision', 'revision number must be a positive integer');
        const occurredAt = toUtcIso(input.occurredAt, 'occurredAt');
        const receivedAt = this.store.now();
        assertWithinClockSkew(occurredAt, receivedAt, 'result.clock_skew', 'occurredAt');
        const revisions = this.findRevisions(input);
        const sameRevision = revisions.find((result) => result.revisionNumber === input.revisionNumber);
        if (sameRevision) {
            assertCondition(sameRevision.contentHash === input.contentHash, 'result.revision_conflict', 'revision number already exists with different content');
            return sameRevision;
        }
        const current = revisions.filter((result) => result.status === 'CURRENT').sort((a, b) => b.revisionNumber - a.revisionNumber)[0];
        const supersedes = current && input.revisionNumber > current.revisionNumber ? current : undefined;
        return this.createRevision(input, occurredAt, receivedAt, supersedes, current !== undefined && supersedes === undefined);
    }
    createRevision(input, occurredAt, receivedAt, supersedes, supersededOnArrival) {
        const result = {
            id: this.store.nextId('result'),
            tenantId: input.tenantId,
            projectId: input.projectId,
            batchId: input.batchId,
            runId: input.runId,
            ...(input.aliquotId === undefined ? {} : { aliquotId: input.aliquotId }),
            ...(input.controlKind === undefined ? {} : { controlKind: input.controlKind }),
            analyte: input.analyte,
            value: input.value,
            unit: input.unit,
            detectionLimit: input.detectionLimit,
            qualityFlags: [...input.qualityFlags],
            instrumentSoftwareVersion: input.instrumentSoftwareVersion,
            contentHash: input.contentHash,
            revisionNumber: input.revisionNumber,
            ...(supersedes === undefined ? {} : { supersedesRevisionId: supersedes.id }),
            status: supersededOnArrival ? 'SUPERSEDED' : 'CURRENT',
            occurredAt,
            receivedAt,
            version: 1,
        };
        if (supersedes) {
            supersedes.status = 'SUPERSEDED';
            supersedes.version += 1;
        }
        this.store.results.set(result.id, result);
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'result.revision_created', entity: 'result', entityId: result.id, metadata: { batchId: input.batchId, revisionNumber: input.revisionNumber, analyte: input.analyte, status: result.status } });
        this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'result.revision-created', aggregateId: result.id, payload: JSON.stringify({ resultId: result.id, batchId: input.batchId, revisionNumber: input.revisionNumber }) });
        return result;
    }
    findRevisions(input) {
        return [...this.store.results.values()].filter((result) => result.projectId === input.projectId && result.batchId === input.batchId && result.analyte === input.analyte && result.aliquotId === input.aliquotId && result.controlKind === input.controlKind);
    }
}
