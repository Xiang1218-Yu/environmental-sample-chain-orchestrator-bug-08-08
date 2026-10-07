import { assertCondition, assertFound } from '../domain/errors.js';
import { localBusinessDate, MAX_CLOCK_SKEW_MS, parseInstant, toUtcIso } from '../domain/time.js';
export class ReceivingService {
    store;
    constructor(store) {
        this.store = store;
    }
    receive(input) {
        const duplicate = [...this.store.receiving.values()].find((item) => item.clientOperationId === input.clientOperationId && item.projectId === input.projectId);
        if (duplicate)
            return duplicate;
        const container = assertFound(this.store.containers.get(input.containerId), 'receiving.container_not_found', 'container not found');
        assertCondition(container.tenantId === input.tenantId && container.projectId === input.projectId, 'scope.forbidden', 'container is outside the requested project');
        assertCondition(container.custodyStatus === 'RECEIVED' || container.custodyStatus === 'HANDED_OVER', 'receiving.invalid_state', 'container is not ready for receiving');
        const sample = assertFound(this.store.samples.get(container.sampleId), 'receiving.sample_not_found', 'sample not found');
        // The lab receive event keeps its instant in canonical UTC; the local
        // business date is derived from the lab's reported offset. Both are stored
        // so every entry point reads the same values.
        const receivedAt = toUtcIso(input.receivedAt, 'receivedAt');
        const receivedDateLocal = localBusinessDate(input.receivedAt, 'receivedAt');
        this.assertWithinRetention(sample.collectedAt, receivedAt, sample.preservation.maxTransitHours, input.decision);
        const id = this.store.nextId('receiving');
        const record = {
            id,
            tenantId: input.tenantId,
            projectId: input.projectId,
            containerId: input.containerId,
            decision: input.decision,
            receivedBy: input.receivedBy,
            receivedAt,
            receivedDateLocal,
            recordedAt: this.store.now(),
            temperatureCelsius: input.temperatureCelsius,
            sealStatus: input.sealStatus,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            clientOperationId: input.clientOperationId,
            version: 1,
        };
        this.store.receiving.set(id, record);
        container.custodyStatus = input.decision === 'ACCEPTED' ? 'RELEASED_TO_LAB' : 'ISOLATED';
        container.sealStatus = input.sealStatus;
        container.version += 1;
        sample.status = input.decision === 'ACCEPTED' ? 'RECEIVED' : 'ISOLATED';
        sample.receivedAt = receivedAt;
        sample.version += 1;
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'sample.received', entity: 'container', entityId: container.id, metadata: { decision: input.decision, sealStatus: input.sealStatus, receivingId: id } });
        this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'sample.received', aggregateId: sample.id, payload: JSON.stringify({ sampleId: sample.id, containerId: container.id, decision: input.decision }) });
        return record;
    }
    /**
     * Retention is evaluated on event instants (UTC), never on wall-clock dates.
     * A small clock-skew tolerance keeps slightly-behind device clocks usable;
     * anything beyond it is rejected instead of silently passing or failing.
     */
    assertWithinRetention(collectedAtUtc, receivedAtUtc, maxTransitHours, decision) {
        const collectedMs = parseInstant(collectedAtUtc, 'collectedAt');
        const receivedMs = parseInstant(receivedAtUtc, 'receivedAt');
        assertCondition(receivedMs >= collectedMs - MAX_CLOCK_SKEW_MS, 'receiving.clock_skew', 'received time is before collection time beyond the clock skew tolerance');
        if (decision !== 'ACCEPTED')
            return;
        const transitMs = Math.max(0, receivedMs - collectedMs);
        assertCondition(transitMs <= maxTransitHours * 3_600_000, 'receiving.transit_expired', 'sample exceeded its maximum transit time before lab receipt');
    }
}
