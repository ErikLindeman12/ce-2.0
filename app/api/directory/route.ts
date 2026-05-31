import { NextResponse, type NextRequest } from 'next/server';
import { searchDirectory } from '@/lib/directory';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') ?? '';
  return NextResponse.json({ data: await searchDirectory(q) });
}
