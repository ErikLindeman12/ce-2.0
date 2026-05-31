import type { CreateReferralInput } from '@ce2/types';
import type { ChannelAdapter } from './index';

/**
 * Handles referrals arriving via the CE 2.0 cloud-to-cloud API.
 * The sending org's referral-intake (or gateway) POSTs a structured
 * JSON payload that already conforms closely to the canonical Referral
 * shape — this adapter validates and maps it with minimal transformation.
 *
 * TODO: Real implementation should:
 *  - Validate the JWT / CrossOrgToken on the incoming request (done by auth
 *    middleware before this adapter is invoked).
 *  - Verify `fromOrgId` in the payload matches the token's `iss` claim.
 *  - Run JSON Schema / Zod validation against the expected payload shape.
 *  - Map any org-local patient identifiers to the central MPI if possible.
 */
export class CloudAdapter implements ChannelAdapter {
  readonly channel = 'cloud' as const;

  normalize(_raw: unknown): CreateReferralInput {
    // TODO: parse structured JSON payload from another org's cloud API
    throw new Error('Not implemented: cloud normalization');
  }
}
