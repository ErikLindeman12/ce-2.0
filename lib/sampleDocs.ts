/**
 * lib/sampleDocs.ts — canned fax/DM texts for the simulation scenarios.
 *
 * Heuristic confidence requirements:
 *   fax_referral_clean    → classify ≥0.9, extract ≥0.85, match ≥0.9 (exact name+DOB)
 *   fax_roi_clean         → classify ≥0.9, extract ≥0.85, match ≥0.9 (exact name+DOB)
 *   fax_ambiguous_patient → classify ≥0.9, extract ≥0.7 (name only, no DOB), match ~0.45 (two candidates)
 *   fax_messy             → classify ~0.3, extract ~0.2  (no labels, garbled)
 *   dm_records_request    → classify ≥0.9, extract ≥0.9, match ≥0.97 (exact name+DOB via JSON-ish)
 *   fax_roi_missing_auth  → classify ≥0.9, extract ~0.5 (auth line missing → low completeness)
 *   call_referral         → classify ≥0.9, extract ≥0.9 (CALL SUMMARY block), match ≥0.97
 *   call_records_request  → classify ≥0.9, extract ≥0.9 (CALL SUMMARY block), match ≥0.97
 *   fax_referral_partial  → classify ≥0.9, extract ~0.85 (labeled), match ~0.6 (fuzzy single-candidate)
 *   fax_prior_auth        → classify ≥0.9 via agent classify_rules ('prior auth'), extract ≥0.85 (labeled), match ≥0.97 (exact name+DOB+MRN)
 */

export type ScenarioKey =
  | 'fax_referral_clean'
  | 'fax_roi_clean'
  | 'fax_ambiguous_patient'
  | 'fax_messy'
  | 'dm_records_request'
  | 'fax_roi_missing_auth'
  | 'call_referral'
  | 'call_records_request'
  | 'fax_referral_partial'
  | 'fax_prior_auth';

export type BatchKey = 'batch_morning';

export interface SampleDoc {
  scenario: ScenarioKey;
  source_channel: 'fax' | 'direct_message' | 'phone';
  /** org_id of the sending org (used to set org_id on the work item) */
  from_org_id: string;
  source_text: string;
}

