import { NextResponse } from 'next/server';
import { listQueues } from '@/lib/workItems';

export async function GET() {
  try {
    const queues = await listQueues();
    return NextResponse.json(queues);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[queues.list_failed]', msg);
    return NextResponse.json({ error: 'Failed to list queues' }, { status: 500 });
  }
}
