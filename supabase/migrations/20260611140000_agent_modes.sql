-- Add mode column to agents table.
-- Idempotent: safe to re-apply.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'autonomous';
