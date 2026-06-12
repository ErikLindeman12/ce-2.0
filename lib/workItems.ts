/**
 * lib/workItems.ts — CRUD + queue queries for work items.
 *
 * list(queueKey?)      → WorkItem[] with patient/org joins
 * get(id)              → { item, auditTrail, outboundAttempts, patientCandidates?, reviews, events }
 * counts()             → Record<QueueKey, number>
 * create(payload)      → WorkItem
 */

import { getSupabase } from './supabase';
import { listEvents } from './events';
import { toReviewRequestSummary } from './types';
import type {
  AuditLogEntry,
  OutboundAttempt,
  Patient,
  QueueKey,
  ReviewRequest,
  ReviewRequestSummary,
  WorkItem,
  WorkQueue,
} from './types';

// ---------------------------------------------------------------------------
// List work items (optionally filtered by queue)
// ---------------------------------------------------------------------------

export async function listWorkItems(queueKey?: string): Promise<WorkItem[]> {
  const sb = getSupabase();
  let q = sb
    .from('work_items')
    .select(
      `*,
       patient:patients(id,first_name,last_name,dob,mrn,phone,created_at),
       org:organizations(id,name,contact)`,
    )
    .order('created_at', { ascending: false });

  if (queueKey) {
    q = q.eq('queue_key', queueKey);
  }

  const { data, error } = await q;
  if (error) throw new Error(`work_items list failed: ${error.message}`);
  return (data ?? []) as unknown as WorkItem[];
}

// ---------------------------------------------------------------------------
// Get a single work item with full detail
// ---------------------------------------------------------------------------

/** Minimal event shape for the item-detail timeline (additive API field). */
export interface CaseEventSummary {
  id: string;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface WorkItemDetail {
  item: WorkItem;
  auditTrail: AuditLogEntry[];
  outboundAttempts: OutboundAttempt[];
  /** Populated from the latest pending review's candidates (legacy review_reason parse as fallback) */
  patientCandidates?: Patient[];
  /** All review requests for the case, newest first (agent names joined). */
  reviews: ReviewRequestSummary[];
  /** The case's last 30 events, newest first — the item-page timeline. */
  events: CaseEventSummary[];
}

export async function getWorkItem(id: string): Promise<WorkItemDetail | null> {
  const sb = getSupabase();

  const { data: item, error } = await sb
    .from('work_items')
    .select(
      `*,
       patient:patients(id,first_name,last_name,dob,mrn,phone,created_at),
       org:organizations(id,name,contact)`,
    )
    .eq('id', id)
    .single();

  if (error || !item) return null;

  const [auditRes, attemptsRes, reviewsRes, caseEvents, agentNames] = await Promise.all([
    sb
      .from('audit_log')
      .select('*')
      .eq('work_item_id', id)
      .order('created_at', { ascending: true }),
    sb
      .from('outbound_attempts')
      .select('*')
      .eq('work_item_id', id)
      .order('attempt_no', { ascending: true }),
    sb
      .from('review_requests')
      .select('*')
      .eq('case_id', id)
      .order('created_at', { ascending: false }),
    listEvents({ caseId: id, limit: 30 }),
    agentNameMap(),
  ]);

  const wi = item as unknown as WorkItem;
  const reviewRows = (reviewsRes.data ?? []) as unknown as ReviewRequest[];
  const pendingReviews = reviewRows.filter((r) => r.status === 'pending');

  // Patient candidates: the latest pending review's candidates jsonb wins —
  // rows were stored from matchPatientHeuristic's Patient rows (snake_case).
  let patientCandidates: Patient[] | undefined;
  const withCandidates = pendingReviews.find(
    (r) => Array.isArray(r.candidates) && r.candidates.length > 0,
  );
  if (withCandidates) {
    patientCandidates = (withCandidates.candidates ?? []).map((c) => {
      const row = c as Record<string, unknown>;
      return {
        id: String(row['id'] ?? ''),
        first_name: String(row['first_name'] ?? row['firstName'] ?? ''),
        last_name: String(row['last_name'] ?? row['lastName'] ?? ''),
        dob: String(row['dob'] ?? ''),
        mrn: String(row['mrn'] ?? ''),
        phone: (row['phone'] as string | null) ?? null,
        created_at: String(row['created_at'] ?? ''),
      } as Patient;
    });
  }

  // Fallback (legacy string-parse) when no pending review carries candidates.
  // Covers two cases:
  //   - Ambiguous (two named patients): review_reason includes "patients named"
  //   - Fuzzy single-candidate: review_reason starts with "Closest MPI match is"
  if ((!patientCandidates || patientCandidates.length === 0) && wi.queue_key === 'human_review' && wi.review_reason) {
    const extracted = wi.extracted_data as Record<string, string>;

    if (wi.review_reason.includes('patients named')) {
      // Ambiguous: exact name match — may return 2+ candidates
      const firstName = extracted['patient_first_name'] ?? '';
      const lastName = extracted['patient_last_name'] ?? '';
      if (firstName && lastName) {
        const { data: candidates } = await sb
          .from('patients')
          .select('*')
          .ilike('first_name', firstName)
          .ilike('last_name', lastName);
        patientCandidates = (candidates ?? []) as Patient[];
      }
    } else if (wi.review_reason.startsWith('Closest MPI match is')) {
      // Fuzzy single-candidate: use loosened first-3-chars + exact last name
      const firstName = extracted['patient_first_name'] ?? '';
      const lastName = extracted['patient_last_name'] ?? '';
      if (firstName.length >= 3 && lastName) {
        const { data: candidates } = await sb
          .from('patients')
          .select('*')
          .ilike('first_name', firstName.slice(0, 3) + '%')
          .ilike('last_name', lastName);
        patientCandidates = (candidates ?? []) as Patient[];
      }
    }
  }

  // ApprovalBanner compat: synthesize agent_state.pending_approval at READ time
  // from the latest pending 'approval' review — never written to the DB.
  const approval = pendingReviews.find((r) => r.kind === 'approval' && r.proposal);
  if (approval?.proposal) {
    wi.agent_state = {
      ...(wi.agent_state ?? {}),
      pending_approval: {
        action: approval.proposal.action,
        params: approval.proposal.params,
        confidence: approval.proposal.confidence,
        rationale: approval.proposal.rationale,
        agentId: approval.agent_id,
        agentName: (approval.agent_id && agentNames.get(approval.agent_id)) || 'Agent',
        reviewId: approval.id,
      },
    };
  }

  return {
    item: wi,
    auditTrail: ((auditRes.data ?? []) as unknown as AuditLogEntry[]).map((e) => ({
      ...e,
      actor: displayActor(e.actor, agentNames),
    })),
    outboundAttempts: (attemptsRes.data ?? []) as unknown as OutboundAttempt[],
    patientCandidates,
    reviews: reviewRows.map((r) =>
      toReviewRequestSummary(r, r.agent_id ? agentNames.get(r.agent_id) ?? null : null),
    ),
    events: caseEvents.map((e) => ({
      id: e.id,
      type: e.type,
      actor: displayActor(e.actor, agentNames),
      payload: e.payload,
      createdAt: e.created_at,
    })),
  };
}

// ---------------------------------------------------------------------------
// Replace raw `agent:<uuid>` actors with `agent:<Name>` for display
// ---------------------------------------------------------------------------

async function agentNameMap(): Promise<Map<string, string>> {
  const { data } = await getSupabase().from('agents').select('id,name');
  return new Map(
    ((data ?? []) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]),
  );
}

