import type { ReceivingDecision, ReceivingRecord } from '../domain/types.js';
import { assertCondition, assertFound } from '../domain/errors.js';
import { addHours, businessDateOf, compareInstants, DEFAULT_BUSINESS_TIME_ZONE, normalizeInstant } from '../domain/time.js';
import { Store } from '../store/store.js';

export interface ReceiveInput {
  tenantId: string;
  projectId: string;
  containerId: string;
  receivedBy: string;
  receivedAt: string;
  /** IANA time zone for the local business date of receipt; defaults to UTC. */
  businessTimeZone?: string;
  temperatureCelsius: number;
  sealStatus: 'INTACT' | 'BROKEN' | 'MISSING' | 'RESEALED';
  decision: ReceivingDecision;
  reason?: string;
  clientOperationId: string;
}

export class ReceivingService {
  constructor(private readonly store: Store) {}

  receive(input: ReceiveInput): ReceivingRecord {
    const duplicate = [...this.store.receiving.values()].find((item) => item.clientOperationId === input.clientOperationId && item.projectId === input.projectId);
    if (duplicate) return duplicate;
    const container = assertFound(this.store.containers.get(input.containerId), 'receiving.container_not_found', 'container not found');
    assertCondition(container.tenantId === input.tenantId && container.projectId === input.projectId, 'scope.forbidden', 'container is outside the requested project');
    assertCondition(container.custodyStatus === 'RECEIVED' || container.custodyStatus === 'HANDED_OVER', 'receiving.invalid_state', 'container is not ready for receiving');
    const sample = assertFound(this.store.samples.get(container.sampleId), 'receiving.sample_not_found', 'sample not found');
    // Event occurrence time, normalized to a UTC instant. The same normalized
    // value is written to every record of this event, so no entry point can
    // reach a different conclusion from a different textual representation.
    const receivedAt = normalizeInstant(input.receivedAt);
    const businessTimeZone = input.businessTimeZone ?? DEFAULT_BUSINESS_TIME_ZONE;
    // Holding time is measured between UTC instants: the collection event
    // time plus the protocol transit window. The deadline instant itself is
    // inclusive — a receipt exactly at the deadline is still within holding.
    const transitDeadlineAt = addHours(sample.collectedAt, sample.preservation.maxTransitHours);
    const withinHoldingTime = compareInstants(receivedAt, transitDeadlineAt) <= 0;
    const record: ReceivingRecord = {
      id: this.store.nextId('receiving'),
      tenantId: input.tenantId,
      projectId: input.projectId,
      containerId: input.containerId,
      decision: input.decision,
      receivedBy: input.receivedBy,
      receivedAt,
      serverReceivedAt: this.store.now(),
      receivedBusinessDate: businessDateOf(receivedAt, businessTimeZone),
      businessTimeZone,
      transitDeadlineAt,
      withinHoldingTime,
      temperatureCelsius: input.temperatureCelsius,
      sealStatus: input.sealStatus,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      clientOperationId: input.clientOperationId,
      version: 1,
    };
    this.store.receiving.set(record.id, record);
    container.custodyStatus = input.decision === 'ACCEPTED' ? 'RELEASED_TO_LAB' : 'ISOLATED';
    container.sealStatus = input.sealStatus;
    container.version += 1;
    sample.status = input.decision === 'ACCEPTED' ? 'RECEIVED' : 'ISOLATED';
    sample.receivedAt = receivedAt;
    sample.version += 1;
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'sample.received', entity: 'container', entityId: container.id, metadata: { decision: input.decision, sealStatus: input.sealStatus, receivingId: record.id, withinHoldingTime } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'sample.received', aggregateId: sample.id, payload: JSON.stringify({ sampleId: sample.id, containerId: container.id, decision: input.decision, withinHoldingTime }) });
    return record;
  }
}
