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
-- NOTE: providers must be inserted before referral_requirements that reference them.
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

-- Referral requirements: org-level and provider-level custom configs.
-- Orgs/providers without a row here get baseline fields only.

-- Cleveland Clinic (org-level): requires insurance + makes clinical notes mandatory.
INSERT INTO referral_requirements (org_id, provider_id, required_fields, custom_config) VALUES
  ('org_cleveland', null,
   '[
     {"key":"clinicalNotes","label":"Clinical notes","type":"textarea","required":true},
     {"key":"insurancePolicyNumber","label":"Insurance policy number","type":"text","required":true},
     {"key":"priorAuthNumber","label":"Prior authorization number","type":"text","required":false}
   ]'::jsonb,
   '{"noteFormat":"SOAP"}'::jsonb),

-- UCSF (org-level): adds contact preference + imaging checkbox.
  ('org_ucsf', null,
   '[
     {"key":"preferredContactMethod","label":"Preferred contact method","type":"select","required":true,"options":["phone","fax","portal"]},
     {"key":"imagingResultsAttached","label":"Prior imaging attached?","type":"boolean","required":true}
   ]'::jsonb,
   '{}'::jsonb),

-- Dr. Lisa Chen (provider-level): requires prior imaging results on top of Cleveland's org config.
  (null, 'prov_chen',
   '[
     {"key":"priorImagingResults","label":"Prior imaging results","type":"textarea","required":true}
   ]'::jsonb,
   '{"preferredReferralWindow":"2 weeks"}'::jsonb)

ON CONFLICT DO NOTHING;

-- =============================================================================
-- WORK QUEUE PLATFORM SEED DATA
-- All inserts idempotent via ON CONFLICT clauses.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Work queues (5)
-- ---------------------------------------------------------------------------
INSERT INTO work_queues (key, name, description, sort_order) VALUES
  ('intake',        'Intake',          'Incoming faxes and messages awaiting classification', 0),
  ('referrals',     'Referrals',       'Inbound referral requests ready for processing',      1),
  ('roi_incoming',  'ROI — Incoming',  'Incoming release-of-information / records requests',  2),
  ('roi_outgoing',  'ROI — Outgoing',  'Outgoing records requests we sent; awaiting response',3),
  ('human_review',  'Human Review',    'Items escalated for human decision',                  4)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Mock patients (8, including two "Maria Garcia" with different DOBs)
-- ---------------------------------------------------------------------------
INSERT INTO patients (id, first_name, last_name, dob, mrn, phone) VALUES
  ('a1b2c3d4-0001-0001-0001-000000000001', 'James',   'Whitfield', '1955-08-14', 'MRN-00101', '+1-608-555-0101'),
  ('a1b2c3d4-0002-0002-0002-000000000002', 'Maria',   'Garcia',    '1981-03-04', 'MRN-00102', '+1-608-555-0102'),
  ('a1b2c3d4-0003-0003-0003-000000000003', 'Maria',   'Garcia',    '1990-07-22', 'MRN-00103', '+1-608-555-0103'),
  ('a1b2c3d4-0004-0004-0004-000000000004', 'Robert',  'Tanaka',    '1963-11-30', 'MRN-00104', '+1-608-555-0104'),
  ('a1b2c3d4-0005-0005-0005-000000000005', 'Susan',   'Chen',      '1978-05-19', 'MRN-00105', '+1-608-555-0105'),
  ('a1b2c3d4-0006-0006-0006-000000000006', 'David',   'Kim',       '1945-02-28', 'MRN-00106', '+1-608-555-0106'),
  ('a1b2c3d4-0007-0007-0007-000000000007', 'Linda',   'Okafor',    '1972-09-07', 'MRN-00107', '+1-608-555-0107'),
  ('a1b2c3d4-0008-0008-0008-000000000008', 'Thomas',  'Reyes',     '1988-12-03', 'MRN-00108', '+1-608-555-0108')
ON CONFLICT (mrn) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Organization contact info for outbound channels.
-- org_mgh   → fax-only preferred (fax + preferred_channel = fax)
-- org_ucsf  → "never answers" simulation flag (no_response)
-- Others    → mixed channels
-- ---------------------------------------------------------------------------
UPDATE organizations SET contact = '{"fax":"+1-617-555-0142","email":"records@mass-general.example","phone":"+1-617-555-0143","preferred_channel":"fax"}'::jsonb
  WHERE id = 'org_mgh';

