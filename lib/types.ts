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

// ---------------------------------------------------------------------------
// Referral instructions — per-org / per-provider required fields
// ---------------------------------------------------------------------------

export type ReferralFieldType = 'text' | 'date' | 'select' | 'boolean' | 'textarea';

export interface ReferralField {
  key: string;
  label: string;
  type: ReferralFieldType;
  required: boolean;
  options?: string[];
}

export interface ReferralInstructionsTarget {
  orgId: string | null;
  orgName: string | null;
  providerId: string | null;
  providerName: string | null;
}

export interface ReferralInstructions {
  target: ReferralInstructionsTarget;
  fields: ReferralField[];
  customConfig: Record<string, unknown>;
}

export const BASELINE_FIELDS: ReferralField[] = [
  { key: 'patient.firstName', label: 'First name', type: 'text', required: true },
  { key: 'patient.lastName', label: 'Last name', type: 'text', required: true },
  { key: 'patient.dateOfBirth', label: 'Date of birth', type: 'date', required: true },
  { key: 'referringProvider.npi', label: 'Referring provider NPI', type: 'text', required: true },
  { key: 'procedure', label: 'Procedure / data type', type: 'text', required: true },
  { key: 'priority', label: 'Priority', type: 'select', required: true, options: ['routine', 'urgent', 'stat'] },
  { key: 'clinicalNotes', label: 'Clinical notes', type: 'textarea', required: false },
];

// ---------------------------------------------------------------------------
// Send referral payload
// ---------------------------------------------------------------------------


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
