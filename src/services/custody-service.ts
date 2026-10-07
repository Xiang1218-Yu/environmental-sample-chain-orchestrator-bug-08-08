import type { CustodyTransfer, SealStatus, TemperatureReading } from '../domain/types.js';
import { assertCondition, assertFound } from '../domain/errors.js';
import { toUtcIso } from '../domain/time.js';
import { Store } from '../store/store.js';

export interface HandoverInput {
  tenantId: string;
  projectId: string;
  containerId: string;
  fromHolderId: string;
  toHolderId: string;
  fromLocation: string;
  toLocation: string;
  handedOverAt: string;
  temperatureCelsius: number;
  sealStatus: SealStatus;
  clientOperationId: string;
}

export class CustodyService {
  constructor(private readonly store: Store) {}

  handOver(input: HandoverInput): CustodyTransfer {
    const duplicate = [...this.store.transfers.values()].find((item) => item.clientOperationId === input.clientOperationId && item.projectId === input.projectId);
    if (duplicate) return duplicate;
    const container = assertFound(this.store.containers.get(input.containerId), 'custody.container_not_found', 'container not found');
    this.assertScope(container.tenantId, container.projectId, input.tenantId, input.projectId);
    assertCondition(container.currentHolderId === input.fromHolderId, 'custody.holder_mismatch', 'container is held by a different user');
    assertCondition(container.custodyStatus === 'SEALED' || container.custodyStatus === 'RECEIVED' || container.custodyStatus === 'RELEASED_TO_LAB', 'custody.invalid_state', 'container cannot be handed over in its current state');
    const prior = [...this.store.transfers.values()].filter((item) => item.containerId === input.containerId).sort((a, b) => b.transferSequence - a.transferSequence)[0];
    const handedOverAt = toUtcIso(input.handedOverAt, 'handedOverAt');
    const transfer: CustodyTransfer = {
      id: this.store.nextId('transfer'),
      tenantId: input.tenantId,
      projectId: input.projectId,
      containerId: input.containerId,
      transferSequence: (prior?.transferSequence ?? 0) + 1,
      fromHolderId: input.fromHolderId,
      toHolderId: input.toHolderId,
      fromLocation: input.fromLocation,
      toLocation: input.toLocation,
      handedOverAt,
      temperatureCelsius: input.temperatureCelsius,
      sealStatus: input.sealStatus,
      status: input.sealStatus === 'INTACT' ? 'PENDING_RECEIPT' : 'ISOLATED',
      clientOperationId: input.clientOperationId,
      version: 1,
    };
    this.store.transfers.set(transfer.id, transfer);
    container.currentHolderId = input.toHolderId;
    container.currentLocation = input.toLocation;
    container.custodyStatus = transfer.status === 'ISOLATED' ? 'ISOLATED' : 'HANDED_OVER';
    container.sealStatus = input.sealStatus;
    insertByInstant(container.temperatureLog, { recordedAt: handedOverAt, celsius: input.temperatureCelsius, source: 'HANDHELD' });
    container.version += 1;
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'custody.handed_over', entity: 'container', entityId: container.id, metadata: { transferId: transfer.id, sequence: transfer.transferSequence, sealStatus: input.sealStatus } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'custody.handed-over', aggregateId: container.id, payload: JSON.stringify({ transferId: transfer.id, transferSequence: transfer.transferSequence, containerId: container.id }) });
    return transfer;
  }

  confirmReceipt(transferId: string, input: { receiverId: string; receivedAt: string; temperatureCelsius: number; sealStatus: SealStatus }): CustodyTransfer {
    const transfer = assertFound(this.store.transfers.get(transferId), 'custody.transfer_not_found', 'transfer not found');
    const container = assertFound(this.store.containers.get(transfer.containerId), 'custody.container_not_found', 'container not found');
    if (transfer.status === 'CONFIRMED' || transfer.status === 'ISOLATED') return transfer;
    assertCondition(transfer.status === 'PENDING_RECEIPT', 'custody.not_pending', 'transfer is not pending receipt');
    assertCondition(transfer.toHolderId === input.receiverId, 'custody.receiver_mismatch', 'receiver does not match the transfer');
    const receivedAt = toUtcIso(input.receivedAt, 'receivedAt');
    transfer.receivedAt = receivedAt;
    transfer.sealStatus = input.sealStatus;
    transfer.status = input.sealStatus === 'INTACT' ? 'CONFIRMED' : 'ISOLATED';
    transfer.version += 1;
    container.custodyStatus = transfer.status === 'CONFIRMED' ? 'RECEIVED' : 'ISOLATED';
    container.sealStatus = input.sealStatus;
    insertByInstant(container.temperatureLog, { recordedAt: receivedAt, celsius: input.temperatureCelsius, source: 'LAB_RECEIPT' });
    container.version += 1;
    this.store.addAudit({ tenantId: transfer.tenantId, projectId: transfer.projectId, action: 'custody.received', entity: 'transfer', entityId: transfer.id, metadata: { sequence: transfer.transferSequence, sealStatus: input.sealStatus } });
    this.store.addOutbox({ tenantId: transfer.tenantId, projectId: transfer.projectId, topic: 'custody.received', aggregateId: container.id, payload: JSON.stringify({ transferId, containerId: container.id, status: transfer.status }) });
    return transfer;
  }

  private assertScope(actualTenant: string, actualProject: string, tenantId: string, projectId: string): void {
    assertCondition(actualTenant === tenantId && actualProject === projectId, 'scope.forbidden', 'object does not belong to the requested project');
  }
}

/**
 * Inserts a reading so the trail stays ordered by event instant, not by
 * arrival order. Offline devices upload late, so a backdated reading must
 * land before later ones that were appended earlier. Ties keep arrival order.
 */
function insertByInstant(log: TemperatureReading[], reading: TemperatureReading): void {
  const instant = Date.parse(reading.recordedAt);
  let index = log.length;
  while (index > 0 && Date.parse(log[index - 1]!.recordedAt) > instant) index -= 1;
  log.splice(index, 0, reading);
}
