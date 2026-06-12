-- Event substrate: events, deliveries, review requests, routing rules (docs/substrate-spec.md)
-- Idempotent: CI re-applies migrations on merge.

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  type text not null,
  case_id uuid references work_items(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  actor text not null default 'system',
  caused_by_event_id uuid,
  depth int not null default 0,
  deliver_at timestamptz,
  delivered_at timestamptz,
  dedupe_key text unique,
  created_at timestamptz not null default now()
);
create index if not exists events_undelivered_idx on events (seq) where delivered_at is null;
create index if not exists events_case_idx on events (case_id);
create index if not exists events_type_idx on events (type, created_at desc);

create table if not exists event_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  case_id uuid references work_items(id) on delete cascade,
  status text not null default 'pending', -- pending|running|done|shadowed|skipped
  turn_id uuid,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_id, agent_id)
);
create index if not exists event_deliveries_pending_idx on event_deliveries (status, created_at);
create index if not exists event_deliveries_case_idx on event_deliveries (case_id);

create table if not exists review_requests (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references work_items(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  kind text not null default 'question', -- approval|question|exception
  question text not null,
  proposal jsonb,
  candidates jsonb,
  options jsonb,
  queue_key text references work_queues(key),
  status text not null default 'pending', -- pending|answered|void
  answer jsonb,
  answered_by text,
  created_at timestamptz not null default now(),
  answered_at timestamptz
);
create index if not exists review_requests_case_idx on review_requests (case_id, status);
create index if not exists review_requests_queue_idx on review_requests (queue_key, status);

create table if not exists routing_rules (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  filter jsonb not null default '{}'::jsonb,
  queue_key text not null references work_queues(key),
  priority int not null default 100,
  owner text,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists routing_rules_type_idx on routing_rules (event_type, priority);

create table if not exists event_types (
  type text primary key,
  description text,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);

alter table agents add column if not exists subscriptions jsonb not null default '[]'::jsonb;
alter table agents add column if not exists owner text;
alter table work_items add column if not exists state_version int not null default 0;
alter table work_items add column if not exists claimed_at timestamptz;
alter table outbound_attempts add column if not exists kind text;
alter table outbound_attempts add column if not exists dedupe_key text;
create unique index if not exists outbound_attempts_dedupe_idx on outbound_attempts (dedupe_key) where dedupe_key is not null;
alter table work_queues add column if not exists kind text not null default 'work';
alter table work_queues add column if not exists config jsonb not null default '{}'::jsonb;
alter table audit_log add column if not exists turn_id uuid;
alter table audit_log add column if not exists delivery_id uuid;
