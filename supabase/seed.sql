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

-- =============================================================================
-- W1b seed additions (idempotent)
-- =============================================================================

-- Records Chaser: set config.chase_policy (fax → fax → voice @ 30s wait).
-- Steps stored as plain channel strings; expanded to ChaseStep at compose time.
INSERT INTO agents (name, queue_key, enabled, instructions, tools, confidence_threshold, model, config)
  VALUES (
    'Records Chaser',
    'roi_outgoing',
    true,
    'Send outgoing records requests and manage the chase loop. On a fresh item compose and send the initial request via the org preferred channel. When a response arrives mark the item complete with "records received".',
    '{send_fax,send_email,send_sms,place_call,mark_complete,escalate_to_human}',
    0.7,
    'heuristic',
    '{"chase_policy":{"steps":["fax","fax","voice"],"waitSeconds":30}}'
  )
  ON CONFLICT (name) DO UPDATE
    SET config = '{"chase_policy":{"steps":["fax","fax","voice"],"waitSeconds":30}}'::jsonb;

-- org_mgh: secure-email ladder (email → voice @ 30s wait).
UPDATE organizations
  SET contact = contact || '{"chase_policy":{"steps":["email","voice"],"waitSeconds":30}}'::jsonb
  WHERE id = 'org_mgh';

-- org_cleveland: remove preferred_channel='portal' (portal is no longer an outbound channel).
-- Ensure 'cloud' is in capabilities.channels for Care Everywhere detection.
UPDATE organizations
  SET contact = contact - 'preferred_channel'
  WHERE id = 'org_cleveland'
    AND contact->>'preferred_channel' = 'portal';

UPDATE organizations
  SET channels = array(
    SELECT DISTINCT unnest(channels || ARRAY['cloud'])
  )
  WHERE id = 'org_cleveland'
    AND NOT ('cloud' = ANY(channels));

-- org_mayo: ensure 'cloud' in capabilities.channels (Care Everywhere).
UPDATE organizations
  SET channels = array(
    SELECT DISTINCT unnest(channels || ARRAY['cloud'])
  )
  WHERE id = 'org_mayo'
    AND NOT ('cloud' = ANY(channels));

-- W1b: network membership — only true Epic orgs carry 'cloud' (Care Everywhere).
-- Off-network orgs are reached via chase ladders (fax/secure email/voice).
UPDATE organizations SET channels = array_remove(channels, 'cloud')
  WHERE id IN ('org_ucsf','org_mgh','org_aurora','org_kaiser','org_froedtert');

-- W1b: org_mgh is the secure-email-ladder org — it needs an email address
-- (its email was removed in an earlier demo role; chase steps without contact
-- info are skipped, which silently collapsed its email→voice ladder).
UPDATE organizations SET contact = contact || '{"email":"records@mgh.example"}'::jsonb
  WHERE id = 'org_mgh';

-- =============================================================================
-- EVENT SUBSTRATE SEED (docs/substrate-spec.md §5) — the workflows as data.
-- Runs AFTER the legacy agent upserts above, so these values are final state.
-- All statements idempotent: ON CONFLICT upserts or WHERE NOT EXISTS guards.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Work queues: new prior_auth queue + queue kinds + minimal column configs
-- ---------------------------------------------------------------------------
INSERT INTO work_queues (key, name, description, sort_order) VALUES
  ('prior_auth', 'Prior Auth', 'Prior authorization requests being chased with payers', 5)
ON CONFLICT (key) DO UPDATE
  SET name        = EXCLUDED.name,
      description = EXCLUDED.description;

-- human_review is the review surface (cases join through pending review_requests);
-- everything else is a plain work queue.
UPDATE work_queues SET kind = 'review' WHERE key = 'human_review' AND kind IS DISTINCT FROM 'review';
UPDATE work_queues SET kind = 'work'   WHERE key <> 'human_review' AND kind IS DISTINCT FROM 'work';

UPDATE work_queues
  SET config = '{"columns":[{"type":"field","key":"patient","label":"Patient","path":"extracted.patient_name"},{"type":"chase_progress"}]}'::jsonb
  WHERE key = 'prior_auth';

UPDATE work_queues
  SET config = '{"columns":[{"type":"review_reason"}]}'::jsonb
  WHERE key = 'human_review';

-- ---------------------------------------------------------------------------
-- Event types: the taxonomy (descriptions power the builder/timeline UI)
-- ---------------------------------------------------------------------------
INSERT INTO event_types (type, description) VALUES
  ('document.received',  'An inbound document arrived (fax, direct message, call artifact, portal submission)'),
  ('document.classified','A document was classified into a case type'),
  ('fields.extracted',   'Structured fields were extracted from a document'),
  ('patient.matched',    'A patient was matched against the MPI'),
  ('case.created',       'A new case (work item) was created'),
  ('case.routed',        'The router placed a case into a work queue'),
  ('case.moved',         'A case was manually moved to another queue'),
  ('attempt.created',    'An outbound attempt was created (fax, email, sms, voice, care everywhere)'),
  ('response.received',  'A response to an outbound attempt arrived'),
  ('attempt.timed_out',  'An outbound attempt timed out with no response'),
  ('timer.elapsed',      'A durable timer fired'),
  ('review.requested',   'An agent asked a human for a decision'),
  ('review.voided',      'A pending review request was voided (stale or superseded)'),
  ('human.decided',      'A human answered a review request'),
  ('case.completed',     'A case was completed with a result')
