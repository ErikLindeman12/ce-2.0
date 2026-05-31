import type { OrgChannel, CreateReferralInput } from '@ce2/types';

export interface ChannelAdapter {
  channel: OrgChannel;
  /**
   * Normalizes a raw inbound payload into a CreateReferralInput.
   * Each channel adapter is responsible for mapping its wire format
   * into the canonical Referral shape expected by the store.
   */
  normalize(raw: unknown): CreateReferralInput;
}

export { CloudAdapter } from './cloud';
export { FaxAdapter } from './fax';
export { DirectAdapter } from './direct';
export { PortalAdapter } from './portal';
