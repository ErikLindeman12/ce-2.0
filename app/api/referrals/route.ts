import { NextResponse, type NextRequest } from 'next/server';
import type { SendReferralPayload } from '@/lib/types';
import { validatePayload, sendReferral, OrgNotFoundError } from '@/lib/referrals';

export async function POST(req: NextRequest) {
  let payload: SendReferralPayload;
  try {
    payload = (await req.json()) as SendReferralPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Validate required fields
  const validation = validatePayload(payload);
  if (!validation.valid) {
    return NextResponse.json(
      { error: 'missing_fields', fields: validation.missingFields },
      { status: 422 },
    );
  }

  try {
    const result = await sendReferral(payload);

    console.log(
      '[referral.received]',
      JSON.stringify({ referralId: result.referralId, dispatchStatus: result.dispatchStatus }),
    );

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof OrgNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }

    console.error('[referral.error]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Failed to save referral' }, { status: 500 });
  }
}
