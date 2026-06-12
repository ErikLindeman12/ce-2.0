/**
 * lib/tools.ts — shared tool registry (event substrate).
 *
 * TOOLS: Record<string, ToolDef> — every tool humans AND agents invoke.
 * runTool(name, workItemId, params, actor, ctx?) — validates, executes, audits.
 *
 * Substrate contract (docs/substrate-spec.md §3):
 * - Every ToolDef carries effect: 'annotate' | 'external'.
 * - Tools AUTO-EMIT events (causedBy ctx.event, actor preserved):
 *     classify_document → document.classified {as, confidence}
 *     extract_fields    → fields.extracted {fieldCount}
 *     match_patient     → patient.matched {patientId, confidence} (on success)
 *     send_* / request_more_info → attempt.created {attemptId, channel, kind}
 * - All agent_state writes go through mergeCaseState (versioned).
 * - External sends are idempotent via outbound_attempts.dedupe_key
 *   (`${deliveryId}:${tool}:${attemptNo}`) — unique conflict returns the
 *   existing attempt as success without re-writing state.
 * - Engine code never references workflow-specific queue/type literals.
 */

import { getSupabase } from './supabase';
import { renderOutboundDocument, type Channel, type DocumentKind } from './outbound';
import { classifyHeuristic } from './llm';
import { emitEvent } from './events';
import { mergeCaseState, readCasePath } from './caseState';
import { createReviewRequest, answerReview, findPendingReview } from './reviews';
import type {
  OutboundAttemptKind,
  OutboundChannel,
  Pred,
  RequirementSpec,
  ToolCtx,
  ToolDef,
  ToolResult,
  WorkItem,
} from './types';

// ---------------------------------------------------------------------------
// Utility: write audit log (every runTool call lands here, with turn linkage)
// ---------------------------------------------------------------------------

async function audit(
  workItemId: string,
  actor: string,
  action: string,
  detail: Record<string, unknown>,
  ctx?: ToolCtx,
): Promise<void> {
  const { error } = await getSupabase()
    .from('audit_log')
    .insert({
      work_item_id: workItemId,
      actor,
      action,
      detail,
      turn_id: ctx?.turnId ?? null,
      delivery_id: ctx?.deliveryId ?? null,
    });
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
// Helper: fetch a work item row (selected columns) or null
// ---------------------------------------------------------------------------

async function getWorkItem<T>(workItemId: string, columns: string): Promise<T | null> {
  const { data } = await getSupabase()
    .from('work_items')
    .select(columns)
    .eq('id', workItemId)
    .single();
  return (data as T) ?? null;
}

// ---------------------------------------------------------------------------
// Helper: merge one key into work_items.confidence (NOT agent_state — direct
// column write is allowed for type/confidence)
// ---------------------------------------------------------------------------

async function mergeConfidence(workItemId: string, key: string, value: number): Promise<void> {
  const sb = getSupabase();
  const { data: item } = await sb
    .from('work_items')
    .select('confidence')
    .eq('id', workItemId)
    .single();
  const existing = (item as { confidence: Record<string, number> } | null)?.confidence ?? {};
  await sb
    .from('work_items')
    .update({
      confidence: { ...existing, [key]: value },
      updated_at: new Date().toISOString(),
    })
    .eq('id', workItemId);
}

// ---------------------------------------------------------------------------
// Helper: build outbound context from a work item for document rendering
// ---------------------------------------------------------------------------

async function buildOutboundContext(
  workItemId: string,
  orgId: string | null,
  attemptNo: number,
  contact: { fax?: string; email?: string; phone?: string } | null,
  priorAttemptAt?: string,
): Promise<import('./outbound').OutboundContext> {
  const sb = getSupabase();

  const item = await getWorkItem<{
    id: string;
    extracted_data: Record<string, string>;
    matched_patient_id: string | null;
    org_id: string | null;
  }>(workItemId, 'id,extracted_data,matched_patient_id,org_id');

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
    priorAttemptAt,
  };
}

// ---------------------------------------------------------------------------
// Predicate evaluator (verify_requirements) — generic, config-driven
// ---------------------------------------------------------------------------

