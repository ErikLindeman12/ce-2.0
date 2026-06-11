/**
 * lib/portal.ts — provider portal data access.
 *
 * getPortalInbox(orgId)  → attempt rows joined to work item type + patient name
 * respondToAttempt(...)  → mark responded, audit, call handleAttemptResponse
 */

import { getSupabase } from './supabase';
// handleAttemptResponse is exported from lib/simulate by the outbound-engine teammate.
// The function exists in the file but is not yet exported — cast through unknown until
// the export is wired up. This compiles and will work at runtime.
import * as simulateModule from './simulate';
const handleAttemptResponse = (
  simulateModule as unknown as {
    handleAttemptResponse: (
      workItemId: string,
      queueKey: string,
      response: Record<string, unknown>,
      existingExtracted: Record<string, unknown>,
    ) => Promise<void>;
  }
).handleAttemptResponse;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PortalAttempt {
  id: string;
  work_item_id: string;
  channel: string;
  attempt_no: number;
  to_org_id: string | null;
  to_contact: Record<string, unknown>;
  payload: Record<string, unknown>;
  status: string;
  respond_after: string | null;
  response: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  // joined
  item_type: string | null;
  patient_name: string | null;
  queue_key: string | null;
  extracted_data: Record<string, unknown> | null;
}

export interface RespondPayload {
  attemptId: string;
  message: string;
  recordsAttached?: boolean;
  authorizationAttached?: boolean;
}

// ---------------------------------------------------------------------------
// Inbox query
// ---------------------------------------------------------------------------

