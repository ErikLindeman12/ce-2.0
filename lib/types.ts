export type OrgChannel = 'cloud' | 'direct' | 'fax' | 'portal';

export interface OrgCapabilities {
  channels: OrgChannel[];
  dataTypes: string[];
}

export interface Org {
  id: string;
  name: string;
  tenantSlug: string;
  endpointUrl: string;
  capabilities: OrgCapabilities;
  active: boolean;
}

export interface Provider {
  id: string;
  orgId: string;
  name: string;
  npi: string;
  specialty: string;
  active: boolean;
}

export interface DirectorySearchResult {
  organizations: Org[];
  providers: Provider[];
}

export type ReferralStatus = 'sent' | 'dispatch_failed' | 'queued';

export interface SendReferralPayload {
  toOrgId: string;
  toOrgName: string;
  patient: {
    firstName: string;
    lastName: string;
    dateOfBirth: string;
  };
  request: {
    dataType: string;
    priority: 'routine' | 'urgent' | 'stat';
    notes?: string;
  };
  referringProviderNpi?: string;
  clinicalNotes?: string;
  notifyEmail?: string;
  notifyPhone?: string;
}

export interface SendReferralResult {
  referralId: string;
  status: ReferralStatus;
  dispatchStatus: ReferralStatus;
}
