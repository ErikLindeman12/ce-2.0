-- The app talks to Postgres only via the server-side service_role key.
-- Tables created through the Management API did not pick up the default
-- table grants, so service_role had no privileges. Grant them explicitly.
grant usage on schema public to service_role;
grant select, insert, update, delete on public.organizations to service_role;
grant select, insert, update, delete on public.referrals to service_role;

-- Keep future tables working without another manual grant.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
