import type { CreateReferralInput } from '@ce2/types';
import type { ChannelAdapter } from './index';

/**
 * Handles referrals submitted through the CE 2.0 central referral portal.
 * Portal users (clinicians or coordinators) fill out a structured web form.
 * The portal frontend submits a JSON form payload to this service.
 *
 * TODO: Real implementation should:
 *  - Validate the authenticated portal user's session and extract their
 *    associated orgId as the fromOrgId.
 *  - Run Zod (or equivalent) schema validation on the form payload,
 *    returning field-level errors to the portal UI on failure.
 *  - Map portal-specific field names (e.g. camelCase form fields) to the
 *    canonical CreateReferralInput shape.
 *  - Support optional file attachments (referral letters, supporting labs)
 *    uploaded alongside the form — store attachment references on the referral.
 *  - Enforce that the selected toOrgId supports the requested dataType via
 *    the directory service's capabilities check.
 */
export class PortalAdapter implements ChannelAdapter {
  readonly channel = 'portal' as const;

  normalize(_raw: unknown): CreateReferralInput {
    // TODO: parse portal form submission
    throw new Error('Not implemented: portal normalization');
  }
}
