export type OrgChannel = 'cloud' | 'direct' | 'fax' | 'portal';

export interface OrgCapabilities {
  channels: OrgChannel[];
  dataTypes: string[];
}

export interface Org {
  id: string;
  name: string;
  tenantSlug: string;
  endpointUrl: string;
  capabilities: OrgCapabilities;
  specialties: string[];
  city: string | null;
  state: string | null;
  zip: string | null;
  active: boolean;
}

export interface Provider {
  id: string;
  orgId: string;
  name: string;
  npi: string;
  specialty: string;
  active: boolean;
}

export interface DirectorySearchResult {
  organizations: Org[];
  providers: Provider[];
}

/** Shared filter options for directory search. All optional + composable. */
export interface DirectoryFilters {
  q?: string;
  specialty?: string;
  city?: string;
  state?: string;
}

// ---------------------------------------------------------------------------
// Referral instructions — per-org / per-provider required fields
// ---------------------------------------------------------------------------

export type ReferralFieldType = 'text' | 'date' | 'select' | 'boolean' | 'textarea';

export interface ReferralField {
  key: string;
  label: string;
  type: ReferralFieldType;
  required: boolean;
  options?: string[];
}

export interface ReferralInstructionsTarget {
  orgId: string | null;
  orgName: string | null;
  providerId: string | null;
  providerName: string | null;
}

export interface ReferralInstructions {
  target: ReferralInstructionsTarget;
  fields: ReferralField[];
  customConfig: Record<string, unknown>;
}

export const BASELINE_FIELDS: ReferralField[] = [
  { key: 'patient.firstName', label: 'First name', type: 'text', required: true },
  { key: 'patient.lastName', label: 'Last name', type: 'text', required: true },
  { key: 'patient.dateOfBirth', label: 'Date of birth', type: 'date', required: true },
  { key: 'referringProvider.npi', label: 'Referring provider NPI', type: 'text', required: true },
  { key: 'procedure', label: 'Procedure / data type', type: 'text', required: true },
  { key: 'priority', label: 'Priority', type: 'select', required: true, options: ['routine', 'urgent', 'stat'] },
  { key: 'clinicalNotes', label: 'Clinical notes', type: 'textarea', required: false },
];

// ---------------------------------------------------------------------------
// Send referral payload
// ---------------------------------------------------------------------------


export interface SendReferralPayload {
  toOrgId: string;
  toOrgName: string;
  patient: {
    firstName: string;
    lastName: string;
    dateOfBirth: string;
  };
  request: {
    dataType: string;
    priority: 'routine' | 'urgent' | 'stat';
    notes?: string;
  };
}

// =============================================================================
// Work Queue Platform types
// =============================================================================

// ---------------------------------------------------------------------------
// Allowed tool names (union used to type-check tool invocations)
// ---------------------------------------------------------------------------
export type ToolName =
  | 'classify_document'
  | 'extract_fields'
  | 'match_patient'
  | 'verify_requirements'
  | 'advance_stage'
  | 'send_fax'
  | 'send_email'
  | 'send_sms'
  | 'place_call'
  | 'request_more_info'
  | 'mark_complete'
  | 'escalate_to_human'
  | 'resolve_review';

export type WorkItemType = 'referral' | 'records_request_in' | 'records_request_out' | 'unknown';
export type WorkItemStatus = 'open' | 'in_progress' | 'waiting' | 'done' | 'error';
export type QueueKey = 'intake' | 'referrals' | 'roi_incoming' | 'roi_outgoing' | 'human_review';
export type OutboundChannel = 'fax' | 'email' | 'sms' | 'voice' | 'portal';
export type OutboundAttemptStatus = 'sent' | 'awaiting_response' | 'responded' | 'timed_out' | 'failed';

export interface WorkQueue {
  key: QueueKey;
  name: string;
  description: string | null;
  sort_order: number;
  item_count?: number;
}

export interface Patient {
  id: string;
  first_name: string;
  last_name: string;
  dob: string;
  mrn: string;
  phone: string | null;
  created_at: string;
}

export interface WorkItem {
  id: string;
  type: WorkItemType;
  queue_key: QueueKey;
  status: WorkItemStatus;
  source_channel: string;
  source_text: string | null;
  extracted_data: Record<string, unknown>;
  matched_patient_id: string | null;
  org_id: string | null;
  confidence: Record<string, number>;
  assignee: string;
  review_reason: string | null;
  agent_state: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // joins
  patient?: Patient | null;
  org?: OrgContact | null;
}

export interface OrgContact {
  id: string;
  name: string;
  contact: {
    fax?: string;
    email?: string;
    phone?: string;
    preferred_channel?: OutboundChannel | 'portal';
    simulation?: string;
  };
}

export interface Agent {
  id: string;
  name: string;
  queue_key: QueueKey;
  enabled: boolean;
  instructions: string;
  tools: string[];
  confidence_threshold: number;
  model: string;
  created_at: string;
}

