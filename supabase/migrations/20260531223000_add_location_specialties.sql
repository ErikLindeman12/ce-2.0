-- CE-17: Add location + specialties columns to organizations for directory search.

ALTER TABLE organizations
  ADD COLUMN city text,
  ADD COLUMN state text,
  ADD COLUMN zip text,
  ADD COLUMN specialties text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS organizations_state_idx ON organizations(state);
CREATE INDEX IF NOT EXISTS organizations_city_idx ON organizations(city);
CREATE INDEX IF NOT EXISTS organizations_specialties_idx ON organizations USING GIN(specialties);
