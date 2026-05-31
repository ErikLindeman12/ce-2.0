import type { Org } from '@ce2/types';

const DIRECTORY_URL = process.env.DIRECTORY_URL ?? 'http://localhost:3001';

export async function getOrg(orgId: string): Promise<Org | null> {
  const res = await fetch(`${DIRECTORY_URL}/orgs/${encodeURIComponent(orgId)}`);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(
      `Directory request failed: GET /orgs/${orgId} returned ${res.status}`
    );
  }
  return res.json() as Promise<Org>;
}

export async function orgExists(orgId: string): Promise<boolean> {
  const org = await getOrg(orgId);
  return org !== null;
}
