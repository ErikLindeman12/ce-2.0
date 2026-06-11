import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { computeAgentStats } from '@/lib/agentStats';
import type { AgentStats } from '@/lib/types';

/**
 * GET /api/agents/stats
 * Returns supervision stats array (one entry per agent) plus aggregate totals.
 * Shape: { data: AgentStats[], totals: AgentStats }
 *
 * NOTE: This file must live at app/api/agents/stats/route.ts, NOT under [id]/,
 * so the App Router resolves /api/agents/stats before the [id] dynamic segment.
 */
export async function GET() {
  try {
    const sb = getSupabase();
    const { data: agentsData, error } = await sb
      .from('agents')
      .select('id')
      .eq('enabled', true);

    if (error) throw new Error(error.message);

    const agentIds = (agentsData ?? []).map((a: { id: string }) => a.id);
    const statsArr: AgentStats[] = (
      await Promise.all(agentIds.map((id: string) => computeAgentStats(id)))
    ).filter((s): s is AgentStats => s !== null);

    const totalActions = statsArr.reduce((s, a) => s + a.actions, 0);
    const totalEscalations = statsArr.reduce((s, a) => s + a.escalations, 0);
    const totals: AgentStats = {
      agentId: 'all',
      processed: statsArr.reduce((s, a) => s + a.processed, 0),
      actions: totalActions,
      escalations: totalEscalations,
      proposals: statsArr.reduce((s, a) => s + a.proposals, 0),
      shadowDecisions: statsArr.reduce((s, a) => s + a.shadowDecisions, 0),
      avgConfidence:
        statsArr.length > 0
          ? statsArr.reduce((s, a) => s + a.avgConfidence, 0) / statsArr.length
          : 0,
      autoRate:
        totalActions + totalEscalations > 0
          ? totalActions / (totalActions + totalEscalations)
          : 1,
    };

    return NextResponse.json({ data: statsArr, totals });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[agents.stats.all.failed]', msg);
    return NextResponse.json({ error: 'Failed to compute stats' }, { status: 500 });
  }
}
