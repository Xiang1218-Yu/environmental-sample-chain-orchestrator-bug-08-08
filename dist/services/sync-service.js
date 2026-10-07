import { assertCondition, DomainError } from '../domain/errors.js';
import { normalizeInstant } from '../domain/time.js';
export class SyncService {
    store;
    sampling;
    custody;
    receiving;
    aliquots;
    constructor(store, sampling, custody, receiving, aliquots) {
        this.store = store;
        this.sampling = sampling;
        this.custody = custody;
        this.receiving = receiving;
        this.aliquots = aliquots;
    }
    async apply(envelope) {
        // occurredAt is the client-reported event time. Offline devices and
        // skewed clocks are expected, so it is normalized and kept for evidence
        // only — staleness and ordering are decided by clientSequence, and the
        // server receive time is recorded separately as appliedAt.
        const normalized = { ...envelope, occurredAt: normalizeInstant(envelope.occurredAt) };
        return this.store.transaction(() => {
            const key = `${normalized.tenantId}|${normalized.projectId}|${normalized.deviceId}|${normalized.operationId}`;
            const existing = this.store.syncRecords.get(key);
            if (existing) {
                if (existing.envelope.payloadHash !== normalized.payloadHash) {
                    existing.result = 'CONFLICT';
                    existing.conflictReason = 'same operation id was submitted with a different payload';
                    throw new DomainError('sync.payload_conflict', existing.conflictReason);
                }
                return existing.result;
            }
            const priorSequence = [...this.store.syncRecords.values()].filter((record) => record.envelope.tenantId === normalized.tenantId && record.envelope.projectId === normalized.projectId && record.envelope.deviceId === normalized.deviceId).map((record) => record.envelope.clientSequence).sort((a, b) => b - a)[0];
            if (priorSequence !== undefined && normalized.clientSequence < priorSequence - 1000) {
                this.record(key, normalized, 'STALE', undefined, 'client sequence is outside the accepted replay window');
                return 'STALE';
            }
            const resultReference = this.dispatch(normalized);
            this.record(key, normalized, 'APPLIED', resultReference);
            return 'APPLIED';
        });
    }
    dispatch(envelope) {
        assertCondition(envelope.projectId.length > 0 && envelope.tenantId.length > 0, 'sync.invalid_scope', 'sync envelope must include tenant and project');
        switch (envelope.type) {
            case 'CREATE_SAMPLE': {
                const input = envelope.payload;
                const created = this.sampling.createSealedSample({ ...input, tenantId: envelope.tenantId, projectId: envelope.projectId, clientDeviceId: envelope.deviceId, clientSequence: envelope.clientSequence });
                return created.sample.id;
            }
            case 'CUSTODY_TRANSFER': {
                const input = envelope.payload;
                return this.custody.handOver({ ...input, tenantId: envelope.tenantId, projectId: envelope.projectId, clientOperationId: envelope.operationId }).id;
            }
            case 'RECEIVE_CONTAINER': {
                const input = envelope.payload;
                return this.receiving.receive({ ...input, tenantId: envelope.tenantId, projectId: envelope.projectId, clientOperationId: envelope.operationId }).id;
            }
            case 'CREATE_ALIQUOT': {
                const input = envelope.payload;
                return this.aliquots.createMany({ ...input, tenantId: envelope.tenantId, projectId: envelope.projectId, operationId: envelope.operationId }).map((item) => item.id).join(',');
            }
        }
    }
    record(key, envelope, result, resultReference, conflictReason) {
        this.store.syncRecords.set(key, { key, envelope: structuredClone(envelope), result, ...(resultReference === undefined ? {} : { resultReference }), ...(conflictReason === undefined ? {} : { conflictReason }), appliedAt: this.store.now() });
    }
}
