import type { CreateReferralInput } from '@ce2/types';
import type { ChannelAdapter } from './index';

/**
 * Handles referrals arriving via inbound fax.
 * The fax pipeline (e.g. an upstream OCR/NLP service or a structured
 * HL7 fax gateway) delivers either raw OCR'd text or a light metadata
 * envelope. This adapter is responsible for extracting patient demographics,
 * requesting org, and referral details from that payload.
 *
 * TODO: Real implementation should:
 *  - Accept either structured fax metadata (JSON envelope from gateway) or
 *    OCR'd plain text from a PDF scan.
 *  - For structured metadata: map gateway fields to CreateReferralInput.
 *  - For OCR text: apply NLP extraction (e.g. via a named-entity model or
 *    regex heuristics) to pull patient name, DOB, requesting provider, and
 *    referral reason.
 *  - Look up fromOrgId using the sending fax number against the directory.
 *  - Flag low-confidence extractions for human triage.
 */
export class FaxAdapter implements ChannelAdapter {
  readonly channel = 'fax' as const;

  normalize(_raw: unknown): CreateReferralInput {
    // TODO: parse OCR'd text or structured fax metadata
    throw new Error('Not implemented: fax normalization');
  }
}
