import { NextResponse, type NextRequest } from 'next/server';
import { searchProviders } from '@/lib/providers';

export async function GET(req: NextRequest) {
  const specialty = req.nextUrl.searchParams.get('specialty') ?? undefined;
  const orgId = req.nextUrl.searchParams.get('org_id') ?? undefined;
  const query = req.nextUrl.searchParams.get('q') ?? undefined;

  return NextResponse.json({
    data: await searchProviders({ query, specialty, orgId }),
  });
}
