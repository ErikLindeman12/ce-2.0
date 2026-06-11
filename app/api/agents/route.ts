import { NextResponse, type NextRequest } from 'next/server';
import { listAgents, createAgent } from '@/lib/workItems';

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
  };

  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body?.name || !body?.queue_key) {
    return NextResponse.json({ error: 'Missing name or queue_key' }, { status: 400 });
  }

  try {
    const agent = await createAgent(body);
    console.log('[agents.created]', JSON.stringify({ agentId: (agent as { id: string }).id, name: body.name }));
    return NextResponse.json(agent, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[agents.create_failed]', msg);
    return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 });
  }
}
