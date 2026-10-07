export type ProjectId = string;
export type TenantId = string;
export type UserId = string;
export type SampleId = string;
export type ContainerId = string;
export type AliquotId = string;
export type BatchId = string;
export type ResultId = string;

export type SampleStatus = 'DRAFT' | 'SEALED' | 'IN_TRANSIT' | 'RECEIVED' | 'ISOLATED' | 'CONSUMED' | 'DISPOSED';
export type SealStatus = 'INTACT' | 'BROKEN' | 'MISSING' | 'RESEALED';
export type CustodyStatus = 'SEALED' | 'HANDED_OVER' | 'RECEIVED' | 'ISOLATED' | 'RELEASED_TO_LAB';
export type ReceivingDecision = 'ACCEPTED' | 'ISOLATED' | 'REJECTED';
export type AliquotStatus = 'AVAILABLE' | 'ALLOCATED' | 'CONSUMED' | 'DISPOSED';
export type BatchStatus = 'DRAFT' | 'READY' | 'RUNNING' | 'RESULTS_PENDING' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type RunStatus = 'REGISTERED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
export type QualityDecisionType = 'APPROVED' | 'REJECTED' | 'RETEST_REQUIRED';
export type EvidenceStatus = 'GENERATING' | 'READY' | 'FAILED' | 'FROZEN';
export type SyncApplyResult = 'APPLIED' | 'DUPLICATE' | 'CONFLICT' | 'STALE';

export interface Versioned {
  version: number;
}

export interface SamplingRecord extends Versioned {
  id: SampleId;
  tenantId: TenantId;
  projectId: ProjectId;
  collectorId: UserId;
  protocolVersion: string;
  medium: 'WATER' | 'SOIL' | 'AIR' | 'SEDIMENT';
  /** Event occurrence time of collection, stored as a canonical UTC instant. */
  collectedAt: string;
  /** Event occurrence time of lab receipt (UTC instant), mirrored from the receiving record. */
  receivedAt?: string;
  location: { latitude: number; longitude: number; siteCode: string };
  preservation: { temperatureCelsius: number; method: string; maxTransitHours: number };
  status: SampleStatus;
  clientDeviceId: string;
  clientSequence: number;
  containerId?: ContainerId;
}

export interface SampleContainer extends Versioned {
  id: ContainerId;
  tenantId: TenantId;
  projectId: ProjectId;
  sampleId: SampleId;
  barcode: string;
  sealCode: string;
  sealStatus: SealStatus;
  custodyStatus: CustodyStatus;
  currentHolderId: UserId;
  currentLocation: string;
  temperatureLog: TemperatureReading[];
  availableVolumeMl: number;
  totalVolumeMl: number;
}

export interface TemperatureReading {
  recordedAt: string;
  celsius: number;
  source: 'HANDHELD' | 'LOGGER' | 'LAB_RECEIPT';
}

export interface CustodyTransfer extends Versioned {
  id: string;
  tenantId: TenantId;
  projectId: ProjectId;
  containerId: ContainerId;
  /**
   * Ordering key for the custody chain. Timestamps are never used to order
   * transfers because device clocks drift.
   */
  transferSequence: number;
  fromHolderId: UserId;
  toHolderId: UserId;
  fromLocation: string;
  toLocation: string;
  /** Event occurrence time of the handover (UTC instant, client-reported). */
  handedOverAt: string;
  /** Event occurrence time of the receipt confirmation (UTC instant). */
  receivedAt?: string;
  temperatureCelsius: number;
  sealStatus: SealStatus;
  status: 'PENDING_RECEIPT' | 'CONFIRMED' | 'ISOLATED' | 'REJECTED';
  clientOperationId: string;
}

export interface ReceivingRecord extends Versioned {
  id: string;
  tenantId: TenantId;
  projectId: ProjectId;
  containerId: ContainerId;
  decision: ReceivingDecision;
  receivedBy: UserId;
  /** Event occurrence time of lab receipt (UTC instant, client-reported). */
  receivedAt: string;
  /** Server receive time: when this record was processed (UTC instant). */
  serverReceivedAt: string;
  /** Local business date of `receivedAt` in `businessTimeZone`. */
  receivedBusinessDate: string;
  /** IANA time zone used to derive `receivedBusinessDate`. */
  businessTimeZone: string;
  /** Holding-time deadline: sample collectedAt + maxTransitHours (UTC instant). */
  transitDeadlineAt: string;
  /** True when receivedAt <= transitDeadlineAt; the deadline instant itself is inclusive. */
  withinHoldingTime: boolean;
  temperatureCelsius: number;
  sealStatus: SealStatus;
  reason?: string;
  clientOperationId: string;
}

export interface Aliquot extends Versioned {
  id: AliquotId;
  tenantId: TenantId;
  projectId: ProjectId;
  parentContainerId: ContainerId;
  barcode: string;
  volumeMl: number;
  unit: 'ML' | 'G' | 'L';
  protocolVersion: string;
  createdBy: UserId;
  createdAt: string;
  status: AliquotStatus;
  sourceOperationId: string;
}

