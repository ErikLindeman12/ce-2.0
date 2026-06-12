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
  | 'resolve_review'
  | 'approve_action'
  | 'reject_action';

export type AgentMode = 'autonomous' | 'supervised' | 'shadow';

/**
 * Open string unions: the platform no longer hardcodes the set of case types or
 * queues — both are data (seeded or created in the builder). The known literals
 * are kept for autocomplete; `(string & {})` admits any other value.
 */
export type WorkItemType =
  | 'referral'
  | 'records_request_in'
  | 'records_request_out'
  | 'prior_auth'
  | 'unknown'
  | (string & {});
export type WorkItemStatus = 'open' | 'in_progress' | 'waiting' | 'done' | 'error';
export type QueueKey =
  | 'intake'
  | 'referrals'
  | 'roi_incoming'
  | 'roi_outgoing'
  | 'human_review'
  | 'prior_auth'
  | (string & {});
export type OutboundChannel = 'fax' | 'email' | 'sms' | 'voice' | 'portal' | 'care_everywhere';
export type OutboundAttemptStatus = 'sent' | 'awaiting_response' | 'responded' | 'timed_out' | 'failed';

// ---------------------------------------------------------------------------
// Chase plan — new step-based model (w1b)
// ---------------------------------------------------------------------------

/** A single step in a chase ladder: a channel name + 1-based attempt counter. */
export interface ChaseStep {
  channel: OutboundChannel;
  attempt: number;
}

/**
 * New shape: {steps, waitSeconds}.
 * Legacy shape {channels, waitSeconds} is still readable by consumers that
 * check for it; buildChannelPlan returns the new shape only.
 */
export interface ChasePlan {
  steps: ChaseStep[];
  waitSeconds: number;
}

export type WorkQueueKind = 'work' | 'review';

/** Per-queue UI config: columns + theme, all data-driven (builder-editable). */
export interface WorkQueueConfig {
  theme?: string;
  columns?: Array<
    | { type: 'field'; key: string; label: string; path: string }
    | { type: 'chase_progress' }
    | { type: 'review_reason' }
  >;
}

export interface WorkQueue {
  key: QueueKey;
  name: string;
  description: string | null;
  sort_order: number;
  kind?: WorkQueueKind;
  config?: WorkQueueConfig;
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
  state_version: number;
  claimed_at: string | null;
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
    chase_policy?: {
      steps: string[];
      waitSeconds?: number;
    };
  };
}

export interface Agent {
  id: string;
  name: string;
  /** Legacy queue binding — superseded by `subscriptions`; kept for back-compat reads. */
  queue_key: QueueKey;
  enabled: boolean;
  instructions: string;
  tools: string[];
  confidence_threshold: number;
  model: string;
  mode: AgentMode;
  config: AgentConfig;
  subscriptions: AgentSubscription[];
  owner: string | null;
  created_at: string;
}

/** Shape returned by GET /api/agents/[id]/stats and each entry in GET /api/agents/stats */
export interface AgentStats {
  agentId: string;
  processed: number;
  actions: number;
  escalations: number;
  proposals: number;
  shadowDecisions: number;
  avgConfidence: number;
  autoRate: number;
}

export type OutboundAttemptKind = 'records_request' | 'records_response' | 'request_more_info';

