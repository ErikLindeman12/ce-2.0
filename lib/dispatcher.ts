/**
 * lib/dispatcher.ts — the event pump (docs/substrate-spec.md §3).
 *
 * pumpEvents() drives the substrate end-to-end:
 *   0. lease sweep — release stale agent claims (cases + deliveries)
 *   1. deliver due events: optimistic delivered_at stamp → Router placement →
 *      fan out event_deliveries to enabled agents with matching subscriptions
 *   2. run pending deliveries FIFO per case as agent turns (runDeliveryTurn)
 *
 * Loops rounds until quiescent, maxRounds, or deadline. Called by tick() AND
 * inline by API routes that emit events.
 *
 * Invariants enforced here (spec §4): at-least-once delivery, one in-flight
 * turn per case (assignee claim + claimed_at lease), claim failure never
 * consumes an event, done-case guard, depth>16 / rate-cap → exception review.
 */

import { getSupabase } from './supabase';
import { matchesEventFilter, routeEvent } from './router';
import { runDeliveryTurn } from './agentRunner';
import { createReviewRequest, findPendingReview } from './reviews';
import type { Agent, EventDelivery, EventRow, PumpReport } from './types';

const LEASE_MS = 60_000;
const MAX_EVENT_DEPTH = 16;
const RATE_CAP_TURNS_PER_MINUTE = 10;
const MAX_EVENTS_PER_ROUND = 50;
const MAX_DELIVERIES_PER_ROUND = 25;

type PendingDelivery = EventDelivery & { event: EventRow | null };

/** Case fields needed for subscription matching + the done-case guard. */
interface CaseMatchRow {
  id: string;
  type: string;
  source_channel: string;
  status: string;
}

export async function pumpEvents(
  opts: { maxRounds?: number; deadlineMs?: number } = {},
): Promise<PumpReport> {
  const maxRounds = opts.maxRounds ?? 3;
  const deadlineMs = opts.deadlineMs ?? 8000;
  const deadlineAt = Date.now() + deadlineMs;

  const report: PumpReport = {
    delivered: 0,
    routed: 0,
    turns: 0,
    shadowed: 0,
    reviews: 0,
    actions: [],
    errors: [],
  };

  await sweepStaleLeases();

  // Enabled agents are cached per pump — subscription fan-out reads this list.
  const supabase = getSupabase();
  const { data: agentsData, error: agentsErr } = await supabase
    .from('agents')
    .select('*')
    .eq('enabled', true);
  if (agentsErr) {
    report.errors.push(`agents load failed: ${agentsErr.message}`);
    return report;
  }
  const agents = (agentsData ?? []) as Agent[];

  for (let round = 0; round < maxRounds; round++) {
    if (Date.now() > deadlineAt) break;
    const delivered = await deliverDueEvents(agents, report, deadlineAt);
    const ran = await runPendingDeliveries(report, deadlineAt);
    if (delivered === 0 && ran === 0) break;
  }

  console.log(
    '[dispatcher.pump]',
    JSON.stringify({
      delivered: report.delivered,
      routed: report.routed,
      turns: report.turns,
      shadowed: report.shadowed,
      reviews: report.reviews,
      actions: report.actions.length,
      errors: report.errors,
    }),
  );
  return report;
}

// ---------------------------------------------------------------------------
// Phase 0 — lease sweep (once per pump)
// ---------------------------------------------------------------------------

