/**
 * lib/portal.ts — provider portal data access.
 *
 * submitPortalRequest(payload) → {itemId}
 * getPortalRequests(orgId)     → PortalRequest[] (My Requests list)
 * respondToAttempt(...)        → mark request_more_info attempt responded (auth case only)
 *
 * W1b: The old generic "respond to any outbound ROI" inbox is removed.
 * respondToAttempt now exists only for the authorization case:
 *   POST /api/portal/respond {attemptId, orgId, authorizationAttached:true}
 *
 * getPortalInbox is kept as an alias but marks the old path — prefer getPortalRequests.
 */

import { getSupabase } from './supabase';
import { handleAttemptResponse } from './simulate';
import { createWorkItem } from './workItems';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Legacy inbox type — kept for any remaining callers */
export interface PortalAttempt {
  id: string;
  work_item_id: string;
  channel: string;
  attempt_no: number;
  to_org_id: string | null;
  to_contact: Record<string, unknown>;
  payload: Record<string, unknown>;
  status: string;
  respond_after: string | null;
  response: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  // joined
  item_type: string | null;
  patient_name: string | null;
  queue_key: string | null;
  extracted_data: Record<string, unknown> | null;
}

/** GET /api/portal/requests item shape */
export interface PortalRequest {
  itemId: string;
  /** 'processing' | 'action_needed' | 'under_review' | 'completed' */
  status: 'processing' | 'action_needed' | 'under_review' | 'completed';
  queueKey: string;
  itemStatus: string;
  createdAt: string;
  recordsRequested: string | null;
  patientName: string | null;
  /** Populated when status='action_needed' — the pending request_more_info attempt id */
  pendingInfoAttemptId: string | null;
  /** Populated when status='completed' — the final records-response document */
  responseDocument: string | null;
  /** Populated when status='completed' — channel records were returned on */
  responseChannel: string | null;
}

export interface RespondPayload {
  attemptId: string;
  orgId: string;
  message?: string;
  authorizationAttached?: boolean;
}

export interface SubmitPortalRequestPayload {
  orgId: string;
  patientFirstName: string;
  patientLastName: string;
  patientDob: string;
  recordsRequested: string;
  authorizationAttached: boolean;
  priority?: 'routine' | 'urgent' | 'stat';
}

// ---------------------------------------------------------------------------
// submitPortalRequest — POST /api/portal/submit
// ---------------------------------------------------------------------------

/**
 * Create a work item from a portal submission.
 *
 * - source_channel = 'portal'
 * - type = 'records_request_in'
 * - queue_key = 'intake' (flows normal intake → roi_incoming pipeline)
 * - org_id = submitting org
 * - source_text = structured PORTAL SUBMISSION document (labeled lines for extractor)
 * - audit: actor=portal:<org>, action=portal_submission
 */
export async function submitPortalRequest(
  payload: SubmitPortalRequestPayload,
): Promise<{ itemId: string }> {
  const sb = getSupabase();

  // Resolve org name for document and audit
  const { data: orgRow } = await sb
    .from('organizations')
    .select('name')
    .eq('id', payload.orgId)
    .single();
  const orgName = (orgRow as { name: string } | null)?.name ?? payload.orgId;

  // Build structured source_text so the extractor scores ≥ 0.8
  const authLine = payload.authorizationAttached
    ? `Authorization: Signed authorization attached (portal)`
    : undefined;

  const sourceLines = [
    `PORTAL SUBMISSION`,
    ``,
    `From: ${orgName}`,
    `Patient: ${payload.patientFirstName} ${payload.patientLastName}`,
    `DOB: ${payload.patientDob}`,
    `Records Requested: ${payload.recordsRequested}`,
    ...(authLine ? [authLine] : []),
    ...(payload.priority ? [`Priority: ${payload.priority}`] : []),
    ``,
    `Submitted via CE 2.0 Provider Portal.`,
  ];

  const sourceText = sourceLines.join('\n');

  // Create the work item
  const item = await createWorkItem({
    type: 'records_request_in',
    queue_key: 'intake',
    source_channel: 'portal',
    source_text: sourceText,
    org_id: payload.orgId,
    extracted_data: {
      patient_first_name: payload.patientFirstName,
      patient_last_name: payload.patientLastName,
      patient_dob: payload.patientDob,
      records_requested: payload.recordsRequested,
      ...(payload.authorizationAttached
        ? { authorization: 'Signed authorization attached (portal)' }
        : {}),
      from_org: orgName,
    },
  });

  // Audit the submission
  await sb.from('audit_log').insert({
    work_item_id: item.id,
    actor: `portal:${orgName}`,
    action: 'portal_submission',
    detail: {
      org_id: payload.orgId,
      patient_name: `${payload.patientFirstName} ${payload.patientLastName}`,
      patient_dob: payload.patientDob,
      records_requested: payload.recordsRequested,
      authorization_attached: payload.authorizationAttached,
      priority: payload.priority ?? 'routine',
    },
  });

  console.log(
    '[portal.submit]',
    JSON.stringify({
      itemId: item.id,
      orgId: payload.orgId,
      orgName,
      authorizationAttached: payload.authorizationAttached,
    }),
  );

  return { itemId: item.id };
}

