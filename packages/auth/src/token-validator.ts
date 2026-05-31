import type { TokenValidateRequest, TokenValidateResponse } from '@ce2/types';

// TODO: Replace stub with a real implementation using a JWT library (e.g. jose).
// The validator should verify the signature against the issuing org's public key,
// check exp/aud/iss claims, and return the decoded CrossOrgTokenClaims on success.
export async function validateToken(_req: TokenValidateRequest): Promise<TokenValidateResponse> {
  throw new Error('Not implemented: token validator');
}
