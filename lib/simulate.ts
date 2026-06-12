/**
 * lib/simulate.ts — the mocked world (pure world-sim + pump driver).
 *
 * injectInbound(scenario)    — creates a work item from a canned doc + emits
 *                              `document.received` (the Router places it).
 * tick()                     — resolves due outbound attempts EVENT-FIRST
 *                              (`response.received` / `attempt.timed_out`),
 *                              then runs pumpEvents(). Idempotent every ~5s.
 * handleAttemptResponse()    — LEGACY SHIM for the portal API: emits
 *                              `response.received` + one pump (until W2 flips
 *                              the portal onto events directly).
 *
 * Substrate rules (docs/substrate-spec.md §3):
 * - The chase ladder loop is GONE — the Records Chaser agent owns chasing via
 *   `attempt.timed_out` subscriptions.
 * - Simulated responses are keyed on attempt.kind + channel, NEVER queue_key.
 * - care_everywhere always responds and is never timed out.
 * - portal attempts have respond_after null so never resolve here; a
 *   request_more_info attempt on a portal-originated case is never
 *   auto-answered (the portal user must respond).
 * - Done-case responses are still emitted; the dispatcher skips delivery to
 *   done cases.
 */

import { getSupabase } from './supabase';
import { emitEvent } from './events';
import { pumpEvents } from './dispatcher';
import { createWorkItem } from './workItems';
import { SAMPLE_DOCS, type ScenarioKey, type BatchKey } from './sampleDocs';
import { renderRecordsTransmittal, type Channel } from './outbound';
import type { TickReport, WorkItem } from './types';

// ---------------------------------------------------------------------------
// Batch scenario definitions
// ---------------------------------------------------------------------------

const BATCH_MORNING: ScenarioKey[] = [
  'fax_referral_clean',
  'fax_roi_clean',
  'fax_ambiguous_patient',
  'fax_messy',
  'dm_records_request',
  'call_referral',
  'fax_referral_partial',
  'fax_roi_missing_auth',
];

// ---------------------------------------------------------------------------
// injectInbound — single scenario or batch
// ---------------------------------------------------------------------------

export async function injectInbound(scenario: ScenarioKey): Promise<WorkItem & { itemId: string }>;
export async function injectInbound(scenario: BatchKey): Promise<{ itemIds: string[] }>;
export async function injectInbound(
  scenario: ScenarioKey | BatchKey,
): Promise<(WorkItem & { itemId: string }) | { itemIds: string[] }> {
  if (scenario === 'batch_morning') {
    const itemIds: string[] = [];
    for (const s of BATCH_MORNING) {
      const item = await injectSingle(s);
      itemIds.push(item.id);
    }
    console.log('[simulate.inbound]', JSON.stringify({ scenario: 'batch_morning', count: itemIds.length, itemIds }));
    return { itemIds };
  }

  const item = await injectSingle(scenario as ScenarioKey);
  return { ...item, itemId: item.id };
}

async function injectSingle(scenario: ScenarioKey): Promise<WorkItem> {
  const doc = SAMPLE_DOCS[scenario];
  if (!doc) throw new Error(`Unknown scenario: ${scenario}`);

  const item = await createWorkItem({
    type: 'unknown',
    queue_key: 'intake',
    source_channel: doc.source_channel,
    source_text: doc.source_text,
    org_id: doc.from_org_id,
  });

  await emitEvent({
    type: 'document.received',
    caseId: item.id,
    payload: { channel: doc.source_channel, scenario },
    actor: 'world',
  });

  console.log(
    '[simulate.inbound]',
    JSON.stringify({ scenario, itemId: item.id, channel: doc.source_channel, org: doc.from_org_id }),
  );

  return item;
}

// ---------------------------------------------------------------------------
// tick — advance the simulated world, then pump the substrate
// ---------------------------------------------------------------------------

