import type { CrossOrgToken } from '@ce2/types';

const BROKER_URL = process.env.BROKER_URL ?? 'http://localhost:3002';

/**
 * Request a short-lived cross-org token from the token broker.
 *
 * The referral-intake service uses this to obtain credentials when it needs
 * to call another org's API on behalf of a requesting org — for example, to
 * notify the receiving org that a referral has arrived.
 */
export async function getCrossOrgToken(
  requestingOrgId: string,
  targetOrgId: string,
  audience: string,
): Promise<CrossOrgToken> {
  const res = await fetch(`${BROKER_URL}/tokens/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestingOrgId, targetOrgId, audience }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error ? `: ${body.error}` : '';
    } catch {
      // ignore JSON parse errors on error responses
    }
    throw new Error(
      `broker-client: getCrossOrgToken failed with status ${res.status}${detail}`,
    );
  }

  const body = (await res.json()) as { data: CrossOrgToken };
  return body.data;
}
