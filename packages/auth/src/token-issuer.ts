import type { TokenIssueRequest, CrossOrgToken } from '@ce2/types';

// TODO: Replace stub with a real implementation using a signing key and a JWT
// library (e.g. jose). The issuer should load the private key from config/secrets,
// build CrossOrgTokenClaims from the request, sign with RS256 or ES256, and
// return the compact JWT alongside the decoded claims.
export async function issueToken(_req: TokenIssueRequest): Promise<CrossOrgToken> {
  throw new Error('Not implemented: token issuer');
}