export interface OutboundAttempt {
  id: string;
  work_item_id: string;
  channel: OutboundChannel;
  kind: OutboundAttemptKind | null;
  dedupe_key: string | null;
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

// =============================================================================
// Event substrate types (docs/substrate-spec.md)
// =============================================================================

export interface EventRow {
  id: string;
  seq: number;
  type: string;
  case_id: string | null;
  payload: Record<string, unknown>;
  actor: string;
  caused_by_event_id: string | null;
  depth: number;
  deliver_at: string | null;
  delivered_at: string | null;
  dedupe_key: string | null;
  created_at: string;
}

export type EventDeliveryStatus = 'pending' | 'running' | 'done' | 'shadowed' | 'skipped';

export interface EventDelivery {
  id: string;
  event_id: string;
  agent_id: string;
  case_id: string | null;
  status: EventDeliveryStatus;
  turn_id: string | null;
  claimed_at: string | null;
  created_at: string;
}

export type ReviewKind = 'approval' | 'question' | 'exception';
export type ReviewStatus = 'pending' | 'answered' | 'void';

export interface ReviewRequest {
  id: string;
  case_id: string;
  agent_id: string | null;
  kind: ReviewKind;
  question: string;
  proposal: {
    action: string;
    params: Record<string, unknown>;
    confidence: number;
    rationale: string;
    state_version: number;
  } | null;
  candidates: Record<string, unknown>[] | null;
  options: Record<string, unknown> | null;
  queue_key: QueueKey | null;
  status: ReviewStatus;
  answer: Record<string, unknown> | null;
  answered_by: string | null;
  created_at: string;
  answered_at: string | null;
}

export interface RoutingRule {
  id: string;
  event_type: string;
  filter: Record<string, unknown>;
  queue_key: QueueKey;
  priority: number;
  owner: string | null;
  enabled: boolean;
  created_at: string;
}

/** Declarative effects applied atomically to case state BEFORE a turn runs. */
export interface OnEventEffects {
  merge_payload?: Array<{ from: string; to: string }>;
  set_state?: Record<string, unknown>;
  clear_state?: string[];
}

export interface AgentSubscription {
  event_type: string;
  /**
   * Equality match against event.payload.* — plus special keys:
   * `case_type` (matches case.type), `source_channel` (matches case.source_channel).
   */
  filter?: Record<string, unknown>;
  on_event?: OnEventEffects;
}

// --- Predicate DSL (complete_when / requirements) ---

export type PredOp = 'eq' | 'neq' | 'exists' | 'absent' | 'matches' | 'not_matches' | 'in';

export interface Pred {
  /** 'state.x' | 'extracted.x' | 'case.type' | 'case.matched_patient_id' | ... */
  path: string;
  op: PredOp;
  value?: unknown;
}

export interface Cond {
  all?: Pred[];
  any?: Pred[];
}

export interface RequirementSpec {
  flag: string;
  path: string;
  op: PredOp;
  value?: unknown;
  and?: Pred[];
  on_missing?: { message?: string; max_requests?: number };
}

export interface CompleteWhenSpec {
  when: Cond;
  outcome: { result: string; note?: string };
}

export interface SendPolicySpec {
  document_kind: 'records_response' | 'records_request';
  set_flag?: string;
  when?: Cond;
}

export interface ChasePolicySpec {
  steps: string[];
  waitSeconds?: number;
  on_exhausted?: { question?: string };
}

/** Named low-code policies — presence of a policy gates the matching planner skill. */
export interface AgentConfig {
  chase_policy?: ChasePolicySpec;
  requirements?: RequirementSpec[];
  send_policy?: SendPolicySpec;
  complete_when?: CompleteWhenSpec[];
  classify_rules?: Array<{ matches: string; type: string }>;
  [key: string]: unknown;
}

export type CompletionVerb = 'report_result' | 'request_human_review' | 'emit_event' | 'wait';

export const COMPLETION_VERBS: CompletionVerb[] = [
  'report_result',
  'request_human_review',
  'emit_event',
  'wait',
];

export interface ToolCtx {
  turnId?: string;
  deliveryId?: string;
  event?: EventRow;
  agent?: Agent;
}

export interface PumpReport {
  delivered: number;
  routed: number;
  turns: number;
  shadowed: number;
  reviews: number;
  /** Per-turn tool actions, surfaced as toasts by the queues board. */
  actions: Array<{ itemId: string; action: string; confidence: number; actor: string }>;
  errors: string[];
}

// ---------------------------------------------------------------------------
// LLM / reasoning types
// ---------------------------------------------------------------------------

export interface ReasoningInput {
  workItem: WorkItem;
  agent: Agent;
  stepHistory: string[];
  /** The event that activated this turn (subscription-driven turns). */
  event?: EventRow;
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
  /**
   * 'annotate' = enriches the case (classify/extract/match/verify) — runs without
   * approval in supervised mode. 'external' = visible outside the system (sends,
   * calls) — gated behind approval in supervised mode. Consumers MUST treat a
   * missing value as 'external' (the safe default).
   */
  effect?: 'annotate' | 'external';
  execute: (
    workItemId: string,
    params: Record<string, unknown>,
    actor: string,
    ctx?: ToolCtx
  ) => Promise<ToolResult>;
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
  matchedPatientId: string | null;
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
  mode: AgentMode;
  config: AgentConfig;
  subscriptions: AgentSubscription[];
  owner: string | null;
  createdAt: string;
}

/** Camel-case review request for API responses */
export interface ReviewRequestSummary {
  id: string;
  caseId: string;
  agentId: string | null;
  agentName?: string | null;
  kind: ReviewKind;
  question: string;
  proposal: ReviewRequest['proposal'];
  candidates: Record<string, unknown>[] | null;
  queueKey: QueueKey | null;
  status: ReviewStatus;
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
    matchedPatientId: item.matched_patient_id ?? null,
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
    mode: a.mode ?? 'autonomous',
    config: a.config ?? {},
    subscriptions: a.subscriptions ?? [],
    owner: a.owner ?? null,
    createdAt: a.created_at,
  };
}

export function toReviewRequestSummary(r: ReviewRequest, agentName?: string | null): ReviewRequestSummary {
  return {
    id: r.id,
    caseId: r.case_id,
    agentId: r.agent_id,
    agentName: agentName ?? null,
    kind: r.kind,
    question: r.question,
    proposal: r.proposal,
    candidates: r.candidates,
    queueKey: r.queue_key,
    status: r.status,
    createdAt: r.created_at,
  };
}
