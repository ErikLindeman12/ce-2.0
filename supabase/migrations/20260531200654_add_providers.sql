-- Add providers table: individual clinicians belonging to organizations.

create table if not exists providers (
  id           text primary key,
  org_id       text not null references organizations(id),
  name         text not null,
  npi          text not null unique,
  specialty    text not null,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists providers_org_id_idx on providers(org_id);
create index if not exists providers_specialty_idx on providers(specialty);
