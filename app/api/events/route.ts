import { NextResponse, type NextRequest } from 'next/server';
import { emitEvent, latestEventOfType, listEvents } from '@/lib/events';
import { pumpEvents } from '@/lib/dispatcher';

/** GET /api/events?caseId=&limit= — event log (item timeline / activity feed). */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const caseId = sp.get('caseId') ?? undefined;
  const limitRaw = sp.get('limit');
  const limit =
    limitRaw !== null && Number.isFinite(Number(limitRaw)) && Number(limitRaw) > 0
      ? Math.floor(Number(limitRaw))
      : undefined;

  const events = await listEvents({ caseId, limit });
  return NextResponse.json({ data: events });
}

/**
 * POST /api/events — manual emission (the builder's "fire sample event").
 * Body: {type, caseId?, payload?} emits a fresh event as actor 'human';
 * {replayType} re-emits the latest event of that type as a NEW human event
 * with the same case_id + payload. Either path ends with an inline pump.
 */
export async function POST(req: NextRequest) {
  let body: {
    type?: string;
    caseId?: string;
    payload?: Record<string, unknown>;
    replayType?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: { message: 'Invalid JSON body' } }, { status: 400 });
  }

  if (body?.replayType) {
    if (typeof body.replayType !== 'string') {
      return NextResponse.json({ error: { message: 'Invalid replayType' } }, { status: 400 });
    }
    const prior = await latestEventOfType(body.replayType);
    if (!prior) {
      return NextResponse.json(
        { error: { message: `No prior event of type '${body.replayType}' to replay` } },
        { status: 404 },
      );
    }
    const event = await emitEvent({
      type: prior.type,
      caseId: prior.case_id,
      payload: prior.payload,
      actor: 'human',
    });
    if (!event) {
      return NextResponse.json({ error: { message: 'Failed to emit event' } }, { status: 500 });
    }
    const pump = await pumpEvents({ maxRounds: 2, deadlineMs: 5000 });
    console.log('[events.replayed]', JSON.stringify({ type: event.type, caseId: event.case_id, turns: pump.turns }));
    return NextResponse.json({ data: { event, turns: pump.turns } }, { status: 201 });
  }

  if (!body?.type || typeof body.type !== 'string') {
    return NextResponse.json({ error: { message: 'Missing event type' } }, { status: 400 });
  }

  const event = await emitEvent({
    type: body.type,
    caseId: body.caseId ?? null,
    payload: body.payload ?? {},
    actor: 'human',
  });
  if (!event) {
    return NextResponse.json({ error: { message: 'Failed to emit event' } }, { status: 500 });
  }

  const pump = await pumpEvents({ maxRounds: 2, deadlineMs: 5000 });
  console.log('[events.emitted_api]', JSON.stringify({ type: event.type, caseId: event.case_id, turns: pump.turns }));
  return NextResponse.json({ data: { event, turns: pump.turns } }, { status: 201 });
}
