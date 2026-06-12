/**
 * lib/agentStats.ts — compute per-agent supervision stats.
 * Used by GET /api/agents/[id]/stats and GET /api/agents/stats.
 *
 * Re-keyed for the event substrate (docs/substrate-spec.md):
 * - escalations / proposals come from review_requests (the agent's actual asks
 *   for human input — more reliable than audit action names now).
 * - actions = audit rows for tool executions (audit_log action = tool name);
 *   turn bookkeeping rows (shadow_decision / propose_action / report_result /
 *   answer_review) are excluded.
 * - AgentStats shape is IDENTICAL to before.
 */

import { getSupabase } from './supabase';
import type { AgentStats, ReviewKind } from './types';

/** Audit actions that are turn bookkeeping, not tool executions. */
const NON_ACTION_AUDITS = new Set([
  'shadow_decision',
  'propose_action',
  'report_result',
  'answer_review',
]);

export async function computeAgentStats(agentId: string): Promise<AgentStats | null> {
  const sb = getSupabase();

  // Verify agent exists
  const { data: agentRow } = await sb
    .from('agents')
    .select('id')
    .eq('id', agentId)
    .single();
  if (!agentRow) return null;

  const actor = `agent:${agentId}`;

  const [auditRes, reviewRes] = await Promise.all([
    sb.from('audit_log').select('work_item_id, action, detail').eq('actor', actor),
    sb.from('review_requests').select('kind').eq('agent_id', agentId),
  ]);

  if (auditRes.error) throw new Error(auditRes.error.message);
  if (reviewRes.error) throw new Error(reviewRes.error.message);

  const entries = (auditRes.data ?? []) as Array<{
    work_item_id: string | null;
    action: string;
    detail: Record<string, unknown>;
  }>;
  const reviews = (reviewRes.data ?? []) as Array<{ kind: ReviewKind }>;

  // Reviews created by the agent: questions/exceptions are escalations,
  // approvals are proposals.
  const escalations = reviews.filter((r) => r.kind === 'question' || r.kind === 'exception').length;
  const proposals = reviews.filter((r) => r.kind === 'approval').length;

  let actions = 0;
  let shadowDecisions = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;
  const uniqueItems = new Set<string>();

  for (const entry of entries) {
    if (entry.work_item_id) uniqueItems.add(entry.work_item_id);

    const conf = (entry.detail?.['confidence'] as number | undefined) ?? null;
    if (conf !== null && conf > 0) {
      confidenceSum += conf;
      confidenceCount++;
    }

    if (entry.action === 'shadow_decision') {
      shadowDecisions++;
    } else if (!NON_ACTION_AUDITS.has(entry.action)) {
      actions++;
    }
  }

  const processed = uniqueItems.size;
  const avgConfidence = confidenceCount > 0 ? confidenceSum / confidenceCount : 0;
  const autoRate = actions + escalations > 0 ? actions / (actions + escalations) : 1;

  return {
    agentId,
    processed,
    actions,
    escalations,
    proposals,
    shadowDecisions,
    avgConfidence,
    autoRate,
  };
}
