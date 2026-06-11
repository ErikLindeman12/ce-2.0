import { NextResponse, type NextRequest } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { createWorkItem } from '@/lib/workItems';
import { buildChannelPlan, renderOutboundDocument } from '@/lib/outbound';
import type { OutboundChannel } from '@/lib/types';

interface RoiPayload {
  patientId: string;
  orgId: string;
  recordsRequested: string;
  channel?: OutboundChannel;
  waitSeconds?: number;
}

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

  // Fetch Records Chaser agent config for chase_policy fallback
  const { data: agentRow } = await sb
    .from('agents')
    .select('config')
    .eq('name', 'Records Chaser')
    .single();
  const agentConfig = (agentRow as { config: Record<string, unknown> } | null)?.config ?? {};

  // Build channel plan (new step-based shape)
  const plan = buildChannelPlan(
    {
      channels: orgChannels,
      contact: orgContact as { fax?: string; email?: string; phone?: string; preferred_channel?: string; chase_policy?: { steps?: string[]; waitSeconds?: number } },
    },
    agentConfig as { chase_policy?: { steps?: string[]; waitSeconds?: number } },
    payload.channel as import('@/lib/outbound').Channel | undefined,
    payload.waitSeconds,
  );

  const firstStep = plan.steps[0];
  const firstChannel = firstStep.channel as OutboundChannel;
  const isCareEverywhere = firstChannel === 'care_everywhere';

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

  // Set matched patient + agent_state with NEW step-based chase_plan
  await sb
    .from('work_items')
    .update({
      matched_patient_id: payload.patientId,
      agent_state: {
        attempt_no: 1,
        last_channel: firstChannel,
        kind: 'records_request',
        chase_plan: {
          steps: plan.steps,
          waitSeconds: plan.waitSeconds,
        },
      },
    })
    .eq('id', item.id);

  // Render outbound document for first attempt
  const outboundCtx: import('@/lib/outbound').OutboundContext = {
    itemId: item.id,
    patientName: `${p.first_name} ${p.last_name}`,
    patientDob: p.dob,
    patientMrn: p.mrn,
    recordsRequested: payload.recordsRequested,
    orgName,
    orgFax: orgContact['fax'] as string | undefined,
    orgEmail: orgContact['email'] as string | undefined,
    orgPhone: orgContact['phone'] as string | undefined,
    attemptNo: 1,
  };
  const rendered = renderOutboundDocument(
    firstChannel as import('@/lib/outbound').Channel,
    'records_request',
    outboundCtx,
  );

  const contactSnapshot: Record<string, unknown> = {
    fax: orgContact['fax'],
    email: orgContact['email'],
    phone: orgContact['phone'],
  };

  // care_everywhere: respond_after = now + 8s
  // portal: respond_after = null (never auto-timed-out)
  // others: use plan.waitSeconds
  let respondAfter: string | null;
  if (isCareEverywhere) {
    respondAfter = new Date(Date.now() + 8000).toISOString();
  } else if (firstChannel === 'portal') {
    respondAfter = null;
  } else {
    respondAfter = new Date(Date.now() + plan.waitSeconds * 1000).toISOString();
  }

  const { data: attempt, error: aErr } = await sb
    .from('outbound_attempts')
    .insert({
      work_item_id: item.id,
      channel: firstChannel,
      attempt_no: 1,
      to_org_id: payload.orgId,
      to_contact: contactSnapshot,
      payload: {
        subject: rendered.subject,
        body: rendered.body,
        document: rendered.document,
        kind: 'records_request',
      },
      status: 'sent',
      respond_after: respondAfter,
    })
    .select('id')
    .single();

  if (aErr) {
    console.error('[roi.attempt_failed]', aErr.message);
    return NextResponse.json({ error: 'Failed to create outbound attempt' }, { status: 500 });
  }

  // Set item to waiting
  await sb
    .from('work_items')
    .update({ status: 'waiting' })
    .eq('id', item.id);

  // Audit log
  await sb.from('audit_log').insert({
    work_item_id: item.id,
    actor: 'human',
    action: `send_${firstChannel}`,
    detail: {
      attempt_id: (attempt as { id: string }).id,
      channel: firstChannel,
      org_id: payload.orgId,
      records_requested: payload.recordsRequested,
      chase_plan: { steps: plan.steps, waitSeconds: plan.waitSeconds },
    },
  });

  console.log(
    '[roi.composed]',
    JSON.stringify({
      itemId: item.id,
      orgId: payload.orgId,
      channel: firstChannel,
      waitSeconds: plan.waitSeconds,
      stepCount: plan.steps.length,
      steps: plan.steps.map((s) => `${s.channel}#${s.attempt}`).join(' → '),
      attemptId: (attempt as { id: string }).id,
    }),
  );

  return NextResponse.json(
    { data: { workItemId: item.id } },
    { status: 201 },
  );
}
