-- Demo fixtures for the org directory. Idempotent (safe to re-run).
-- Runs automatically on `supabase db reset` (local). To load into the remote
-- project, run it once explicitly (see docs/comment in this commit).
INSERT INTO organizations (id, name, tenant_slug, endpoint_url, channels, data_types, specialties, city, state, zip) VALUES
  ('org_mayo',      'Mayo Clinic',                  'mayo-clinic',       'https://api.mayo-clinic.ce2.local',      '{cloud,direct}',     '{labs,meds,imaging}',    '{cardiology,orthopedics,neurology,rheumatology}', 'Rochester',   'MN', '55905'),
  ('org_mayo_wi',   'Mayo Clinic Health System WI', 'mayo-clinic-wi',    'https://api.mayo-wi.ce2.local',          '{cloud,direct}',     '{labs,meds,imaging}',    '{cardiology,rheumatology,primary-care}',          'La Crosse',   'WI', '54601'),
  ('org_mgh',       'Mass General',                 'mass-general',      'https://api.mass-general.ce2.local',     '{cloud,fax,direct}', '{labs,meds,notes}',      '{oncology,neurology,cardiology}',                 'Boston',      'MA', '02114'),
  ('org_cleveland', 'Cleveland Clinic',             'cleveland-clinic',  'https://api.cleveland-clinic.ce2.local', '{cloud}',            '{labs,imaging,notes}',   '{cardiology,orthopedics,gastroenterology}',       'Cleveland',   'OH', '44195'),
  ('org_jhh',       'Johns Hopkins Hospital',       'johns-hopkins',     'https://api.johns-hopkins.ce2.local',    '{cloud,direct}',     '{labs,meds,imaging}',    '{oncology,neurology,rheumatology}',               'Baltimore',   'MD', '21287'),
  ('org_kaiser',    'Kaiser Permanente',            'kaiser-permanente', 'https://api.kaiser.ce2.local',           '{cloud,portal}',     '{labs,meds,notes}',      '{primary-care,cardiology,dermatology}',           'Oakland',     'CA', '94612'),
  ('org_ucsf',      'UCSF Medical Center',          'ucsf',              'https://api.ucsf.ce2.local',             '{cloud,direct,fax}', '{labs,imaging}',         '{neurology,oncology,radiology}',                  'San Francisco','CA', '94143'),
  ('org_froedtert', 'Froedtert Hospital',           'froedtert',         'https://api.froedtert.ce2.local',        '{cloud,direct}',     '{labs,meds,imaging}',    '{cardiology,orthopedics,oncology}',               'Milwaukee',   'WI', '53226'),
  ('org_aurora',    'Aurora Health Care',            'aurora-health',     'https://api.aurora.ce2.local',           '{cloud,portal}',     '{labs,meds,notes}',      '{primary-care,cardiology,neurology}',             'Milwaukee',   'WI', '53204')
ON CONFLICT (id) DO NOTHING;

-- Demo providers linked to the organizations above.
INSERT INTO providers (id, org_id, name, npi, specialty) VALUES
  ('prov_chen',     'org_cleveland',  'Dr. Lisa Chen',         '1234567890', 'cardiology'),
  ('prov_garcia',   'org_mayo',       'Dr. Marco Garcia',      '2345678901', 'orthopedics'),
  ('prov_patel',    'org_mgh',        'Dr. Priya Patel',       '3456789012', 'oncology'),
  ('prov_kim',      'org_ucsf',       'Dr. David Kim',         '4567890123', 'neurology'),
  ('prov_wright',   'org_jhh',        'Dr. Sarah Wright',      '5678901234', 'oncology'),
  ('prov_tanaka',   'org_kaiser',     'Dr. Kenji Tanaka',      '6789012345', 'primary-care'),
  ('prov_lee',      'org_cleveland',  'Dr. Jennifer Lee',      '7890123456', 'cardiology'),
  ('prov_brooks',   'org_mayo',       'Dr. Michael Brooks',    '8901234567', 'neurology'),
  ('prov_mueller',  'org_mayo_wi',    'Dr. Anna Mueller',      '9012345678', 'cardiology'),
  ('prov_johnson',  'org_froedtert',  'Dr. Robert Johnson',    '0123456789', 'cardiology'),
  ('prov_smith',    'org_aurora',     'Dr. Emily Smith',       '1122334455', 'cardiology'),
  ('prov_nguyen',   'org_mayo_wi',    'Dr. Tran Nguyen',       '2233445566', 'rheumatology'),
  ('prov_wilson',   'org_froedtert',  'Dr. Mark Wilson',       '3344556677', 'orthopedics'),
  ('prov_davis',    'org_aurora',     'Dr. Karen Davis',       '4455667788', 'neurology')
ON CONFLICT (id) DO NOTHING;
