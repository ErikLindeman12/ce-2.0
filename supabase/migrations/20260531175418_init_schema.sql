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

-- Seed the directory (mirrors the former in-memory lib/organizations.ts).
insert into organizations (id, name, tenant_slug, endpoint_url, channels, data_types) values
  ('org_mayo',      'Mayo Clinic',             'mayo-clinic',      'https://api.mayo-clinic.ce2.local',      '{cloud,direct}',     '{labs,meds,imaging}'),
  ('org_mgh',       'Mass General',            'mass-general',     'https://api.mass-general.ce2.local',     '{cloud,fax,direct}', '{labs,meds,notes}'),
  ('org_cleveland', 'Cleveland Clinic',        'cleveland-clinic', 'https://api.cleveland-clinic.ce2.local', '{cloud}',            '{labs,imaging,notes,cardiology}'),
  ('org_jhh',       'Johns Hopkins Hospital',  'johns-hopkins',    'https://api.johns-hopkins.ce2.local',    '{cloud,direct}',     '{labs,meds,imaging,oncology}'),
  ('org_kaiser',    'Kaiser Permanente',       'kaiser-permanente','https://api.kaiser.ce2.local',           '{cloud,portal}',     '{labs,meds,notes,primary-care}'),
  ('org_ucsf',      'UCSF Medical Center',     'ucsf',             'https://api.ucsf.ce2.local',             '{cloud,direct,fax}', '{labs,imaging,neurology}')
on conflict (id) do nothing;