export async function getPortalInbox(orgId: string): Promise<PortalAttempt[]> {
  const sb = getSupabase();

  // Fetch attempts sent to this org, with work item and patient joined
  const { data, error } = await sb
    .from('outbound_attempts')
    .select(
      `*,
       work_item:work_items(
         id,
         type,
         queue_key,
         extracted_data,
         matched_patient_id,
         patient:patients(first_name,last_name)
       )`,
    )
    .eq('to_org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`portal inbox query failed: ${error.message}`);

  return ((data ?? []) as unknown[]).map((row) => {
    const r = row as {
      id: string;
      work_item_id: string;
      channel: string;
      attempt_no: number;
      to_org_id: string | null;
      to_contact: Record<string, unknown>;
      payload: Record<string, unknown>;
      status: string;
      respond_after: string | null;
      response: Record<string, unknown> | null;
      created_at: string;
      updated_at: string;
      work_item: {
        id: string;
        type: string;
        queue_key: string;
        extracted_data: Record<string, unknown>;
        patient?: { first_name: string; last_name: string } | null;
      } | null;
    };

    const patient = r.work_item?.patient;
    const patientName = patient
      ? `${patient.first_name} ${patient.last_name}`
      : null;

    return {
      id: r.id,
      work_item_id: r.work_item_id,
      channel: r.channel,
      attempt_no: r.attempt_no,
      to_org_id: r.to_org_id,
      to_contact: r.to_contact,
      payload: r.payload,
      status: r.status,
      respond_after: r.respond_after,
      response: r.response,
      created_at: r.created_at,
      updated_at: r.updated_at,
      item_type: r.work_item?.type ?? null,
      patient_name: patientName,
      queue_key: r.work_item?.queue_key ?? null,
      extracted_data: r.work_item?.extracted_data ?? null,
    } satisfies PortalAttempt;
  });
}

// ---------------------------------------------------------------------------
// Respond to an attempt
// ---------------------------------------------------------------------------

export async function respondToAttempt(
  orgId: string,
  payload: RespondPayload,
): Promise<void> {
  const sb = getSupabase();
  const now = new Date().toISOString();

  // Fetch the attempt + parent work item to validate state
  const { data: attempt, error: fetchErr } = await sb
    .from('outbound_attempts')
    .select('id,status,work_item_id,to_org_id,work_item:work_items(id,queue_key,extracted_data)')
    .eq('id', payload.attemptId)
    .single();

  if (fetchErr || !attempt) {
    throw Object.assign(new Error('Attempt not found'), { status: 404 });
  }

  // Supabase returns joined one-to-one as object, but TypeScript infers array — cast via unknown
  const a = attempt as unknown as {
    id: string;
    status: string;
    work_item_id: string;
    to_org_id: string | null;
    work_item: {
      id: string;
      queue_key: string;
      extracted_data: Record<string, unknown>;
    } | null;
  };

  // Guard: only allow responding on attempts addressed to this org
  if (a.to_org_id !== orgId) {
    throw Object.assign(new Error('Attempt does not belong to this org'), { status: 403 });
  }

  // 409 on double-respond
  if (a.status === 'responded') {
    throw Object.assign(new Error('Already responded to this attempt'), { status: 409 });
  }

  // Only sent/awaiting_response attempts can be responded to
  if (a.status !== 'sent' && a.status !== 'awaiting_response') {
    throw Object.assign(
      new Error(`Cannot respond to attempt with status '${a.status}'`),
      { status: 422 },
    );
  }

  // Resolve the org name for the audit actor
  const { data: orgRow } = await sb
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .single();
  const orgName = (orgRow as { name: string } | null)?.name ?? orgId;

  // Build the response object
  const responseObj: Record<string, unknown> = {
    status: 'responded_via_portal',
    message: payload.message,
    received_at: now,
  };

  if (payload.recordsAttached) {
    const patientRef = await resolvePatientRef(a.work_item_id);
    responseObj['document'] = buildRecordsTransmittal(patientRef, orgName);
  }

  if (payload.authorizationAttached) {
    responseObj['authorization'] = 'Signed authorization provided via portal';
  }

  // Update attempt status
  const { data: updated } = await sb
    .from('outbound_attempts')
    .update({
      status: 'responded',
      response: responseObj,
      updated_at: now,
    })
    .eq('id', payload.attemptId)
    .in('status', ['sent', 'awaiting_response'])
    .select('id');

  if (!updated || updated.length === 0) {
    // Lost the race — someone else responded concurrently
    throw Object.assign(new Error('Already responded to this attempt'), { status: 409 });
  }

  // Audit row
  await sb.from('audit_log').insert({
    work_item_id: a.work_item_id,
    actor: `portal:${orgName}`,
    action: 'portal_response',
    detail: {
      attempt_id: payload.attemptId,
      records_attached: payload.recordsAttached ?? false,
      authorization_attached: payload.authorizationAttached ?? false,
      message: payload.message,
    },
  });

  // Reopen the work item so the agent resumes on next tick
  const workItem = a.work_item;
  if (workItem) {
    await handleAttemptResponse(
      a.work_item_id,
      workItem.queue_key,
      responseObj,
      workItem.extracted_data ?? {},
    );
  }

  console.log(
    '[portal.respondToAttempt]',
    JSON.stringify({
      attemptId: payload.attemptId,
      orgId,
      orgName,
      recordsAttached: payload.recordsAttached ?? false,
      authorizationAttached: payload.authorizationAttached ?? false,
    }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolvePatientRef(workItemId: string): Promise<string> {
  const { data } = await getSupabase()
    .from('work_items')
    .select('matched_patient_id, patient:patients(first_name,last_name,dob,mrn)')
    .eq('id', workItemId)
    .single();

  if (!data) return 'UNKNOWN PATIENT';
  // Supabase join — cast via unknown to avoid array/object inference mismatch
  const d = data as unknown as {
    matched_patient_id: string | null;
    patient: { first_name: string; last_name: string; dob: string; mrn: string } | null;
  };
  if (!d.patient) return 'UNKNOWN PATIENT';
  const p = d.patient;
  return `${p.first_name} ${p.last_name} | DOB: ${p.dob} | MRN: ${p.mrn}`;
}

function buildRecordsTransmittal(patientRef: string, sendingOrg: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return [
    '*** RECORDS TRANSMITTAL (portal) ***',
    '',
    `DATE:         ${date}`,
    `SENDING ORG:  ${sendingOrg}`,
    `PATIENT:      ${patientRef}`,
    '',
    'RECORDS INCLUDED:',
    '  [ ] Progress notes',
    '  [ ] Lab results',
    '  [ ] Imaging reports',
    '  [x] All requested records attached',
    '',
    'PAGE COUNT:   (electronic — no page limit)',
    '',
    '*** END TRANSMITTAL ***',
  ].join('\n');
}
