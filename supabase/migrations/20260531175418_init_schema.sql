-- CE 2.0 initial schema: organizations + referrals.

create table if not exists organizations (
  id           text primary key,
  name         text not null,
  tenant_slug  text not null unique,
  endpoint_url text not null,
  channels     text[] not null default '{}',
  data_types   text[] not null default '{}',
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists referrals (
  id          uuid primary key default gen_random_uuid(),
  to_org_id   text not null references organizations(id),
  to_org_name text not null,
  patient     jsonb not null,
  request     jsonb not null,
  status      text not null default 'received',
  created_at  timestamptz not null default now()
);

create index if not exists referrals_to_org_id_idx on referrals(to_org_id);