function displayActor(actor: string, names: Map<string, string>): string {
  if (!actor.startsWith('agent:')) return actor;
  const name = names.get(actor.slice('agent:'.length));
  return name ? `agent:${name}` : actor;
}

async function withAgentNames(entries: AuditLogEntry[]): Promise<AuditLogEntry[]> {
  if (!entries.some((e) => e.actor.startsWith('agent:'))) return entries;
  const names = await agentNameMap();
  return entries.map((e) => ({ ...e, actor: displayActor(e.actor, names) }));
}

// ---------------------------------------------------------------------------
// Item counts per queue
// ---------------------------------------------------------------------------

export async function queueCounts(): Promise<Record<string, number>> {
  const { data, error } = await getSupabase()
    .from('work_items')
    .select('queue_key')
    .neq('status', 'done');

  if (error) throw new Error(`queue counts failed: ${error.message}`);

  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    const k = (row as { queue_key: string }).queue_key;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// List all queues with counts
// ---------------------------------------------------------------------------

export async function listQueues(): Promise<WorkQueue[]> {
  const [queuesRes, counts] = await Promise.all([
    getSupabase()
      .from('work_queues')
      .select('*')
      .order('sort_order', { ascending: true }),
    queueCounts(),
  ]);

  if (queuesRes.error) throw new Error(`work_queues list failed: ${queuesRes.error.message}`);

  return ((queuesRes.data ?? []) as WorkQueue[]).map((q) => ({
    ...q,
    item_count: counts[q.key] ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Create a work item
// ---------------------------------------------------------------------------

export interface CreateWorkItemPayload {
  type?: string;
  queue_key: QueueKey;
  source_channel: string;
  source_text?: string;
  org_id?: string;
  extracted_data?: Record<string, unknown>;
}

export async function createWorkItem(payload: CreateWorkItemPayload): Promise<WorkItem> {
  const { data, error } = await getSupabase()
    .from('work_items')
    .insert({
      type: payload.type ?? 'unknown',
      queue_key: payload.queue_key,
      source_channel: payload.source_channel,
      source_text: payload.source_text ?? null,
      org_id: payload.org_id ?? null,
      extracted_data: payload.extracted_data ?? {},
    })
    .select('*')
    .single();

  if (error) throw new Error(`Failed to create work item: ${error.message}`);
  return data as unknown as WorkItem;
}

// ---------------------------------------------------------------------------
// List agents
// ---------------------------------------------------------------------------

export async function listAgents() {
  const { data, error } = await getSupabase()
    .from('agents')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`agents list failed: ${error.message}`);
  return data;
}

export async function getAgent(id: string) {
  const { data, error } = await getSupabase()
    .from('agents')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data;
}

export async function createAgent(payload: {
  name: string;
  queue_key: string;
  enabled?: boolean;
  instructions?: string;
  tools?: string[];
  confidence_threshold?: number;
  model?: string;
  mode?: string;
  config?: Record<string, unknown>;
}) {
  const { data, error } = await getSupabase()
    .from('agents')
    .insert(payload)
    .select('*')
    .single();
  if (error) throw new Error(`Failed to create agent: ${error.message}`);
  return data;
}

export async function updateAgent(id: string, payload: Record<string, unknown>) {
  const { data, error } = await getSupabase()
    .from('agents')
    .update(payload)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(`Failed to update agent: ${error.message}`);
  return data;
}

// ---------------------------------------------------------------------------
// List all patients (MPI lookup for ROI composer / patient picker)
// ---------------------------------------------------------------------------

export async function listPatients(): Promise<Patient[]> {
  const { data, error } = await getSupabase()
    .from('patients')
    .select('*')
    .order('last_name', { ascending: true });
  if (error) throw new Error(`patients list failed: ${error.message}`);
  return (data ?? []) as unknown as Patient[];
}

// ---------------------------------------------------------------------------
// Compose an outgoing ROI request (POST /api/roi)
// Creates a work_item in roi_outgoing + first outbound_attempt
// ---------------------------------------------------------------------------

export interface CreateRoiRequestPayload {
  patientId: string;
  orgId: string;
  recordsRequested: string;
  channel?: 'fax' | 'email' | 'sms' | 'voice';
}

export async function createRoiRequest(payload: CreateRoiRequestPayload): Promise<string> {
  const sb = getSupabase();

  // Resolve org contact
  const { data: org } = await sb
    .from('organizations')
    .select('contact,name')
    .eq('id', payload.orgId)
    .single();
  const contact = (org as { contact: Record<string, string>; name: string } | null)?.contact ?? {};
  const orgName = (org as { contact: Record<string, string>; name: string } | null)?.name ?? '';
  const channel = payload.channel ?? (contact['preferred_channel'] as 'fax' | 'email' | 'sms' | 'voice' | undefined) ?? 'fax';

  // Create the work item
  const item = await createWorkItem({
    type: 'records_request_out',
    queue_key: 'roi_outgoing',
    source_channel: 'portal',
    org_id: payload.orgId,
    extracted_data: {
      records_requested: payload.recordsRequested,
      org_name: orgName,
    },
  });

  // Set matched_patient_id
  await sb
    .from('work_items')
    .update({ matched_patient_id: payload.patientId, updated_at: new Date().toISOString() })
    .eq('id', item.id);

  // Create first outbound attempt
  const respondAfterSecs = 20 + Math.floor(Math.random() * 21);
  await sb.from('outbound_attempts').insert({
    work_item_id: item.id,
    channel,
    attempt_no: 1,
    to_org_id: payload.orgId,
    to_contact: { fax: contact['fax'], email: contact['email'], phone: contact['phone'] },
    payload: {
      subject: 'Records Request',
      body: `Please provide: ${payload.recordsRequested}`,
    },
    status: 'sent',
    respond_after: new Date(Date.now() + respondAfterSecs * 1000).toISOString(),
  });

  // Set item to waiting and track attempt_no
  await sb
    .from('work_items')
    .update({
      status: 'waiting',
      agent_state: { attempt_no: 1, last_channel: channel },
      updated_at: new Date().toISOString(),
    })
    .eq('id', item.id);

  console.log('[workItems.createRoiRequest]', JSON.stringify({ itemId: item.id, orgId: payload.orgId, channel }));

  return item.id;
}

// ---------------------------------------------------------------------------
// Aliases matching the spec-pinned function names
// ---------------------------------------------------------------------------

/** Alias: listByQueue(key) → listWorkItems(key) */
export const listByQueue = listWorkItems;

/** Alias: getDetail(id) → getWorkItem(id) */
export const getDetail = getWorkItem;

/** Alias: listActivity(limit?) → recentActivity(limit?) */
export const listActivity = recentActivity;

// ---------------------------------------------------------------------------
// Recent audit log activity
// ---------------------------------------------------------------------------

export async function recentActivity(limit: number = 30): Promise<AuditLogEntry[]> {
  const { data, error } = await getSupabase()
    .from('audit_log')
    .select('*, work_item:work_items(id,type,queue_key)')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`activity query failed: ${error.message}`);
  return withAgentNames((data ?? []) as unknown as AuditLogEntry[]);
}
