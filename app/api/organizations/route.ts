import { NextResponse, type NextRequest } from 'next/server';
import { searchOrgs } from '@/lib/organizations';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') ?? '';
  return NextResponse.json({ data: await searchOrgs(q) });
}
