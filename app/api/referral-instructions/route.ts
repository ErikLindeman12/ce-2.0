import { NextResponse, type NextRequest } from 'next/server';
import { getReferralInstructions } from '@/lib/referralInstructions';

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get('orgId') ?? undefined;
  const providerId = req.nextUrl.searchParams.get('providerId') ?? undefined;

  if (!orgId && !providerId) {
    return NextResponse.json(
      { error: 'At least one of orgId or providerId is required' },
      { status: 400 },
    );
  }

  const result = await getReferralInstructions({ orgId, providerId });

  if (!result) {
    return NextResponse.json({ error: 'Organization or provider not found' }, { status: 404 });
  }

  return NextResponse.json({ data: result });
}
