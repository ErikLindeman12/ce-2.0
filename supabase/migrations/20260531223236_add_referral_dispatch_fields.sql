-- Add dispatch tracking fields to referrals.
-- Status values now: 'sent', 'dispatch_failed', 'queued' (replaces 'received').

alter table referrals add column if not exists dispatch_error text;
alter table referrals alter column status set default 'queued';