ON CONFLICT (type) DO UPDATE
  SET description = EXCLUDED.description;

-- ---------------------------------------------------------------------------
-- Routing rules: the Router's placement config. routing_rules has no natural
-- key and survives demo resets, so guard each insert with WHERE NOT EXISTS.
-- ---------------------------------------------------------------------------
INSERT INTO routing_rules (event_type, filter, queue_key, priority, owner)
SELECT 'document.received', '{}'::jsonb, 'intake', 100, 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM routing_rules
  WHERE event_type = 'document.received' AND queue_key = 'intake' AND filter = '{}'::jsonb
);

INSERT INTO routing_rules (event_type, filter, queue_key, priority, owner)
SELECT 'document.classified', '{"as":"referral"}'::jsonb, 'referrals', 100, 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM routing_rules
  WHERE event_type = 'document.classified' AND queue_key = 'referrals' AND filter = '{"as":"referral"}'::jsonb
);

INSERT INTO routing_rules (event_type, filter, queue_key, priority, owner)
SELECT 'document.classified', '{"as":"records_request_in"}'::jsonb, 'roi_incoming', 100, 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM routing_rules
  WHERE event_type = 'document.classified' AND queue_key = 'roi_incoming' AND filter = '{"as":"records_request_in"}'::jsonb
);

INSERT INTO routing_rules (event_type, filter, queue_key, priority, owner)
SELECT 'document.classified', '{"as":"prior_auth"}'::jsonb, 'prior_auth', 100, 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM routing_rules
  WHERE event_type = 'document.classified' AND queue_key = 'prior_auth' AND filter = '{"as":"prior_auth"}'::jsonb
);

INSERT INTO routing_rules (event_type, filter, queue_key, priority, owner)
SELECT 'review.requested', '{}'::jsonb, 'human_review', 100, 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM routing_rules
  WHERE event_type = 'review.requested' AND queue_key = 'human_review' AND filter = '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- Agents: subscriptions + named policies. These upserts run after (and win
-- over) the legacy agent blocks above. Tools lose the retired verbs
-- (advance_stage / mark_complete / escalate_to_human) — completion verbs
-- (report_result / request_human_review / emit_event / wait) replace them.
-- mode and enabled are NOT in the DO UPDATE set, so runtime flips
-- (shadow→live, enable/disable) survive a reseed.
-- ---------------------------------------------------------------------------

-- Intake Agent: wakes on every inbound document; classify→extract→match.
INSERT INTO agents (name, queue_key, enabled, mode, instructions, tools, confidence_threshold, model, subscriptions, config)
  VALUES (
    'Intake Agent',
    'intake',
    true,
    'autonomous',
    'Classify inbound documents, extract patient fields, match against the MPI, and route to the appropriate downstream queue. If confidence is below threshold on any step, escalate to Human Review with the specific question.',
    '{classify_document,extract_fields,match_patient}',
    0.8,
    'heuristic',
    '[{"event_type":"document.received"}]'::jsonb,
    '{"classify_rules":[{"matches":"prior auth","type":"prior_auth"}]}'::jsonb
  )
ON CONFLICT (name) DO UPDATE
  SET queue_key            = EXCLUDED.queue_key,
      instructions         = EXCLUDED.instructions,
      tools                = EXCLUDED.tools,
      confidence_threshold = EXCLUDED.confidence_threshold,
      model                = EXCLUDED.model,
      subscriptions        = EXCLUDED.subscriptions,
      config               = EXCLUDED.config;

