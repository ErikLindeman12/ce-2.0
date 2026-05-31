export type OrgId = string;

export type OrgChannel = 'cloud' | 'direct' | 'fax' | 'portal';

export interface OrgCapabilities {
  channels: OrgChannel[];
  dataTypes: string[]; // e.g. ['labs', 'meds', 'imaging', 'notes']
}

export interface Org {
  id: OrgId;
  name: string;
  tenantSlug: string; // e.g. 'mayo-clinic'
  endpointUrl: string; // base URL for this org's cloud API
  capabilities: OrgCapabilities;
  active: boolean;
  createdAt: string; // ISO 8601
  updatedAt: string;
}

export type CreateOrgInput = Omit<Org, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateOrgInput = Partial<Omit<Org, 'id' | 'createdAt' | 'updatedAt'>>;