export interface AnalysisBatch extends Versioned {
  id: BatchId;
  tenantId: TenantId;
  projectId: ProjectId;
  protocolVersion: string;
  instrumentType: string;
  status: BatchStatus;
  memberAliquotIds: AliquotId[];
  requiredControls: ControlRequirement[];
  controlResultIds: ResultId[];
  createdBy: UserId;
  createdAt: string;
  startedAt?: string;
  frozenAt?: string;
  approvedAt?: string;
}

export interface ControlRequirement {
  kind: 'BLANK' | 'CALIBRATION' | 'POSITIVE_CONTROL' | 'NEGATIVE_CONTROL';
  minimumCount: number;
}

export interface InstrumentRun extends Versioned {
  id: string;
  tenantId: TenantId;
  projectId: ProjectId;
  batchId: BatchId;
  externalRunId: string;
  rawFileHash: string;
  instrumentSoftwareVersion: string;
  startedAt: string;
  completedAt?: string;
  status: RunStatus;
}

export interface ResultRevision extends Versioned {
  id: ResultId;
  tenantId: TenantId;
  projectId: ProjectId;
  batchId: BatchId;
  runId: string;
  aliquotId?: AliquotId;
  controlKind?: ControlRequirement['kind'];
  analyte: string;
  value: number;
  unit: string;
  detectionLimit: number;
  qualityFlags: string[];
  instrumentSoftwareVersion: string;
  contentHash: string;
  /**
   * Business revision number assigned by the instrument/LIMS. This is the
   * only ordering key between revisions — never compare `occurredAt` or
   * `createdAt` to decide which revision is current.
   */
  revisionNumber: number;
  /**
   * Event occurrence time on the instrument (UTC instant). May legitimately
   * precede `createdAt` when a device uploads after being offline.
   */
  occurredAt: string;
  supersedesRevisionId?: ResultId;
  status: 'CURRENT' | 'SUPERSEDED' | 'WITHDRAWN';
  /** Server receive time of this revision (UTC instant). Not an ordering key. */
  createdAt: string;
}

export interface QualityDecision extends Versioned {
  id: string;
  tenantId: TenantId;
  projectId: ProjectId;
  batchId: BatchId;
  resultId: ResultId;
  decision: QualityDecisionType;
  reason: string;
  ruleVersion: string;
  reviewerId: UserId;
  decidedAt: string;
}

export interface EvidenceTimelineEntry {
  kind: string;
  id: string;
  /** Event occurrence or server receive time as a canonical UTC instant. */
  at: string;
  /** Local business date of `at` in the package display time zone. */
  businessDate: string;
}

export interface EvidencePackage extends Versioned {
  id: string;
  tenantId: TenantId;
  projectId: ProjectId;
  requestKey: string;
  status: EvidenceStatus;
  snapshotVersion: number;
  /** IANA time zone used for the display dates in `timeline`. */
  displayTimeZone: string;
  /** Server generation/freeze time (UTC instant). */
  frozenAt?: string;
  /** Local business date of `frozenAt` in `displayTimeZone`. */
  frozenBusinessDate?: string;
  /** Display-ready timeline of the exported chain, sorted by instant. */
  timeline: EvidenceTimelineEntry[];
  sourceIds: { sampleIds: SampleId[]; containerIds: ContainerId[]; batchIds: BatchId[]; resultIds: ResultId[]; qualityDecisionIds: string[] };
  manifestHash?: string;
  fileKeys: string[];
  failureReason?: string;
}

export interface SyncEnvelope {
  tenantId: TenantId;
  projectId: ProjectId;
  deviceId: string;
  clientSequence: number;
  operationId: string;
  entityId: string;
  baseVersion: number;
  type: 'CREATE_SAMPLE' | 'CUSTODY_TRANSFER' | 'RECEIVE_CONTAINER' | 'CREATE_ALIQUOT';
  payloadHash: string;
  payload: unknown;
  /**
   * Client-reported event time (UTC instant). Recorded for evidence only:
   * offline devices and skewed clocks are expected, so staleness and ordering
   * are decided by `clientSequence`, never by this timestamp.
   */
  occurredAt: string;
}

export interface SyncRecord {
  key: string;
  envelope: SyncEnvelope;
  result: SyncApplyResult;
  resultReference?: string;
  conflictReason?: string;
  /** Server receive time of the envelope (UTC instant). */
  appliedAt: string;
}

export interface AuditRecord {
  id: string;
  tenantId: TenantId;
  projectId: ProjectId;
  action: string;
  entity: string;
  entityId: string;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface OutboxMessage {
  id: string;
  tenantId: TenantId;
  projectId: ProjectId;
  topic: string;
  aggregateId: string;
  payload: string;
  status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  createdAt: string;
}

export interface FileRecord {
  key: string;
  contentHash: string;
  createdAt: string;
  status: 'STAGED' | 'COMMITTED' | 'DELETED';
}
