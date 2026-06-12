/**
 * lib/router.ts — placement engine (docs/substrate-spec.md §3).
 *
 * routeEvent(event) is the ONLY writer of work_items.queue_key. Placement is
 * pure config: enabled routing_rules matched by (event_type, filter) in
 * priority order — first match wins. One built-in: `case.moved {to}` powers the
 * manual move button. Every placement emits `case.routed`, which is itself
 * never routed or subscribed (cycle guard).
 *
 * The Router NEVER touches status / assignee / agent_state.
 */

import { getSupabase } from './supabase';
import { emitEvent } from './events';
import type { EventRow, RoutingRule } from './types';

/** The case fields filter matching can reference via special keys. */
interface CaseFilterFields {
  type?: string;
  source_channel?: string;
}

/**
 * Shared filter semantics for routing rules AND agent subscriptions:
 * every key must equal event.payload[key], EXCEPT the special keys
 * `case_type` (matches the case's work_items.type) and `source_channel`
 * (matches the case's source_channel). Case-keyed predicates fail when the
 * event has no case. Object values compare by JSON equality.
 */
export function matchesEventFilter(
  filter: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown>,
  caseRow: CaseFilterFields | null,
): boolean {
  for (const [key, expected] of Object.entries(filter ?? {})) {
    let actual: unknown;
    if (key === 'case_type') {
      if (!caseRow) return false;
      actual = caseRow.type;
    } else if (key === 'source_channel') {
      if (!caseRow) return false;
      actual = caseRow.source_channel;
    } else {
      actual = payload[key];
    }
    const equal =
      actual === expected ||
      (typeof actual === 'object' &&
        actual !== null &&
        typeof expected === 'object' &&
        expected !== null &&
        JSON.stringify(actual) === JSON.stringify(expected));
    if (!equal) return false;
  }
  return true;
}

/**
 * Route a single event. Returns the queue key the case was placed in, or null
 * when no rule matched (placement left alone — that is normal, not an error).
 */
export async function routeEvent(event: EventRow): Promise<string | null> {
  // Cycle guard: case.routed is never routed and never subscribed.
  if (event.type === 'case.routed') return null;

  const supabase = getSupabase();
  const payload = event.payload ?? {};

  // -------------------------------------------------------------------------
  // Built-in: manual move (`case.moved {to}`) — no rule required.
  // -------------------------------------------------------------------------
  if (event.type === 'case.moved') {
    const to = payload['to'];
    if (!event.case_id || typeof to !== 'string' || !to) return null;

    await supabase
      .from('work_items')
      .update({ queue_key: to, updated_at: new Date().toISOString() })
      .eq('id', event.case_id);

    await emitEvent({
      type: 'case.routed',
      caseId: event.case_id,
      payload: { queue: to },
      actor: 'router',
      causedBy: event,
      dedupeKey: `route:${event.id}`,
    });

    console.log(
      '[router.route]',
      JSON.stringify({ event: event.type, caseId: event.case_id, queue: to, builtin: true }),
    );
    return to;
  }

  // -------------------------------------------------------------------------
  // Config rules: first enabled match by priority wins.
  // -------------------------------------------------------------------------
  if (!event.case_id) return null;

  const { data: rulesData, error: rulesErr } = await supabase
    .from('routing_rules')
    .select('*')
    .eq('event_type', event.type)
    .eq('enabled', true)
    .order('priority', { ascending: true });

  if (rulesErr) {
    console.log('[router.rules_failed]', JSON.stringify({ event: event.type, error: rulesErr.message }));
    return null;
  }
  const rules = (rulesData ?? []) as RoutingRule[];
  if (rules.length === 0) return null;

  const { data: caseData } = await supabase
    .from('work_items')
    .select('id, type, source_channel, queue_key')
    .eq('id', event.case_id)
    .maybeSingle();
  const caseRow = caseData as
    | { id: string; type: string; source_channel: string; queue_key: string }
    | null;
  if (!caseRow) return null;

  const rule = rules.find((r) => matchesEventFilter(r.filter, payload, caseRow));
  if (!rule) return null;

  if (caseRow.queue_key !== rule.queue_key) {
    await supabase
      .from('work_items')
      .update({ queue_key: rule.queue_key, updated_at: new Date().toISOString() })
      .eq('id', event.case_id);
  }

  // review.requested placements also stamp the review row so kind='review'
  // queues can join cases on review_requests.queue_key.
  if (event.type === 'review.requested') {
    const reviewId = payload['reviewId'];
    if (typeof reviewId === 'string' && reviewId) {
      await supabase.from('review_requests').update({ queue_key: rule.queue_key }).eq('id', reviewId);
    }
  }

  await emitEvent({
    type: 'case.routed',
    caseId: event.case_id,
    payload: { queue: rule.queue_key, rule_id: rule.id },
    actor: 'router',
    causedBy: event,
    dedupeKey: `route:${event.id}`,
  });

  console.log(
    '[router.route]',
    JSON.stringify({ event: event.type, caseId: event.case_id, queue: rule.queue_key, ruleId: rule.id }),
  );
  return rule.queue_key;
}
