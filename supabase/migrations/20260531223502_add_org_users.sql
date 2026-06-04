-- org_users: links Supabase Auth users to CE 2.0 organizations with a role.
-- A user can belong to multiple orgs; each membership carries a role.

create table if not exists org_users (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  org_id     text not null references organizations(id),
  role       text not null check (role in ('referrer', 'referee')),
  created_at timestamptz not null default now(),
  unique(user_id, org_id)
);

create index if not exists org_users_user_id_idx on org_users(user_id);
create index if not exists org_users_org_id_idx on org_users(org_id);
