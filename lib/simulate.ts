/**
 * lib/simulate.ts — the mocked world.
 *
 * injectInbound(scenario)    — creates a work item in intake from a canned doc.
 * tick()                     — advances the world; idempotent and safe every ~5s.
 * handleAttemptResponse()    — exported so the portal API can call it too.
 *
 * W1b changes:
 * - Chase loop reads the new ChasePlan {steps: ChaseStep[], waitSeconds} shape.
 * - Legacy {channels:[...]} shape is still readable as fallback.
 * - care_everywhere: respond_after = now+8s; never chased.
 * - SECOND REQUEST framing: when a chase step has attempt > 1, priorAttemptAt is passed.
 * - Escalation message includes the full step list (e.g. "fax, fax, voice").
 */

import { getSupabase } from './supabase';
import { runAgents } from './agentRunner';
import { createWorkItem } from './workItems';
import { runTool } from './tools';
import { SAMPLE_DOCS, type ScenarioKey, type BatchKey } from './sampleDocs';
import {
  renderOutboundDocument,
  renderRecordsTransmittal,
  type Channel,
  type DocumentKind,
} from './outbound';
import type { ChaseStep, TickReport, WorkItem } from './types';

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

  console.log(
    '[simulate.inbound]',
    JSON.stringify({ scenario, itemId: item.id, channel: doc.source_channel, org: doc.from_org_id }),
  );

  return item;
}

