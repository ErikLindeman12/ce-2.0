import type { Org } from './types';

// Temporary in-memory directory. Swap this module's internals for a Supabase
// query later — the route handler that calls searchOrgs() won't change.
const ORGS: Org[] = [
  {
    id: 'org_mayo',
    name: 'Mayo Clinic',
    tenantSlug: 'mayo-clinic',
    endpointUrl: 'https://api.mayo-clinic.ce2.local',
    capabilities: { channels: ['cloud', 'direct'], dataTypes: ['labs', 'meds', 'imaging'] },
    active: true,
  },
  {
    id: 'org_mgh',
    name: 'Mass General',
    tenantSlug: 'mass-general',
    endpointUrl: 'https://api.mass-general.ce2.local',
    capabilities: { channels: ['cloud', 'fax', 'direct'], dataTypes: ['labs', 'meds', 'notes'] },
    active: true,
  },
  {
    id: 'org_cleveland',
    name: 'Cleveland Clinic',
    tenantSlug: 'cleveland-clinic',
    endpointUrl: 'https://api.cleveland-clinic.ce2.local',
    capabilities: { channels: ['cloud'], dataTypes: ['labs', 'imaging', 'notes', 'cardiology'] },
    active: true,
  },
  {
    id: 'org_jhh',
    name: 'Johns Hopkins Hospital',
    tenantSlug: 'johns-hopkins',
    endpointUrl: 'https://api.johns-hopkins.ce2.local',
    capabilities: { channels: ['cloud', 'direct'], dataTypes: ['labs', 'meds', 'imaging', 'oncology'] },
    active: true,
  },
  {
    id: 'org_kaiser',
    name: 'Kaiser Permanente',
    tenantSlug: 'kaiser-permanente',
    endpointUrl: 'https://api.kaiser.ce2.local',
    capabilities: { channels: ['cloud', 'portal'], dataTypes: ['labs', 'meds', 'notes', 'primary-care'] },
    active: true,
  },
  {
    id: 'org_ucsf',
    name: 'UCSF Medical Center',
    tenantSlug: 'ucsf',
    endpointUrl: 'https://api.ucsf.ce2.local',
    capabilities: { channels: ['cloud', 'direct', 'fax'], dataTypes: ['labs', 'imaging', 'neurology'] },
    active: true,
  },
];

export function searchOrgs(query: string): Org[] {
  const q = query.trim().toLowerCase();
  if (!q) return ORGS;
  return ORGS.filter(
    (org) =>
      org.name.toLowerCase().includes(q) ||
      org.tenantSlug.toLowerCase().includes(q) ||
      org.capabilities.dataTypes.some((d) => d.toLowerCase().includes(q)),
  );
}
