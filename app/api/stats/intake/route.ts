/**
 * GET /api/stats/intake
 *
 * Returns aggregate intake statistics computed from audit_log + work_items.
 * All-time counts; no date math required.
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

    // Auto-routed: items that were classified AND have an advance_stage audit entry
    const { data: advanceRows } = await sb
      .from('audit_log')
      .select('work_item_id')
      .eq('action', 'advance_stage')
      .in('work_item_id', processed > 0 ? processedIds : ['__none__']);

    const autoRoutedIds = new Set(
      (advanceRows ?? []).map((r) => (r as { work_item_id: string }).work_item_id),
    );
    const autoRouted = autoRoutedIds.size;

    // Escalated: items that have an escalate_to_human audit entry originating from intake
    const { data: escalateRows } = await sb
      .from('audit_log')
      .select('work_item_id')
      .eq('action', 'escalate_to_human')
      .in('work_item_id', processed > 0 ? processedIds : ['__none__']);

    const escalatedIds = new Set(
      (escalateRows ?? []).map((r) => (r as { work_item_id: string }).work_item_id),
    );
    const escalated = escalatedIds.size;

    // Resolved by human: items that have a resolve_review audit entry
    const { data: resolveRows } = await sb
      .from('audit_log')
      .select('work_item_id')
      .eq('action', 'resolve_review')
      .in('work_item_id', processed > 0 ? processedIds : ['__none__']);

    const resolvedByHuman = new Set(
      (resolveRows ?? []).map((r) => (r as { work_item_id: string }).work_item_id),
    ).size;

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
