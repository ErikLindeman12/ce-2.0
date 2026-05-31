import { v4 as uuidv4 } from 'uuid';
import type { Org, CreateOrgInput, UpdateOrgInput } from '@ce2/types';

const store = new Map<string, Org>();

function seed(): void {
  const now = new Date().toISOString();

  const mayo: Org = {
    id: uuidv4(),
    name: 'Mayo Clinic',
    tenantSlug: 'mayo-clinic',
    endpointUrl: 'https://api.mayo-clinic.ce2.local',
    capabilities: {
      channels: ['cloud', 'direct'],
      dataTypes: ['labs', 'meds', 'imaging'],
    },
    active: true,
    createdAt: now,
    updatedAt: now,
  };

  const mgh: Org = {
    id: uuidv4(),
    name: 'Mass General',
    tenantSlug: 'mass-general',
    endpointUrl: 'https://api.mass-general.ce2.local',
    capabilities: {
      channels: ['cloud', 'fax', 'direct'],
      dataTypes: ['labs', 'meds', 'notes'],
    },
    active: true,
    createdAt: now,
    updatedAt: now,
  };

  store.set(mayo.id, mayo);
  store.set(mgh.id, mgh);
}

seed();

export function getAllOrgs(): Org[] {
  return Array.from(store.values());
}

export function getOrgById(id: string): Org | undefined {
  return store.get(id);
}

export function getOrgBySlug(slug: string): Org | undefined {
  return Array.from(store.values()).find((org) => org.tenantSlug === slug);
}

export function createOrg(input: CreateOrgInput): Org {
  const now = new Date().toISOString();
  const org: Org = {
    ...input,
    id: uuidv4(),
    createdAt: now,
    updatedAt: now,
  };
  store.set(org.id, org);
  return org;
}

export function updateOrg(id: string, input: UpdateOrgInput): Org | undefined {
  const existing = store.get(id);
  if (!existing) return undefined;

  const updated: Org = {
    ...existing,
    ...input,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  store.set(id, updated);
  return updated;
}
