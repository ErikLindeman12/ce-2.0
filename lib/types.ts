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
  specialties: string[];
  city: string | null;
  state: string | null;
  zip: string | null;
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

/** Shared filter options for directory search. All optional + composable. */
export interface DirectoryFilters {
  q?: string;
  specialty?: string;
  city?: string;
  state?: string;
}

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
}
