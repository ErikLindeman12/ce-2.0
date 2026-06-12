/**
 * lib/agentRunner.ts — event-driven agent turns (docs/substrate-spec.md §3).
 *
 * runDeliveryTurn(delivery, event, agent) — called by the dispatcher for each
 * claimed delivery. Applies the matching subscription's on_event effects, then
 * loops reason() → mode/confidence gates → tool execution (max 4 steps).
 *
 * The dispatcher owns claims/releases: this module never touches assignee or
 * claimed_at — the only status write is 'done' via the report_result verb
 * (tools may independently set 'waiting').
 *
 * Mode gates sit at the boundary, shadow FIRST: a shadow agent executes
 * NOTHING (no tools, no state writes, no reviews) — it only audits what it
 * would have done. The old poll loop (runAgents/fetchEligibleItems) is gone.
 */

import { randomUUID } from 'crypto';
import { getSupabase } from './supabase';
import { reason } from './llm';
import { runTool, TOOLS } from './tools';
import { emitEvent } from './events';
import { mergeCaseState, readPayloadPath } from './caseState';
import { createReviewRequest } from './reviews';
import type {
  Agent,
  AgentSubscription,
  EventDelivery,
  EventRow,
  OnEventEffects,
  PumpReport,
  ToolCtx,
  WorkItem,
} from './types';

const MAX_STEPS_PER_TURN = 4;

export type TurnOutcome = 'completed' | 'review' | 'shadowed' | 'wait' | 'error';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchCase(caseId: string): Promise<WorkItem | null> {
  const { data, error } = await getSupabase()
    .from('work_items')
    .select('*')
    .eq('id', caseId)
    .single();
  if (error || !data) return null;
  return data as unknown as WorkItem;
}

/**
 * Same filter semantics as the dispatcher: equality match against
 * event.payload.* plus special keys `case_type` (case.type) and
 * `source_channel` (case.source_channel).
 */
function subscriptionMatches(sub: AgentSubscription, event: EventRow, item: WorkItem): boolean {
  if (sub.event_type !== event.type) return false;
  for (const [key, expected] of Object.entries(sub.filter ?? {})) {
    let actual: unknown;
    if (key === 'case_type') actual = item.type;
    else if (key === 'source_channel') actual = item.source_channel;
    else actual = readPayloadPath(event.payload, key);
    if (actual !== expected) return false;
  }
  return true;
}

/**
 * Apply on_event effects in ONE mergeCaseState call:
 * - merge_payload: from 'payload.x.y' → 'extracted.z' (mergeExtracted) or 'state.z' (set)
 * - set_state: string values starting with '$payload.' interpolate from the payload
 * - clear_state: removed keys
 */
async function applyOnEventEffects(
  caseId: string,
  effects: OnEventEffects,
  event: EventRow,
): Promise<boolean> {
  const set: Record<string, unknown> = {};
  const mergeExtracted: Record<string, unknown> = {};
  const clear = [...(effects.clear_state ?? [])];

  for (const { from, to } of effects.merge_payload ?? []) {
    const value = readPayloadPath(event.payload, from);
    if (value === undefined) continue;
    if (to.startsWith('extracted.')) mergeExtracted[to.slice('extracted.'.length)] = value;
    else if (to.startsWith('state.')) set[to.slice('state.'.length)] = value;
    else set[to] = value;
  }

  for (const [key, raw] of Object.entries(effects.set_state ?? {})) {
    set[key] =
      typeof raw === 'string' && raw.startsWith('$payload.')
        ? readPayloadPath(event.payload, raw.slice('$payload.'.length))
        : raw;
  }

  if (Object.keys(set).length === 0 && Object.keys(mergeExtracted).length === 0 && clear.length === 0) {
    return false;
  }

  const res = await mergeCaseState(caseId, { set, clear, mergeExtracted });
  console.log(
    '[runner.on_event]',
    JSON.stringify({ caseId, eventType: event.type, ok: res.ok, version: res.version }),
  );
  return true;
}