export const SAMPLE_DOCS: Record<ScenarioKey, SampleDoc> = {
  // -------------------------------------------------------------------------
  // 1. Clean cardiology referral fax — seeded patient James Whitfield
  //    All labeled fields present → classify ~0.95, extract ~0.9, match ~0.97
  // -------------------------------------------------------------------------
  fax_referral_clean: {
    scenario: 'fax_referral_clean',
    source_channel: 'fax',
    from_org_id: 'org_mayo',
    source_text: `
REFERRAL REQUEST — FAX TRANSMISSION
=====================================
From:     Dr. Michael Brooks, Mayo Clinic
Fax:      +1-507-555-0100
Date:     2026-06-11

To:       Froedtert Hospital — Cardiology
Fax:      +1-414-555-0142

Patient:  James Whitfield
DOB:      1955-08-14
MRN:      MRN-00101
Phone:    +1-608-555-0101

Reason:   New patient cardiology evaluation — atrial fibrillation workup.
          Patient reports palpitations and shortness of breath x 3 months.
          Recent EKG shows irregularly irregular rhythm consistent with AF.

Priority: Routine
Provider: Dr. Michael Brooks NPI 8901234567

Please confirm receipt.
`.trim(),
  },

  // -------------------------------------------------------------------------
  // 2. Clean ROI request — seeded patient Susan Chen, org_mgh requesting records
  //    All labeled fields + authorization line present
  //    classify ~0.95, extract ~0.9, match ~0.97
  // -------------------------------------------------------------------------
  fax_roi_clean: {
    scenario: 'fax_roi_clean',
    source_channel: 'fax',
    from_org_id: 'org_mgh',
    source_text: `
RELEASE OF INFORMATION REQUEST
================================
From:     Mass General Hospital — Records Department
Fax:      +1-617-555-0142
Date:     2026-06-11

To:       Froedtert Hospital — Medical Records

Patient:  Susan Chen
DOB:      1978-05-19
MRN:      MRN-00105

Records Requested: All cardiology notes and EKGs from 2024-01-01 to present.

Authorization: Patient authorization on file. Signed consent form attached.
               Authorization#: AUTH-20260611-0105

Requesting Provider: Dr. Priya Patel NPI 3456789012
Reason: Continuity of care — oncology co-management.

Please fax records to +1-617-555-0142.
`.trim(),
  },

  // -------------------------------------------------------------------------
  // 3. Ambiguous patient — "Maria Garcia" with NO DOB
  //    Two seeded patients share this name → match confidence ~0.45
  //    classify ~0.93, extract ~0.72 (name present, DOB absent)
  // -------------------------------------------------------------------------
  fax_ambiguous_patient: {
    scenario: 'fax_ambiguous_patient',
    source_channel: 'fax',
    from_org_id: 'org_cleveland',
    source_text: `
REFERRAL REQUEST — FAX TRANSMISSION
=====================================
From:     Cleveland Clinic — Dr. Jennifer Lee
Fax:      +1-216-555-0142
Date:     2026-06-11

To:       Froedtert Hospital — Cardiology

Patient:  Maria Garcia
Phone:    +1-414-555-9999

Reason:   Cardiology referral for stress test evaluation.
          Patient has exertional chest pain on moderate activity.

Priority: Routine
Provider: Dr. Jennifer Lee NPI 7890123456

Please confirm receipt.
`.trim(),
  },

  // -------------------------------------------------------------------------
  // 4. Messy fax — garbled OCR, no labeled fields at all
  //    classify ~0.3 (no keywords), extract ~0.15 (no labels found)
  // -------------------------------------------------------------------------
  fax_messy: {
    scenario: 'fax_messy',
    source_channel: 'fax',
    from_org_id: 'org_aurora',
    source_text: `
Frm: Aur0ra Hea1th 4-14555O242
Dat3: Jun 11 202G

Frdtert Hosp  Recrd Dept

plz send recs 4 pt above ASAP we need befor appt
wh1tfield?? or mby ch3n — npt sure which -- pls check

stess test restlts 2024 also labz from jan

thnk u
Aur0ra Team
`.trim(),
  },

  // -------------------------------------------------------------------------
  // 5. Structured direct message — clean JSON-ish payload
  //    classify ~0.97 (records request + ROI keywords), extract ~0.95, match ~0.97
  // -------------------------------------------------------------------------
  dm_records_request: {
    scenario: 'dm_records_request',
    source_channel: 'direct_message',
    from_org_id: 'org_jhh',
    source_text: `
{
  "message_type": "RELEASE OF INFORMATION REQUEST",
  "from_org": "Johns Hopkins Hospital",
  "from_contact": "records@jhh.example",
  "date": "2026-06-11",
  "patient": {
    "first_name": "Robert",
    "last_name": "Tanaka",
    "dob": "1963-11-30",
    "mrn": "MRN-00104"
  },
  "records_requested": "All inpatient notes and discharge summaries from 2023-01-01 to 2024-12-31.",
  "authorization": "Patient signed HIPAA authorization form. Authorization#: AUTH-20260611-0104",
  "requesting_provider": {
    "name": "Dr. Sarah Wright",
    "npi": "5678901234"
  },
  "return_channel": "email",
  "return_address": "records@jhh.example"
}
`.trim(),
  },

  // -------------------------------------------------------------------------
  // 6. ROI request missing authorization line — triggers request_more_info
  //    classify ~0.93 (ROI keywords present), extract ~0.5 (auth absent)
  // -------------------------------------------------------------------------
  fax_roi_missing_auth: {
    scenario: 'fax_roi_missing_auth',
    source_channel: 'fax',
    from_org_id: 'org_kaiser',
    source_text: `
RELEASE OF INFORMATION REQUEST
================================
From:     Kaiser Permanente — Records Department
Fax:      +1-510-555-0142
Date:     2026-06-11

To:       Froedtert Hospital — Medical Records

Patient:  Linda Okafor
DOB:      1972-09-07
MRN:      MRN-00107

Records Requested: Neurology consultation notes from 2025-01-01 to present.

Requesting Provider: Dr. Kenji Tanaka NPI 6789012345
Reason: Specialist co-management.

Please fax records to +1-510-555-0142.

NOTE: Authorization form to follow under separate cover.
`.trim(),
  },

  // -------------------------------------------------------------------------
  // 7. Phone call artifact — cardiology referral for Thomas Reyes (MRN-00108)
  //    source_channel: 'phone'; transcript + CALL SUMMARY block
  //    classify ≥0.9 (referral keyword), extract ≥0.9 (labeled block), match ≥0.97
  // -------------------------------------------------------------------------
  call_referral: {
    scenario: 'call_referral',
    source_channel: 'phone',
    from_org_id: 'org_aurora',
    source_text: `
Thanks for calling Froedtert Hospital referral intake, this is Jamie speaking.
Hi Jamie, this is Dana Reyes from Lakeview Family Medicine, how are you?
Doing great, thanks for calling. What can I help you with today?
We'd like to refer one of our patients to your cardiology department for evaluation of exertional chest pain.
Of course, I can take that information. Go ahead.
Patient's name is Thomas Reyes, date of birth December 3rd, 1988.
And the reason for referral?
He's been having exertional chest pain on moderate activity for the past six weeks. We did an EKG — it came back with some nonspecific ST changes. We'd like a full cardiology workup.
Got it. And your callback number?
Sure, it's plus one six oh eight five five five four four four four.
Great. I'll get that entered. You should receive a confirmation shortly.

---------------- CALL SUMMARY (auto-transcribed) ----------------
Caller:    Dana Reyes — Lakeview Family Medicine
Patient:   Thomas Reyes
DOB:       1988-12-03
Reason:    Cardiology referral — exertional chest pain, nonspecific ST changes
Callback:  +1-608-555-4444
`.trim(),
  },

  // -------------------------------------------------------------------------
  // 8. Phone call artifact — records request for David Kim (MRN-00106)
  //    source_channel: 'phone'; transcript + CALL SUMMARY block
  //    classify ≥0.9 (records request keywords), extract ≥0.9, match ≥0.97
  //    flows to roi_incoming and is fulfilled like any ROI
  // -------------------------------------------------------------------------
  call_records_request: {
    scenario: 'call_records_request',
    source_channel: 'phone',
    from_org_id: 'org_jhh',
    source_text: `
Good morning, Froedtert records department, this is Alex.
Hi Alex, calling from Johns Hopkins Hospital records team. I need to request some records for a patient of yours.
Sure, happy to help. What's the patient name?
Patient is David Kim, date of birth February 28th, 1945.
And what records are you looking for?
We need all cardiology notes and echocardiogram results from 2023 to present. The patient has a follow-up with us next week.
Do you have authorization on file?
Yes, the patient signed a HIPAA authorization form. I'll fax a copy to your records fax line after this call. Authorization number AUTH-20260611-0106.
Perfect, we'll watch for that and get those pulled together for you.
Great, thank you so much.

---------------- CALL SUMMARY (auto-transcribed) ----------------
Caller:    Alex Chen — Johns Hopkins Hospital Records
Patient:   David Kim
DOB:       1945-02-28
Records Requested: All cardiology notes and echocardiogram results from 2023-01-01 to present
Authorization:     AUTH-20260611-0106 — patient signed HIPAA auth, fax to follow
Callback:  +1-410-555-7777
`.trim(),
  },

  // -------------------------------------------------------------------------
  // 9. Fax with slightly misspelled patient name vs MPI ("Jame" not "James")
  //    Patient: James Whitfield (MRN-00101, DOB: 1955-08-14)
  //    classify ≥0.9, extract ~0.85 (labels present), match ~0.6 (fuzzy single-candidate)
  //    → escalates with "Closest MPI match is James Whitfield (DOB …, MRN …) — is this the right patient?"
  // -------------------------------------------------------------------------
  fax_referral_partial: {
    scenario: 'fax_referral_partial',
    source_channel: 'fax',
    from_org_id: 'org_mayo',
    source_text: `
REFERRAL REQUEST — FAX TRANSMISSION
=====================================
From:     Dr. Michael Brooks, Mayo Clinic
Fax:      +1-507-555-0100
Date:     2026-06-11

To:       Froedtert Hospital — Cardiology
Fax:      +1-414-555-0142

Patient:  Jame Whitfield
DOB:      1955-08-14
Phone:    +1-608-555-0101

Reason:   Cardiology referral — exertional chest pain, worsening over 2 months.
          Recent stress test abnormal. Requesting urgent evaluation.

Priority: Routine
Provider: Dr. Michael Brooks NPI 8901234567

Please confirm receipt.
`.trim(),
  },

  // -------------------------------------------------------------------------
  // 10. Prior authorization request fax — seeded patient Susan Chen (MRN-00105)
  //     Classifies as 'prior_auth' via Intake Agent config.classify_rules
  //     ("prior auth" matches the header) — NOT via the builtin keyword map.
  //     All labeled fields present → classify ~0.95, extract ~0.9, match ~0.97
  //     Routes to the prior_auth queue; chased by the Auth Chaser (shadow).
  // -------------------------------------------------------------------------
  fax_prior_auth: {
    scenario: 'fax_prior_auth',
    source_channel: 'fax',
    from_org_id: 'org_aurora',
    source_text: `
PRIOR AUTHORIZATION REQUEST — FAX TRANSMISSION
================================================
From:     Aurora Health Care — Neurology, Dr. Karen Davis
Fax:      +1-414-555-0242
Date:     2026-06-11

To:       Froedtert Hospital — Authorization Department

Payer:    Kaiser Permanente — Utilization Management
Member ID: KP-WI-4471209

Patient:  Susan Chen
DOB:      1978-05-19
MRN:      MRN-00105
Phone:    +1-608-555-0105

Procedure: MRI lumbar spine without contrast
CPT Code:  72148
Diagnosis: Chronic low back pain with left L5 radiculopathy (ICD-10 M54.16)

Reason:   Six weeks of conservative therapy (PT and NSAIDs) without improvement.
          Progressive left leg weakness on exam. MRI needed to evaluate for
          disc herniation prior to surgical consult.

Priority: Routine
Ordering Provider: Dr. Karen Davis NPI 4455667788

Please obtain prior authorization from the payer and confirm the
authorization number by fax.
`.trim(),
  },
};
