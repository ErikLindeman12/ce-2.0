import { unstable_cache } from 'next/cache';
import { getSupabase } from './supabase';
import type { Org, OrgChannel } from './types';

interface OrgRow {
  id: string;
  name: string;
  tenant_slug: string;
  endpoint_url: string;
  channels: string[];
  data_types: string[];
  active: boolean;
}

function toOrg(r: OrgRow): Org {
  return {
    id: r.id,
    name: r.name,
    tenantSlug: r.tenant_slug,
    endpointUrl: r.endpoint_url,
    capabilities: { channels: r.channels as OrgChannel[], dataTypes: r.data_types },
    active: r.active,
  };
}

// Cache the full DB read in Vercel's Data Cache (survives across serverless
// invocations). Postgres is hit at most once per `revalidate` window; the
// per-query filtering below runs live, server-side, so the browser only ever
// receives matching rows — never the whole directory.
const getActiveOrgs = unstable_cache(
  async (): Promise<Org[]> => {
    const { data, error } = await getSupabase()
      .from('organizations')
      .select('id,name,tenant_slug,endpoint_url,channels,data_types,active')
      .eq('active', true);

    if (error) throw new Error(`organizations query failed: ${error.message}`);
    return (data as OrgRow[]).map(toOrg);
  },
  ['organizations-active'],
  { revalidate: 60, tags: ['organizations'] },
);

export async function searchOrgs(query: string): Promise<Org[]> {
  const orgs = await getActiveOrgs();

  const q = query.trim().toLowerCase();
  if (!q) return orgs;
  return orgs.filter(
    (o) =>
      o.name.toLowerCase().includes(q) ||
      o.tenantSlug.toLowerCase().includes(q) ||
      o.capabilities.dataTypes.some((d) => d.toLowerCase().includes(q)),
  );
}