// ---------------------------------------------------------------------------
// getPortalRequests — GET /api/portal/requests?orgId=
// ---------------------------------------------------------------------------

/**
 * Return the org's submitted portal items with plain-language status mapping.
 *
 * Status mapping (per spec §3):
 *  intake / processing     → 'processing'
 *  waiting after request_more_info → 'action_needed' (pendingInfoAttemptId populated)
 *  human_review            → 'under_review'
 *  done                    → 'completed' (responseDocument + responseChannel populated)
 */
export async function getPortalRequests(orgId: string): Promise<PortalRequest[]> {
  const sb = getSupabase();

  // Fetch work items submitted via portal by this org
  const { data: items, error } = await sb
    .from('work_items')
    .select(
      `id, queue_key, status, created_at, extracted_data, agent_state,
       patient:patients(first_name,last_name),
       outbound_attempts(id,channel,status,payload,response,attempt_no)`,
    )
    .eq('org_id', orgId)
    .eq('source_channel', 'portal')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`portal requests query failed: ${error.message}`);

  return ((items ?? []) as unknown[]).map((row) => {
    const r = row as {
      id: string;
      queue_key: string;
      status: string;
      created_at: string;
      extracted_data: Record<string, unknown>;
      agent_state: Record<string, unknown>;
      patient?: { first_name: string; last_name: string } | null;
      outbound_attempts: Array<{
        id: string;
        channel: string;
        status: string;
        attempt_no: number;
        payload: Record<string, unknown>;
        response: Record<string, unknown> | null;
      }>;
    };

    const extracted = r.extracted_data ?? {};
    const agentState = r.agent_state ?? {};
    const attempts = r.outbound_attempts ?? [];

    // Derive patient name
    const patientName = r.patient
      ? `${r.patient.first_name} ${r.patient.last_name}`
      : extracted['patient_first_name']
        ? `${extracted['patient_first_name']} ${extracted['patient_last_name'] ?? ''}`.trim()
        : null;

    const recordsRequested = (extracted['records_requested'] as string | undefined) ?? null;

    // Map to plain-language status
    let portalStatus: PortalRequest['status'];
    let pendingInfoAttemptId: string | null = null;
    let responseDocument: string | null = null;
    let responseChannel: string | null = null;

    if (r.status === 'done') {
      portalStatus = 'completed';
      // The records WE sent live in the fulfillment attempt's payload.document
      // (the rendered Records Response/transmittal) — attempt.response is just
      // the delivery ack. Prefer the fulfillment document, whatever channel it
      // went out on.
      const fulfillment = attempts.find(
        (a) =>
          a.payload?.['kind'] === 'records_response' ||
          String(a.payload?.['subject'] ?? '').includes('Records Response'),
      );
      const anyResponded = attempts.find((a) => a.status === 'responded' && a.response);
      responseDocument =
        ((fulfillment?.payload?.['document'] as string | undefined) ??
          (anyResponded?.response?.['document'] as string | undefined)) ?? null;
      responseChannel = fulfillment?.channel ?? anyResponded?.channel ?? null;
    } else if (r.queue_key === 'human_review') {
      portalStatus = 'under_review';
    } else if (r.status === 'waiting' && agentState['more_info_sent']) {
      // Agent sent request_more_info — find the pending attempt
      portalStatus = 'action_needed';
      const moreInfoAttempt = attempts.find(
        (a) => (a.payload?.['kind'] === 'request_more_info') &&
               (a.status === 'sent' || a.status === 'awaiting_response'),
      );
      pendingInfoAttemptId = moreInfoAttempt?.id ?? null;
    } else {
      portalStatus = 'processing';
    }

    return {
      itemId: r.id,
      status: portalStatus,
      queueKey: r.queue_key,
      itemStatus: r.status,
      createdAt: r.created_at,
      recordsRequested,
      patientName,
      pendingInfoAttemptId,
      responseDocument,
      responseChannel,
    } satisfies PortalRequest;
  });
}

// ---------------------------------------------------------------------------
// respondToAttempt — authorization case only
// POST /api/portal/respond {attemptId, orgId, authorizationAttached:true}
// ---------------------------------------------------------------------------

