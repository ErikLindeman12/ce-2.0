import type { OrgId } from './org';

export interface CrossOrgTokenClaims {
  iss: OrgId;        // issuing org
  sub: OrgId;        // subject org (target)
  aud: string;       // audience — the service being called
  iat: number;       // issued at (unix seconds)
  exp: number;       // expiry (unix seconds)
  jti: string;       // unique token id
}

export interface CrossOrgToken {
  token: string;     // signed JWT
  claims: CrossOrgTokenClaims;
}

export interface TokenIssueRequest {
  requestingOrgId: OrgId;
  targetOrgId: OrgId;
  audience: string;
  ttlSeconds?: number;
}

export interface TokenValidateRequest {
  token: string;
  expectedAudience: string;
  expectedIssuer?: OrgId;
}

export interface TokenValidateResponse {
  valid: boolean;
  claims?: CrossOrgTokenClaims;
  error?: string;
}
