-- Add config column to agents for low-code chase-policy configurability.
-- Idempotent: IF NOT EXISTS means safe to run on any environment state.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}';
