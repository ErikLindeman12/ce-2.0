import { NextResponse, type NextRequest } from 'next/server';
import { listWorkItems } from '@/lib/workItems';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const queue = searchParams.get('queue') ?? undefined;

  try {
    const items = await listWorkItems(queue);
    return NextResponse.json(items);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[work-items.list_failed]', msg);
    return NextResponse.json({ error: 'Failed to list work items' }, { status: 500 });
  }
}
