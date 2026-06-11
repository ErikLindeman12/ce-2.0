import { NextResponse } from 'next/server';
import { listPatients } from '@/lib/workItems';
import { toPatientSummary } from '@/lib/types';

export async function GET() {
  try {
    const patients = await listPatients();
    const data = patients.map(toPatientSummary);
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('[patients.list_failed]', JSON.stringify({ error: msg }));
    return NextResponse.json({ error: { message: 'Failed to list patients' } }, { status: 500 });
  }
}
