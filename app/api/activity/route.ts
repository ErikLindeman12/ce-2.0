import { NextResponse, type NextRequest } from 'next/server';
import { recentActivity } from '@/lib/workItems';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = parseInt(searchParams.get('limit') ?? '30', 10);

  try {
    const activity = await recentActivity(Math.min(limit, 100));
    return NextResponse.json(activity);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[activity.list_failed]', msg);
    return NextResponse.json({ error: 'Failed to get activity' }, { status: 500 });
  }
}
