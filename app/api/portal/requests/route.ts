import { NextResponse, type NextRequest } from 'next/server';
import { getPortalRequests } from '@/lib/portal';

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get('orgId');
  if (!orgId) {
    return NextResponse.json({ error: { message: 'orgId is required' } }, { status: 400 });
  }

  try {
    const requests = await getPortalRequests(orgId);
    return NextResponse.json({ data: requests });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[portal.requests.failed]', msg);
    return NextResponse.json({ error: { message: 'Failed to load portal requests' } }, { status: 500 });
  }
}
