import { NextResponse } from 'next/server';
import { getWorkItem } from '@/lib/workItems';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const { id } = params;
  try {
    const detail = await getWorkItem(id);
    if (!detail) {
      return NextResponse.json({ error: 'Work item not found' }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[work-items.get_failed]', msg);
    return NextResponse.json({ error: 'Failed to get work item' }, { status: 500 });
  }
}