-- ROI Fulfillment Agent: verify requirements → request missing info → send
-- records → complete. response.received merges the portal/fax authorization
-- into extracted and re-arms requirement verification.
INSERT INTO agents (name, queue_key, enabled, mode, instructions, tools, confidence_threshold, model, subscriptions, config)
  VALUES (
    'ROI Fulfillment Agent',
    'roi_incoming',
    true,
    'autonomous',
    'Verify that incoming records requests include a matched patient, a records description, and an authorization line. If complete, send records back via the requester org preferred channel and mark complete. If info is missing, send request_more_info outbound and set item to waiting.',
    '{verify_requirements,send_fax,send_email,send_sms,request_more_info}',
    0.8,
    'heuristic',
    '[{"event_type":"document.classified","filter":{"as":"records_request_in"}},{"event_type":"response.received","filter":{"case_type":"records_request_in"},"on_event":{"merge_payload":[{"from":"payload.response.authorization","to":"extracted.authorization"}],"clear_state":["requirements","more_info_sent"],"set_state":{"response_received":true}}},{"event_type":"human.decided","filter":{"case_type":"records_request_in"}}]'::jsonb,
    '{"requirements":[{"flag":"has_patient","path":"case.matched_patient_id","op":"exists"},{"flag":"has_records","path":"extracted.records_requested","op":"exists","on_missing":{"message":"Please specify which records are needed."}},{"flag":"has_auth","path":"extracted.authorization","op":"exists","and":[{"path":"extracted.authorization","op":"not_matches","value":"to follow"}],"on_missing":{"message":"Missing patient authorization — please attach a signed authorization.","max_requests":2}}],"send_policy":{"document_kind":"records_response","set_flag":"records_sent"},"complete_when":[{"when":{"all":[{"path":"state.records_sent","op":"eq","value":true}]},"outcome":{"result":"records_sent","note":"Records sent — request fulfilled."}}]}'::jsonb
  )
ON CONFLICT (name) DO UPDATE
  SET queue_key            = EXCLUDED.queue_key,
      instructions         = EXCLUDED.instructions,
      tools                = EXCLUDED.tools,
      confidence_threshold = EXCLUDED.confidence_threshold,
      model                = EXCLUDED.model,
      subscriptions        = EXCLUDED.subscriptions,
      config               = EXCLUDED.config;

-- Records Chaser: owns the outbound chase ladder for records_request_out.
-- complete_when fires when a response lands (state set by the subscription).
INSERT INTO agents (name, queue_key, enabled, mode, instructions, tools, confidence_threshold, model, subscriptions, config)
  VALUES (
    'Records Chaser',
    'roi_outgoing',
    true,
    'autonomous',
    'Send outgoing records requests and manage the chase loop. On a fresh item compose and send the initial request via the org preferred channel. When a response arrives mark the item complete with "records received".',
    '{send_fax,send_email,send_sms,place_call,send_care_everywhere}',
    0.7,
    'heuristic',
    '[{"event_type":"case.created","filter":{"case_type":"records_request_out"}},{"event_type":"attempt.timed_out","filter":{"case_type":"records_request_out"}},{"event_type":"response.received","filter":{"case_type":"records_request_out"},"on_event":{"set_state":{"response_received":true,"last_channel":"$payload.channel"}}}]'::jsonb,
    '{"chase_policy":{"steps":["fax","fax","voice"],"waitSeconds":30},"complete_when":[{"when":{"all":[{"path":"state.response_received","op":"eq","value":true}]},"outcome":{"result":"records_received","note":"Records received via {{state.last_channel}} — ref ROI-{{case.id8}}."}}]}'::jsonb
  )
ON CONFLICT (name) DO UPDATE
  SET queue_key            = EXCLUDED.queue_key,
      instructions         = EXCLUDED.instructions,
      tools                = EXCLUDED.tools,
      confidence_threshold = EXCLUDED.confidence_threshold,
      model                = EXCLUDED.model,
      subscriptions        = EXCLUDED.subscriptions,
      config               = EXCLUDED.config;

-- Auth Chaser (NEW): prior-auth workflow as pure config — no engine code knows
-- about it. Ships in shadow mode (flip to live in the builder for the demo).
INSERT INTO agents (name, queue_key, enabled, mode, instructions, tools, confidence_threshold, model, owner, subscriptions, config)
  VALUES (
    'Auth Chaser',
    'prior_auth',
    true,
    'shadow',
    'Chase payers for prior authorization decisions. Try the configured ladder; escalate to a human when exhausted.',
    '{send_fax,send_email,place_call}',
    0.75,
    'heuristic',
    'seed',
    '[{"event_type":"document.classified","filter":{"as":"prior_auth"}},{"event_type":"attempt.timed_out","filter":{"case_type":"prior_auth"}},{"event_type":"response.received","filter":{"case_type":"prior_auth"},"on_event":{"set_state":{"response_received":true,"last_channel":"$payload.channel"}}}]'::jsonb,
    '{"chase_policy":{"steps":["fax","fax","voice"],"waitSeconds":30,"on_exhausted":{"question":"Payer unresponsive after 3 attempts — call the payer line or park this auth?"}},"complete_when":[{"when":{"all":[{"path":"state.response_received","op":"eq","value":true}]},"outcome":{"result":"auth_received","note":"Authorization decision received via {{state.last_channel}}."}}]}'::jsonb
  )
ON CONFLICT (name) DO UPDATE
  SET queue_key            = EXCLUDED.queue_key,
      instructions         = EXCLUDED.instructions,
      tools                = EXCLUDED.tools,
      confidence_threshold = EXCLUDED.confidence_threshold,
      model                = EXCLUDED.model,
      owner                = EXCLUDED.owner,
      subscriptions        = EXCLUDED.subscriptions,
      config               = EXCLUDED.config;
