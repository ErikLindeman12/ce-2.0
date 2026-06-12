/**
 * lib/reviews.ts — human decisions as first-class rows (docs/substrate-spec.md §3).
 *
 * createReviewRequest(input, ctx?) — one pending review per (case, agent);
 *   sets work_items.review_reason (compat surface) + emits `review.requested`.
 * findPendingReview(caseId, kind?) — latest pending review for a case.
 * answerReview(reviewId, answer, actor) —
 *   kind 'approval': approve → state_version + allowlist fences, then execute
 *   the stored proposal VERBATIM; reject → answered + a new 'exception' review.
 *   kind 'question'/'exception' (workbench resolve): merge corrected fields,
 *   explicit patientId wins, re-match on patient-field change, re-route via
 *   events, and re-activate ONLY the requesting agent via a targeted delivery.
 *
 * Circular-import rule: tools.ts statically imports this module, so approved
 * proposals execute via a DYNAMIC import of runTool inside the function body.
 */

import { getSupabase } from './supabase';
import { emitEvent } from './events';
import { mergeCaseState } from './caseState';
import { matchPatientHeuristic } from './llm';
import type {
  Agent,
  ReviewKind,
  ReviewRequest,
  ToolCtx,
  ToolResult,
  WorkItem,
} from './types';

