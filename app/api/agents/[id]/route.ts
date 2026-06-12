import { NextResponse, type NextRequest } from 'next/server';
import { getAgent, updateAgent } from '@/lib/workItems';
import { parseSubscriptions, replayShadowedDeliveries } from '@/lib/platformConfig';
import { pumpEvents } from '@/lib/dispatcher';

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

  // Whitelist updatable fields — config/subscriptions are jsonb passthroughs
  const allowed = ['name', 'enabled', 'instructions', 'tools', 'confidence_threshold', 'model', 'mode', 'config', 'subscriptions', 'owner'];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  if ('subscriptions' in updates) {
    const subs = parseSubscriptions(updates['subscriptions']);
    if (!subs) {
      return NextResponse.json(
        { error: 'Invalid subscriptions — expected array of {event_type, filter?, on_event?}' },
        { status: 400 },
      );
    }
    updates['subscriptions'] = subs;
  }

  if ('owner' in updates && updates['owner'] !== null && typeof updates['owner'] !== 'string') {
    return NextResponse.json({ error: 'Invalid owner — expected string' }, { status: 400 });
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  try {
    // Detect a mode flip FROM 'shadow' TO live BEFORE writing — the prior mode
    // decides whether shadowed deliveries get replayed (spec invariant 6).
    let flipFromShadow = false;
    if (updates['mode'] === 'supervised' || updates['mode'] === 'autonomous') {
      const current = (await getAgent(id)) as { mode?: string } | null;
      flipFromShadow = current?.mode === 'shadow';
    }

    const agent = await updateAgent(id, updates);
    console.log('[agents.updated]', JSON.stringify({ agentId: id, fields: Object.keys(updates), flipFromShadow }));

    if (flipFromShadow) {
      const replayed = await replayShadowedDeliveries(id);
      // Inline pump: the replayed deliveries run for real before we respond.
      await pumpEvents({ maxRounds: 2, deadlineMs: 5000 });
      return NextResponse.json({ ...(agent as Record<string, unknown>), replayed });
    }

    return NextResponse.json(agent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[agents.update_failed]', msg);
    return NextResponse.json({ error: 'Failed to update agent' }, { status: 500 });
  }
}
