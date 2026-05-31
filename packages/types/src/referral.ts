import type { OrgId, OrgChannel } from './org';

export type ReferralStatus =
  | 'received'
  | 'triaged'
  | 'accepted'
  | 'declined'
  | 'scheduled'
  | 'completed'
  | 'cancelled';

export interface ReferralPatient {
  externalId: string;       // org-local patient ID
  centralId?: string;       // Epic central MPI ID (may not be resolved yet)
  firstName: string;
  lastName: string;
  dateOfBirth: string;      // ISO 8601 date
}

export interface ReferralRequest {
  dataType: string;         // e.g. 'labs', 'meds', 'consult', 'imaging'
  priority: 'routine' | 'urgent' | 'stat';
  notes?: string;
}

export interface Referral {
  id: string;
  fromOrgId: OrgId;
  toOrgId: OrgId;
  channel: OrgChannel;      // how it arrived
  status: ReferralStatus;
  patient: ReferralPatient;
  request: ReferralRequest;
  createdAt: string;
  updatedAt: string;
  statusHistory: Array<{
    status: ReferralStatus;
    timestamp: string;
    note?: string;
  }>;
}

export type CreateReferralInput = Omit<Referral, 'id' | 'createdAt' | 'updatedAt' | 'statusHistory' | 'status'>;