export interface CreateReviewInput {
  caseId: string;
  agentId?: string | null;
  kind: ReviewKind;
  question: string;
  proposal?: ReviewRequest['proposal'];
  candidates?: Record<string, unknown>[];
  options?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// createReviewRequest
// ---------------------------------------------------------------------------

/**
 * Create a pending review for a case. Enforces ONE pending review per
 * (case_id, agent_id) — nullable-safe: if a pending review already exists for
 * the same case + agent, it is returned as-is (no duplicate, no re-emit).
 */
export async function createReviewRequest(
  input: CreateReviewInput,
  ctx?: ToolCtx,
): Promise<ReviewRequest | null> {
  const sb = getSupabase();
  const agentId = input.agentId ?? null;

  // Dedup: one pending review per (case, agent) — agent_id nullable-safe.
  let dupQuery = sb
    .from('review_requests')
    .select('*')
    .eq('case_id', input.caseId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1);
  dupQuery = agentId ? dupQuery.eq('agent_id', agentId) : dupQuery.is('agent_id', null);
  const { data: existing } = await dupQuery;
  if (existing && existing.length > 0) {
    console.log(
      '[reviews.create]',
      JSON.stringify({ caseId: input.caseId, agentId, dedup: true, reviewId: (existing[0] as ReviewRequest).id }),
    );
    return existing[0] as ReviewRequest;
  }

  const { data, error } = await sb
    .from('review_requests')
    .insert({
      case_id: input.caseId,
      agent_id: agentId,
      kind: input.kind,
      question: input.question,
      proposal: input.proposal ?? null,
      candidates: input.candidates ?? null,
      options: input.options ?? null,
      status: 'pending',
    })
    .select('*')
    .single();

  if (error || !data) {
    console.log('[reviews.create_failed]', JSON.stringify({ caseId: input.caseId, error: error?.message }));
    return null;
  }
  const row = data as ReviewRequest;

  // Compat: queue cards + the portal read review_reason off the case.
  // Direct update only — never touch queue_key/assignee/status here.
  await sb
    .from('work_items')
    .update({ review_reason: input.question, updated_at: new Date().toISOString() })
    .eq('id', input.caseId);

  await emitEvent({
    type: 'review.requested',
    caseId: input.caseId,
    payload: { reviewId: row.id, kind: input.kind, agentId },
    actor: agentId ? `agent:${agentId}` : 'system',
    causedBy: ctx?.event ?? null,
    dedupeKey: `review:${row.id}:requested`,
  });

  console.log(
    '[reviews.create]',
    JSON.stringify({ reviewId: row.id, caseId: input.caseId, agentId, kind: input.kind }),
  );
  return row;
}

// ---------------------------------------------------------------------------
// findPendingReview
// ---------------------------------------------------------------------------

/** Latest pending review for a case (optionally filtered by kind). */
export async function findPendingReview(
  caseId: string,
  kind?: ReviewKind,
): Promise<ReviewRequest | null> {
  const sb = getSupabase();
  let query = sb
    .from('review_requests')
    .select('*')
    .eq('case_id', caseId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1);
  if (kind) query = query.eq('kind', kind);
  const { data, error } = await query;
  if (error) {
    console.log('[reviews.find_failed]', JSON.stringify({ caseId, error: error.message }));
    return null;
  }
  return (data && data.length > 0 ? (data[0] as ReviewRequest) : null);
}

// ---------------------------------------------------------------------------
// answerReview
// ---------------------------------------------------------------------------

export async function answerReview(
  reviewId: string,
  answer: Record<string, unknown>,
  actor: string,
): Promise<ToolResult> {
  const sb = getSupabase();

  const { data: reviewData, error: readErr } = await sb
    .from('review_requests')
    .select('*')
    .eq('id', reviewId)
    .single();
  if (readErr || !reviewData) return { success: false, error: 'Review not found' };
  const review = reviewData as ReviewRequest;

  if (review.status !== 'pending') {
    return { success: false, error: 'Review already answered' };
  }

  // Validate before claiming so a bad payload doesn't consume the review.
  const decision = String(answer['decision'] ?? '');
  if (review.kind === 'approval' && decision !== 'approve' && decision !== 'reject') {
    return { success: false, error: 'Invalid decision — expected approve or reject' };
  }

  // Atomic claim (pending → answered) — survives double-submit from two tabs.
  const { data: claimed } = await sb
    .from('review_requests')
    .update({
      status: 'answered',
      answer,
      answered_by: actor,
      answered_at: new Date().toISOString(),
    })
    .eq('id', reviewId)
    .eq('status', 'pending')
    .select('id');
  if (!claimed || claimed.length === 0) {
    return { success: false, error: 'Review already answered' };
  }

  if (review.kind === 'approval') {
    return decision === 'approve'
      ? answerApprove(review, actor)
      : answerReject(review, actor);
  }
  return answerResolve(review, answer, actor);
}

// ---- kind 'approval', decision approve -------------------------------------

async function answerApprove(review: ReviewRequest, actor: string): Promise<ToolResult> {
  const sb = getSupabase();
  const proposal = review.proposal;

  if (!proposal) {
    await setReviewStatus(review.id, 'void');
    await auditAnswer(review, actor, 'void_no_proposal');
    return { success: false, error: 'Review has no proposal' };
  }

  const { data: caseData } = await sb
    .from('work_items')
    .select('*')
    .eq('id', review.case_id)
    .single();
  const item = caseData as WorkItem | null;
  if (!item) {
    await setReviewStatus(review.id, 'void');
    await auditAnswer(review, actor, 'void_missing_case');
    return { success: false, error: 'Case not found' };
  }

  // Fence 1: the case must not have changed since the proposal was made.
  if (proposal.state_version !== item.state_version) {
    await setReviewStatus(review.id, 'void');
    await clearReviewReason(review.case_id);
    await emitEvent({
      type: 'human.decided',
      caseId: review.case_id,
      payload: { reviewId: review.id, decision: 'void_stale' },
      actor,
    });
    // Re-trigger so the agent replans against the new state.
    await emitEvent({
      type: 'review.voided',
      caseId: review.case_id,
      payload: { agentId: review.agent_id },
      actor,
    });
    await auditAnswer(review, actor, 'void_stale');
    console.log(
      '[reviews.answer]',
      JSON.stringify({ reviewId: review.id, decision: 'void_stale', proposalVersion: proposal.state_version, caseVersion: item.state_version }),
    );
    return { success: false, error: 'Case changed since proposal — agent will replan' };
  }

  // Fence 2: the agent must still exist, be enabled, and still allow the tool.
  let agent: Agent | null = null;
  if (review.agent_id) {
    const { data: agentData } = await sb
      .from('agents')
      .select('*')
      .eq('id', review.agent_id)
      .maybeSingle();
    agent = (agentData as Agent | null) ?? null;
  }
  if (!agent || !agent.enabled || !agent.tools.includes(proposal.action)) {
    await setReviewStatus(review.id, 'void');
    await auditAnswer(review, actor, 'void_not_allowed');
    return { success: false, error: 'Proposed tool no longer allowed' };
  }

  // Execute the stored proposal VERBATIM (dynamic import — circular-import rule).
  const { runTool } = await import('./tools');
  const result = await runTool(
    proposal.action,
    review.case_id,
    proposal.params,
    `human(approved:${agent.name})`,
  );

  await clearReviewReason(review.case_id);
  await emitEvent({
    type: 'human.decided',
    caseId: review.case_id,
    payload: { reviewId: review.id, decision: 'approve', action: proposal.action },
    actor,
  });
  await auditAnswer(review, actor, 'approve');

  console.log(
    '[reviews.answer]',
    JSON.stringify({ reviewId: review.id, decision: 'approve', action: proposal.action, success: result.success }),
  );
  return result;
}

// ---- kind 'approval', decision reject ---------------------------------------

async function answerReject(review: ReviewRequest, actor: string): Promise<ToolResult> {
  await emitEvent({
    type: 'human.decided',
    caseId: review.case_id,
    payload: { reviewId: review.id, decision: 'reject' },
    actor,
  });

  // Preserve today's surface: a rejected proposal becomes a manual exception.
  await createReviewRequest({
    caseId: review.case_id,
    agentId: review.agent_id,
    kind: 'exception',
    question: `Proposed ${review.proposal?.action ?? 'action'} rejected — handle manually`,
  });

  await auditAnswer(review, actor, 'reject');
  console.log('[reviews.answer]', JSON.stringify({ reviewId: review.id, decision: 'reject' }));
  return { success: true };
}

// ---- kind 'question' / 'exception' (workbench resolve) ----------------------

const PATIENT_FIELD_KEYS = new Set([
  'patient_first_name',
  'patient_last_name',
  'patient_dob',
  'patient_mrn',
  'patient_name',
]);

async function answerResolve(
  review: ReviewRequest,
  answer: Record<string, unknown>,
  actor: string,
): Promise<ToolResult> {
  const sb = getSupabase();
  const caseId = review.case_id;

  const fields = (answer['fields'] ?? {}) as Record<string, unknown>;
  const patientId = (answer['patientId'] ?? answer['patient_id']) as string | undefined;
  const queueKey = (answer['queueKey'] ?? answer['queue_key']) as string | undefined;
  const newType = answer['type'] as string | undefined;

  const { data: caseData } = await sb.from('work_items').select('*').eq('id', caseId).single();
  const item = caseData as WorkItem | null;
  if (!item) return { success: false, error: 'Case not found' };

  // 1) Merge corrected fields into extracted_data (versioned write).
  const existingExtracted = item.extracted_data ?? {};
  const changedKeys = Object.keys(fields).filter((k) => existingExtracted[k] !== fields[k]);
  if (Object.keys(fields).length > 0) {
    await mergeCaseState(caseId, { mergeExtracted: fields });
  }

  // 2) Patient identity: explicit patientId wins; else re-match when
  //    patient-ish fields changed (single high-confidence hit applies).
  const patientFieldsChanged = changedKeys.some((k) => PATIENT_FIELD_KEYS.has(k));
  if (patientId) {
    await sb
      .from('work_items')
      .update({
        matched_patient_id: patientId,
        confidence: { ...(item.confidence ?? {}), match: 1.0 },
        updated_at: new Date().toISOString(),
      })
      .eq('id', caseId);
  } else if (patientFieldsChanged) {
    const merged = { ...existingExtracted, ...fields } as Record<string, string>;
    const match = await matchPatientHeuristic(merged);
    const updates: Record<string, unknown> = {
      confidence: { ...(item.confidence ?? {}), match: match.confidence },
      updated_at: new Date().toISOString(),
    };
    if (match.patientId) updates['matched_patient_id'] = match.patientId;
    await sb.from('work_items').update(updates).eq('id', caseId);
  }

  // 3) Re-route via events (the Router is the only queue_key writer).
  if (queueKey) {
    await emitEvent({
      type: 'case.moved',
      caseId,
      payload: { to: queueKey },
      actor: 'human',
    });
  } else if (newType) {
    // Persist the human reclassification on the case, then let routing rules
    // place it — replaces the old hardcoded resolve routing map.
    await sb
      .from('work_items')
      .update({
        type: newType,
        confidence: { ...(item.confidence ?? {}), classify: 1.0 },
        updated_at: new Date().toISOString(),
      })
      .eq('id', caseId);
    await emitEvent({
      type: 'document.classified',
      caseId,
      payload: { as: newType, confidence: 1 },
      actor: 'human',
    });
  }

  // 4) Bookkeeping (review already marked answered by the atomic claim).
  await clearReviewReason(caseId);
  const decided = await emitEvent({
    type: 'human.decided',
    caseId,
    payload: { reviewId: review.id, decision: 'resolve' },
    actor,
  });

  // 5) Targeted re-activation: ONLY the requesting agent wakes on this event
  //    (a direct delivery row — do not rely on broad subscriptions).
  if (decided && review.agent_id) {
    const { error: deliveryErr } = await sb.from('event_deliveries').insert({
      event_id: decided.id,
      agent_id: review.agent_id,
      case_id: caseId,
      status: 'pending',
    });
    if (deliveryErr) {
      console.log(
        '[reviews.answer]',
        JSON.stringify({ reviewId: review.id, deliveryInsert: 'failed', error: deliveryErr.message }),
      );
    }
  }

  await auditAnswer(review, actor, 'resolve');
  console.log(
    '[reviews.answer]',
    JSON.stringify({ reviewId: review.id, decision: 'resolve', changedKeys, patientId: patientId ?? null, queueKey: queueKey ?? null, type: newType ?? null }),
  );
  return { success: true, data: {} };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function setReviewStatus(reviewId: string, status: 'answered' | 'void'): Promise<void> {
  await getSupabase().from('review_requests').update({ status }).eq('id', reviewId);
}

/**
 * Sync the compat review_reason surface: null when no pending reviews remain,
 * otherwise the latest pending question (keeps queue cards accurate when a
 * second review is still open on the same case).
 */
async function clearReviewReason(caseId: string): Promise<void> {
  const sb = getSupabase();
  const { data: pending } = await sb
    .from('review_requests')
    .select('question')
    .eq('case_id', caseId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1);
  const next = pending && pending.length > 0 ? (pending[0] as { question: string }).question : null;
  await sb
    .from('work_items')
    .update({ review_reason: next, updated_at: new Date().toISOString() })
    .eq('id', caseId);
}

async function auditAnswer(review: ReviewRequest, actor: string, decision: string): Promise<void> {
  const { error } = await getSupabase().from('audit_log').insert({
    work_item_id: review.case_id,
    actor,
    action: 'answer_review',
    detail: { reviewId: review.id, kind: review.kind, decision },
  });
  if (error) {
    console.log('[reviews.audit_error]', JSON.stringify({ reviewId: review.id, error: error.message }));
  }
}
