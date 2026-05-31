import { NextResponse, type NextRequest } from 'next/server';
import { searchProviders } from '@/lib/providers';

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  return NextResponse.json({
    data: await searchProviders({
      q: params.get('q') ?? undefined,
      specialty: params.get('specialty') ?? undefined,
      orgId: params.get('org_id') ?? undefined,
      city: params.get('city') ?? undefined,
      state: params.get('state') ?? undefined,
    }),
  });
}
