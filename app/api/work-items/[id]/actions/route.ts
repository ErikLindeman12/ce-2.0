import { NextResponse, type NextRequest } from 'next/server';
import { runTool } from '@/lib/tools';
import { pumpEvents } from '@/lib/dispatcher';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;

  let body: { tool: string; params?: Record<string, unknown> };
  try {
    body = (await req.json()) as { tool: string; params?: Record<string, unknown> };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body?.tool) {
    return NextResponse.json({ error: 'Missing tool name' }, { status: 400 });
  }

  try {
    const result = await runTool(body.tool, id, body.params ?? {}, 'human');
    // Inline pump: tool-emitted events cascade before we respond, so human
    // actions take effect immediately instead of waiting for the next tick.
    await pumpEvents({ maxRounds: 2, deadlineMs: 5000 });
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 422 });
    }
    return NextResponse.json({ status: 'ok', data: result.data }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[work-items.action_failed]', msg);
    return NextResponse.json({ error: 'Action failed' }, { status: 500 });
  }
}
