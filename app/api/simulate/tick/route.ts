import { NextResponse } from 'next/server';
import { tick } from '@/lib/simulate';

export async function POST() {
  try {
    const report = await tick();
    return NextResponse.json({ status: 'ok', report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[simulate.tick_failed]', msg);
    return NextResponse.json({ error: 'Tick failed' }, { status: 500 });
  }
}
