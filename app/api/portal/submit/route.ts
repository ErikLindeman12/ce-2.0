import { NextResponse, type NextRequest } from 'next/server';
import { submitPortalRequest } from '@/lib/portal';

interface SubmitBody {
  orgId?: string;
  patientFirstName?: string;
  patientLastName?: string;
  patientDob?: string;
  recordsRequested?: string;
  authorizationAttached?: boolean;
  priority?: 'routine' | 'urgent' | 'stat';
}

export async function POST(req: NextRequest) {
  let body: SubmitBody;
  try {
    body = (await req.json()) as SubmitBody;
  } catch {
    return NextResponse.json({ error: { message: 'Invalid JSON body' } }, { status: 400 });
  }

  const { orgId, patientFirstName, patientLastName, patientDob, recordsRequested, authorizationAttached, priority } = body;

  if (!orgId || !patientFirstName || !patientLastName || !patientDob || !recordsRequested) {
    return NextResponse.json(
      {
        error: {
          message:
            'orgId, patientFirstName, patientLastName, patientDob, and recordsRequested are required',
        },
      },
      { status: 400 },
    );
  }

  try {
    const result = await submitPortalRequest({
      orgId,
      patientFirstName,
      patientLastName,
      patientDob,
      recordsRequested,
      authorizationAttached: authorizationAttached ?? false,
      priority,
    });
    return NextResponse.json({ data: { itemId: result.itemId } }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[portal.submit.failed]', msg);
    return NextResponse.json({ error: { message: 'Failed to submit portal request' } }, { status: 500 });
  }
}
