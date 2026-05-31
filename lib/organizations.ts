import { getSupabase } from './supabase';
import type { DirectoryFilters, Org, OrgChannel } from './types';

interface OrgRow {
  id: string;
  name: string;
  tenant_slug: string;
  endpoint_url: string;
  channels: string[];
  data_types: string[];
  specialties: string[];
  city: string | null;
  state: string | null;
  zip: string | null;
  active: boolean;
}

function toOrg(r: OrgRow): Org {
  return {
    id: r.id,
    name: r.name,
    tenantSlug: r.tenant_slug,
    endpointUrl: r.endpoint_url,
    capabilities: { channels: r.channels as OrgChannel[], dataTypes: r.data_types },
    specialties: r.specialties,
    city: r.city,
    state: r.state,
    zip: r.zip,
    active: r.active,
  };
}

export async function searchOrgs(filters: DirectoryFilters = {}): Promise<Org[]> {
  let qb = getSupabase()
    .from('organizations')
    .select('id,name,tenant_slug,endpoint_url,channels,data_types,specialties,city,state,zip,active')
    .eq('active', true);

  if (filters.specialty) {
    qb = qb.contains('specialties', [filters.specialty.toLowerCase()]);
  }

  if (filters.state) {
    qb = qb.ilike('state', filters.state);
  }

  if (filters.city) {
    qb = qb.ilike('city', filters.city);
  }

  if (filters.q) {
    const pattern = `%${filters.q}%`;
    qb = qb.or(`name.ilike.${pattern},tenant_slug.ilike.${pattern}`);
  }

  const { data, error } = await qb;

  if (error) throw new Error(`organizations query failed: ${error.message}`);
  return (data as OrgRow[]).map(toOrg);
}
