-- Demo fixtures for the org directory. Idempotent (safe to re-run).
-- Runs automatically on `supabase db reset` (local). To load into the remote
-- project, run it once explicitly (see docs/comment in this commit).
insert into organizations (id, name, tenant_slug, endpoint_url, channels, data_types) values
  ('org_mayo',      'Mayo Clinic',             'mayo-clinic',      'https://api.mayo-clinic.ce2.local',      '{cloud,direct}',     '{labs,meds,imaging}'),
  ('org_mgh',       'Mass General',            'mass-general',     'https://api.mass-general.ce2.local',     '{cloud,fax,direct}', '{labs,meds,notes}'),
  ('org_cleveland', 'Cleveland Clinic',        'cleveland-clinic', 'https://api.cleveland-clinic.ce2.local', '{cloud}',            '{labs,imaging,notes,cardiology}'),
  ('org_jhh',       'Johns Hopkins Hospital',  'johns-hopkins',    'https://api.johns-hopkins.ce2.local',    '{cloud,direct}',     '{labs,meds,imaging,oncology}'),
  ('org_kaiser',    'Kaiser Permanente',       'kaiser-permanente','https://api.kaiser.ce2.local',           '{cloud,portal}',     '{labs,meds,notes,primary-care}'),
  ('org_ucsf',      'UCSF Medical Center',     'ucsf',             'https://api.ucsf.ce2.local',             '{cloud,direct,fax}', '{labs,imaging,neurology}')
on conflict (id) do nothing;

-- Demo providers linked to the organizations above.
insert into providers (id, org_id, name, npi, specialty) values
  ('prov_chen',    'org_cleveland', 'Dr. Lisa Chen',       '1234567890', 'cardiology'),
  ('prov_garcia',  'org_mayo',      'Dr. Marco Garcia',    '2345678901', 'orthopedics'),
  ('prov_patel',   'org_mgh',       'Dr. Priya Patel',     '3456789012', 'oncology'),
  ('prov_kim',     'org_ucsf',      'Dr. David Kim',       '4567890123', 'neurology'),
  ('prov_wright',  'org_jhh',       'Dr. Sarah Wright',    '5678901234', 'oncology'),
  ('prov_tanaka',  'org_kaiser',    'Dr. Kenji Tanaka',    '6789012345', 'primary-care'),
  ('prov_lee',     'org_cleveland', 'Dr. Jennifer Lee',    '7890123456', 'cardiology'),
  ('prov_brooks',  'org_mayo',      'Dr. Michael Brooks',  '8901234567', 'neurology')
on conflict (id) do nothing;