export interface OutboundAttempt {
  id: string;
  work_item_id: string;
  channel: OutboundChannel;
  attempt_no: number;
  to_org_id: string | null;
  to_contact: Record<string, unknown>;
  payload: Record<string, unknown>;
  status: OutboundAttemptStatus;
  respond_after: string | null;
  response: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface AuditLogEntry {
  id: number;
  work_item_id: string | null;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
  created_at: string;
  // joined
  work_item?: Pick<WorkItem, 'id' | 'type' | 'queue_key'> | null;
}

// ---------------------------------------------------------------------------
// LLM / reasoning types
// ---------------------------------------------------------------------------

export interface ReasoningInput {
  workItem: WorkItem;
  agent: Agent;
  stepHistory: string[];
}

export interface Decision {
  action: string;
  params: Record<string, unknown>;
  confidence: number;
  rationale: string;
  question?: string;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export interface ToolDef {
  description: string;
  execute: (workItemId: string, params: Record<string, unknown>, actor: string) => Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Simulate / tick report
// ---------------------------------------------------------------------------

export interface TickReport {
  respondedAttempts: string[];
  timedOutAttempts: string[];
  chaseAttempts: string[];
  escalations: string[];
  agentRun: RunReport;
}

export interface RunReport {
  processed: number;
  actions: Array<{ itemId: string; action: string; confidence: number; actor: string }>;
}

// =============================================================================
// Camel-case API response shapes (pinned contract — UI and routes build against these)
// =============================================================================

/** GET /api/queues item shape */
export interface QueueInfo {
  key: QueueKey;
  name: string;
  description: string | null;
  sortOrder: number;
  count: number;
}

/** Minimal patient shape returned in API list responses */
export interface PatientSummary {
  id: string;
  firstName: string;
  lastName: string;
  dob: string;
  mrn: string;
}

/** GET /api/work-items item shape */
export interface WorkItemSummary {
  id: string;
  type: WorkItemType;
  queueKey: QueueKey;
  status: WorkItemStatus;
  sourceChannel: string;
  createdAt: string;
  updatedAt: string;
  assignee: string;
  reviewReason: string | null;
  confidence: Record<string, number>;
  extractedData: Record<string, unknown>;
  agentState: Record<string, unknown>;
  patient: PatientSummary | null;
  org: { id: string; name: string } | null;
}

/** GET /api/work-items/:id response data shape */
export interface WorkItemDetailResponse {
  item: WorkItemSummary & { sourceText: string | null; agentState: Record<string, unknown> };
  audit: AuditEntry[];
  attempts: OutboundAttemptSummary[];
  patientCandidates: PatientSummary[];
}

/** Camel-case audit entry for API responses */
export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

/** Camel-case outbound attempt for API responses */
export interface OutboundAttemptSummary {
  id: string;
  channel: OutboundChannel;
  attemptNo: number;
  status: OutboundAttemptStatus;
  toContact: Record<string, unknown>;
  payload: Record<string, unknown>;
  response: Record<string, unknown> | null;
  respondAfter: string | null;
  createdAt: string;
}

/** GET /api/agents + POST /api/agents response shape */
export interface AgentResponse {
  id: string;
  name: string;
  queueKey: QueueKey;
  enabled: boolean;
  instructions: string;
  tools: string[];
  confidenceThreshold: number;
  model: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// DB row → API shape mapping helpers
// ---------------------------------------------------------------------------

export function toQueueInfo(q: WorkQueue, count: number): QueueInfo {
  return {
    key: q.key,
    name: q.name,
    description: q.description,
    sortOrder: q.sort_order,
    count,
  };
}

export function toPatientSummary(p: Patient): PatientSummary {
  return {
    id: p.id,
    firstName: p.first_name,
    lastName: p.last_name,
    dob: p.dob,
    mrn: p.mrn,
  };
}

export function toWorkItemSummary(item: WorkItem): WorkItemSummary {
  return {
    id: item.id,
    type: item.type,
    queueKey: item.queue_key,
    status: item.status,
    sourceChannel: item.source_channel,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    assignee: item.assignee,
    reviewReason: item.review_reason,
    confidence: item.confidence,
    extractedData: item.extracted_data,
    agentState: item.agent_state,
    patient: item.patient
      ? toPatientSummary(item.patient as Patient)
      : null,
    org: item.org ? { id: item.org.id, name: item.org.name } : null,
  };
}

export function toAgentResponse(a: Agent): AgentResponse {
  return {
    id: a.id,
    name: a.name,
    queueKey: a.queue_key,
    enabled: a.enabled,
    instructions: a.instructions,
    tools: a.tools,
    confidenceThreshold: a.confidence_threshold,
    model: a.model,
    createdAt: a.created_at,
  };
}
