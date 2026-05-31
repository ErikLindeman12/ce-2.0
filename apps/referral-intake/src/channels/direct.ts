import type { CreateReferralInput } from '@ce2/types';
import type { ChannelAdapter } from './index';

/**
 * Handles referrals arriving via Direct Secure Messaging (DirectTrust /
 * ONC Direct Protocol). The message arrives as an S/MIME-wrapped payload
 * containing either a C-CDA (CDA R2) document or a FHIR Bundle.
 *
 * TODO: Real implementation should:
 *  - Unwrap the S/MIME envelope and verify the sender certificate against
 *    the DirectTrust certificate authority bundle.
 *  - Detect payload type: CDA vs FHIR (check Content-Type or root element).
 *  - For CDA: parse the XML, extract the referral act (LOINC 57133-1),
 *    patient demographics from recordTarget, and referring provider from
 *    author/performer elements.
 *  - For FHIR: parse the Bundle, locate the ServiceRequest resource, and
 *    map Patient, Practitioner, and Organization resources to the canonical
 *    Referral shape.
 *  - Resolve fromOrgId by matching the sender Direct address against the
 *    directory service.
 */
export class DirectAdapter implements ChannelAdapter {
  readonly channel = 'direct' as const;

  normalize(_raw: unknown): CreateReferralInput {
    // TODO: parse Direct Secure Message (S/MIME wrapped CDA or FHIR)
    throw new Error('Not implemented: direct normalization');
  }
}
