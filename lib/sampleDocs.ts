/**
 * lib/sampleDocs.ts — canned fax/DM texts for the six simulation scenarios.
 *
 * Heuristic confidence requirements:
 *   fax_referral_clean    → classify ≥0.9, extract ≥0.85, match ≥0.9 (exact name+DOB)
 *   fax_roi_clean         → classify ≥0.9, extract ≥0.85, match ≥0.9 (exact name+DOB)
 *   fax_ambiguous_patient → classify ≥0.9, extract ≥0.7 (name only, no DOB), match ~0.45 (two candidates)
 *   fax_messy             → classify ~0.3, extract ~0.2  (no labels, garbled)
 *   dm_records_request    → classify ≥0.9, extract ≥0.9, match ≥0.97 (exact name+DOB via JSON-ish)
 *   fax_roi_missing_auth  → classify ≥0.9, extract ~0.5 (auth line missing → low completeness)
 */

export type ScenarioKey =
  | 'fax_referral_clean'
  | 'fax_roi_clean'
  | 'fax_ambiguous_patient'
  | 'fax_messy'
  | 'dm_records_request'
  | 'fax_roi_missing_auth';

export interface SampleDoc {
  scenario: ScenarioKey;
  source_channel: 'fax' | 'direct_message';
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
};