export async function respondToAttempt(
  orgId: string,
  payload: RespondPayload,
): Promise<void> {
  const sb = getSupabase();
  const now = new Date().toISOString();

  // Fetch the attempt + parent work item to validate state
  const { data: attempt, error: fetchErr } = await sb
    .from('outbound_attempts')
    .select('id,status,work_item_id,to_org_id,work_item:work_items(id,queue_key,extracted_data)')
    .eq('id', payload.attemptId)
    .single();

  if (fetchErr || !attempt) {
    throw Object.assign(new Error('Attempt not found'), { status: 404 });
  }

  // Supabase returns joined one-to-one as object, but TypeScript infers array — cast via unknown
  const a = attempt as unknown as {
    id: string;
    status: string;
    work_item_id: string;
    to_org_id: string | null;
    work_item: {
      id: string;
      queue_key: string;
      extracted_data: Record<string, unknown>;
    } | null;
  };

  // Guard: only allow responding on attempts addressed to this org
  // For portal submissions (source_channel='portal'), the org that submitted is the requester.
  // The outbound request_more_info attempt goes TO the requesting org — to_org_id = orgId.
  if (a.to_org_id !== orgId) {
    throw Object.assign(new Error('Attempt does not belong to this org'), { status: 403 });
  }

  // 409 on double-respond
  if (a.status === 'responded') {
    throw Object.assign(new Error('Already responded to this attempt'), { status: 409 });
  }

  // Only sent/awaiting_response attempts can be responded to
  if (a.status !== 'sent' && a.status !== 'awaiting_response') {
    throw Object.assign(
      new Error(`Cannot respond to attempt with status '${a.status}'`),
      { status: 422 },
    );
  }

  // Resolve the org name for the audit actor
  const { data: orgRow } = await sb
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .single();
  const orgName = (orgRow as { name: string } | null)?.name ?? orgId;

  // Build the response object — authorization case
  const responseObj: Record<string, unknown> = {
    status: 'responded_via_portal',
    message: payload.message ?? 'Authorization attached via portal.',
    received_at: now,
    authorization: payload.authorizationAttached
      ? 'Signed authorization provided via portal'
      : undefined,
  };

  // Update attempt status
  const { data: updated } = await sb
    .from('outbound_attempts')
    .update({
      status: 'responded',
      response: responseObj,
      updated_at: now,
    })
    .eq('id', payload.attemptId)
    .in('status', ['sent', 'awaiting_response'])
    .select('id');

  if (!updated || updated.length === 0) {
    // Lost the race — someone else responded concurrently
    throw Object.assign(new Error('Already responded to this attempt'), { status: 409 });
  }

  // Audit row
  await sb.from('audit_log').insert({
    work_item_id: a.work_item_id,
    actor: `portal:${orgName}`,
    action: 'portal_response',
    detail: {
      attempt_id: payload.attemptId,
      authorization_attached: payload.authorizationAttached ?? false,
      message: payload.message ?? '',
    },
  });

  // Reopen the work item so the agent resumes on next tick
  const workItem = a.work_item;
  if (workItem) {
    await handleAttemptResponse(
      a.work_item_id,
      workItem.queue_key,
      responseObj,
      workItem.extracted_data ?? {},
    );
  }

  console.log(
    '[portal.respondToAttempt]',
    JSON.stringify({
      attemptId: payload.attemptId,
      orgId,
      orgName,
      authorizationAttached: payload.authorizationAttached ?? false,
    }),
  );
}

// ---------------------------------------------------------------------------
// getPortalInbox — legacy alias (kept for compatibility)
// ---------------------------------------------------------------------------

export async function getPortalInbox(orgId: string): Promise<PortalAttempt[]> {
  const sb = getSupabase();

  // Fetch attempts sent to this org, with work item and patient joined
  const { data, error } = await sb
    .from('outbound_attempts')
    .select(
      `*,
       work_item:work_items(
         id,
         type,
         queue_key,
         extracted_data,
         matched_patient_id,
         patient:patients(first_name,last_name)
       )`,
    )
    .eq('to_org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`portal inbox query failed: ${error.message}`);

  return ((data ?? []) as unknown[]).map((row) => {
    const r = row as {
      id: string;
      work_item_id: string;
      channel: string;
      attempt_no: number;
      to_org_id: string | null;
      to_contact: Record<string, unknown>;
      payload: Record<string, unknown>;
      status: string;
      respond_after: string | null;
      response: Record<string, unknown> | null;
      created_at: string;
      updated_at: string;
      work_item: {
        id: string;
        type: string;
        queue_key: string;
        extracted_data: Record<string, unknown>;
        patient?: { first_name: string; last_name: string } | null;
      } | null;
    };

    const patient = r.work_item?.patient;
    const patientName = patient
      ? `${patient.first_name} ${patient.last_name}`
      : null;

    return {
      id: r.id,
      work_item_id: r.work_item_id,
      channel: r.channel,
      attempt_no: r.attempt_no,
      to_org_id: r.to_org_id,
      to_contact: r.to_contact,
      payload: r.payload,
      status: r.status,
      respond_after: r.respond_after,
      response: r.response,
      created_at: r.created_at,
      updated_at: r.updated_at,
      item_type: r.work_item?.type ?? null,
      patient_name: patientName,
      queue_key: r.work_item?.queue_key ?? null,
      extracted_data: r.work_item?.extracted_data ?? null,
    } satisfies PortalAttempt;
  });
}
