import { NextResponse, type NextRequest } from 'next/server';
import { searchDirectory } from '@/lib/directory';
import type { DirectoryFilters } from '@/lib/types';

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const filters: DirectoryFilters = {
    q: params.get('q') ?? undefined,
    specialty: params.get('specialty') ?? undefined,
    city: params.get('city') ?? undefined,
    state: params.get('state') ?? undefined,
  };
  return NextResponse.json({ data: await searchDirectory(filters) });
}