export async function tick(): Promise<TickReport> {
  const report: TickReport = {
    respondedAttempts: [],
    timedOutAttempts: [],
    chaseAttempts: [],
    escalations: [],
    agentRun: { processed: 0, actions: [] },
  };

  const sb = getSupabase();
  const now = new Date().toISOString();

  // -------------------------------------------------------------------------
  // 1. Resolve outbound attempts whose respond_after has passed — EVENT-FIRST:
  //    emit the outcome event (deduped per attempt), THEN update the attempt
  //    behind an optimistic status guard. Portal attempts (respond_after=null)
  //    never appear here — lte(null) never matches, and the explicit NOT NULL
  //    keeps the trap closed.
  // -------------------------------------------------------------------------

  const { data: dueAttempts, error: dueErr } = await sb
    .from('outbound_attempts')
    .select('*, work_item:work_items(id,org_id,source_channel,matched_patient_id)')
    .in('status', ['sent', 'awaiting_response'])
    .not('respond_after', 'is', null)
    .lte('respond_after', now);

  if (dueErr) {
    console.log('[simulate.tick.err]', dueErr.message);
  }

  for (const attempt of dueAttempts ?? []) {
    const a = attempt as {
      id: string;
      work_item_id: string;
      channel: string;
      kind: string | null;
      attempt_no: number;
      to_org_id: string | null;
      payload?: Record<string, unknown> | null;
      work_item: {
        id: string;
        org_id: string | null;
        source_channel: string | null;
        matched_patient_id: string | null;
      } | null;
    };

    // Portal attempts wait for a human response — never simulated.
    if (a.channel === 'portal') continue;

    const attemptKind = (a.kind ?? (a.payload?.['kind'] as string | undefined) ?? 'records_request') as string;

    // A request-more-info aimed at a PORTAL-originated case: the requester IS
    // the portal user — the simulated world must not answer on their behalf.
    if (a.work_item?.source_channel === 'portal' && attemptKind === 'request_more_info') {
      continue;
    }

    // care_everywhere always responds (never the no_response simulation).
    const isCareEverywhere = a.channel === 'care_everywhere';
    const orgId = a.to_org_id ?? a.work_item?.org_id ?? null;

    let isNoResponse = false;
    if (orgId && !isCareEverywhere) {
      const { data: org } = await sb
        .from('organizations')
        .select('contact')
        .eq('id', orgId)
        .single();
      const contact = (org as { contact: Record<string, string> } | null)?.contact ?? {};
      isNoResponse = contact['simulation'] === 'no_response';
    }

    if (isNoResponse) {
      // EVENT-FIRST: the timeout becomes a fact before the attempt row changes.
      const event = await emitEvent({
        type: 'attempt.timed_out',
        caseId: a.work_item_id,
        payload: { attemptId: a.id, channel: a.channel, attemptNo: a.attempt_no, kind: attemptKind },
        actor: 'world',
        dedupeKey: `attempt:${a.id}:timed_out`,
      });
      if (!event) continue; // emit failed — retry next tick

      // Voice attempts record a no-answer outcome on the attempt itself.
      const voiceNoAnswerResponse =
        a.channel === 'voice'
          ? {
              outcome: 'no_answer',
              note: 'Rang 45s — no answer. Voicemail left with callback number and reference.',
            }
          : undefined;

      const { data: updated } = await sb
        .from('outbound_attempts')
        .update({
          status: 'timed_out',
          ...(voiceNoAnswerResponse ? { response: voiceNoAnswerResponse } : {}),
          updated_at: now,
        })
        .eq('id', a.id)
        .in('status', ['sent', 'awaiting_response'])
        .select('id');

      if (updated && updated.length > 0) {
        report.timedOutAttempts.push(a.id);
        console.log('[simulate.tick]', JSON.stringify({ event: 'timed_out', attemptId: a.id, channel: a.channel }));
      }
    } else {
      const responsePayload = await buildSimulatedResponse(
        attemptKind,
        a.channel,
        a.work_item_id,
        orgId,
        a.work_item?.matched_patient_id ?? null,
      );

      // EVENT-FIRST: the response becomes a fact before the attempt row changes.
      const event = await emitEvent({
        type: 'response.received',
        caseId: a.work_item_id,
        payload: {
          attemptId: a.id,
          channel: a.channel,
          attemptNo: a.attempt_no,
          kind: attemptKind,
          response: responsePayload,
        },
        actor: 'world',
        dedupeKey: `attempt:${a.id}:responded`,
      });
      if (!event) continue; // emit failed — retry next tick

      const { data: updated } = await sb
        .from('outbound_attempts')
        .update({
          status: 'responded',
          response: responsePayload,
          updated_at: now,
        })
        .eq('id', a.id)
        .in('status', ['sent', 'awaiting_response'])
        .select('id');

      if (updated && updated.length > 0) {
        report.respondedAttempts.push(a.id);
        console.log('[simulate.tick]', JSON.stringify({ event: 'responded', attemptId: a.id, channel: a.channel }));
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. Pump the substrate — routing, fan-out, agent turns. Chasing is now the
  //    Records Chaser agent reacting to attempt.timed_out, not a loop here.
  // -------------------------------------------------------------------------

  const pump = await pumpEvents();
  report.agentRun = { processed: pump.turns, actions: pump.actions };

  console.log(
    '[simulate.tick]',
    JSON.stringify({
      event: 'tick_complete',
      responded: report.respondedAttempts.length,
      timedOut: report.timedOutAttempts.length,
      delivered: pump.delivered,
      routed: pump.routed,
      turns: pump.turns,
      agentActions: report.agentRun.actions.length,
    }),
  );

  return report;
}

// ---------------------------------------------------------------------------
// handleAttemptResponse — LEGACY SHIM (portal API calls this until W2)
// ---------------------------------------------------------------------------

/**
 * Legacy shim: the portal respond route still calls this with the old
 * signature. It now just emits `response.received` and pumps once — the
 * subscribed agent (not per-queue branching) decides what the response means.
 */
export async function handleAttemptResponse(
  workItemId: string,
  _queueKey: string,
  response: Record<string, unknown>,
  _existingExtracted: Record<string, unknown>,
): Promise<void> {
  await emitEvent({
    type: 'response.received',
    caseId: workItemId,
    payload: { response },
    actor: 'world',
  });
  await pumpEvents({ maxRounds: 2 });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the simulated counterparty response. Keyed on attempt kind + channel —
 * NEVER on queue_key (workflow knowledge lives in agent config, not here).
 */
async function buildSimulatedResponse(
  attemptKind: string,
  channel: string,
  workItemId: string,
  orgId: string | null,
  matchedPatientId: string | null,
): Promise<Record<string, unknown>> {
  if (attemptKind === 'records_request') {
    // RECORDS TRANSMITTAL document (C-CDA document return for care_everywhere)
    const sb = getSupabase();
    let patientName = 'Patient';
    let patientDob: string | undefined;

    if (matchedPatientId) {
      const { data: pat } = await sb
        .from('patients')
        .select('first_name,last_name,dob')
        .eq('id', matchedPatientId)
        .single();
      const p = pat as { first_name: string; last_name: string; dob: string } | null;
      if (p) {
        patientName = `${p.first_name} ${p.last_name}`;
        patientDob = p.dob;
      }
    }

    let orgName = 'Unknown Org';
    if (orgId) {
      const { data: orgRow } = await sb
        .from('organizations')
        .select('name')
        .eq('id', orgId)
        .single();
      orgName = (orgRow as { name: string } | null)?.name ?? orgName;
    }

    const refNo = `ROI-${workItemId.slice(0, 8).toUpperCase()}`;
    const transmittal = renderRecordsTransmittal({
      patientName,
      patientDob,
      orgName,
      channel: channel as Channel,
      refNo,
    });

    return {
      status: channel === 'care_everywhere' ? 'records_provided_ccd' : 'records_provided',
      message: channel === 'care_everywhere'
        ? 'C-CDA document returned via Care Everywhere.'
        : 'Records are attached. All requested documents are included.',
      document: transmittal,
      ref: refNo,
      received_at: new Date().toISOString(),
    };
  }

  if (attemptKind === 'request_more_info') {
    // Responding to a request_more_info — provide the missing authorization
    return {
      status: 'info_provided',
      authorization: `Patient authorization provided. Authorization#: AUTH-${Date.now()}`,
      message: 'Signed authorization form is attached.',
      received_at: new Date().toISOString(),
    };
  }

  return {
    status: 'acknowledged',
    message: 'Request acknowledged.',
    received_at: new Date().toISOString(),
  };
}
