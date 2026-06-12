import { getSupabase } from './supabase';
import type { EventRow } from './types';

export interface EmitEventInput {
  type: string;
  caseId?: string | null;
  payload?: Record<string, unknown>;
  actor?: string;
  causedBy?: EventRow | { id: string; depth: number } | null;
  afterSeconds?: number;
  dedupeKey?: string;
}

/**
 * Append an event to the log. The single emission point for the whole platform.
 *
 * - `dedupeKey` conflict is NOT an error: the existing event is returned and no
 *   duplicate is written (this is what makes at-least-once processing safe).
 * - `afterSeconds` turns the event into a durable timer (deliver_at in the future).
 * - `causedBy` threads the causal chain; depth is parent+1 (the dispatcher refuses
 *   delivery beyond depth 16 — the loop breaker).
 * - The event type is auto-registered in event_types so it shows up in builder
 *   dropdowns. Adding a new trigger point to the platform = emitting it once.
 */
export async function emitEvent(input: EmitEventInput): Promise<EventRow | null> {
  const supabase = getSupabase();
  const depth = input.causedBy ? (input.causedBy.depth ?? 0) + 1 : 0;

  const row = {
    type: input.type,
    case_id: input.caseId ?? null,
    payload: input.payload ?? {},
    actor: input.actor ?? 'system',
    caused_by_event_id: input.causedBy?.id ?? null,
    depth,
    deliver_at: input.afterSeconds
      ? new Date(Date.now() + input.afterSeconds * 1000).toISOString()
      : null,
    dedupe_key: input.dedupeKey ?? null,
  };

  const { data, error } = await supabase.from('events').insert(row).select().single();

  if (error) {
    // Unique violation on dedupe_key → the event already exists; return it.
    if (input.dedupeKey && `${error.code}` === '23505') {
      const { data: existing } = await supabase
        .from('events')
        .select('*')
        .eq('dedupe_key', input.dedupeKey)
        .single();
      return (existing as EventRow) ?? null;
    }
    console.log(`[event.emit_failed] type=${input.type} error=${error.message}`);
    return null;
  }

  registerEventType(input.type).catch(() => {});
  console.log(`[event.emitted] type=${input.type} case=${input.caseId ?? '-'} depth=${depth}`);
  return data as EventRow;
}

const knownTypes = new Set<string>();

async function registerEventType(type: string): Promise<void> {
  if (knownTypes.has(type)) return;
  knownTypes.add(type);
  const supabase = getSupabase();
  await supabase.from('event_types').upsert({ type }, { onConflict: 'type', ignoreDuplicates: true });
}

/** Recent events for a case (item-detail timeline) or globally (activity feed). */
export async function listEvents(opts: { caseId?: string; limit?: number } = {}): Promise<EventRow[]> {
  const supabase = getSupabase();
  let query = supabase
    .from('events')
    .select('*')
    .order('seq', { ascending: false })
    .limit(opts.limit ?? 50);
  if (opts.caseId) query = query.eq('case_id', opts.caseId);
  const { data, error } = await query;
  if (error) {
    console.log(`[event.list_failed] ${error.message}`);
    return [];
  }
  return (data ?? []) as EventRow[];
}

/** Most recent event of a type — used by the builder's "fire sample event" replay. */
export async function latestEventOfType(type: string): Promise<EventRow | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('events')
    .select('*')
    .eq('type', type)
    .order('seq', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as EventRow) ?? null;
}
