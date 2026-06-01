import { getSupabase } from './supabase';
import type { DirectoryFilters, Provider } from './types';

interface ProviderRow {
  id: string;
  org_id: string;
  name: string;
  npi: string;
  specialty: string;
  active: boolean;
}

function toProvider(r: ProviderRow): Provider {
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    npi: r.npi,
    specialty: r.specialty,
    active: r.active,
  };
}

export interface ProviderSearchOpts extends DirectoryFilters {
  orgId?: string;
}

export async function searchProviders(opts: ProviderSearchOpts = {}): Promise<Provider[]> {
  let qb = getSupabase()
    .from('providers')
    .select('id,org_id,name,npi,specialty,active')
    .eq('active', true);

  if (opts.orgId) {
    qb = qb.eq('org_id', opts.orgId);
  }

  if (opts.specialty) {
    qb = qb.ilike('specialty', opts.specialty);
  }

  if (opts.state || opts.city) {
    // Filter providers by their org's location using a subquery.
    // Supabase JS client doesn't support joins with filters on the joined table
    // in a way that filters the parent rows, so we fetch matching org IDs first.
    let orgQb = getSupabase()
      .from('organizations')
      .select('id')
      .eq('active', true);

    if (opts.state) {
      orgQb = orgQb.ilike('state', opts.state);
    }
    if (opts.city) {
      orgQb = orgQb.ilike('city', opts.city);
    }

    const { data: orgRows, error: orgError } = await orgQb;
    if (orgError) throw new Error(`org location query failed: ${orgError.message}`);

    const orgIds = (orgRows as { id: string }[]).map((r) => r.id);
    if (orgIds.length === 0) return [];
    qb = qb.in('org_id', orgIds);
  }

  if (opts.q) {
    const pattern = `%${opts.q}%`;
    qb = qb.or(`name.ilike.${pattern},npi.ilike.${pattern},specialty.ilike.${pattern}`);
  }

  const { data, error } = await qb;

  if (error) throw new Error(`providers query failed: ${error.message}`);
  return (data as ProviderRow[]).map(toProvider);
}
