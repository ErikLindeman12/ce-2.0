import { NextResponse, type NextRequest } from 'next/server';
import { respondToAttempt } from '@/lib/portal';

export async function POST(req: NextRequest) {
  let body: {
    attemptId?: string;
    orgId?: string;
    message?: string;
    recordsAttached?: boolean;
    authorizationAttached?: boolean;
  };

  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: { message: 'Invalid JSON body' } }, { status: 400 });
  }

  const { attemptId, orgId, message, recordsAttached, authorizationAttached } = body;

  if (!attemptId || !orgId || !message) {
    return NextResponse.json(
      { error: { message: 'attemptId, orgId, and message are required' } },
      { status: 400 },
    );
  }

  try {
    await respondToAttempt(orgId, {
      attemptId,
      message,
      recordsAttached: recordsAttached ?? false,
      authorizationAttached: authorizationAttached ?? false,
    });
    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    const status =
      typeof err === 'object' && err !== null && 'status' in err
        ? (err as { status: number }).status
        : 500;
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[portal.respond.failed]', msg);
    return NextResponse.json({ error: { message: msg } }, { status });
  }
}
