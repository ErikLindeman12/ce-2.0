import { NextResponse, type NextRequest } from 'next/server';
import { getAgent, updateAgent } from '@/lib/workItems';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const { id } = params;
  try {
    const agent = await getAgent(id);
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    return NextResponse.json(agent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[agents.get_failed]', msg);
    return NextResponse.json({ error: 'Failed to get agent' }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Whitelist updatable fields — config is a jsonb passthrough (no stats logic touched)
  const allowed = ['name', 'enabled', 'instructions', 'tools', 'confidence_threshold', 'model', 'mode', 'config'];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  try {
    const agent = await updateAgent(id, updates);
    console.log('[agents.updated]', JSON.stringify({ agentId: id, fields: Object.keys(updates) }));
    return NextResponse.json(agent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[agents.update_failed]', msg);
    return NextResponse.json({ error: 'Failed to update agent' }, { status: 500 });
  }
}
