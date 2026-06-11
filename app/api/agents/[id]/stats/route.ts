import { NextResponse } from 'next/server';
import { computeAgentStats } from '@/lib/agentStats';

/**
 * GET /api/agents/[id]/stats
 * Returns supervision stats for a single agent derived from audit_log.
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const { id } = params;
  try {
    const stats = await computeAgentStats(id);
    if (!stats) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }
    return NextResponse.json(stats);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[agents.stats.failed]', msg);
    return NextResponse.json({ error: 'Failed to compute stats' }, { status: 500 });
  }
}
