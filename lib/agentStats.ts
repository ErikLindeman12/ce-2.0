/**
 * lib/agentStats.ts — compute per-agent supervision stats from audit_log.
 * Used by GET /api/agents/[id]/stats and GET /api/agents/stats.
 */

import { getSupabase } from './supabase';
import type { AgentStats } from './types';

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

  const { data: rows, error } = await sb
    .from('audit_log')
    .select('action, detail')
    .eq('actor', actor);

  if (error) throw new Error(error.message);

  const entries = (rows ?? []) as Array<{ action: string; detail: Record<string, unknown> }>;

  let actions = 0;
  let escalations = 0;
  let proposals = 0;
  let shadowDecisions = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;

  // Count unique work items touched for "processed"
  const { data: itemRows } = await sb
    .from('audit_log')
    .select('work_item_id')
    .eq('actor', actor);
  const uniqueItems = new Set(
    (itemRows ?? [])
      .map((r: { work_item_id: string | null }) => r.work_item_id)
      .filter(Boolean),
  );
  const processed = uniqueItems.size;

  for (const entry of entries) {
    const conf = (entry.detail['confidence'] as number | undefined) ?? null;
    if (conf !== null && conf > 0) {
      confidenceSum += conf;
      confidenceCount++;
    }

    if (entry.action === 'escalate_to_human') {
      escalations++;
    } else if (entry.action === 'propose_action') {
      proposals++;
    } else if (entry.action === 'shadow_decision') {
      shadowDecisions++;
    } else {
      actions++;
    }
  }

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