// ---------------------------------------------------------------------------
// tick — advance the simulated world
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
  // 1. Resolve outbound attempts whose respond_after has passed.
  //    Portal attempts (respond_after=null) are NEVER processed here.
  //    Use optimistic UPDATE WHERE status='sent'/'awaiting_response' to prevent
  //    double-processing.
  // -------------------------------------------------------------------------

  const { data: dueAttempts, error: dueErr } = await sb
    .from('outbound_attempts')
    .select('*, work_item:work_items(id,org_id,queue_key,agent_state,extracted_data,matched_patient_id,source_channel)')
    .in('status', ['sent', 'awaiting_response'])
    .lte('respond_after', now)
    // respond_after IS NOT NULL is implicit because lte(null) never matches
    ;

  if (dueErr) {
    console.log('[simulate.tick.err]', dueErr.message);
  }

  for (const attempt of dueAttempts ?? []) {
    const a = attempt as {
      id: string;
      work_item_id: string;
      channel: string;
      attempt_no: number;
      to_org_id: string | null;
      payload?: Record<string, unknown> | null;
      work_item: {
        id: string;
        org_id: string | null;
        queue_key: string;
        agent_state: Record<string, unknown>;
        extracted_data: Record<string, unknown>;
        matched_patient_id: string | null;
        source_channel?: string;
      } | null;
    };

    // Skip portal attempts — they wait for a human response
    if (a.channel === 'portal') continue;

    // A request-more-info aimed at a PORTAL-originated request: the requester
    // IS the portal user — the simulated world must not answer on their
    // behalf. The attempt stays pending until they attach the authorization
    // in their portal ("Action needed").
    if (
      a.work_item?.source_channel === 'portal' &&
      (a.payload?.['kind'] === 'request_more_info' ||
        String(a.payload?.['subject'] ?? '').includes('Additional Information'))
    ) {
      continue;
    }

    // care_everywhere always responds (never no_response simulation)
    const isCareEverywhere = a.channel === 'care_everywhere';

    const orgId = a.to_org_id ?? a.work_item?.org_id ?? null;

    // Check simulation flag (skipped for care_everywhere)
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
      // Build voice no-answer outcome when the channel is voice
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

        // Set work item back to open so the chase loop can advance
        await sb
          .from('work_items')
          .update({ status: 'open', assignee: 'unassigned', updated_at: now })
          .eq('id', a.work_item_id)
          .in('status', ['waiting', 'in_progress']);
      }
    } else {
      // Build simulated response with RECORDS TRANSMITTAL document when appropriate
      const responsePayload = await buildSimulatedResponse(
        a.work_item?.queue_key ?? '',
        a.channel,
        a.work_item_id,
        orgId,
        a.work_item?.matched_patient_id ?? null,
      );

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

        // Handle response effects per queue
        await handleAttemptResponse(
          a.work_item_id,
          a.work_item?.queue_key ?? '',
          responsePayload,
          a.work_item?.extracted_data ?? {},
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. Chase escalation for roi_outgoing items with timed-out attempts.
  //    Reads the new ChasePlan {steps: ChaseStep[]} shape; falls back to legacy
  //    {channels:[...]} or the hardcoded default order.
  // -------------------------------------------------------------------------

  const LEGACY_CHASE_ORDER: string[] = ['fax', 'email', 'sms', 'voice'];

  // Find roi_outgoing items that have a timed_out attempt and are now open
  const { data: chaseItems } = await sb
    .from('work_items')
    .select('*, outbound_attempts(id,channel,attempt_no,status,created_at)')
    .eq('queue_key', 'roi_outgoing')
    .in('status', ['open', 'waiting'])
    .eq('assignee', 'unassigned');

  for (const rawItem of chaseItems ?? []) {
    const ci = rawItem as WorkItem & {
      outbound_attempts: Array<{ id: string; channel: string; attempt_no: number; status: string; created_at: string }>;
    };

    // Never chase care_everywhere — it auto-responds
    const hasCareEverywhereAttempt = (ci.outbound_attempts ?? []).some(
      (a) => a.channel === 'care_everywhere',
    );
    if (hasCareEverywhereAttempt) continue;

    // Never chase while an attempt is still in flight
    const pending = (ci.outbound_attempts ?? []).some(
      (a) => a.status === 'sent' || a.status === 'awaiting_response',
    );
    if (pending) continue;

    const timedOut = (ci.outbound_attempts ?? []).filter((a) => a.status === 'timed_out');
    if (timedOut.length === 0) continue;

    // Find the highest attempt_no that timed out
    const latestTimedOut = timedOut.sort((a, b) => b.attempt_no - a.attempt_no)[0];
    const lastAttemptNo = latestTimedOut.attempt_no;

    // Read chase plan from agent_state
    const agentState = ci.agent_state as Record<string, unknown>;

    // New shape: {steps: ChaseStep[], waitSeconds}
    const chasePlanNew = agentState['chase_plan'] as
      | { steps?: ChaseStep[]; channels?: string[]; waitSeconds?: number }
      | undefined;

    let chaseSteps: ChaseStep[];
    const waitSeconds = chasePlanNew?.waitSeconds;

    if (chasePlanNew?.steps && Array.isArray(chasePlanNew.steps) && chasePlanNew.steps.length > 0) {
      // New step-based plan
      chaseSteps = chasePlanNew.steps as ChaseStep[];
    } else if (chasePlanNew?.channels && Array.isArray(chasePlanNew.channels)) {
      // Legacy {channels:[...]} shape — expand into steps (no repeats)
      const seen: Record<string, number> = {};
      chaseSteps = (chasePlanNew.channels as string[])
        .filter((ch) => ch !== 'portal' && ch !== 'care_everywhere')
        .map((ch) => {
          seen[ch] = (seen[ch] ?? 0) + 1;
          return { channel: ch as Channel, attempt: seen[ch] };
        });
    } else {
      // Default
      chaseSteps = LEGACY_CHASE_ORDER.map((ch, i) => ({ channel: ch as Channel, attempt: i === 0 ? 1 : i }));
    }

    // Filter out care_everywhere and portal from chase steps
    chaseSteps = chaseSteps.filter(
      (s) => s.channel !== 'care_everywhere' && s.channel !== 'portal',
    );

    if (chaseSteps.length === 0) continue;

    // The next step is the one after lastAttemptNo (steps are 1-indexed by position)
    const nextStepIdx = lastAttemptNo; // attempt_no=1 → next is index 1 (0-based)

    if (nextStepIdx >= chaseSteps.length) {
      // All steps exhausted → escalate to human
      const claimed = await claimForChase(ci.id);
      if (!claimed) continue;

      const stepList = chaseSteps.map((s) => s.channel).join(', ');
      await runTool(
        'escalate_to_human',
        ci.id,
        {
          question: `No response after ${lastAttemptNo} attempt${lastAttemptNo !== 1 ? 's' : ''} (${stepList}) — call them or close?`,
        },
        'system',
      );
      report.escalations.push(ci.id);
      console.log(
        '[simulate.tick]',
        JSON.stringify({ event: 'chase_escalated', itemId: ci.id, steps: stepList }),
      );
    } else {
      const nextStep = chaseSteps[nextStepIdx];
      const nextChannel = nextStep.channel;
      const chaseAttemptNo = lastAttemptNo + 1;

      const claimed = await claimForChase(ci.id);
      if (!claimed) continue;

      const orgId = ci.org_id ?? null;
      const contact = orgId ? await getOrgContact(orgId) : null;
      const contactSnapshot: Record<string, unknown> = {
        fax: contact?.fax,
        email: contact?.email,
        phone: contact?.phone,
      };

      // Build rendered document for the chase attempt
      const kind: DocumentKind = (agentState['kind'] as DocumentKind | undefined) ?? 'records_request';
      const outboundCtx = await buildChaseContext(ci, orgId, chaseAttemptNo, contact, latestTimedOut.created_at);
      const rendered = renderOutboundDocument(nextChannel, kind, outboundCtx);
      const payload = {
        subject: rendered.subject,
        body: rendered.body,
        document: rendered.document,
        kind,
      };

      const respondAfterMs = waitSeconds
        ? Date.now() + waitSeconds * 1000
        : Date.now() + (20 + Math.floor(Math.random() * 21)) * 1000;

      const { data: newAttempt } = await sb
        .from('outbound_attempts')
        .insert({
          work_item_id: ci.id,
          channel: nextChannel,
          attempt_no: chaseAttemptNo,
          to_org_id: orgId,
          to_contact: contactSnapshot,
          payload,
          status: 'sent',
          respond_after: new Date(respondAfterMs).toISOString(),
        })
        .select('id')
        .single();

      if (newAttempt) {
        await sb.from('audit_log').insert({
          work_item_id: ci.id,
          actor: 'system',
          action: `send_${nextChannel}`,
          detail: {
            attempt_no: chaseAttemptNo,
            channel: nextChannel,
            channel_attempt: nextStep.attempt,
            attempt_id: (newAttempt as { id: string }).id,
          },
        });
      }

      await sb
        .from('work_items')
        .update({
          status: 'waiting',
          assignee: 'unassigned',
          agent_state: {
            ...agentState,
            attempt_no: chaseAttemptNo,
            last_channel: nextChannel,
          },
          updated_at: now,
        })
        .eq('id', ci.id);

      report.chaseAttempts.push(ci.id);
      console.log(
        '[simulate.tick]',
        JSON.stringify({
          event: 'chase_next',
          itemId: ci.id,
          channel: nextChannel,
          channelAttempt: nextStep.attempt,
          attemptNo: chaseAttemptNo,
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // 3. Run agents
  // -------------------------------------------------------------------------

  report.agentRun = await runAgents();

  console.log(
    '[simulate.tick]',
    JSON.stringify({
      event: 'tick_complete',
      responded: report.respondedAttempts.length,
      timedOut: report.timedOutAttempts.length,
      chase: report.chaseAttempts.length,
      escalations: report.escalations.length,
      agentActions: report.agentRun.actions.length,
    }),
  );

  return report;
}

// ---------------------------------------------------------------------------
// handleAttemptResponse — exported for portal API
// ---------------------------------------------------------------------------

export async function handleAttemptResponse(
  workItemId: string,
  queueKey: string,
  response: Record<string, unknown>,
  existingExtracted: Record<string, unknown>,
): Promise<void> {
  const sb = getSupabase();

  // A response on an already-completed item (e.g. delivery confirmation of a
  // records-response fax) must not reopen it — that would re-run the pipeline
  // and re-send records every tick.
  const { data: current } = await sb
    .from('work_items')
    .select('status')
    .eq('id', workItemId)
    .single();
  if ((current as { status: string } | null)?.status === 'done') {
    return;
  }

  if (queueKey === 'roi_outgoing') {
    // Records received — mark agent_state so the Records Chaser can complete it
    const { data: item } = await sb
      .from('work_items')
      .select('agent_state')
      .eq('id', workItemId)
      .single();
    const agentState = (item as { agent_state: Record<string, unknown> } | null)?.agent_state ?? {};
    await sb
      .from('work_items')
      .update({
        status: 'open',
        assignee: 'unassigned',
        agent_state: { ...agentState, response_received: true },
        updated_at: new Date().toISOString(),
      })
      .eq('id', workItemId);
  } else if (queueKey === 'roi_incoming') {
    // Authorization or info arrived — merge into extracted_data, set back to open.
    // Also clear the cached verify_requirements result: it was computed BEFORE
    // this new info and would otherwise deadlock the planner (verify "done"
    // but recorded incomplete → fulfillment never fires).
    const mergedExtracted = { ...existingExtracted };
    if (response['authorization']) {
      mergedExtracted['authorization'] = response['authorization'];
    }
    const { data: stItem } = await sb
      .from('work_items')
      .select('agent_state')
      .eq('id', workItemId)
      .single();
    const st = ((stItem as { agent_state: Record<string, unknown> } | null)?.agent_state ?? {}) as Record<string, unknown>;
    delete st['requirements'];
    await sb
      .from('work_items')
      .update({
        extracted_data: mergedExtracted,
        agent_state: st,
        status: 'open',
        assignee: 'unassigned',
        updated_at: new Date().toISOString(),
      })
      .eq('id', workItemId);
  } else {
    // Generic — set back to open
    await sb
      .from('work_items')
      .update({
        status: 'open',
        assignee: 'unassigned',
        updated_at: new Date().toISOString(),
      })
      .eq('id', workItemId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function claimForChase(itemId: string): Promise<boolean> {
  const { data } = await getSupabase()
    .from('work_items')
    .update({ assignee: 'system', updated_at: new Date().toISOString() })
    .eq('id', itemId)
    .eq('assignee', 'unassigned')
    .in('status', ['open', 'waiting'])
    .select('id');
  return !!(data && data.length > 0);
}

async function getOrgContact(orgId: string): Promise<{
  fax?: string;
  email?: string;
  phone?: string;
  preferred_channel?: string;
  simulation?: string;
} | null> {
  const { data } = await getSupabase()
    .from('organizations')
    .select('contact')
    .eq('id', orgId)
    .single();
  return (data as { contact: Record<string, string> } | null)?.contact ?? null;
}

async function buildSimulatedResponse(
  queueKey: string,
  channel: string,
  workItemId: string,
  orgId: string | null,
  matchedPatientId: string | null,
): Promise<Record<string, unknown>> {
  if (queueKey === 'roi_outgoing') {
    // Build a RECORDS TRANSMITTAL document (C-CDA for care_everywhere)
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

  if (queueKey === 'roi_incoming') {
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

async function buildChaseContext(
  item: WorkItem,
  orgId: string | null,
  attemptNo: number,
  contact: { fax?: string; email?: string; phone?: string } | null,
  priorAttemptAt?: string,
): Promise<import('./outbound').OutboundContext> {
  const sb = getSupabase();
  const extracted = item.extracted_data as Record<string, string>;

  let patientName = 'Unknown Patient';
  let patientDob: string | undefined;
  let patientMrn: string | undefined;

  if (item.matched_patient_id) {
    const { data: pat } = await sb
      .from('patients')
      .select('first_name,last_name,dob,mrn')
      .eq('id', item.matched_patient_id)
      .single();
    const p = pat as { first_name: string; last_name: string; dob: string; mrn: string } | null;
    if (p) {
      patientName = `${p.first_name} ${p.last_name}`;
      patientDob = p.dob;
      patientMrn = p.mrn;
    }
  } else {
    const fn = (extracted['patient_first_name'] ?? extracted['patient_name'] ?? '') as string;
    const ln = (extracted['patient_last_name'] ?? '') as string;
    if (fn || ln) patientName = `${fn} ${ln}`.trim();
    patientDob = extracted['patient_dob'] as string | undefined;
    patientMrn = extracted['patient_mrn'] as string | undefined;
  }

  let orgName = (extracted['org_name'] ?? '') as string;
  if (!orgName && orgId) {
    const { data: orgRow } = await sb
      .from('organizations')
      .select('name')
      .eq('id', orgId)
      .single();
    orgName = (orgRow as { name: string } | null)?.name ?? 'Unknown Org';
  }

  return {
    itemId: item.id,
    patientName,
    patientDob,
    patientMrn,
    recordsRequested: extracted['records_requested'] as string | undefined,
    orgName,
    orgFax: contact?.fax,
    orgEmail: contact?.email,
    orgPhone: contact?.phone,
    attemptNo,
    priorAttemptAt,
  };
}
