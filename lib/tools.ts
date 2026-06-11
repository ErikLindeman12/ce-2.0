/**
 * lib/tools.ts — shared tool registry.
 *
 * TOOLS: Record<string, ToolDef> — every tool humans AND agents invoke.
 * runTool(name, workItemId, params, actor) — validates, executes, audits.
 *
 * Every execution writes an audit_log row with actor, action, detail
 * (params + result + confidence).
 */

import { getSupabase } from './supabase';
import { renderOutboundDocument, type Channel, type DocumentKind } from './outbound';
import { matchPatientHeuristic } from './llm';
import type { ToolDef, ToolResult, OutboundChannel } from './types';

// ---------------------------------------------------------------------------
// Utility: write audit log
// ---------------------------------------------------------------------------

async function audit(
  workItemId: string,
  actor: string,
  action: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const { error } = await getSupabase()
    .from('audit_log')
    .insert({ work_item_id: workItemId, actor, action, detail });
  if (error) {
    console.log('[audit.error]', JSON.stringify({ action, error: error.message }));
  }
}

// ---------------------------------------------------------------------------
// Helper: simulated outbound respond_after (default 20-40s)
// ---------------------------------------------------------------------------

function respondAfter(waitSeconds?: number): string {
  const seconds = waitSeconds ?? (20 + Math.floor(Math.random() * 21));
  return new Date(Date.now() + seconds * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Helper: get org contact info
// ---------------------------------------------------------------------------

async function getOrgContact(orgId: string | null): Promise<{
  fax?: string;
  email?: string;
  phone?: string;
  preferred_channel?: OutboundChannel;
  simulation?: string;
} | null> {
  if (!orgId) return null;
  const { data } = await getSupabase()
    .from('organizations')
    .select('contact')
    .eq('id', orgId)
    .single();
  return (data as { contact: Record<string, string> } | null)?.contact ?? null;
}

// ---------------------------------------------------------------------------
// Helper: create an outbound attempt and set work item to waiting
// portal channel → respond_after = null (never auto-timed-out by tick)
// ---------------------------------------------------------------------------

async function createOutboundAttempt(
  workItemId: string,
  channel: OutboundChannel,
  orgId: string | null,
  contactSnapshot: Record<string, unknown>,
  payload: { subject: string; body: string; document?: string; kind?: string },
  attemptNo: number = 1,
  waitSeconds?: number,
): Promise<string> {
  const sb = getSupabase();
  const isPortal = channel === 'portal';

  const { data, error } = await sb
    .from('outbound_attempts')
    .insert({
      work_item_id: workItemId,
      channel,
      attempt_no: attemptNo,
      to_org_id: orgId,
      to_contact: contactSnapshot,
      payload,
      status: 'sent',
      respond_after: isPortal ? null : respondAfter(waitSeconds),
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to create outbound attempt: ${error.message}`);

  // Set item to waiting
  await sb
    .from('work_items')
    .update({ status: 'waiting', updated_at: new Date().toISOString() })
    .eq('id', workItemId);

  return (data as { id: string }).id;
}

// ---------------------------------------------------------------------------
// Helper: build outbound context from a work item for document rendering
// ---------------------------------------------------------------------------

async function buildOutboundContext(
  workItemId: string,
  orgId: string | null,
  attemptNo: number,
  contact: { fax?: string; email?: string; phone?: string } | null,
): Promise<import('./outbound').OutboundContext> {
  const sb = getSupabase();

  const { data: itemData } = await sb
    .from('work_items')
    .select('id,extracted_data,matched_patient_id,org_id')
    .eq('id', workItemId)
    .single();

  const item = itemData as {
    id: string;
    extracted_data: Record<string, string>;
    matched_patient_id: string | null;
    org_id: string | null;
  } | null;

  const extracted = item?.extracted_data ?? {};

  let patientName = 'Unknown Patient';
  let patientDob: string | undefined;
  let patientMrn: string | undefined;

  if (item?.matched_patient_id) {
    const { data: pat } = await sb
      .from('patients')
      .select('first_name,last_name,dob,mrn')
      .eq('id', item.matched_patient_id)
      .single();
    const p = pat as { first_name: string; last_name: string; dob: string; mrn: string } | null;
    if (p) {
      patientName = `${p.first_name} ${p.last_name}`;
      patientDob = p.dob;
      patientMrn = p.mrn;
    }
  } else {
    const fn = (extracted['patient_first_name'] ?? extracted['patient_name'] ?? '') as string;
    const ln = (extracted['patient_last_name'] ?? '') as string;
    if (fn || ln) patientName = `${fn} ${ln}`.trim();
    patientDob = (extracted['patient_dob'] ?? undefined) as string | undefined;
    patientMrn = (extracted['patient_mrn'] ?? undefined) as string | undefined;
  }

  // Org name
  let orgName = (extracted['org_name'] ?? '') as string;
  if (!orgName && orgId) {
    const { data: orgRow } = await sb
      .from('organizations')
      .select('name')
      .eq('id', orgId)
      .single();
    orgName = (orgRow as { name: string } | null)?.name ?? 'Unknown Org';
  }

  return {
    itemId: workItemId,
    patientName,
    patientDob,
    patientMrn,
    recordsRequested: (extracted['records_requested'] ?? undefined) as string | undefined,
    orgName,
    orgFax: contact?.fax,
    orgEmail: contact?.email,
    orgPhone: contact?.phone,
    attemptNo,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const TOOLS: Record<string, ToolDef> = {
  // ---- classify_document --------------------------------------------------
  classify_document: {
    description: 'Classify the document type (referral | records_request_in | unknown).',
    async execute(workItemId, params, _actor) {
      const docType = params['document_type'] as string | undefined;
      if (!docType) return { success: false, error: 'Missing document_type param' };

      const sb = getSupabase();
      const { error } = await sb
        .from('work_items')
        .update({
          type: docType,
          updated_at: new Date().toISOString(),
        })
        .eq('id', workItemId);

      if (error) return { success: false, error: error.message };

      // Merge confidence score
      const { data: item } = await sb
        .from('work_items')
        .select('confidence')
        .eq('id', workItemId)
        .single();
      const existing = (item as { confidence: Record<string, number> } | null)?.confidence ?? {};
      await sb
        .from('work_items')
        .update({
          confidence: { ...existing, classify: params['confidence'] ?? 0.8 },
          updated_at: new Date().toISOString(),
        })
        .eq('id', workItemId);

      return { success: true, data: { type: docType } };
    },
  },

  // ---- extract_fields -----------------------------------------------------
  extract_fields: {
    description: 'Extract structured fields from the source document.',
    async execute(workItemId, params, _actor) {
      const fields = params['fields'] as Record<string, unknown> | undefined;
      if (!fields) return { success: false, error: 'Missing fields param' };

      const sb = getSupabase();
      const { data: item } = await sb
        .from('work_items')
        .select('extracted_data,confidence,agent_state')
        .eq('id', workItemId)
        .single();

      const existing = (item as { extracted_data: Record<string, unknown> } | null)
        ?.extracted_data ?? {};
      const existingConf =
        (item as { confidence: Record<string, number> } | null)?.confidence ?? {};
      const existingState =
        (item as { agent_state: Record<string, unknown> } | null)?.agent_state ?? {};

      // Merge extraction_meta into agent_state when present
      const extractionMeta = params['extraction_meta'] as Record<string, unknown> | undefined;
      const updatedState = extractionMeta
        ? { ...existingState, extraction_meta: extractionMeta }
        : existingState;

      const { error } = await sb
        .from('work_items')
        .update({
          extracted_data: { ...existing, ...fields },
          confidence: { ...existingConf, extract: params['confidence'] ?? 0.8 },
          agent_state: updatedState,
          updated_at: new Date().toISOString(),
        })
        .eq('id', workItemId);

      if (error) return { success: false, error: error.message };
      return { success: true, data: { extracted_fields: Object.keys(fields) } };
    },
  },

  // ---- match_patient -------------------------------------------------------
  match_patient: {
    description: 'Match extracted patient data against the MPI.',
    async execute(workItemId, params, _actor) {
      const patientId = params['patient_id'] as string | null | undefined;
      const confidence = (params['confidence'] as number | undefined) ?? 0.8;

      const sb = getSupabase();
      const { data: item } = await sb
        .from('work_items')
        .select('confidence')
        .eq('id', workItemId)
        .single();
      const existingConf =
        (item as { confidence: Record<string, number> } | null)?.confidence ?? {};

      const updates: Record<string, unknown> = {
        confidence: { ...existingConf, match: confidence },
        updated_at: new Date().toISOString(),
      };
      if (patientId) updates['matched_patient_id'] = patientId;

      const { error } = await sb.from('work_items').update(updates).eq('id', workItemId);
      if (error) return { success: false, error: error.message };

      return { success: true, data: { matched_patient_id: patientId ?? null } };
    },
  },

  // ---- verify_requirements ------------------------------------------------
  verify_requirements: {
    description: 'Verify that an ROI request has patient, records description, and authorization.',
    async execute(workItemId, params, _actor) {
      const confidence = (params['confidence'] as number | undefined) ?? 0.8;
      const requirements = params['requirements'] as Record<string, boolean> | undefined;
      const sb = getSupabase();
      const { data: item } = await sb
        .from('work_items')
        .select('confidence,agent_state')
        .eq('id', workItemId)
        .single();
      const existingConf =
        (item as { confidence: Record<string, number> } | null)?.confidence ?? {};
      const existingState =
        (item as { agent_state: Record<string, unknown> } | null)?.agent_state ?? {};

      const updates: Record<string, unknown> = {
        confidence: { ...existingConf, verify: confidence },
        updated_at: new Date().toISOString(),
      };

      // Store requirements result in agent_state so the planner can check it
      if (requirements) {
        updates['agent_state'] = { ...existingState, requirements };
      }

      await sb.from('work_items').update(updates).eq('id', workItemId);

      return { success: true, data: params };
    },
  },

  // ---- advance_stage -------------------------------------------------------
  advance_stage: {
    description: 'Move a work item to a different queue (e.g. intake → referrals).',
    async execute(workItemId, params, _actor) {
      const queueKey = params['queue_key'] as string | undefined;
      const type = params['type'] as string | undefined;
      if (!queueKey) return { success: false, error: 'Missing queue_key param' };

      const updates: Record<string, unknown> = {
        queue_key: queueKey,
        status: 'open',
        assignee: 'unassigned',
        updated_at: new Date().toISOString(),
      };
      if (type) updates['type'] = type;

      const { error } = await getSupabase()
        .from('work_items')
        .update(updates)
        .eq('id', workItemId);

      if (error) return { success: false, error: error.message };
      return { success: true, data: { queue_key: queueKey } };
    },
  },

  // ---- send_fax -----------------------------------------------------------
  send_fax: {
    description: 'Send a fax outbound and set item to waiting.',
    async execute(workItemId, params, actor) {
      const { data: item } = await getSupabase()
        .from('work_items')
        .select('org_id, agent_state')
        .eq('id', workItemId)
        .single();

      const orgId = (item as { org_id: string | null } | null)?.org_id ?? null;
      const agentState =
        (item as { agent_state: Record<string, unknown> } | null)?.agent_state ?? {};
      const attemptNo = ((agentState['attempt_no'] as number | undefined) ?? 0) + 1;
      const stateFlag = params['state_flag'] as string | undefined;
      // Fulfillment sends (planner marks them records_sent) deliver the
      // records — render the response document, not another request.
      const kind: DocumentKind =
        stateFlag === 'records_sent'
          ? 'records_response'
          : ((agentState['kind'] as DocumentKind | undefined) ?? 'records_request');

      const contact = await getOrgContact(orgId);
      const ctx = await buildOutboundContext(workItemId, orgId, attemptNo, contact);
      const rendered = renderOutboundDocument('fax', kind, ctx);
      const payload = { subject: rendered.subject, body: rendered.body, document: rendered.document, kind };

      const result = await sendViaChannel(workItemId, 'fax', orgId, payload, actor, attemptNo, agentState, stateFlag);
      console.log('[tool.send_fax]', JSON.stringify({ workItemId, orgId, attemptNo }));
      return result;
    },
  },

  // ---- send_email ---------------------------------------------------------
  send_email: {
    description: 'Send an email outbound and set item to waiting.',
    async execute(workItemId, params, actor) {
      const { data: item } = await getSupabase()
        .from('work_items')
        .select('org_id, agent_state')
        .eq('id', workItemId)
        .single();

      const orgId = (item as { org_id: string | null } | null)?.org_id ?? null;
      const agentState =
        (item as { agent_state: Record<string, unknown> } | null)?.agent_state ?? {};
      const attemptNo = ((agentState['attempt_no'] as number | undefined) ?? 0) + 1;
      const stateFlag = params['state_flag'] as string | undefined;
      // Fulfillment sends (planner marks them records_sent) deliver the
      // records — render the response document, not another request.
      const kind: DocumentKind =
        stateFlag === 'records_sent'
          ? 'records_response'
          : ((agentState['kind'] as DocumentKind | undefined) ?? 'records_request');

      const contact = await getOrgContact(orgId);
      const ctx = await buildOutboundContext(workItemId, orgId, attemptNo, contact);
      const rendered = renderOutboundDocument('email', kind, ctx);
      const payload = { subject: rendered.subject, body: rendered.body, document: rendered.document, kind };

      const result = await sendViaChannel(workItemId, 'email', orgId, payload, actor, attemptNo, agentState, stateFlag);
      console.log('[tool.send_email]', JSON.stringify({ workItemId, orgId, attemptNo }));
      return result;
    },
  },

  // ---- send_sms -----------------------------------------------------------
  send_sms: {
    description: 'Send an SMS outbound and set item to waiting.',
    async execute(workItemId, params, actor) {
      const { data: item } = await getSupabase()
        .from('work_items')
        .select('org_id, agent_state')
        .eq('id', workItemId)
        .single();

      const orgId = (item as { org_id: string | null } | null)?.org_id ?? null;
      const agentState =
        (item as { agent_state: Record<string, unknown> } | null)?.agent_state ?? {};
      const attemptNo = ((agentState['attempt_no'] as number | undefined) ?? 0) + 1;
      const stateFlag = params['state_flag'] as string | undefined;
      // Fulfillment sends (planner marks them records_sent) deliver the
      // records — render the response document, not another request.
      const kind: DocumentKind =
        stateFlag === 'records_sent'
          ? 'records_response'
          : ((agentState['kind'] as DocumentKind | undefined) ?? 'records_request');

      const contact = await getOrgContact(orgId);
      const ctx = await buildOutboundContext(workItemId, orgId, attemptNo, contact);
      const rendered = renderOutboundDocument('sms', kind, ctx);
      const payload = { subject: rendered.subject, body: rendered.body, document: rendered.document, kind };

      const result = await sendViaChannel(workItemId, 'sms', orgId, payload, actor, attemptNo, agentState, stateFlag);
      console.log('[tool.send_sms]', JSON.stringify({ workItemId, orgId, attemptNo }));
      return result;
    },
  },

  // ---- place_call ---------------------------------------------------------
  place_call: {
    description: 'Place a voice call outbound and set item to waiting.',
    async execute(workItemId, params, actor) {
      const { data: item } = await getSupabase()
        .from('work_items')
        .select('org_id, agent_state')
        .eq('id', workItemId)
        .single();

      const orgId = (item as { org_id: string | null } | null)?.org_id ?? null;
      const agentState =
        (item as { agent_state: Record<string, unknown> } | null)?.agent_state ?? {};
      const attemptNo = ((agentState['attempt_no'] as number | undefined) ?? 0) + 1;
      const stateFlag = params['state_flag'] as string | undefined;
      // Fulfillment sends (planner marks them records_sent) deliver the
      // records — render the response document, not another request.
      const kind: DocumentKind =
        stateFlag === 'records_sent'
          ? 'records_response'
          : ((agentState['kind'] as DocumentKind | undefined) ?? 'records_request');

      const contact = await getOrgContact(orgId);
      const ctx = await buildOutboundContext(workItemId, orgId, attemptNo, contact);
      const rendered = renderOutboundDocument('voice', kind, ctx);
      const payload = { subject: rendered.subject, body: rendered.body, document: rendered.document, kind };

      const result = await sendViaChannel(workItemId, 'voice', orgId, payload, actor, attemptNo, agentState, stateFlag);
      console.log('[tool.place_call]', JSON.stringify({ workItemId, orgId, attemptNo }));
      return result;
    },
  },

  // ---- request_more_info --------------------------------------------------
  request_more_info: {
    description: 'Send an outbound request for more information to the requesting org.',
    async execute(workItemId, params, actor) {
      const { data: item } = await getSupabase()
        .from('work_items')
        .select('org_id, agent_state')
        .eq('id', workItemId)
        .single();

      const orgId = (item as { org_id: string | null } | null)?.org_id ?? null;
      const agentState =
        (item as { agent_state: Record<string, unknown> } | null)?.agent_state ?? {};

      const contact = await getOrgContact(orgId);
      const rawChannel = contact?.preferred_channel ?? 'fax';
      // portal orgs: fall back to fax for more-info since portal is handled differently
      const channel = (rawChannel === 'portal' ? 'fax' : rawChannel) as OutboundChannel;
      const contactSnapshot: Record<string, unknown> = {
        fax: contact?.fax,
        email: contact?.email,
        phone: contact?.phone,
      };

      const attemptNo = ((agentState['attempt_no'] as number | undefined) ?? 0) + 1;
      const ctx = await buildOutboundContext(workItemId, orgId, attemptNo, contact);
      const rendered = renderOutboundDocument(channel as Channel, 'request_more_info', ctx);
      const payload = {
        subject: rendered.subject,
        body: rendered.body,
        document: rendered.document,
        kind: 'request_more_info',
      };

      const attemptId = await createOutboundAttempt(
        workItemId,
        channel,
        orgId,
        contactSnapshot,
        payload,
        attemptNo,
      );

      // Mark agent_state so we don't re-send
      await getSupabase()
        .from('work_items')
        .update({
          agent_state: { ...agentState, more_info_sent: true, attempt_no: attemptNo },
          updated_at: new Date().toISOString(),
        })
        .eq('id', workItemId);

      console.log('[tool.request_more_info]', JSON.stringify({ workItemId, attemptId }));
      return { success: true, data: { attempt_id: attemptId, channel, kind: 'request_more_info' } };
    },
  },

  // ---- mark_complete -------------------------------------------------------
  mark_complete: {
    description: 'Mark a work item as done.',
    async execute(workItemId, params, _actor) {
      const { error } = await getSupabase()
        .from('work_items')
        .update({
          status: 'done',
          assignee: 'unassigned',
          updated_at: new Date().toISOString(),
        })
        .eq('id', workItemId);

      if (error) return { success: false, error: error.message };
      const note = (params['note'] as string | undefined) ?? 'Completed.';
      return { success: true, data: { note } };
    },
  },

  // ---- escalate_to_human --------------------------------------------------
  escalate_to_human: {
    description: 'Escalate a work item to Human Review with a specific question.',
    async execute(workItemId, params, _actor) {
      const question =
        (params['question'] as string | undefined) ?? 'Needs human review.';

      const { error } = await getSupabase()
        .from('work_items')
        .update({
          queue_key: 'human_review',
          assignee: 'human',
          review_reason: question,
          status: 'open',
          updated_at: new Date().toISOString(),
        })
        .eq('id', workItemId);

      if (error) return { success: false, error: error.message };
      return { success: true, data: { question } };
    },
  },

  // ---- approve_action (human-only) ----------------------------------------
  approve_action: {
    description: 'Approve a pending supervised-mode agent proposal and execute it.',
    async execute(workItemId, _params, actor) {
      const sb = getSupabase();
      const { data: item } = await sb
        .from('work_items')
        .select('agent_state')
        .eq('id', workItemId)
        .single();

      const agentState =
        (item as { agent_state: Record<string, unknown> } | null)?.agent_state ?? {};
      const pending = agentState['pending_approval'] as
        | {
            action: string;
            params: Record<string, unknown>;
            confidence: number;
            rationale: string;
            agentId: string;
            agentName: string;
          }
        | undefined;

      if (!pending) {
        return { success: false, error: 'No pending_approval on this item' };
      }

      const returnQueue = (agentState['return_queue'] as string | undefined) ?? 'intake';
      const approvedActor = `human(approved:${pending.agentName})`;

      // Execute the stored action
      const result = await runTool(pending.action, workItemId, pending.params, approvedActor);

      // Clear pending_approval and return to the original queue — but build the
      // new agent_state from a FRESH read: the executed tool may have just
      // written its own state (attempt_no, records_sent, …) and writing the
      // pre-execution snapshot back would erase it and cause a re-proposal loop.
      const { data: afterItem } = await sb
        .from('work_items')
        .select('agent_state,status')
        .eq('id', workItemId)
        .single();
      const afterRow = afterItem as
        | { agent_state: Record<string, unknown>; status: string }
        | null;
      const { return_queue: _rq, pending_approval: _pa, ...restState } =
        (afterRow?.agent_state ?? agentState) as Record<string, unknown>;
      void _rq; void _pa;
      await sb
        .from('work_items')
        .update({
          agent_state: restState,
          queue_key: returnQueue,
          assignee: 'unassigned',
          review_reason: null,
          // Preserve 'waiting' when the approved action was an outbound send
          // (its respond/timeout lifecycle owns the item now).
          status: afterRow?.status === 'waiting' ? 'waiting' : 'open',
          updated_at: new Date().toISOString(),
        })
        .eq('id', workItemId);

      console.log('[tool.approve_action]', JSON.stringify({ workItemId, action: pending.action, actor }));
      return { success: true, data: { approved_action: pending.action, tool_result: result } };
    },
  },

  // ---- reject_action (human-only) -----------------------------------------
  reject_action: {
    description: 'Reject a pending supervised-mode agent proposal and escalate for manual handling.',
    async execute(workItemId, _params, _actor) {
      const sb = getSupabase();
      const { data: item } = await sb
        .from('work_items')
        .select('agent_state')
        .eq('id', workItemId)
        .single();

      const agentState =
        (item as { agent_state: Record<string, unknown> } | null)?.agent_state ?? {};
      const pending = agentState['pending_approval'] as
        | { action: string; agentName: string }
        | undefined;

      const actionName = pending?.action ?? 'unknown';

      // Clear pending_approval and escalate
      const { pending_approval: _pa, return_queue: _rq, ...restState } = agentState as Record<string, unknown>;
      void _pa; void _rq;
      await sb
        .from('work_items')
        .update({
          agent_state: restState,
          updated_at: new Date().toISOString(),
        })
        .eq('id', workItemId);

      // Escalate with reason
      const escalateResult = await runTool(
        'escalate_to_human',
        workItemId,
        { question: `Proposed ${actionName} rejected — handle manually.` },
        _actor,
      );

      console.log('[tool.reject_action]', JSON.stringify({ workItemId, rejectedAction: actionName }));
      return { success: true, data: { rejected_action: actionName, escalate: escalateResult } };
    },
  },

  // ---- resolve_review (human-only) ----------------------------------------
  resolve_review: {
    description: 'Resolve a Human Review escalation: apply correction and route onward.',
    async execute(workItemId, params, _actor) {
      const chosenPatientId = (params['patient_id'] ?? params['patientId']) as
        | string
        | undefined;
      const nextQueue = (params['queue_key'] ?? params['queueKey']) as string | undefined;
      const correctedFields = params['fields'] as Record<string, string> | undefined;

      const sb = getSupabase();

      // Fetch current item state for merging
      const { data: currentItem } = await sb
        .from('work_items')
        .select('type,confidence,extracted_data')
        .eq('id', workItemId)
        .single();

      const existingConf =
        (currentItem as { confidence: Record<string, number> } | null)?.confidence ?? {};
      const existingExtracted =
        (currentItem as { extracted_data: Record<string, unknown> } | null)?.extracted_data ?? {};

      const updates: Record<string, unknown> = {
        assignee: 'unassigned',
        review_reason: null,
        status: 'open',
        updated_at: new Date().toISOString(),
      };

      // Merge corrected fields and audit which keys changed
      let changedKeys: string[] = [];
      let patientFieldsChanged = false;
      if (correctedFields && Object.keys(correctedFields).length > 0) {
        const patientFieldSet = new Set(['patient_first_name', 'patient_last_name', 'patient_dob', 'patient_mrn', 'patient_name']);
        changedKeys = Object.keys(correctedFields).filter(
          (k) => existingExtracted[k] !== correctedFields[k],
        );
        patientFieldsChanged = changedKeys.some((k) => patientFieldSet.has(k));
        updates['extracted_data'] = { ...existingExtracted, ...correctedFields };
      }

      if (chosenPatientId) {
        updates['matched_patient_id'] = chosenPatientId;
        updates['confidence'] = { ...existingConf, match: 0.99 };
      } else if (patientFieldsChanged && correctedFields) {
        // Re-run patient match with corrected fields
        const mergedExtracted = { ...existingExtracted, ...correctedFields } as Record<string, string>;
        const matchResult = await matchPatientHeuristic(mergedExtracted);
        if (matchResult.patientId) {
          updates['matched_patient_id'] = matchResult.patientId;
          updates['confidence'] = { ...existingConf, match: matchResult.confidence };
        } else {
          updates['confidence'] = { ...existingConf, match: matchResult.confidence };
        }
      }

      if (nextQueue) {
        updates['queue_key'] = nextQueue;
      } else {
        // Default routing after review
        const itemType = (currentItem as { type: string } | null)?.type;
        if (itemType === 'referral') updates['queue_key'] = 'referrals';
        else if (itemType === 'records_request_in') updates['queue_key'] = 'roi_incoming';
        else updates['queue_key'] = 'intake';
      }

      const { error } = await sb.from('work_items').update(updates).eq('id', workItemId);
      if (error) return { success: false, error: error.message };
      return {
        success: true,
        data: {
          resolved: true,
          patient_id: chosenPatientId ?? null,
          changed_fields: changedKeys,
        },
      };
    },
  },
};

// ---------------------------------------------------------------------------
// Internal: send via a specific channel
// ---------------------------------------------------------------------------

async function sendViaChannel(
  workItemId: string,
  channel: OutboundChannel,
  orgId: string | null,
  payload: { subject: string; body: string; document?: string; kind?: string },
  _actor: string,
  attemptNo: number,
  currentAgentState?: Record<string, unknown>,
  stateFlag?: string,
): Promise<ToolResult> {
  const contact = await getOrgContact(orgId);
  const contactSnapshot: Record<string, unknown> = {
    fax: contact?.fax,
    email: contact?.email,
    phone: contact?.phone,
  };

  // Inherit waitSeconds from chase_plan if present
  const chasePlan = (currentAgentState?.['chase_plan'] as { waitSeconds?: number } | undefined);
  const waitSeconds = chasePlan?.waitSeconds;

  const attemptId = await createOutboundAttempt(
    workItemId,
    channel,
    orgId,
    contactSnapshot,
    payload,
    attemptNo,
    waitSeconds,
  );

  // Read current agent_state if not provided
  let agentState = currentAgentState;
  if (!agentState) {
    const { data: item } = await getSupabase()
      .from('work_items')
      .select('agent_state')
      .eq('id', workItemId)
      .single();
    agentState = (item as { agent_state: Record<string, unknown> } | null)?.agent_state ?? {};
  }

  const newState: Record<string, unknown> = {
    ...agentState,
    attempt_no: attemptNo,
    last_channel: channel,
  };
  // Set a boolean flag in agent_state when requested (e.g. records_sent=true)
  if (stateFlag) {
    newState[stateFlag] = true;
  }

  await getSupabase()
    .from('work_items')
    .update({
      agent_state: newState,
      updated_at: new Date().toISOString(),
    })
    .eq('id', workItemId);

  return { success: true, data: { attempt_id: attemptId, channel } };
}

// ---------------------------------------------------------------------------
// Public: runTool
// ---------------------------------------------------------------------------

export async function runTool(
  toolName: string,
  workItemId: string,
  params: Record<string, unknown>,
  actor: string,
): Promise<ToolResult> {
  const tool = TOOLS[toolName];
  if (!tool) {
    const err = `Unknown tool: ${toolName}`;
    await audit(workItemId, actor, toolName, { error: err, params });
    return { success: false, error: err };
  }

  let result: ToolResult;
  try {
    result = await tool.execute(workItemId, params, actor);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = { success: false, error: msg };
  }

  await audit(workItemId, actor, toolName, {
    params,
    result,
    confidence: params['confidence'] ?? null,
  });

  return result;
}
