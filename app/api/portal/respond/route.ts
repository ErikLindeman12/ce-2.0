/**
 * POST /api/portal/respond
 *
 * W1b: This endpoint now only handles the authorization case.
 * External orgs use this to respond to a request_more_info attempt when
 * they are attaching a signed authorization (authorizationAttached: true).
 *
 * The old generic "respond to any outbound ROI" path is removed — external orgs
 * no longer answer our outgoing ROIs in-app. That path is now Care Everywhere
 * for Epic orgs and fax/voice for everyone else.
 *
 * Body: { attemptId, orgId, message?, authorizationAttached: true }
 */

import { NextResponse, type NextRequest } from 'next/server';
import { respondToAttempt } from '@/lib/portal';

interface RespondBody {
  attemptId?: string;
  orgId?: string;
  message?: string;
  authorizationAttached?: boolean;
}

export async function POST(req: NextRequest) {
  let body: RespondBody;

  try {
    body = (await req.json()) as RespondBody;
  } catch {
    return NextResponse.json({ error: { message: 'Invalid JSON body' } }, { status: 400 });
  }

  const { attemptId, orgId, message, authorizationAttached } = body;

  if (!attemptId || !orgId) {
    return NextResponse.json(
      { error: { message: 'attemptId and orgId are required' } },
      { status: 400 },
    );
  }

  // Guard: this endpoint is for the authorization case only
  if (!authorizationAttached) {
    return NextResponse.json(
      {
        error: {
          message:
            'This endpoint only accepts authorization responses (authorizationAttached: true). ' +
            'External orgs respond to outgoing ROIs via fax, email, or Care Everywhere — not in-app.',
        },
      },
      { status: 400 },
    );
  }

  try {
    await respondToAttempt(orgId, {
      attemptId,
      orgId,
      message,
      authorizationAttached: true,
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
