import { NextResponse, type NextRequest } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { buildChannelPlan, isEpicOrg, type Channel } from '@/lib/outbound';
import { findAgentSubscribedTo } from '@/lib/platformConfig';

const CHANNELS: readonly string[] = ['fax', 'email', 'sms', 'voice', 'portal', 'care_everywhere'];

/**
 * GET /api/roi/plan-preview?orgId=&channel=&waitSeconds=
 * Computes the same chase plan the ROI composer would resolve (same
 * agent-by-subscription resolution + buildChannelPlan) without creating
 * anything — powers the compose form's live preview.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const orgId = sp.get('orgId');
  if (!orgId) {
    return NextResponse.json({ error: { message: 'Missing orgId' } }, { status: 400 });
  }

  const channelRaw = sp.get('channel');
  const channel = channelRaw && CHANNELS.includes(channelRaw) ? (channelRaw as Channel) : undefined;
  const waitRaw = sp.get('waitSeconds');
  const waitSeconds =
    waitRaw !== null && Number.isFinite(Number(waitRaw)) ? Number(waitRaw) : undefined;

  const { data: org, error } = await getSupabase()
    .from('organizations')
    .select('id,name,contact,channels')
    .eq('id', orgId)
    .single();

  if (error || !org) {
    return NextResponse.json({ error: { message: 'Organization not found' } }, { status: 404 });
  }

  const orgRow = org as {
    id: string;
    name: string;
    contact: Record<string, unknown> | null;
    channels: string[] | null;
  };
  const orgShape = {
    channels: orgRow.channels ?? [],
    contact: (orgRow.contact ?? {}) as {
      fax?: string;
      email?: string;
      phone?: string;
      preferred_channel?: string;
      chase_policy?: { steps?: string[]; waitSeconds?: number };
    },
  };

  // Same resolution as the composer: the enabled agent subscribed to
  // case.created on records_request_out (null-safe — defaults otherwise).
  const chaser = await findAgentSubscribedTo('case.created', 'records_request_out');

  const plan = buildChannelPlan(
    orgShape,
    (chaser?.config ?? {}) as { chase_policy?: { steps?: string[]; waitSeconds?: number } },
    channel,
    waitSeconds,
  );

  return NextResponse.json({
    data: {
      plan,
      orgName: orgRow.name,
      isEpicOrg: isEpicOrg(orgShape),
    },
  });
}
