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

export async function searchOrgs(query: string): Promise<Org[]> {
  const { data, error } = await getSupabase()
    .from('organizations')
    .select('id,name,tenant_slug,endpoint_url,channels,data_types,active')
    .eq('active', true);

  if (error) throw new Error(`organizations query failed: ${error.message}`);
  const orgs = (data as OrgRow[]).map(toOrg);

  const q = query.trim().toLowerCase();
  if (!q) return orgs;
  return orgs.filter(
    (o) =>
      o.name.toLowerCase().includes(q) ||
      o.tenantSlug.toLowerCase().includes(q) ||
      o.capabilities.dataTypes.some((d) => d.toLowerCase().includes(q)),
  );
}
