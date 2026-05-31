import { NextResponse, type NextRequest } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import type { SendReferralPayload } from '@/lib/types';

export async function POST(req: NextRequest) {
  let payload: SendReferralPayload;
  try {
    payload = (await req.json()) as SendReferralPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!payload?.toOrgId) {
    return NextResponse.json({ error: 'Missing toOrgId' }, { status: 400 });
  }

  const { data, error } = await getSupabase()
    .from('referrals')
    .insert({
      to_org_id: payload.toOrgId,
      to_org_name: payload.toOrgName,
      patient: payload.patient,
      request: payload.request,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[referral.insert_failed]', error.message);
    return NextResponse.json({ error: 'Failed to save referral' }, { status: 500 });
  }

  console.log(
    '[referral.received]',
    JSON.stringify({ referralId: data.id, receivedAt: new Date().toISOString(), ...payload }),
  );

  return NextResponse.json({ status: 'accepted', referralId: data.id }, { status: 202 });
}
