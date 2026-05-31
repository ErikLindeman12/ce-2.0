import type { Org, Referral, CreateReferralInput, OrgChannel } from '@ce2/types';

const DIRECTORY_URL =
  process.env.NEXT_PUBLIC_DIRECTORY_URL ?? 'http://localhost:3001';
const REFERRAL_INTAKE_URL =
  process.env.NEXT_PUBLIC_REFERRAL_INTAKE_URL ?? 'http://localhost:3003';

// ---------------------------------------------------------------------------
// Orgs
// ---------------------------------------------------------------------------

export async function listOrgs(): Promise<Org[]> {
  try {
    const res = await fetch(`${DIRECTORY_URL}/orgs`, { cache: 'no-store' });
    if (!res.ok) return [];
    return (await res.json()) as Org[];
  } catch {
    return [];
  }
}

export async function getOrg(id: string): Promise<Org | null> {
  try {
    const res = await fetch(`${DIRECTORY_URL}/orgs/${encodeURIComponent(id)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as Org;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

export async function listReferrals(filters?: {
  fromOrgId?: string;
  toOrgId?: string;
  status?: string;
}): Promise<Referral[]> {
  try {
    const params = new URLSearchParams();
    if (filters?.fromOrgId) params.set('fromOrgId', filters.fromOrgId);
    if (filters?.toOrgId) params.set('toOrgId', filters.toOrgId);
    if (filters?.status) params.set('status', filters.status);

    const qs = params.toString();
    const url = `${REFERRAL_INTAKE_URL}/referrals${qs ? `?${qs}` : ''}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return [];
    return (await res.json()) as Referral[];
  } catch {
    return [];
  }
}

export async function getReferral(id: string): Promise<Referral | null> {
  try {
    const res = await fetch(
      `${REFERRAL_INTAKE_URL}/referrals/${encodeURIComponent(id)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    return (await res.json()) as Referral;
  } catch {
    return null;
  }
}

export async function createReferral(
  input: CreateReferralInput & { channel: OrgChannel },
): Promise<Referral> {
  const res = await fetch(`${REFERRAL_INTAKE_URL}/referrals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to create referral: ${text}`);
  }
  return (await res.json()) as Referral;
}
