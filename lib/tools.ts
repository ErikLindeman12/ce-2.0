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
// Helper: random delay for simulated outbound respond_after (20-40 seconds)
// ---------------------------------------------------------------------------

function respondAfter(): string {
  const seconds = 20 + Math.floor(Math.random() * 21); // 20–40s
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
// ---------------------------------------------------------------------------

async function createOutboundAttempt(
  workItemId: string,
  channel: OutboundChannel,
  orgId: string | null,
  contactSnapshot: Record<string, unknown>,
  payload: { subject: string; body: string },
  attemptNo: number = 1,
): Promise<string> {
  const sb = getSupabase();
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
      respond_after: respondAfter(),
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
// Helper: send via preferred channel
// ---------------------------------------------------------------------------

async function sendViaPreferredChannel(
  workItemId: string,
  orgId: string | null,
  payload: { subject: string; body: string },
  actor: string,
  attemptNo: number = 1,
): Promise<ToolResult> {
  const contact = await getOrgContact(orgId);
  const preferredChannel = (contact?.preferred_channel ?? 'fax') as OutboundChannel;
  const contactSnapshot: Record<string, unknown> = {
    fax: contact?.fax,
    email: contact?.email,
    phone: contact?.phone,
  };

  const attemptId = await createOutboundAttempt(
    workItemId,
    preferredChannel,
    orgId,
    contactSnapshot,
    payload,
    attemptNo,
  );

  console.log(
    `[tool.${preferredChannel}_via_preferred]`,
    JSON.stringify({ workItemId, attemptId, orgId, channel: preferredChannel }),
  );

  return { success: true, data: { attempt_id: attemptId, channel: preferredChannel } };
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
        .select('extracted_data,confidence')
        .eq('id', workItemId)
        .single();

      const existing = (item as { extracted_data: Record<string, unknown> } | null)
        ?.extracted_data ?? {};
      const existingConf =
        (item as { confidence: Record<string, number> } | null)?.confidence ?? {};

      const { error } = await sb
        .from('work_items')
        .update({
          extracted_data: { ...existing, ...fields },
          confidence: { ...existingConf, extract: params['confidence'] ?? 0.8 },
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
      const sb = getSupabase();
      const { data: item } = await sb
        .from('work_items')
        .select('confidence')
        .eq('id', workItemId)
        .single();
      const existingConf =
        (item as { confidence: Record<string, number> } | null)?.confidence ?? {};

      await sb
        .from('work_items')
        .update({
          confidence: { ...existingConf, verify: confidence },
          updated_at: new Date().toISOString(),
        })
        .eq('id', workItemId);

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

      const payload = {
        subject: (params['subject'] as string | undefined) ?? 'Fax',
        body: (params['body'] as string | undefined) ?? '',
      };

      const result = await sendViaChannel(workItemId, 'fax', orgId, payload, actor, attemptNo);
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

      const payload = {
        subject: (params['subject'] as string | undefined) ?? 'Email',
        body: (params['body'] as string | undefined) ?? '',
      };

      const result = await sendViaChannel(workItemId, 'email', orgId, payload, actor, attemptNo);
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

      const payload = {
        subject: 'SMS',
        body: (params['body'] as string | undefined) ?? 'Records requested.',
      };

      const result = await sendViaChannel(workItemId, 'sms', orgId, payload, actor, attemptNo);
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

      const payload = {
        subject: 'Voice call',
        body: (params['message'] as string | undefined) ?? 'Records requested.',
      };

      const result = await sendViaChannel(workItemId, 'voice', orgId, payload, actor, attemptNo);
      console.log('[tool.place_call]', JSON.stringify({ workItemId, orgId, attemptNo }));
      return result;
    },
  },

  // ---- request_more_info --------------------------------------------------
  request_more_info: {
    description: 'Send an outbound request for more information to the requesting org.',
    async execute(workItemId, params, actor) {
      const reason = (params['reason'] as string | undefined) ?? 'More information required.';

      const { data: item } = await getSupabase()
        .from('work_items')
        .select('org_id, agent_state')
        .eq('id', workItemId)
        .single();

      const orgId = (item as { org_id: string | null } | null)?.org_id ?? null;
      const agentState =
        (item as { agent_state: Record<string, unknown> } | null)?.agent_state ?? {};

      const payload = {
        subject: 'Request for Additional Information',
        body: reason,
      };

      const contact = await getOrgContact(orgId);
      const channel = (contact?.preferred_channel ?? 'fax') as OutboundChannel;
      const contactSnapshot: Record<string, unknown> = {
        fax: contact?.fax,
        email: contact?.email,
      };

      const attemptNo = ((agentState['attempt_no'] as number | undefined) ?? 0) + 1;
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

      console.log('[tool.request_more_info]', JSON.stringify({ workItemId, reason, attemptId }));
      return { success: true, data: { attempt_id: attemptId, channel, reason } };
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

  // ---- resolve_review (human-only) ----------------------------------------
  resolve_review: {
    description: 'Resolve a Human Review escalation: apply correction and route onward.',
    async execute(workItemId, params, _actor) {
      const chosenPatientId = (params['patient_id'] ?? params['patientId']) as
        | string
        | undefined;
      const nextQueue = (params['queue_key'] ?? params['queueKey']) as string | undefined;

      const sb = getSupabase();
      const updates: Record<string, unknown> = {
        assignee: 'unassigned',
        review_reason: null,
        status: 'open',
        updated_at: new Date().toISOString(),
      };

      if (chosenPatientId) {
        updates['matched_patient_id'] = chosenPatientId;
        const { data: item } = await sb
          .from('work_items')
          .select('confidence')
          .eq('id', workItemId)
          .single();
        const existingConf =
          (item as { confidence: Record<string, number> } | null)?.confidence ?? {};
        updates['confidence'] = { ...existingConf, match: 0.99 };
      }

      if (nextQueue) {
        updates['queue_key'] = nextQueue;
      } else {
        // Default routing after review
        const { data: item } = await sb
          .from('work_items')
          .select('type')
          .eq('id', workItemId)
          .single();
        const itemType = (item as { type: string } | null)?.type;
        if (itemType === 'referral') updates['queue_key'] = 'referrals';
        else if (itemType === 'records_request_in') updates['queue_key'] = 'roi_incoming';
        else updates['queue_key'] = 'intake';
      }

      const { error } = await sb.from('work_items').update(updates).eq('id', workItemId);
      if (error) return { success: false, error: error.message };
      return { success: true, data: { resolved: true, patient_id: chosenPatientId ?? null } };
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
  payload: { subject: string; body: string },
  _actor: string,
  attemptNo: number,
): Promise<ToolResult> {
  const contact = await getOrgContact(orgId);
  const contactSnapshot: Record<string, unknown> = {
    fax: contact?.fax,
    email: contact?.email,
    phone: contact?.phone,
  };

  const attemptId = await createOutboundAttempt(
    workItemId,
    channel,
    orgId,
    contactSnapshot,
    payload,
    attemptNo,
  );

  // Track attempt_no in agent_state
  const { data: item } = await getSupabase()
    .from('work_items')
    .select('agent_state')
    .eq('id', workItemId)
    .single();
  const agentState =
    (item as { agent_state: Record<string, unknown> } | null)?.agent_state ?? {};
  await getSupabase()
    .from('work_items')
    .update({
      agent_state: { ...agentState, attempt_no: attemptNo, last_channel: channel },
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