async function sweepStaleLeases(): Promise<void> {
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - LEASE_MS).toISOString();

  // Only stale AGENT claims are swept — never 'human'.
  const { data: sweptCases } = await supabase
    .from('work_items')
    .update({
      status: 'open',
      assignee: 'unassigned',
      claimed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('status', 'in_progress')
    .like('assignee', 'agent:%')
    .lt('claimed_at', cutoff)
    .select('id');

  const { data: sweptDeliveries } = await supabase
    .from('event_deliveries')
    .update({ status: 'pending' })
    .eq('status', 'running')
    .lt('claimed_at', cutoff)
    .select('id');

  const cases = sweptCases?.length ?? 0;
  const deliveries = sweptDeliveries?.length ?? 0;
  if (cases > 0 || deliveries > 0) {
    console.log('[dispatcher.sweep]', JSON.stringify({ cases, deliveries }));
  }
}

// ---------------------------------------------------------------------------
// Phase a — deliver due events (route + subscription fan-out)
// ---------------------------------------------------------------------------

async function deliverDueEvents(
  agents: Agent[],
  report: PumpReport,
  deadlineAt: number,
): Promise<number> {
  const supabase = getSupabase();
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from('events')
    .select('*')
    .is('delivered_at', null)
    .or(`deliver_at.is.null,deliver_at.lte.${nowIso}`)
    .order('seq', { ascending: true })
    .limit(MAX_EVENTS_PER_ROUND);

  if (error) {
    report.errors.push(`events load failed: ${error.message}`);
    return 0;
  }

  let delivered = 0;
  for (const event of (data ?? []) as EventRow[]) {
    if (Date.now() > deadlineAt) break;

    // Optimistic stamp — exactly one pump delivers each event.
    const { data: stamped } = await supabase
      .from('events')
      .update({ delivered_at: new Date().toISOString() })
      .eq('id', event.id)
      .is('delivered_at', null)
      .select('id');
    if (!stamped || stamped.length === 0) continue;

    delivered++;
    report.delivered++;

    // Router placement (the only queue_key writer).
    try {
      const queue = await routeEvent(event);
      if (queue) report.routed++;
    } catch (err) {
      report.errors.push(
        `route failed event=${event.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Subscription fan-out. Case fields fetched once per event; null-case
    // events are allowed — case-keyed filter predicates simply fail to match.
    let caseRow: CaseMatchRow | null = null;
    if (event.case_id) {
      const { data: c } = await supabase
        .from('work_items')
        .select('id, type, source_channel, status')
        .eq('id', event.case_id)
        .maybeSingle();
      caseRow = (c as CaseMatchRow | null) ?? null;
    }

    // Done-case guard: subscriptions only match cases with status open|waiting|in_progress.
    if (caseRow && caseRow.status === 'done') continue;

    const matched = agents.filter((agent) =>
      (agent.subscriptions ?? []).some(
        (sub) =>
          sub.event_type === event.type &&
          matchesEventFilter(sub.filter, event.payload ?? {}, caseRow),
      ),
    );
    if (matched.length === 0) continue;

    // Loop breaker: refuse delivery beyond depth 16 — exception review instead.
    if (event.depth > MAX_EVENT_DEPTH) {
      if (event.case_id) {
        const review = await createExceptionReviewOnce(
          event.case_id,
          'Possible event loop detected (depth >16) — investigate.',
        );
        if (review) report.reviews++;
      }
      console.log(
        '[dispatcher.depth_guard]',
        JSON.stringify({ eventId: event.id, type: event.type, depth: event.depth }),
      );
      continue;
    }

    const rows = matched.map((agent) => ({
      event_id: event.id,
      agent_id: agent.id,
      case_id: event.case_id,
      status: 'pending',
    }));
    const { error: insErr } = await supabase
      .from('event_deliveries')
      .upsert(rows, { onConflict: 'event_id,agent_id', ignoreDuplicates: true });
    if (insErr) {
      report.errors.push(`delivery insert failed event=${event.id}: ${insErr.message}`);
    }
  }

  return delivered;
}

// ---------------------------------------------------------------------------
// Phase b — run pending deliveries (FIFO per case)
// ---------------------------------------------------------------------------

async function runPendingDeliveries(report: PumpReport, deadlineAt: number): Promise<number> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('event_deliveries')
    .select('*, event:events(*)')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(100);

  if (error) {
    report.errors.push(`deliveries load failed: ${error.message}`);
    return 0;
  }

  const pending = ((data ?? []) as PendingDelivery[])
    .filter((d) => d.event)
    .sort((a, b) => (a.event as EventRow).seq - (b.event as EventRow).seq);

  // At most the FIRST pending delivery per case per round (FIFO by event seq);
  // null-case deliveries all run.
  const seenCases = new Set<string>();
  const chosen: PendingDelivery[] = [];
  for (const d of pending) {
    if (d.case_id) {
      if (seenCases.has(d.case_id)) continue;
      seenCases.add(d.case_id);
    }
    chosen.push(d);
    if (chosen.length >= MAX_DELIVERIES_PER_ROUND) break;
  }

  let processed = 0;
  for (const delivery of chosen) {
    if (Date.now() > deadlineAt) break;
    processed++;
    await runOneDelivery(delivery, delivery.event as EventRow, report);
  }
  return processed;
}

async function runOneDelivery(
  delivery: PendingDelivery,
  event: EventRow,
  report: PumpReport,
): Promise<void> {
  const supabase = getSupabase();
  const nowIso = new Date().toISOString();

  // Rate cap: >10 completed turns for this case in the last minute → exception.
  if (delivery.case_id) {
    const { count } = await supabase
      .from('event_deliveries')
      .select('id', { count: 'exact', head: true })
      .eq('case_id', delivery.case_id)
      .eq('status', 'done')
      .gt('claimed_at', new Date(Date.now() - 60_000).toISOString());

    if ((count ?? 0) > RATE_CAP_TURNS_PER_MINUTE) {
      await markDelivery(delivery.id, 'skipped', 'pending');
      const review = await createExceptionReviewOnce(
        delivery.case_id,
        'Agent turn rate cap hit (>10 turns/case/min) — investigate.',
      );
      if (review) report.reviews++;
      console.log(
        '[dispatcher.rate_cap]',
        JSON.stringify({ caseId: delivery.case_id, deliveryId: delivery.id }),
      );
      return;
    }
  }

  // Claim the delivery (pending → running).
  const { data: claimedDelivery } = await supabase
    .from('event_deliveries')
    .update({ status: 'running', claimed_at: nowIso })
    .eq('id', delivery.id)
    .eq('status', 'pending')
    .select('id');
  if (!claimedDelivery || claimedDelivery.length === 0) return;

  // Claim the case — one in-flight turn per case.
  const claimAssignee = `agent:${delivery.agent_id}`;
  let priorStatus: string | null = null;

  if (delivery.case_id) {
    const { data: c } = await supabase
      .from('work_items')
      .select('id, status, assignee')
      .eq('id', delivery.case_id)
      .maybeSingle();
    const caseRow = c as { id: string; status: string; assignee: string } | null;

    if (!caseRow || caseRow.status === 'done') {
      // Case gone or completed — never wake an agent on it; consume the delivery.
      await markDelivery(delivery.id, 'skipped', 'running');
      return;
    }
    if (caseRow.assignee !== 'unassigned' || !['open', 'waiting'].includes(caseRow.status)) {
      // Someone else holds the case — claim failure never consumes an event.
      await releaseDelivery(delivery.id);
      return;
    }
    priorStatus = caseRow.status;

    const { data: claimedCase } = await supabase
      .from('work_items')
      .update({
        assignee: claimAssignee,
        status: 'in_progress',
        claimed_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', delivery.case_id)
      .eq('assignee', 'unassigned')
      .eq('status', priorStatus)
      .select('id');
    if (!claimedCase || claimedCase.length === 0) {
      await releaseDelivery(delivery.id);
      return;
    }
  }

  // Load the agent fresh — enabled/mode may have changed since fan-out.
  const { data: agentData } = await supabase
    .from('agents')
    .select('*')
    .eq('id', delivery.agent_id)
    .maybeSingle();
  const agent = agentData as Agent | null;
  if (!agent || !agent.enabled) {
    await markDelivery(delivery.id, 'skipped', 'running');
    await releaseCase(delivery.case_id, claimAssignee, priorStatus);
    return;
  }

  // Run the turn.
  let outcome: 'completed' | 'review' | 'shadowed' | 'wait' | 'error' = 'error';
  try {
    const result = await runDeliveryTurn(delivery, event, agent);
    outcome = result.outcome;
    report.actions.push(...result.actions);
    if (outcome === 'error') {
      report.errors.push(`turn errored delivery=${delivery.id} agent=${agent.name}`);
    }
  } catch (err) {
    report.errors.push(
      `turn failed delivery=${delivery.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  report.turns++;
  if (outcome === 'shadowed') report.shadowed++;
  if (outcome === 'review') report.reviews++;

  // Mark the delivery per outcome (guarded — the runner may have marked it already).
  await markDelivery(delivery.id, outcome === 'shadowed' ? 'shadowed' : 'done', 'running');

  // Release the case unless the turn moved it on (tools setting waiting/done stick).
  await releaseCase(delivery.case_id, claimAssignee, priorStatus);

  console.log(
    '[dispatcher.turn]',
    JSON.stringify({
      deliveryId: delivery.id,
      eventType: event.type,
      caseId: delivery.case_id,
      agent: agent.name,
      outcome,
    }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function markDelivery(
  deliveryId: string,
  status: 'done' | 'shadowed' | 'skipped',
  fromStatus: 'pending' | 'running',
): Promise<void> {
  await getSupabase()
    .from('event_deliveries')
    .update({ status })
    .eq('id', deliveryId)
    .eq('status', fromStatus);
}

/** Claim failure path: put the delivery back so it retries next round/tick. */
async function releaseDelivery(deliveryId: string): Promise<void> {
  await getSupabase()
    .from('event_deliveries')
    .update({ status: 'pending', claimed_at: null })
    .eq('id', deliveryId)
    .eq('status', 'running');
}

/**
 * Release a claimed case after a turn. Restores the pre-claim status only when
 * the case is still 'in_progress' — if a tool set it to 'waiting' or 'done'
 * during the turn (sends do), that status sticks; we then just clear the agent
 * assignee so the next claim can succeed.
 */
async function releaseCase(
  caseId: string | null,
  claimAssignee: string,
  priorStatus: string | null,
): Promise<void> {
  if (!caseId || !priorStatus) return;
  const supabase = getSupabase();
  const nowIso = new Date().toISOString();

  const { data: restored } = await supabase
    .from('work_items')
    .update({ assignee: 'unassigned', claimed_at: null, status: priorStatus, updated_at: nowIso })
    .eq('id', caseId)
    .eq('assignee', claimAssignee)
    .eq('status', 'in_progress')
    .select('id');
  if (restored && restored.length > 0) return;

  // Status changed during the turn — keep it, but drop the agent claim so the
  // case is claimable again (e.g. 'waiting' after a send must stay claimable
  // for the timed-out follow-up turn).
  await supabase
    .from('work_items')
    .update({ assignee: 'unassigned', claimed_at: null, updated_at: nowIso })
    .eq('id', caseId)
    .eq('assignee', claimAssignee)
    .in('status', ['open', 'waiting', 'error']);
}

/** One pending exception review per case — dedupe before insert. */
async function createExceptionReviewOnce(caseId: string, question: string): Promise<boolean> {
  const pending = await findPendingReview(caseId, 'exception');
  if (pending) return false;
  const review = await createReviewRequest({ caseId, kind: 'exception', question });
  return !!review;
}
