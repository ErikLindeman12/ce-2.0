-- Referral requirements: per-org and per-provider configurable fields.
-- Org-level rows (provider_id NULL) define org-wide requirements.
-- Provider-level rows add/override fields for a specific provider.
-- A future location_id column will slot into the same table.

create table if not exists referral_requirements (
  id              uuid primary key default gen_random_uuid(),
  org_id          text references organizations(id),
  provider_id     text references providers(id),
  required_fields jsonb not null default '[]',
  custom_config   jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint at_least_one_target check (org_id is not null or provider_id is not null)
);

create index if not exists referral_requirements_org_id_idx on referral_requirements(org_id);
create index if not exists referral_requirements_provider_id_idx on referral_requirements(provider_id);
