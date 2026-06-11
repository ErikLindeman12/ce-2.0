import { NextResponse, type NextRequest } from 'next/server';
import { injectInbound } from '@/lib/simulate';
import type { ScenarioKey } from '@/lib/sampleDocs';

const VALID_SCENARIOS: ScenarioKey[] = [
  'fax_referral_clean',
  'fax_roi_clean',
  'fax_ambiguous_patient',
  'fax_messy',
  'dm_records_request',
  'fax_roi_missing_auth',
];

export async function POST(req: NextRequest) {
  let body: { scenario: string };
  try {
    body = (await req.json()) as { scenario: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const scenario = body?.scenario as ScenarioKey;
  if (!VALID_SCENARIOS.includes(scenario)) {
    return NextResponse.json(
      { error: `Unknown scenario. Valid: ${VALID_SCENARIOS.join(', ')}` },
      { status: 400 },
    );
  }

  try {
    const item = await injectInbound(scenario);
    return NextResponse.json({ status: 'injected', itemId: item.id, scenario }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[simulate.inbound_failed]', msg);
    return NextResponse.json({ error: 'Failed to inject scenario' }, { status: 500 });
  }
}
