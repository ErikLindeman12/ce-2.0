import { getSupabase } from './supabase';
import {
  BASELINE_FIELDS,
  type ReferralField,
  type ReferralInstructions,
  type ReferralInstructionsTarget,
} from './types';

interface RequirementsRow {
  org_id: string | null;
  provider_id: string | null;
  required_fields: ReferralField[];
  custom_config: Record<string, unknown>;
}

/**
 * Merge custom fields onto a base field list.
 * - Matching keys: the custom entry overrides required/label/type/options.
 * - New keys: appended to the end.
 */
function mergeFields(base: ReferralField[], custom: ReferralField[]): ReferralField[] {
  const merged = base.map((f) => ({ ...f }));
  for (const cf of custom) {
    const idx = merged.findIndex((f) => f.key === cf.key);
    if (idx >= 0) {
      merged[idx] = { ...merged[idx], ...cf };
    } else {
      merged.push({ ...cf });
    }
  }
  return merged;
}

export async function getReferralInstructions(opts: {
  orgId?: string;
  providerId?: string;
}): Promise<ReferralInstructions | null> {
  const { orgId, providerId } = opts;
  const sb = getSupabase();

  // Resolve provider → org if only providerId given
  let resolvedOrgId = orgId ?? null;
  let providerName: string | null = null;

  if (providerId) {
    const { data: prov, error: provErr } = await sb
      .from('providers')
      .select('org_id,name')
      .eq('id', providerId)
      .single();

    if (provErr || !prov) return null; // provider not found
    providerName = (prov as { org_id: string; name: string }).name;
    if (!resolvedOrgId) {
      resolvedOrgId = (prov as { org_id: string; name: string }).org_id;
    }
  }

  // Resolve org name
  let orgName: string | null = null;
  if (resolvedOrgId) {
    const { data: org, error: orgErr } = await sb
      .from('organizations')
      .select('name')
      .eq('id', resolvedOrgId)
      .single();

    if (orgErr || !org) return null; // org not found
    orgName = (org as { name: string }).name;
  }

  const target: ReferralInstructionsTarget = {
    orgId: resolvedOrgId,
    orgName,
    providerId: providerId ?? null,
    providerName,
  };

  // Start from baseline
  let fields = BASELINE_FIELDS.map((f) => ({ ...f }));
  let customConfig: Record<string, unknown> = {};

  // Layer 1: org-level config (provider_id IS NULL)
  if (resolvedOrgId) {
    const { data: orgReq } = await sb
      .from('referral_requirements')
      .select('org_id,provider_id,required_fields,custom_config')
      .eq('org_id', resolvedOrgId)
      .is('provider_id', null)
      .single();

    if (orgReq) {
      const row = orgReq as RequirementsRow;
      fields = mergeFields(fields, row.required_fields);
      customConfig = { ...customConfig, ...row.custom_config };
    }
  }

  // Layer 2: provider-level config
  if (providerId) {
    const { data: provReq } = await sb
      .from('referral_requirements')
      .select('org_id,provider_id,required_fields,custom_config')
      .eq('provider_id', providerId)
      .single();

    if (provReq) {
      const row = provReq as RequirementsRow;
      fields = mergeFields(fields, row.required_fields);
      customConfig = { ...customConfig, ...row.custom_config };
    }
  }

  return { target, fields, customConfig };
}
