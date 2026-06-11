import { NextResponse, type NextRequest } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { createWorkItem } from '@/lib/workItems';
import type { OutboundChannel } from '@/lib/types';

interface RoiPayload {
  patientId: string;
  orgId: string;
  recordsRequested: string;
  channel?: OutboundChannel;
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
  const preferredChannel = (payload.channel ?? orgContact['preferred_channel'] ?? 'fax') as OutboundChannel;

  const p = patient as { id: string; first_name: string; last_name: string; dob: string; mrn: string };

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
    },
  });

  // Set matched patient
  await sb
    .from('work_items')
    .update({ matched_patient_id: payload.patientId })
    .eq('id', item.id);

  // Create first outbound attempt
  const respondAfterSeconds = 20 + Math.floor(Math.random() * 21);
  const contactSnapshot: Record<string, unknown> = {
    fax: orgContact['fax'],
    email: orgContact['email'],
    phone: orgContact['phone'],
  };

  const { data: attempt, error: aErr } = await sb
    .from('outbound_attempts')
    .insert({
      work_item_id: item.id,
      channel: preferredChannel,
      attempt_no: 1,
      to_org_id: payload.orgId,
      to_contact: contactSnapshot,
      payload: {
        subject: 'Records Request',
        body: `Please provide the following records for patient ${p.first_name} ${p.last_name} (DOB ${p.dob}, MRN ${p.mrn}): ${payload.recordsRequested}`,
      },
      status: 'sent',
      respond_after: new Date(Date.now() + respondAfterSeconds * 1000).toISOString(),
    })
    .select('id')
    .single();

  if (aErr) {
    console.error('[roi.attempt_failed]', aErr.message);
    return NextResponse.json({ error: 'Failed to create outbound attempt' }, { status: 500 });
  }

  // Set item to waiting + track attempt_no
  await sb
    .from('work_items')
    .update({
      status: 'waiting',
      agent_state: { attempt_no: 1, last_channel: preferredChannel },
    })
    .eq('id', item.id);

  // Audit log
  await sb.from('audit_log').insert({
    work_item_id: item.id,
    actor: 'human',
    action: `send_${preferredChannel}`,
    detail: {
      attempt_id: (attempt as { id: string }).id,
      channel: preferredChannel,
      org_id: payload.orgId,
      records_requested: payload.recordsRequested,
    },
  });

  console.log(
    '[roi.composed]',
    JSON.stringify({
      itemId: item.id,
      orgId: payload.orgId,
      channel: preferredChannel,
      attemptId: (attempt as { id: string }).id,
    }),
  );

  return NextResponse.json(
    { status: 'created', itemId: item.id, attemptId: (attempt as { id: string }).id, channel: preferredChannel },
    { status: 201 },
  );
}