function evalPred(item: WorkItem, pred: Pred): boolean {
  const value = readCasePath(item, pred.path);
  switch (pred.op) {
    case 'eq':
      return value === pred.value;
    case 'neq':
      return value !== pred.value;
    case 'exists':
      return value !== undefined && value !== null && value !== '';
    case 'absent':
      return value === undefined || value === null || value === '';
    case 'matches':
      return value === undefined || value === null
        ? false
        : new RegExp(String(pred.value), 'i').test(String(value));
    case 'not_matches':
      return value === undefined || value === null
        ? true
        : !new RegExp(String(pred.value), 'i').test(String(value));
    case 'in':
      return Array.isArray(pred.value) && (pred.value as unknown[]).includes(value);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Generic outbound send — shared by send_fax/send_email/send_sms/place_call/
// send_care_everywhere. Idempotent via dedupe_key; state via mergeCaseState.
// ---------------------------------------------------------------------------

async function executeSend(
  toolName: string,
  channel: OutboundChannel,
  workItemId: string,
  params: Record<string, unknown>,
  actor: string,
  ctx?: ToolCtx,
): Promise<ToolResult> {
  const sb = getSupabase();

  const item = await getWorkItem<{ org_id: string | null; agent_state: Record<string, unknown> | null }>(
    workItemId,
    'org_id, agent_state',
  );
  if (!item) return { success: false, error: `Work item not found: ${workItemId}` };

  const orgId = item.org_id ?? null;
  const state = (item.agent_state ?? {}) as Record<string, unknown>;

  const nextAttemptNo = ((state['attempt_no'] as number | undefined) ?? 0) + 1;
  const stateFlag = params['state_flag'] as string | undefined;
  const isCareEverywhere = channel === 'care_everywhere';

  // Attempt + document kind. Fulfillment sends (planner marks them records_sent)
  // deliver the records — render the response document, not another request.
  // Care Everywhere sends are always structured record queries.
  const kind: OutboundAttemptKind & DocumentKind = isCareEverywhere
    ? 'records_request'
    : stateFlag === 'records_sent'
      ? 'records_response'
      : ((state['kind'] as (OutboundAttemptKind & DocumentKind) | undefined) ?? 'records_request');

  // SECOND REQUEST framing — derived from the case's latest timed-out attempt
  // (replicates the old simulate.ts chase loop: attemptNo = global counter,
  // priorAttemptAt = created_at of the last timed-out attempt).
  const { data: lastTimedOut } = await sb
    .from('outbound_attempts')
    .select('created_at')
    .eq('work_item_id', workItemId)
    .eq('status', 'timed_out')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const priorAttemptAt = (lastTimedOut as { created_at: string } | null)?.created_at;

  // channel_attempt = count of prior attempts on the same channel + 1
  const { count: priorOnChannel } = await sb
    .from('outbound_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('work_item_id', workItemId)
    .eq('channel', channel);
  const channelAttempt = (priorOnChannel ?? 0) + 1;

  const contact = await getOrgContact(orgId);
  const outboundCtx = await buildOutboundContext(workItemId, orgId, nextAttemptNo, contact, priorAttemptAt);
  const rendered = renderOutboundDocument(channel as Channel, kind, outboundCtx);
  const payload = { subject: rendered.subject, body: rendered.body, document: rendered.document, kind };

  // respond_after: care_everywhere → now+8s; portal → null (never auto-resolved
  // by tick); else chase_plan.waitSeconds if present, else 20-40s random.
  let respondAfterIso: string | null;
  if (isCareEverywhere) {
    respondAfterIso = new Date(Date.now() + 8000).toISOString();
  } else if (channel === 'portal') {
    respondAfterIso = null;
  } else {
    const chasePlan = state['chase_plan'] as { waitSeconds?: number } | undefined;
    respondAfterIso = respondAfter(chasePlan?.waitSeconds);
  }

  const dedupeKey = ctx?.deliveryId ? `${ctx.deliveryId}:${toolName}:${nextAttemptNo}` : null;

  const { data: inserted, error: insertErr } = await sb
    .from('outbound_attempts')
    .insert({
      work_item_id: workItemId,
      channel,
      kind,
      dedupe_key: dedupeKey,
      attempt_no: nextAttemptNo,
      to_org_id: orgId,
      to_contact: { fax: contact?.fax, email: contact?.email, phone: contact?.phone },
      payload,
      status: 'sent',
      respond_after: respondAfterIso,
    })
    .select('id')
    .single();

  if (insertErr) {
    // At-least-once redelivery hit the dedupe fence → return the existing
    // attempt as success WITHOUT re-writing state (effectively-once).
    if (`${insertErr.code}` === '23505' && dedupeKey) {
      const { data: existing } = await sb
        .from('outbound_attempts')
        .select('id')
        .eq('dedupe_key', dedupeKey)
        .single();
      if (existing) {
        console.log(`[tool.${toolName}]`, JSON.stringify({ workItemId, deduped: true, dedupeKey }));
        return { success: true, data: { attemptId: (existing as { id: string }).id, deduped: true } };
      }
    }
    return { success: false, error: `Failed to create outbound attempt: ${insertErr.message}` };
  }

  const attemptId = (inserted as { id: string }).id;

  // Versioned state write — attempt counter, last channel, optional flag.
  // The planner computes a fresh chase_plan on the first ladder send and passes
  // it as params.chase_plan; persisting it pins the ladder for the case.
  const planFromParams = params.chase_plan as Record<string, unknown> | undefined;
  const merged = await mergeCaseState(workItemId, {
    set: {
      attempt_no: nextAttemptNo,
      last_channel: channel,
      ...(planFromParams ? { chase_plan: planFromParams } : {}),
      ...(stateFlag ? { [stateFlag]: true } : {}),
    },
  });
  if (!merged.ok) {
    console.log(`[tool.${toolName}]`, JSON.stringify({ workItemId, warn: 'state_merge_failed' }));
  }

  // Item → waiting (direct status update is allowed for attempt-creating tools).
  await sb
    .from('work_items')
    .update({ status: 'waiting', updated_at: new Date().toISOString() })
    .eq('id', workItemId);

  await emitEvent({
    type: 'attempt.created',
    caseId: workItemId,
    payload: { attemptId, channel, kind },
    actor,
    causedBy: ctx?.event ?? null,
  });

  console.log(
    `[tool.${toolName}]`,
    JSON.stringify({ workItemId, orgId, channel, attemptNo: nextAttemptNo, channelAttempt, kind }),
  );

  return {
    success: true,
    data: {
      attempt_id: attemptId,
      attemptId,
      channel,
      kind,
      attempt_no: nextAttemptNo,
      channel_attempt: channelAttempt,
    },
  };
}

function makeSendTool(toolName: string, channel: OutboundChannel, description: string): ToolDef {
  return {
    description,
    effect: 'external',
    execute: (workItemId, params, actor, ctx) =>
      executeSend(toolName, channel, workItemId, params, actor, ctx),
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const TOOLS: Record<string, ToolDef> = {
  // ---- classify_document --------------------------------------------------
  classify_document: {
    description: 'Classify the document type from its source text.',
    effect: 'annotate',
    async execute(workItemId, params, actor, ctx) {
      const sb = getSupabase();

      let docType = params['document_type'] as string | undefined;
      let conf = params['confidence'] as number | undefined;

      // No explicit type → classify the source text ourselves, honoring any
      // agent-configured classify_rules on top of the builtin keyword map.
      if (!docType) {
        const item = await getWorkItem<{ source_text: string | null }>(workItemId, 'source_text');
        if (!item) return { success: false, error: `Work item not found: ${workItemId}` };
        const rules = params['classify_rules'] as Array<{ matches: string; type: string }> | undefined;
        const result = classifyHeuristic(item.source_text ?? '', rules);
        docType = result.type;
        conf = conf ?? result.confidence;
      }

      const confidence = conf ?? 0.8;

      // type + confidence are NOT agent_state — direct column write is allowed.
      const { data: current } = await sb
        .from('work_items')
        .select('confidence')
        .eq('id', workItemId)
        .single();
      const existingConf = (current as { confidence: Record<string, number> } | null)?.confidence ?? {};

      const { error } = await sb
        .from('work_items')
        .update({
          type: docType,
          confidence: { ...existingConf, classify: confidence },
          updated_at: new Date().toISOString(),
        })
        .eq('id', workItemId);
      if (error) return { success: false, error: error.message };

      await emitEvent({
        type: 'document.classified',
        caseId: workItemId,
        payload: { as: docType, confidence },
        actor,
        causedBy: ctx?.event ?? null,
      });

      return { success: true, data: { type: docType, confidence } };
    },
  },

  // ---- extract_fields -----------------------------------------------------
  extract_fields: {
    description: 'Extract structured fields from the source document.',
    effect: 'annotate',
    async execute(workItemId, params, actor, ctx) {
      const fields = params['fields'] as Record<string, unknown> | undefined;
      if (!fields) return { success: false, error: 'Missing fields param' };

      const extractionMeta = params['extraction_meta'] as Record<string, unknown> | undefined;

      const merged = await mergeCaseState(workItemId, {
        set: extractionMeta ? { extraction_meta: extractionMeta } : {},
        mergeExtracted: fields,
      });
      if (!merged.ok) return { success: false, error: 'Failed to merge extracted fields' };

      await mergeConfidence(workItemId, 'extract', (params['confidence'] as number | undefined) ?? 0.8);

      await emitEvent({
        type: 'fields.extracted',
        caseId: workItemId,
        payload: { fieldCount: Object.keys(fields).length },
        actor,
        causedBy: ctx?.event ?? null,
      });

      return { success: true, data: { extracted_fields: Object.keys(fields) } };
    },
  },

  // ---- match_patient -------------------------------------------------------
  match_patient: {
    description: 'Match extracted patient data against the MPI.',
    effect: 'annotate',
    async execute(workItemId, params, actor, ctx) {
      const patientId = params['patient_id'] as string | null | undefined;
      const confidence = (params['confidence'] as number | undefined) ?? 0.8;

      const sb = getSupabase();
      const { data: item } = await sb
        .from('work_items')
        .select('confidence')
        .eq('id', workItemId)
        .single();
      const existingConf = (item as { confidence: Record<string, number> } | null)?.confidence ?? {};

      const updates: Record<string, unknown> = {
        confidence: { ...existingConf, match: confidence },
        updated_at: new Date().toISOString(),
      };
      if (patientId) updates['matched_patient_id'] = patientId;

      const { error } = await sb.from('work_items').update(updates).eq('id', workItemId);
      if (error) return { success: false, error: error.message };

      if (patientId) {
        await emitEvent({
          type: 'patient.matched',
          caseId: workItemId,
          payload: { patientId, confidence },
          actor,
          causedBy: ctx?.event ?? null,
        });
      }

      return { success: true, data: { matched_patient_id: patientId ?? null } };
    },
  },

  // ---- verify_requirements ------------------------------------------------
  verify_requirements: {
    description:
      'Evaluate agent-configured requirement predicates (config.requirements) against case state.',
    effect: 'annotate',
    async execute(workItemId, params, _actor) {
      const specs = params['requirements'] as RequirementSpec[] | undefined;
      if (!specs || !Array.isArray(specs) || specs.length === 0) {
        return { success: false, error: 'Missing requirements param (RequirementSpec[])' };
      }

      const item = await getWorkItem<WorkItem>(workItemId, '*');
      if (!item) return { success: false, error: `Work item not found: ${workItemId}` };

      const flags: Record<string, boolean> = {};
      for (const spec of specs) {
        let pass = evalPred(item, { path: spec.path, op: spec.op, value: spec.value });
        if (pass && spec.and && spec.and.length > 0) {
          pass = spec.and.every((p) => evalPred(item, p));
        }
        flags[spec.flag] = pass;
      }

      const allPass = Object.values(flags).every(Boolean);

      const merged = await mergeCaseState(workItemId, { set: { requirements: flags } });
      if (!merged.ok) return { success: false, error: 'Failed to write requirements state' };

      await mergeConfidence(workItemId, 'verify', allPass ? 1.0 : 0.9);

      console.log('[tool.verify_requirements]', JSON.stringify({ workItemId, flags, allPass }));
      return { success: true, data: { requirements: flags, all_pass: allPass } };
    },
  },

  // ---- advance_stage (human/manual — Router places the case) ---------------
  advance_stage: {
    description: 'Move a work item to a different queue (emits case.moved; the Router places it).',
    effect: 'external',
    async execute(workItemId, params, actor, ctx) {
      const queueKey = params['queue_key'] as string | undefined;
      if (!queueKey) return { success: false, error: 'Missing queue_key param' };

      // Optional type correction rides along (type is not agent_state — allowed).
      const type = params['type'] as string | undefined;
      if (type) {
        await getSupabase()
          .from('work_items')
          .update({ type, updated_at: new Date().toISOString() })
          .eq('id', workItemId);
      }

      const event = await emitEvent({
        type: 'case.moved',
        caseId: workItemId,
        payload: { to: queueKey },
        actor,
        causedBy: ctx?.event ?? null,
      });
      if (!event) return { success: false, error: 'Failed to emit case.moved' };

      return { success: true, data: { queue_key: queueKey, eventId: event.id } };
    },
  },

  // ---- send tools -----------------------------------------------------------
  send_fax: makeSendTool('send_fax', 'fax', 'Send a fax outbound and set item to waiting.'),
  send_email: makeSendTool('send_email', 'email', 'Send an email outbound and set item to waiting.'),
  send_sms: makeSendTool('send_sms', 'sms', 'Send an SMS outbound and set item to waiting.'),
  place_call: makeSendTool('place_call', 'voice', 'Place a voice call outbound and set item to waiting.'),
  send_care_everywhere: makeSendTool(
    'send_care_everywhere',
    'care_everywhere',
    'Send a structured Care Everywhere record query (C-CDA) — instant exchange, responds in seconds.',
  ),

  // Alias: some configs/UIs say 'send_voice' — delegates to place_call.
  send_voice: {
    description: 'Place a voice call outbound (alias of place_call).',
    effect: 'external',
    execute: (workItemId, params, actor, ctx) =>
      TOOLS['place_call'].execute(workItemId, params, actor, ctx),
  },

  // ---- request_more_info --------------------------------------------------
  request_more_info: {
    description: 'Send an outbound request for more information to the requesting org.',
    effect: 'external',
    async execute(workItemId, params, actor, ctx) {
      const sb = getSupabase();

      const item = await getWorkItem<{ org_id: string | null; agent_state: Record<string, unknown> | null }>(
        workItemId,
        'org_id, agent_state',
      );
      if (!item) return { success: false, error: `Work item not found: ${workItemId}` };

      const orgId = item.org_id ?? null;
      const state = (item.agent_state ?? {}) as Record<string, unknown>;

      const contact = await getOrgContact(orgId);
      const rawChannel = contact?.preferred_channel ?? 'fax';
      // portal orgs: fall back to fax for more-info since portal is handled differently
      const channel = (rawChannel === 'portal' ? 'fax' : rawChannel) as OutboundChannel;

      const nextAttemptNo = ((state['attempt_no'] as number | undefined) ?? 0) + 1;
      const message =
        (params['message'] as string | undefined) ??
        (params['reason'] as string | undefined) ??
        'Missing patient authorization. Please provide signed authorization form.';

      const outboundCtx = await buildOutboundContext(workItemId, orgId, nextAttemptNo, contact);
      const rendered = renderOutboundDocument(channel as Channel, 'request_more_info', outboundCtx);
      const payload = {
        subject: rendered.subject,
        body: rendered.body,
        document: rendered.document,
        kind: 'request_more_info',
        message,
      };

      const dedupeKey = ctx?.deliveryId ? `${ctx.deliveryId}:request_more_info:${nextAttemptNo}` : null;

      const { data: inserted, error: insertErr } = await sb
        .from('outbound_attempts')
        .insert({
          work_item_id: workItemId,
          channel,
          kind: 'request_more_info',
          dedupe_key: dedupeKey,
          attempt_no: nextAttemptNo,
          to_org_id: orgId,
          to_contact: { fax: contact?.fax, email: contact?.email, phone: contact?.phone },
          payload,
          status: 'sent',
          respond_after: channel === 'portal' ? null : respondAfter(),
        })
        .select('id')
        .single();

      if (insertErr) {
        if (`${insertErr.code}` === '23505' && dedupeKey) {
          const { data: existing } = await sb
            .from('outbound_attempts')
            .select('id')
            .eq('dedupe_key', dedupeKey)
            .single();
          if (existing) {
            console.log('[tool.request_more_info]', JSON.stringify({ workItemId, deduped: true, dedupeKey }));
            return { success: true, data: { attemptId: (existing as { id: string }).id, deduped: true } };
          }
        }
        return { success: false, error: `Failed to create outbound attempt: ${insertErr.message}` };
      }

      const attemptId = (inserted as { id: string }).id;

      // Mark agent_state so we don't re-send (versioned write). more_info_count
      // feeds the planner's on_missing.max_requests escalation.
      const priorCount = Number((state as Record<string, unknown>)['more_info_count'] ?? 0);
      const merged = await mergeCaseState(workItemId, {
        set: { more_info_sent: true, attempt_no: nextAttemptNo, more_info_count: priorCount + 1 },
      });
      if (!merged.ok) {
        console.log('[tool.request_more_info]', JSON.stringify({ workItemId, warn: 'state_merge_failed' }));
      }

      await sb
        .from('work_items')
        .update({ status: 'waiting', updated_at: new Date().toISOString() })
        .eq('id', workItemId);

      await emitEvent({
        type: 'attempt.created',
        caseId: workItemId,
        payload: { attemptId, channel, kind: 'request_more_info' },
        actor,
        causedBy: ctx?.event ?? null,
      });

      console.log('[tool.request_more_info]', JSON.stringify({ workItemId, attemptId, channel }));
      return {
        success: true,
        data: { attempt_id: attemptId, attemptId, channel, kind: 'request_more_info' },
      };
    },
  },

  // ---- mark_complete (human/manual use; agents use report_result) ----------
  mark_complete: {
    description: 'Mark a work item as done.',
    effect: 'external',
    async execute(workItemId, params, actor, ctx) {
      const { error } = await getSupabase()
        .from('work_items')
        .update({
          status: 'done',
          assignee: 'unassigned',
          updated_at: new Date().toISOString(),
        })
        .eq('id', workItemId);
      if (error) return { success: false, error: error.message };

      await emitEvent({
        type: 'case.completed',
        caseId: workItemId,
        payload: { result: (params['note'] as string | undefined) ?? 'completed' },
        actor,
        causedBy: ctx?.event ?? null,
      });

      const note = (params['note'] as string | undefined) ?? 'Completed.';
      return { success: true, data: { note } };
    },
  },

  // ---- escalate_to_human (human/manual use; agents use request_human_review)
  escalate_to_human: {
    description: 'Escalate a work item to a human with a specific question (exception review).',
    effect: 'external',
    async execute(workItemId, params, _actor, ctx) {
      const question = (params['question'] as string | undefined) ?? 'Needs human attention';

      const review = await createReviewRequest(
        { caseId: workItemId, kind: 'exception', question },
        ctx,
      );
      if (!review) return { success: false, error: 'Failed to create review request' };

      // Surface the question on the item; queue placement belongs to the Router.
      await getSupabase()
        .from('work_items')
        .update({ review_reason: question, updated_at: new Date().toISOString() })
        .eq('id', workItemId);

      return { success: true, data: { question, reviewId: review.id } };
    },
  },

  // ---- approve_action (human-only; thin delegate to reviews) ----------------
  approve_action: {
    description: 'Approve the pending supervised-mode agent proposal for this case and execute it.',
    effect: 'external',
    async execute(workItemId, _params, actor) {
      const review = await findPendingReview(workItemId, 'approval');
      if (!review) return { success: false, error: 'No pending review' };
      return answerReview(review.id, { decision: 'approve' }, actor);
    },
  },

  // ---- reject_action (human-only; thin delegate to reviews) -----------------
  reject_action: {
    description: 'Reject the pending supervised-mode agent proposal for this case.',
    effect: 'external',
    async execute(workItemId, _params, actor) {
      const review = await findPendingReview(workItemId, 'approval');
      if (!review) return { success: false, error: 'No pending review' };
      return answerReview(review.id, { decision: 'reject' }, actor);
    },
  },

  // ---- resolve_review (human-only; thin delegate to reviews) ----------------
  resolve_review: {
    description: 'Resolve a pending review: apply corrections and let the Router route onward.',
    effect: 'external',
    async execute(workItemId, params, actor) {
      const review = await findPendingReview(workItemId);
      if (!review) return { success: false, error: 'No pending review' };
      return answerReview(
        review.id,
        {
          decision: 'resolve',
          fields: params['fields'],
          patientId: params['patientId'] ?? params['patient_id'],
          queueKey: params['queueKey'] ?? params['queue_key'],
        },
        actor,
      );
    },
  },
};

// ---------------------------------------------------------------------------
// Public: runTool
// ---------------------------------------------------------------------------

export async function runTool(
  toolName: string,
  workItemId: string,
  params: Record<string, unknown>,
  actor: string,
  ctx?: ToolCtx,
): Promise<ToolResult> {
  const tool = TOOLS[toolName];
  if (!tool) {
    const err = `Unknown tool: ${toolName}`;
    await audit(workItemId, actor, toolName, { error: err, params }, ctx);
    return { success: false, error: err };
  }

  let result: ToolResult;
  try {
    result = await tool.execute(workItemId, params, actor, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = { success: false, error: msg };
  }

  await audit(
    workItemId,
    actor,
    toolName,
    {
      params,
      result,
      confidence: params['confidence'] ?? null,
    },
    ctx,
  );

  return result;
}
