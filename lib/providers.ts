import { getSupabase } from './supabase';
import type { Provider } from './types';

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

export async function searchProviders(opts: {
  query?: string;
  specialty?: string;
  orgId?: string;
}): Promise<Provider[]> {
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

  const { data, error } = await qb;

  if (error) throw new Error(`providers query failed: ${error.message}`);
  const providers = (data as ProviderRow[]).map(toProvider);

  const q = (opts.query ?? '').trim().toLowerCase();
  if (!q) return providers;

  return providers.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.specialty.toLowerCase().includes(q) ||
      p.npi.includes(q),
  );
}