async function auditTurn(
  workItemId: string,
  actor: string,
  action: string,
  detail: Record<string, unknown>,
  turnId: string,
  deliveryId: string,
): Promise<void> {
  const { error } = await getSupabase().from('audit_log').insert({
    work_item_id: workItemId,
    actor,
    action,
    detail,
    turn_id: turnId,
    delivery_id: deliveryId,
  });
  if (error) {
    console.log('[runner.audit_error]', JSON.stringify({ action, error: error.message }));
  }
}

// ---------------------------------------------------------------------------
// runDeliveryTurn
// ---------------------------------------------------------------------------

export async function runDeliveryTurn(
  delivery: EventDelivery,
  event: EventRow,
  agent: Agent,
): Promise<{ actions: PumpReport['actions']; outcome: TurnOutcome }> {
  const actions: PumpReport['actions'] = [];
  const actor = `agent:${agent.id}`;

  // Null-case turns are not yet supported.
  if (!delivery.case_id) {
    console.log('[runner.turn]', JSON.stringify({ deliveryId: delivery.id, skip: 'null_case' }));
    return { actions, outcome: 'wait' };
  }
  const caseId = delivery.case_id;
  const turnId = randomUUID();
  const ctx: ToolCtx = { turnId, deliveryId: delivery.id, event, agent };

  try {
    let item = await fetchCase(caseId);
    if (!item) {
      console.log('[runner.turn]', JSON.stringify({ deliveryId: delivery.id, error: 'case_not_found', caseId }));
      return { actions, outcome: 'error' };
    }
    if (item.status === 'done') return { actions, outcome: 'wait' };

    // Apply the matching subscription's on_event effects FIRST (first match wins).
    const sub = (agent.subscriptions ?? []).find((s) => subscriptionMatches(s, event, item as WorkItem));
    if (sub?.on_event) {
      const applied = await applyOnEventEffects(caseId, sub.on_event, event);
      if (applied) {
        const fresh = await fetchCase(caseId);
        if (fresh) item = fresh;
      }
    }

    const stepHistory: string[] = [];

    for (let step = 0; step < MAX_STEPS_PER_TURN; step++) {
      const decision = await reason({ workItem: item, agent, stepHistory, event });

      console.log(
        '[runner.turn]',
        JSON.stringify({
          agentId: agent.id,
          agentName: agent.name,
          caseId,
          turnId,
          step,
          action: decision.action,
          confidence: decision.confidence,
          rationale: decision.rationale,
        }),
      );

      // ----- a. SHADOW mode (checked FIRST — executes NOTHING) ---------------
      if (agent.mode === 'shadow') {
        await auditTurn(
          caseId,
          actor,
          'shadow_decision',
          {
            action: decision.action,
            params: decision.params,
            confidence: decision.confidence,
            rationale: decision.rationale,
            wouldEscalate: decision.confidence < agent.confidence_threshold,
          },
          turnId,
          delivery.id,
        );
        return {
          actions: [
            { itemId: caseId, action: `shadow:${decision.action}`, confidence: decision.confidence, actor },
          ],
          outcome: 'shadowed',
        };
      }

      // ----- b. Confidence gate (supervised/autonomous) -----------------------
      if (decision.confidence < agent.confidence_threshold) {
        const question =
          decision.question ??
          `Low confidence on ${decision.action} (${decision.confidence.toFixed(2)}) — review needed`;
        await createReviewRequest(
          {
            caseId,
            agentId: agent.id,
            kind: 'question',
            question,
            candidates: decision.params['candidates'] as Record<string, unknown>[] | undefined,
          },
          ctx,
        );
        actions.push({ itemId: caseId, action: 'request_human_review', confidence: decision.confidence, actor });
        return { actions, outcome: 'review' };
      }

      // ----- c. Completion verbs ----------------------------------------------
      if (decision.action === 'wait') {
        return { actions, outcome: 'wait' };
      }

      if (decision.action === 'report_result') {
        // report_result is bookkeeping, not external — supervised executes it
        // like autonomous (matches the old SUPERVISED_PASSTHROUGH incl. mark_complete).
        const result = decision.params['result'];
        const note = decision.params['note'];
        await getSupabase()
          .from('work_items')
          .update({ status: 'done', updated_at: new Date().toISOString() })
          .eq('id', caseId);
        await emitEvent({
          type: 'case.completed',
          caseId,
          payload: { result, note },
          actor,
          causedBy: event,
        });
        await auditTurn(caseId, actor, 'report_result', { result, note }, turnId, delivery.id);
        actions.push({ itemId: caseId, action: 'report_result', confidence: decision.confidence, actor });
        return { actions, outcome: 'completed' };
      }

      if (decision.action === 'request_human_review') {
        const question =
          decision.question ?? String(decision.params['question'] ?? 'Review needed');
        await createReviewRequest(
          {
            caseId,
            agentId: agent.id,
            kind: 'question',
            question,
            candidates: decision.params['candidates'] as Record<string, unknown>[] | undefined,
          },
          ctx,
        );
        actions.push({ itemId: caseId, action: 'request_human_review', confidence: decision.confidence, actor });
        return { actions, outcome: 'review' };
      }

      if (decision.action === 'emit_event') {
        const type = String(decision.params['type'] ?? '');
        if (!type) {
          await auditTurn(caseId, actor, 'emit_event', { error: 'missing type' }, turnId, delivery.id);
          return { actions, outcome: 'wait' };
        }
        const payload = (decision.params['payload'] as Record<string, unknown> | undefined) ?? {};
        await emitEvent({ type, caseId, payload, actor, causedBy: event });
        await auditTurn(caseId, actor, 'emit_event', { type, payload }, turnId, delivery.id);
        actions.push({ itemId: caseId, action: 'emit_event', confidence: decision.confidence, actor });
        stepHistory.push(`emit_event: ${type}`);
        continue; // counts as a step
      }

      // ----- d. Tool allowlist -------------------------------------------------
      if (!agent.tools.includes(decision.action)) {
        await auditTurn(caseId, actor, 'tool_not_allowed', { action: decision.action }, turnId, delivery.id);
        console.log('[runner.tool_not_allowed]', JSON.stringify({ agentName: agent.name, tool: decision.action }));
        return { actions, outcome: 'wait' };
      }

      // ----- e. SUPERVISED + external effect → propose for approval ------------
      const effect = TOOLS[decision.action]?.effect ?? 'external';
      if (agent.mode === 'supervised' && effect === 'external') {
        await createReviewRequest(
          {
            caseId,
            agentId: agent.id,
            kind: 'approval',
            question: `Agent proposes: ${decision.action} (confidence ${decision.confidence.toFixed(2)}) — approve?`,
            proposal: {
              action: decision.action,
              params: decision.params,
              confidence: decision.confidence,
              rationale: decision.rationale,
              state_version: item.state_version,
            },
          },
          ctx,
        );
        // Keep the 'propose_action' audit name — stats depend on it.
        await auditTurn(
          caseId,
          actor,
          'propose_action',
          {
            action: decision.action,
            params: decision.params,
            confidence: decision.confidence,
            rationale: decision.rationale,
          },
          turnId,
          delivery.id,
        );
        actions.push({ itemId: caseId, action: 'propose_action', confidence: decision.confidence, actor });
        return { actions, outcome: 'review' };
      }

      // ----- f. Execute ----------------------------------------------------------
      const result = await runTool(
        decision.action,
        caseId,
        { ...decision.params, confidence: decision.confidence },
        actor,
        ctx,
      );
      actions.push({ itemId: caseId, action: decision.action, confidence: decision.confidence, actor });
      stepHistory.push(`${decision.action}: ${result.success ? 'ok' : result.error}`);

      if (!result.success) {
        console.log('[runner.tool_error]', JSON.stringify({ action: decision.action, error: result.error }));
        return { actions, outcome: 'wait' };
      }

      const fresh = await fetchCase(caseId);
      if (!fresh) return { actions, outcome: 'error' };
      item = fresh;
      if (item.status === 'done') return { actions, outcome: 'completed' };
    }

    return { actions, outcome: 'wait' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('[runner.turn_error]', JSON.stringify({ deliveryId: delivery.id, caseId, error: msg }));
    return { actions, outcome: 'error' };
  }
}
