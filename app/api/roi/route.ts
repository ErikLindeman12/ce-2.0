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

  // Fetch org + contact
  const { data: org, error: oErr } = await sb
    .from('organizations')
    .select('id,name,contact')
    .eq('id', payload.orgId)
    .single();

  if (oErr || !org) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
  }

  const orgContact = (org as { contact: Record<string, string> }).contact ?? {};
  const orgName = (org as { name: string }).name ?? '';

  const p = patient as { id: string; first_name: string; last_name: string; dob: string; mrn: string };

  // Build channel plan
  const plan = buildChannelPlan(
    { contact: orgContact as { fax?: string; email?: string; phone?: string; preferred_channel?: string } },
    payload.channel as import('@/lib/outbound').Channel | undefined,
    payload.waitSeconds,
  );

  const firstChannel = plan.channels[0] as OutboundChannel;
  const isPortal = firstChannel === 'portal';

  // Create work item in roi_outgoing
  const item = await createWorkItem({
    type: 'records_request_out',
    queue_key: 'roi_outgoing',
    source_channel: 'portal',
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

  // Set matched patient + agent_state with chase_plan and kind
  await sb
    .from('work_items')
    .update({
      matched_patient_id: payload.patientId,
      agent_state: {
        attempt_no: 1,
        last_channel: firstChannel,
        kind: 'records_request',
        chase_plan: { channels: plan.channels, waitSeconds: plan.waitSeconds },
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
    orgFax: orgContact['fax'],
    orgEmail: orgContact['email'],
    orgPhone: orgContact['phone'],
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

  // Portal: respond_after = null (never auto-timed-out)
  const respondAfterSeconds = plan.waitSeconds;
  const respondAfter = isPortal
    ? null
    : new Date(Date.now() + respondAfterSeconds * 1000).toISOString();

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
      chase_plan: plan,
    },
  });

  console.log(
    '[roi.composed]',
    JSON.stringify({
      itemId: item.id,
      orgId: payload.orgId,
      channel: firstChannel,
      waitSeconds: plan.waitSeconds,
      chasePlan: plan.channels,
      attemptId: (attempt as { id: string }).id,
    }),
  );

  return NextResponse.json(
    { data: { workItemId: item.id } },
    { status: 201 },
  );
}
