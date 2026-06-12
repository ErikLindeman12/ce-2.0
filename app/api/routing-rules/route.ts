import { NextResponse, type NextRequest } from 'next/server';
import { createRoutingRule, listRoutingRules } from '@/lib/platformConfig';

/** GET /api/routing-rules — all rules ordered by (event_type, priority). */
export async function GET() {
  try {
    const rules = await listRoutingRules();
    return NextResponse.json({ data: rules });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[routing-rules.list_failed]', msg);
    return NextResponse.json({ error: { message: 'Failed to list routing rules' } }, { status: 500 });
  }
}

/** POST /api/routing-rules — create a rule {event_type, filter?, queue_key, priority?, owner?}. */
export async function POST(req: NextRequest) {
  let body: {
    event_type?: string;
    filter?: Record<string, unknown>;
    queue_key?: string;
    priority?: number;
    owner?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: { message: 'Invalid JSON body' } }, { status: 400 });
  }

  if (!body?.event_type || typeof body.event_type !== 'string') {
    return NextResponse.json({ error: { message: 'Missing event_type' } }, { status: 400 });
  }
  if (!body?.queue_key || typeof body.queue_key !== 'string') {
    return NextResponse.json({ error: { message: 'Missing queue_key' } }, { status: 400 });
  }
  if (body.filter !== undefined && (typeof body.filter !== 'object' || body.filter === null || Array.isArray(body.filter))) {
    return NextResponse.json({ error: { message: 'Invalid filter — expected object' } }, { status: 400 });
  }
  if (body.priority !== undefined && typeof body.priority !== 'number') {
    return NextResponse.json({ error: { message: 'Invalid priority — expected number' } }, { status: 400 });
  }
  if (body.owner !== undefined && typeof body.owner !== 'string') {
    return NextResponse.json({ error: { message: 'Invalid owner — expected string' } }, { status: 400 });
  }

  try {
    const rule = await createRoutingRule({
      event_type: body.event_type,
      filter: body.filter,
      queue_key: body.queue_key,
      priority: body.priority,
      owner: body.owner,
    });
    return NextResponse.json({ data: rule }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[routing-rules.create_failed]', msg);
    return NextResponse.json({ error: { message: 'Failed to create routing rule' } }, { status: 500 });
  }
}
