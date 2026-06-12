import { NextResponse } from 'next/server';
import { listEventTypes } from '@/lib/platformConfig';

/** GET /api/event-types — visible event taxonomy (builder dropdowns). */
export async function GET() {
  try {
    const types = await listEventTypes();
    return NextResponse.json({ data: types });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[event-types.list_failed]', msg);
    return NextResponse.json({ error: { message: 'Failed to list event types' } }, { status: 500 });
  }
}
