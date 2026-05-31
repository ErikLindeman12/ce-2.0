import type { Org } from '@ce2/types';

const DIRECTORY_URL = process.env.DIRECTORY_URL ?? 'http://localhost:3001';

/**
 * Fetch a single org by ID from the directory service.
 * Returns null if the org does not exist (404) or on any non-ok response.
 */
export async function getOrg(orgId: string): Promise<Org | null> {
  const res = await fetch(`${DIRECTORY_URL}/orgs/${encodeURIComponent(orgId)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `directory-client: getOrg(${orgId}) failed with status ${res.status}`,
    );
  }
  const body = (await res.json()) as { data: Org };
  return body.data;
}

/**
 * Returns true if an org with the given ID exists in the directory.
 */
export async function orgExists(orgId: string): Promise<boolean> {
  const org = await getOrg(orgId);
  return org !== null;
}
