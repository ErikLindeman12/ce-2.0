import { getSupabase } from './supabase';
import type { SendReferralPayload, SendReferralResult, ReferralStatus } from './types';

// Baseline required fields — used until CE-18 lands the per-org
// referral_requirements table. Keys use dot-notation matching the
// SendReferralPayload shape.
const BASELINE_REQUIRED_FIELDS = [
  'patient.firstName',
  'patient.lastName',
  'patient.dateOfBirth',
  'request.dataType',
  'request.priority',
] as const;

const DISPATCH_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

export function validatePayload(
  payload: SendReferralPayload,
): { valid: true } | { valid: false; missingFields: string[] } {
  const missing: string[] = [];
  for (const field of BASELINE_REQUIRED_FIELDS) {
    const value = getNestedValue(payload as unknown as Record<string, unknown>, field);
    if (value === undefined || value === null || value === '') {
      missing.push(field);
    }
  }

  if (!payload.toOrgId) {
    missing.push('toOrgId');
  }

  if (missing.length > 0) {
    return { valid: false, missingFields: missing };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Dispatch stub
// ---------------------------------------------------------------------------

interface DispatchResult {
  status: ReferralStatus;
  error?: string;
}

async function dispatchToOrg(
  endpointUrl: string | null,
  referralPayload: SendReferralPayload,
): Promise<DispatchResult> {
  if (!endpointUrl) {
    console.log('[referral.dispatch_skipped] no endpoint_url configured');
    return { status: 'queued' };
  }

  try {
    const res = await fetch(endpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(referralPayload),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });

    if (res.ok) {
      console.log('[referral.dispatch_ok]', endpointUrl, res.status);
      return { status: 'sent' };
    }

    const errMsg = `HTTP ${res.status} ${res.statusText}`;
    console.error('[referral.dispatch_failed]', endpointUrl, errMsg);
    return { status: 'dispatch_failed', error: errMsg };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[referral.dispatch_failed]', endpointUrl, errMsg);
    return { status: 'dispatch_failed', error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Notification stub
// ---------------------------------------------------------------------------

function notifyStub(payload: SendReferralPayload, referralId: string): void {
  if (payload.notifyEmail) {
    console.log(
      '[referral.notification_stub]',
      JSON.stringify({ type: 'email', to: payload.notifyEmail, referralId }),
    );
  }
  if (payload.notifyPhone) {
    console.log(
      '[referral.notification_stub]',
      JSON.stringify({ type: 'sms', to: payload.notifyPhone, referralId }),
    );
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

interface OrgRow {
  id: string;
  endpoint_url: string;
}

export async function sendReferral(
  payload: SendReferralPayload,
): Promise<SendReferralResult> {
  // 1. Look up receiving org
  const { data: org, error: orgErr } = await getSupabase()
    .from('organizations')
    .select('id,endpoint_url')
    .eq('id', payload.toOrgId)
    .single<OrgRow>();

  if (orgErr || !org) {
    throw new OrgNotFoundError(payload.toOrgId);
  }

  // 2. Dispatch
  const dispatch = await dispatchToOrg(org.endpoint_url, payload);

  // 3. Insert referral with dispatch outcome
  const { data, error: insertErr } = await getSupabase()
    .from('referrals')
    .insert({
      to_org_id: payload.toOrgId,
      to_org_name: payload.toOrgName,
      patient: payload.patient,
      request: payload.request,
      status: dispatch.status,
      dispatch_error: dispatch.error ?? null,
    })
    .select('id')
    .single();

  if (insertErr || !data) {
    throw new Error(`referral insert failed: ${insertErr?.message ?? 'unknown'}`);
  }

  console.log(
    '[referral.saved]',
    JSON.stringify({ referralId: data.id, status: dispatch.status }),
  );

  // 4. Notification stub
  notifyStub(payload, data.id);

  return {
    referralId: data.id,
    status: dispatch.status,
    dispatchStatus: dispatch.status,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OrgNotFoundError extends Error {
  constructor(orgId: string) {
    super(`Organization not found: ${orgId}`);
    this.name = 'OrgNotFoundError';
  }
}
