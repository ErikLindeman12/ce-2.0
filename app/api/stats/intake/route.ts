/**
 * GET /api/stats/intake
 *
 * Returns aggregate intake statistics computed from audit_log + events +
 * review_requests + work_items. All-time counts; no date math required.
 *
 * Substrate re-derivations (agents no longer call advance_stage):
 * - autoRouted = distinct cases with a `case.routed` event whose
 *   `document.classified` came from an agent actor.
 * - escalated = review_requests created; resolvedByHuman = reviews answered.
 *
 * Response shape (pinned):
 * {
 *   data: {
 *     processed: number,
 *     autoRouted: number,
 *     escalated: number,
 *     resolvedByHuman: number,
 *     avgClassify: number,
 *     avgExtract: number,
 *     avgMatch: number,
 *     byChannel: { fax: number, direct_message: number, phone: number, portal: number }
 *   }
 * }
 */

import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export async function GET() {
  try {
    const sb = getSupabase();

    // All work items that were ever in the intake pipeline (have a classify audit entry)
    // We use audit_log to find items that went through classify_document
    const { data: classifyRows, error: classifyErr } = await sb
      .from('audit_log')
      .select('work_item_id')
      .eq('action', 'classify_document');

    if (classifyErr) throw new Error(classifyErr.message);

    const processedIds = [
      ...new Set(
        (classifyRows ?? []).map((r) => (r as { work_item_id: string }).work_item_id),
      ),
    ].filter(Boolean) as string[];

    const processed = processedIds.length;

    // Auto-routed: distinct cases the Router placed (`case.routed`) whose
    // classification came from an agent (`document.classified` actor agent:*).
    // Two cheap queries over events — agents no longer call advance_stage.
    const { data: agentClassifiedRows } = await sb
      .from('events')
      .select('case_id')
      .eq('type', 'document.classified')
      .like('actor', 'agent:%');

    const agentClassifiedIds = new Set(
      (agentClassifiedRows ?? [])
        .map((r) => (r as { case_id: string | null }).case_id)
        .filter(Boolean) as string[],
    );

    let autoRouted = 0;
    if (agentClassifiedIds.size > 0) {
      const { data: routedRows } = await sb
        .from('events')
        .select('case_id')
        .eq('type', 'case.routed');

      const autoRoutedIds = new Set(
        (routedRows ?? [])
          .map((r) => (r as { case_id: string | null }).case_id)
          .filter((id): id is string => Boolean(id) && agentClassifiedIds.has(id as string)),
      );
      autoRouted = autoRoutedIds.size;
    }

    // Escalated: review requests created (the substrate's escalation surface).
    const { count: escalatedCount } = await sb
      .from('review_requests')
      .select('id', { count: 'exact', head: true });
    const escalated = escalatedCount ?? 0;

    // Resolved by human: review requests answered.
    const { count: resolvedCount } = await sb
      .from('review_requests')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'answered');
    const resolvedByHuman = resolvedCount ?? 0;

    // Average confidence scores across all intake-processed items
    let avgClassify = 0;
    let avgExtract = 0;
    let avgMatch = 0;

    if (processed > 0) {
      const { data: confRows } = await sb
        .from('work_items')
        .select('confidence')
        .in('id', processedIds);

      const classifyScores: number[] = [];
      const extractScores: number[] = [];
      const matchScores: number[] = [];

      for (const row of confRows ?? []) {
        const conf = (row as { confidence: Record<string, number> }).confidence ?? {};
        if (typeof conf['classify'] === 'number') classifyScores.push(conf['classify']);
        if (typeof conf['extract'] === 'number') extractScores.push(conf['extract']);
        if (typeof conf['match'] === 'number') matchScores.push(conf['match']);
      }

      const avg = (arr: number[]) =>
        arr.length > 0
          ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 100) / 100
          : 0;

      avgClassify = avg(classifyScores);
      avgExtract = avg(extractScores);
      avgMatch = avg(matchScores);
    }

    // By-channel counts from processed items
    const byChannel: Record<string, number> = {
      fax: 0,
      direct_message: 0,
      phone: 0,
      portal: 0,
    };

    if (processed > 0) {
      const { data: channelRows } = await sb
        .from('work_items')
        .select('source_channel')
        .in('id', processedIds);

      for (const row of channelRows ?? []) {
        const ch = (row as { source_channel: string }).source_channel;
        if (ch in byChannel) {
          byChannel[ch] = (byChannel[ch] ?? 0) + 1;
        }
      }
    }

    return NextResponse.json({
      data: {
        processed,
        autoRouted,
        escalated,
        resolvedByHuman,
        avgClassify,
        avgExtract,
        avgMatch,
        byChannel: {
          fax: byChannel['fax'] ?? 0,
          direct_message: byChannel['direct_message'] ?? 0,
          phone: byChannel['phone'] ?? 0,
          portal: byChannel['portal'] ?? 0,
        },
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[stats.intake.error]', msg);
    return NextResponse.json({ error: 'Failed to compute intake stats' }, { status: 500 });
  }
}
