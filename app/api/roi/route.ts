import { NextResponse, type NextRequest } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { createWorkItem } from '@/lib/workItems';
import { buildChannelPlan } from '@/lib/outbound';
import { emitEvent } from '@/lib/events';
import { pumpEvents } from '@/lib/dispatcher';
import { findAgentSubscribedTo } from '@/lib/platformConfig';
import type { OutboundChannel } from '@/lib/types';

interface RoiPayload {
  patientId: string;
  orgId: string;
  recordsRequested: string;
  channel?: OutboundChannel;
  waitSeconds?: number;
}

/**
 * Compose an outgoing records request. Event-first: this route resolves the
 * chase plan and creates the case, then emits `case.created` — the subscribed
 * chasing agent sends rung 1 (incl. Care Everywhere) on its first turn inside
 * the inline pump. No outbound_attempt is created here.
 */
export async function POST(req: NextRequest) {
  let payload: RoiPayload;
  try {
    payload = (await req.json()) as RoiPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!payload?.patientId || !payload?.orgId || !payload?.recordsRequested) {
    return NextResponse.json(
      { error: 'Missing patientId, orgId, or recordsRequested' },
      { status: 400 },
    );
  }

  const sb = getSupabase();

  // Fetch patient
  const { data: patient, error: pErr } = await sb
    .from('patients')
    .select('id,first_name,last_name,dob,mrn')
    .eq('id', payload.patientId)
    .single();

  if (pErr || !patient) {
    return NextResponse.json({ error: 'Patient not found' }, { status: 404 });
  }

  // Fetch org + contact + channels (for Epic/Care Everywhere detection)
  const { data: org, error: oErr } = await sb
    .from('organizations')
    .select('id,name,contact,channels')
    .eq('id', payload.orgId)
    .single();

  if (oErr || !org) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
  }

  const orgRow = org as {
    id: string;
    name: string;
    contact: Record<string, unknown>;
    channels: string[];
  };
  const orgContact = orgRow.contact ?? {};
  const orgName = orgRow.name ?? '';
  const orgChannels = orgRow.channels ?? [];

  const p = patient as { id: string; first_name: string; last_name: string; dob: string; mrn: string };

  // Resolve the chasing agent BY SUBSCRIPTION (case.created on
  // records_request_out), not by name. Null-safe: no agent → plan from
  // org/defaults only.
  const chaser = await findAgentSubscribedTo('case.created', 'records_request_out');
  const agentConfig = chaser?.config ?? {};

  // Build channel plan (step-based shape): org + agent config + form override
  const plan = buildChannelPlan(
    {
      channels: orgChannels,
      contact: orgContact as { fax?: string; email?: string; phone?: string; preferred_channel?: string; chase_policy?: { steps?: string[]; waitSeconds?: number } },
    },
    agentConfig as { chase_policy?: { steps?: string[]; waitSeconds?: number } },
    payload.channel as import('@/lib/outbound').Channel | undefined,
    payload.waitSeconds,
  );

  // Create work item in roi_outgoing
  const item = await createWorkItem({
    type: 'records_request_out',
    queue_key: 'roi_outgoing',
    source_channel: 'internal',
    org_id: payload.orgId,
    extracted_data: {
      patient_first_name: p.first_name,
      patient_last_name: p.last_name,
      patient_dob: p.dob,
      patient_mrn: p.mrn,
      records_requested: payload.recordsRequested,
      org_name: orgName,
    },
  });

  // Set matched patient + the resolved chase plan. No attempt_no — the chasing
  // agent's ladder cursor starts at 0 and sends rung 1 itself.
  await sb
    .from('work_items')
    .update({
      matched_patient_id: payload.patientId,
      agent_state: {
        kind: 'records_request',
        chase_plan: {
          steps: plan.steps,
          waitSeconds: plan.waitSeconds,
        },
      },
    })
    .eq('id', item.id);

  // Audit: the human composed the request (the send is the agent's turn).
  await sb.from('audit_log').insert({
    work_item_id: item.id,
    actor: 'human',
    action: 'roi_composed',
    detail: {
      org_id: payload.orgId,
      records_requested: payload.recordsRequested,
      chase_plan: { steps: plan.steps, waitSeconds: plan.waitSeconds },
      agent: chaser?.name ?? null,
    },
  });

  // Event-first handoff: case.created wakes the subscribed chasing agent.
  const event = await emitEvent({
    type: 'case.created',
    caseId: item.id,
    payload: { case_type: 'records_request_out' },
    actor: 'human',
  });
  if (!event) {
    console.error('[roi.emit_failed]', JSON.stringify({ itemId: item.id }));
    return NextResponse.json({ error: 'Failed to emit case.created' }, { status: 500 });
  }

  // Inline pump so rung 1 goes out before we respond.
  const pump = await pumpEvents({ maxRounds: 2, deadlineMs: 5000 });

  console.log(
    '[roi.composed]',
    JSON.stringify({
      itemId: item.id,
      orgId: payload.orgId,
      waitSeconds: plan.waitSeconds,
      stepCount: plan.steps.length,
      steps: plan.steps.map((s) => `${s.channel}#${s.attempt}`).join(' → '),
      agent: chaser?.name ?? null,
      turns: pump.turns,
    }),
  );

  return NextResponse.json(
    { data: { workItemId: item.id } },
    { status: 201 },
  );
}