UPDATE organizations SET contact = '{"fax":"+1-415-555-0142","email":"records@ucsf.example","phone":"+1-415-555-0143","preferred_channel":"fax","simulation":"no_response"}'::jsonb
  WHERE id = 'org_ucsf';

UPDATE organizations SET contact = '{"fax":"+1-507-555-0142","email":"records@mayo.example","phone":"+1-507-555-0143","preferred_channel":"email"}'::jsonb
  WHERE id = 'org_mayo';

UPDATE organizations SET contact = '{"fax":"+1-608-555-0142","email":"records@mayo-wi.example","phone":"+1-608-555-0143","preferred_channel":"fax"}'::jsonb
  WHERE id = 'org_mayo_wi';

UPDATE organizations SET contact = '{"fax":"+1-216-555-0142","email":"records@cleveland.example","phone":"+1-216-555-0143","preferred_channel":"email"}'::jsonb
  WHERE id = 'org_cleveland';

UPDATE organizations SET contact = '{"fax":"+1-410-555-0142","email":"records@jhh.example","phone":"+1-410-555-0143","preferred_channel":"email"}'::jsonb
  WHERE id = 'org_jhh';

UPDATE organizations SET contact = '{"fax":"+1-510-555-0142","email":"records@kaiser.example","phone":"+1-510-555-0143","preferred_channel":"email"}'::jsonb
  WHERE id = 'org_kaiser';

UPDATE organizations SET contact = '{"fax":"+1-414-555-0142","email":"records@froedtert.example","phone":"+1-414-555-0143","preferred_channel":"fax"}'::jsonb
  WHERE id = 'org_froedtert';

UPDATE organizations SET contact = '{"fax":"+1-414-555-0242","email":"records@aurora.example","phone":"+1-414-555-0243","preferred_channel":"email"}'::jsonb
  WHERE id = 'org_aurora';

-- ---------------------------------------------------------------------------
-- Default agents (3) — unique constraint on name makes ON CONFLICT work
-- ---------------------------------------------------------------------------
INSERT INTO agents (name, queue_key, enabled, instructions, tools, confidence_threshold, model) VALUES
  (
    'Intake Agent',
    'intake',
    true,
    'Classify inbound documents, extract patient fields, match against the MPI, and route to the appropriate downstream queue. If confidence is below threshold on any step, escalate to Human Review with the specific question.',
    '{classify_document,extract_fields,match_patient,advance_stage,escalate_to_human}',
    0.8,
    'heuristic'
  ),
  (
    'ROI Fulfillment Agent',
    'roi_incoming',
    true,
    'Verify that incoming records requests include a matched patient, a records description, and an authorization line. If complete, send records back via the requester org preferred channel and mark complete. If info is missing, send request_more_info outbound and set item to waiting.',
    '{verify_requirements,send_fax,send_email,mark_complete,request_more_info,escalate_to_human}',
    0.8,
    'heuristic'
  ),
  (
    'Records Chaser',
    'roi_outgoing',
    true,
    'Send outgoing records requests and manage the chase loop. On a fresh item compose and send the initial request via the org preferred channel. When a response arrives mark the item complete with "records received".',
    '{send_fax,send_email,send_sms,place_call,mark_complete,escalate_to_human}',
    0.7,
    'heuristic'
  )
ON CONFLICT (name) DO UPDATE
  SET queue_key            = EXCLUDED.queue_key,
      instructions         = EXCLUDED.instructions,
      tools                = EXCLUDED.tools,
      confidence_threshold = EXCLUDED.confidence_threshold,
      model                = EXCLUDED.model;

-- =============================================================================
-- W1 outbound-engine seed additions (idempotent jsonb UPDATEs)
-- =============================================================================

-- org_cleveland → preferred_channel='portal' (on-network; keep other contact fields)
UPDATE organizations
  SET contact = contact || '{"preferred_channel":"portal"}'::jsonb
  WHERE id = 'org_cleveland';

-- org_ucsf → keep simulation='no_response' (already set above; this is a no-op guard)
UPDATE organizations
  SET contact = contact || '{"simulation":"no_response"}'::jsonb
  WHERE id = 'org_ucsf'
    AND NOT (contact ? 'simulation');

-- org_mgh → fax+phone ONLY (no email) so its channel plan visibly skips email.
-- Remove email key; keep fax, phone, preferred_channel=fax.
UPDATE organizations
  SET contact = (contact - 'email') || '{"preferred_channel":"fax"}'::jsonb
  WHERE id = 'org_mgh';
