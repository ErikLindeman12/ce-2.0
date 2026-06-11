import { NextResponse, type NextRequest } from 'next/server';
import { getPortalInbox } from '@/lib/portal';

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get('orgId');
  if (!orgId) {
    return NextResponse.json({ error: { message: 'orgId is required' } }, { status: 400 });
  }

  try {
    const attempts = await getPortalInbox(orgId);
    return NextResponse.json({ data: attempts });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[portal.inbox.failed]', msg);
    return NextResponse.json({ error: { message: 'Failed to load inbox' } }, { status: 500 });
  }
}
