import { assertCondition, assertFound, DomainError } from '../domain/errors.js';
import { normalizeInstant } from '../domain/time.js';
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
        const run = { id: this.store.nextId('run'), tenantId: input.tenantId, projectId: input.projectId, batchId: input.batchId, externalRunId: input.externalRunId, rawFileHash: input.rawFileHash, instrumentSoftwareVersion: input.instrumentSoftwareVersion, startedAt: normalizeInstant(input.startedAt), status: 'REGISTERED', version: 1 };
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
        run.completedAt = normalizeInstant(completedAt);
        run.version += 1;
        return run;
    }
    ingestRevision(input) {
        const run = assertFound(this.store.runs.get(input.runId), 'result.run_not_found', 'instrument run not found');
        const batch = assertFound(this.store.batches.get(input.batchId), 'batch.not_found', 'batch not found');
        assertCondition(run.batchId === batch.id && run.projectId === input.projectId && batch.projectId === input.projectId, 'scope.forbidden', 'result does not belong to the requested batch');
        assertCondition(Number.isInteger(input.revisionNumber) && input.revisionNumber > 0, 'result.invalid_revision', 'revision number must be a positive integer');
        const occurredAt = normalizeInstant(input.occurredAt);
        const revisions = this.findRevisions(input);
        const current = revisions.find((result) => result.status === 'CURRENT');
        // Anchor for ordering decisions: the current revision when one exists,
        // otherwise the highest known business revision (e.g. all withdrawn).
        const anchor = current ?? [...revisions].sort((a, b) => b.revisionNumber - a.revisionNumber)[0];
        if (anchor) {
            if (input.revisionNumber < anchor.revisionNumber) {
                // Late-arriving older revision. It must not displace the newer
                // current one, no matter what its timestamps say.
                this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'result.revision_stale', entity: 'result', entityId: anchor.id, metadata: { batchId: input.batchId, analyte: input.analyte, rejectedRevision: input.revisionNumber, currentRevision: anchor.revisionNumber } });
                return anchor;
            }
            if (input.revisionNumber === anchor.revisionNumber) {
                // Idempotent replay of the same business revision.
                if (anchor.contentHash === input.contentHash)
                    return anchor;
                throw new DomainError('result.revision_conflict', 'same business revision was submitted with different content');
            }
            // Higher business revision wins, even when its occurrence time is
            // earlier than the server receive time of the previous one.
            return this.createRevision(input, occurredAt, anchor.status === 'CURRENT' ? anchor.id : undefined);
        }
        return this.createRevision(input, occurredAt);
    }
    createRevision(input, occurredAt, supersedesRevisionId) {
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
            occurredAt,
            ...(supersedesRevisionId === undefined ? {} : { supersedesRevisionId }),
            status: 'CURRENT',
            // Server receive time. Recorded for audit; never an ordering key.
            createdAt: this.store.now(),
            version: 1,
        };
        if (supersedesRevisionId) {
            const prior = assertFound(this.store.results.get(supersedesRevisionId), 'result.previous_missing', 'previous result revision not found');
            prior.status = 'SUPERSEDED';
            prior.version += 1;
        }
        this.store.results.set(result.id, result);
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'result.revision_created', entity: 'result', entityId: result.id, metadata: { batchId: input.batchId, revisionNumber: input.revisionNumber, analyte: input.analyte } });
        this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'result.revision-created', aggregateId: result.id, payload: JSON.stringify({ resultId: result.id, batchId: input.batchId, revisionNumber: input.revisionNumber }) });
        return result;
    }
    findRevisions(input) {
        return [...this.store.results.values()].filter((result) => result.projectId === input.projectId && result.batchId === input.batchId && result.analyte === input.analyte && result.aliquotId === input.aliquotId && result.controlKind === input.controlKind);
    }
}
