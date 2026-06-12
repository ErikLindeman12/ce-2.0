import { NextResponse, type NextRequest } from 'next/server';
import { listAgents, createAgent } from '@/lib/workItems';
import { parseSubscriptions } from '@/lib/platformConfig';

export async function GET() {
  try {
    const agents = await listAgents();
    return NextResponse.json(agents);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[agents.list_failed]', msg);
    return NextResponse.json({ error: 'Failed to list agents' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: {
    name: string;
    queue_key: string;
    enabled?: boolean;
    instructions?: string;
    tools?: string[];
    confidence_threshold?: number;
    model?: string;
    mode?: string;
    config?: Record<string, unknown>;
    subscriptions?: unknown;
    owner?: unknown;
  };

  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body?.name || !body?.queue_key) {
    return NextResponse.json({ error: 'Missing name or queue_key' }, { status: 400 });
  }

  // Whitelisted insert payload — extra keys never reach the DB.
  const payload: Record<string, unknown> = { name: body.name, queue_key: body.queue_key };
  for (const key of ['enabled', 'instructions', 'tools', 'confidence_threshold', 'model', 'mode', 'config'] as const) {
    if (key in body && body[key] !== undefined) payload[key] = body[key];
  }

  if (body.subscriptions !== undefined) {
    const subs = parseSubscriptions(body.subscriptions);
    if (!subs) {
      return NextResponse.json(
        { error: 'Invalid subscriptions — expected array of {event_type, filter?, on_event?}' },
        { status: 400 },
      );
    }
    payload['subscriptions'] = subs;
  }

  if (body.owner !== undefined) {
    if (body.owner !== null && typeof body.owner !== 'string') {
      return NextResponse.json({ error: 'Invalid owner — expected string' }, { status: 400 });
    }
    payload['owner'] = body.owner;
  }

  try {
    const agent = await createAgent(payload as Parameters<typeof createAgent>[0]);
    console.log('[agents.created]', JSON.stringify({ agentId: (agent as { id: string }).id, name: body.name }));
    return NextResponse.json(agent, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[agents.create_failed]', msg);
    return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 });
  }
}
