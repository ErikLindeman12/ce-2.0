import { NextResponse, type NextRequest } from 'next/server';
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

  const referralId = crypto.randomUUID();

  // For now we just log. These lines land in Vercel's runtime logs
  // (dashboard > project > Logs, or `vercel logs`). Later: persist to Supabase.
  console.log(
    '[referral.received]',
    JSON.stringify({ referralId, receivedAt: new Date().toISOString(), ...payload }),
  );

  return NextResponse.json({ status: 'accepted', referralId }, { status: 202 });
}
