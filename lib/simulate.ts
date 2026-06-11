/**
 * lib/simulate.ts — the mocked world.
 *
 * injectInbound(scenario) — creates a work item in intake from a canned doc.
 * tick()                  — advances the world; idempotent and safe every ~5s.
 */

import { getSupabase } from './supabase';
import { runAgents } from './agentRunner';
import { createWorkItem } from './workItems';
import { runTool } from './tools';
import { SAMPLE_DOCS, type ScenarioKey } from './sampleDocs';
import type { TickReport, WorkItem } from './types';

// ---------------------------------------------------------------------------
// injectInbound
// ---------------------------------------------------------------------------

export async function injectInbound(scenario: ScenarioKey): Promise<WorkItem> {
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
  // 1. Resolve outbound attempts whose respond_after has passed
  //    Use optimistic UPDATE WHERE status='sent'/'awaiting_response' to prevent
  //    double-processing.
  // -------------------------------------------------------------------------

  const { data: dueAttempts, error: dueErr } = await sb
    .from('outbound_attempts')
    .select('*, work_item:work_items(id,org_id,queue_key,agent_state,extracted_data,matched_patient_id)')
    .in('status', ['sent', 'awaiting_response'])
    .lte('respond_after', now);

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
      work_item: {
        id: string;
        org_id: string | null;
        queue_key: string;
        agent_state: Record<string, unknown>;
        extracted_data: Record<string, unknown>;
        matched_patient_id: string | null;
      } | null;
    };

    // Optimistic claim — set to 'responded' or 'timed_out' only if still sent/awaiting
    const orgId = a.to_org_id ?? a.work_item?.org_id ?? null;

    // Check simulation flag
    let isNoResponse = false;
    if (orgId) {
      const { data: org } = await sb
        .from('organizations')
        .select('contact')
        .eq('id', orgId)
        .single();
      const contact = (org as { contact: Record<string, string> } | null)?.contact ?? {};
      isNoResponse = contact['simulation'] === 'no_response';
    }

    if (isNoResponse) {
      // Timeout this attempt
      const { data: updated } = await sb
        .from('outbound_attempts')
        .update({ status: 'timed_out', updated_at: now })
        .eq('id', a.id)
        .in('status', ['sent', 'awaiting_response'])
        .select('id');

      if (updated && updated.length > 0) {
        report.timedOutAttempts.push(a.id);
        console.log('[simulate.tick]', JSON.stringify({ event: 'timed_out', attemptId: a.id }));

        // Set work item back to open so the chase loop can advance
        await sb
          .from('work_items')
          .update({ status: 'open', assignee: 'unassigned', updated_at: now })
          .eq('id', a.work_item_id)
          .in('status', ['waiting', 'in_progress']);
      }
    } else {
      // Simulate a positive response
      const responsePayload = buildSimulatedResponse(a.work_item?.queue_key ?? '', a.channel);

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
        console.log('[simulate.tick]', JSON.stringify({ event: 'responded', attemptId: a.id }));

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
  // 2. Chase escalation for roi_outgoing items with timed-out attempts
  //    Order: fax → email → sms → voice; after voice → escalate_to_human
  // -------------------------------------------------------------------------

  const CHASE_ORDER: string[] = ['fax', 'email', 'sms', 'voice'];

  // Find roi_outgoing items that have a timed_out attempt and are now open
  const { data: chaseItems } = await sb
    .from('work_items')
    .select('*, outbound_attempts(id,channel,attempt_no,status)')
    .eq('queue_key', 'roi_outgoing')
    .in('status', ['open', 'waiting'])
    .eq('assignee', 'unassigned');

  for (const rawItem of chaseItems ?? []) {
    const ci = rawItem as WorkItem & {
      outbound_attempts: Array<{ id: string; channel: string; attempt_no: number; status: string }>;
    };

    const timedOut = (ci.outbound_attempts ?? []).filter((a) => a.status === 'timed_out');
    if (timedOut.length === 0) continue;

    // Find the highest attempt_no that timed out
    const latestTimedOut = timedOut.sort((a, b) => b.attempt_no - a.attempt_no)[0];
    const lastChannel = latestTimedOut.channel;
    const attemptNo = latestTimedOut.attempt_no;

    const nextChannelIdx = CHASE_ORDER.indexOf(lastChannel) + 1;

    if (nextChannelIdx >= CHASE_ORDER.length) {
      // All channels exhausted → escalate to human
      const claimed = await claimForChase(ci.id);
      if (!claimed) continue;

      await runTool(
        'escalate_to_human',
        ci.id,
        {
          question:
            'No response after 4 attempts across fax/email/SMS/voice — call them or close?',
        },
        'system',
      );
      report.escalations.push(ci.id);
      console.log(
        '[simulate.tick]',
        JSON.stringify({ event: 'chase_escalated', itemId: ci.id }),
      );
    } else {
      const nextChannel = CHASE_ORDER[nextChannelIdx];
      const claimed = await claimForChase(ci.id);
      if (!claimed) continue;

      // Create next attempt
      const orgId = ci.org_id ?? null;
      const contact = orgId ? await getOrgContact(orgId) : null;
      const contactSnapshot: Record<string, unknown> = {
        fax: contact?.fax,
        email: contact?.email,
        phone: contact?.phone,
      };

      const { data: newAttempt } = await sb
        .from('outbound_attempts')
        .insert({
          work_item_id: ci.id,
          channel: nextChannel,
          attempt_no: attemptNo + 1,
          to_org_id: orgId,
          to_contact: contactSnapshot,
          payload: {
            subject: `Records Request — Attempt ${attemptNo + 1}`,
            body: `This is follow-up attempt ${attemptNo + 1} via ${nextChannel}. Please provide the requested records.`,
          },
          status: 'sent',
          respond_after: new Date(Date.now() + (20 + Math.floor(Math.random() * 21)) * 1000).toISOString(),
        })
        .select('id')
        .single();

      // Log in audit
      if (newAttempt) {
        await sb.from('audit_log').insert({
          work_item_id: ci.id,
          actor: 'system',
          action: `send_${nextChannel}`,
          detail: {
            attempt_no: attemptNo + 1,
            channel: nextChannel,
            attempt_id: (newAttempt as { id: string }).id,
          },
        });
      }

      // Set item waiting
      await sb
        .from('work_items')
        .update({
          status: 'waiting',
          assignee: 'unassigned',
          agent_state: {
            ...(ci.agent_state ?? {}),
            attempt_no: attemptNo + 1,
            last_channel: nextChannel,
          },
          updated_at: now,
        })
        .eq('id', ci.id);

      report.chaseAttempts.push(ci.id);
      console.log(
        '[simulate.tick]',
        JSON.stringify({ event: 'chase_next', itemId: ci.id, channel: nextChannel, attemptNo: attemptNo + 1 }),
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

function buildSimulatedResponse(queueKey: string, _channel: string): Record<string, unknown> {
  if (queueKey === 'roi_outgoing') {
    return {
      status: 'records_provided',
      message: 'Records are attached. All requested documents are included.',
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

async function handleAttemptResponse(
  workItemId: string,
  queueKey: string,
  response: Record<string, unknown>,
  existingExtracted: Record<string, unknown>,
): Promise<void> {
  const sb = getSupabase();

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
    // Authorization or info arrived — merge into extracted_data, set back to open
    const mergedExtracted = { ...existingExtracted };
    if (response['authorization']) {
      mergedExtracted['authorization'] = response['authorization'];
    }
    await sb
      .from('work_items')
      .update({
        extracted_data: mergedExtracted,
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
