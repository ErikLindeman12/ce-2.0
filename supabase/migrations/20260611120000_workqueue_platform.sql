-- Work Queue Platform — agent-native intake, routing, and chase loop.
-- Idempotent: safe to re-apply (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, etc.)

-- ---------------------------------------------------------------------------
-- patients (mock MPI)
-- ---------------------------------------------------------------------------
create table if not exists patients (
  id         uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name  text not null,
  dob        date not null,
  mrn        text not null unique,
  phone      text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- work_queues
-- ---------------------------------------------------------------------------
create table if not exists work_queues (
  key        text primary key,
  name       text not null,
  description text,
  sort_order int not null default 0
);

-- ---------------------------------------------------------------------------
-- work_items
-- ---------------------------------------------------------------------------
create table if not exists work_items (
  id                 uuid primary key default gen_random_uuid(),
  type               text not null default 'unknown',
  queue_key          text not null references work_queues(key),
  status             text not null default 'open',
  source_channel     text not null,
  source_text        text,
  extracted_data     jsonb not null default '{}',
  matched_patient_id uuid references patients(id),
  org_id             text references organizations(id),
  confidence         jsonb not null default '{}',
  assignee           text not null default 'unassigned',
  review_reason      text,
  agent_state        jsonb not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists work_items_queue_status_idx on work_items(queue_key, status);

-- ---------------------------------------------------------------------------
-- agents
-- ---------------------------------------------------------------------------
create table if not exists agents (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null unique,
  queue_key            text not null references work_queues(key),
  enabled              boolean not null default true,
  instructions         text not null default '',
  tools                text[] not null default '{}',
  confidence_threshold numeric not null default 0.8,
  model                text not null default 'heuristic',
  created_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- outbound_attempts
-- ---------------------------------------------------------------------------
create table if not exists outbound_attempts (
  id             uuid primary key default gen_random_uuid(),
  work_item_id   uuid not null references work_items(id),
  channel        text not null,
  attempt_no     int not null default 1,
  to_org_id      text references organizations(id),
  to_contact     jsonb not null default '{}',
  payload        jsonb not null default '{}',
  status         text not null default 'sent',
  respond_after  timestamptz,
  response       jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists outbound_attempts_status_respond_after_idx on outbound_attempts(status, respond_after);

-- ---------------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------------
create table if not exists audit_log (
  id           bigint generated always as identity primary key,
  work_item_id uuid references work_items(id),
  actor        text not null,
  action       text not null,
  detail       jsonb not null default '{}',
  created_at   timestamptz not null default now()
);

create index if not exists audit_log_work_item_id_idx on audit_log(work_item_id);

-- ---------------------------------------------------------------------------
-- extend organizations with contact book for outbound channels
-- ---------------------------------------------------------------------------
alter table organizations add column if not exists contact jsonb not null default '{}';

-- ---------------------------------------------------------------------------
-- grants for new tables (service_role already has default privileges from
-- the alter default privileges in 20260531181918_grant_app_roles.sql, but
-- tables created before that migration ran may need explicit grants)
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.patients to service_role;
grant select, insert, update, delete on public.work_queues to service_role;
grant select, insert, update, delete on public.work_items to service_role;
grant select, insert, update, delete on public.agents to service_role;
grant select, insert, update, delete on public.outbound_attempts to service_role;
grant select, insert, update, delete on public.audit_log to service_role;
grant usage, select on sequence audit_log_id_seq to service_role;
