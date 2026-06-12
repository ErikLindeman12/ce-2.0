import { NextResponse, type NextRequest } from 'next/server';
import { injectInbound } from '@/lib/simulate';
import { pumpEvents } from '@/lib/dispatcher';
import type { ScenarioKey, BatchKey } from '@/lib/sampleDocs';

const VALID_SCENARIOS: ScenarioKey[] = [
  'fax_referral_clean',
  'fax_roi_clean',
  'fax_ambiguous_patient',
  'fax_messy',
  'dm_records_request',
  'fax_roi_missing_auth',
  'call_referral',
  'call_records_request',
  'fax_referral_partial',
  'fax_prior_auth',
];

const VALID_BATCHES: BatchKey[] = ['batch_morning'];

export async function POST(req: NextRequest) {
  let body: { scenario: string };
  try {
    body = (await req.json()) as { scenario: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const scenario = body?.scenario as string;

  if (VALID_BATCHES.includes(scenario as BatchKey)) {
    try {
      const result = await injectInbound(scenario as BatchKey);
      // Inline pump: routing + first agent turns happen before we respond.
      const pump = await pumpEvents({ maxRounds: 2, deadlineMs: 5000 });
      return NextResponse.json(
        { status: 'injected', itemIds: result.itemIds, count: result.itemIds.length, scenario, turns: pump.turns },
        { status: 201 },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[simulate.inbound_failed]', msg);
      return NextResponse.json({ error: 'Failed to inject batch scenario' }, { status: 500 });
    }
  }

  if (!VALID_SCENARIOS.includes(scenario as ScenarioKey)) {
    return NextResponse.json(
      {
        error: `Unknown scenario. Valid: ${[...VALID_SCENARIOS, ...VALID_BATCHES].join(', ')}`,
      },
      { status: 400 },
    );
  }

  try {
    const result = await injectInbound(scenario as ScenarioKey);
    // Inline pump: routing + first agent turns happen before we respond.
    const pump = await pumpEvents({ maxRounds: 2, deadlineMs: 5000 });
    return NextResponse.json(
      { status: 'injected', itemId: result.itemId, scenario, turns: pump.turns },
      { status: 201 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[simulate.inbound_failed]', msg);
    return NextResponse.json({ error: 'Failed to inject scenario' }, { status: 500 });
  }
}
