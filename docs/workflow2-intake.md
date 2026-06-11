# Workflow 2 — Inbound Intake, Made Excellent

> Builder contract. Scope is ONE workflow: a messy inbound communication
> (fax / direct message / **phone call**) flowing through classify → extract →
> patient-match → route, and the human-review experience when any step can't
> clear the gate. Everything shipped in workflow 1 (and the original MVP) must
> keep working. Invariants: [workqueue-mvp.md](workqueue-mvp.md).

## File ownership (two parallel builders — do not cross)

- **intake-engine**: `lib/sampleDocs.ts`, `lib/llm.ts`, `lib/tools.ts`,
  `lib/simulate.ts`, `lib/types.ts`, `lib/workItems.ts`,
  `app/api/simulate/**`, `app/api/stats/**` (new). NOT lib/outbound.ts,
  NOT app/* pages.
- **intake-ui**: `app/items/**`, `app/queues/**`, `app/components/**`.
  NOT layout/globals (tokens exist — use them), NOT app/portal, app/roi,
  app/agents, and no lib/ or app/api/ edits.

No new npm deps. No migration (new metadata lives in existing jsonb columns).
typecheck + build must pass. The dev server may be running on :3001 — curl to
inspect shapes, never start/stop servers, never run git, never touch the DB.

---

## 1. intake-engine

### Phone as a first-class inbound channel

Two new scenarios (extend ScenarioKey + injectInbound; `source_channel: 'phone'`):
- `call_referral` — an inbound-call artifact: 8–12 lines of realistic
  transcript ("Thanks for calling… this is Dana from Lakeview Family
  Medicine… we'd like to refer…"), then a structured block:
  ```
  ---------------- CALL SUMMARY (auto-transcribed) ----------------
  Caller:    Dana Reyes — Lakeview Family Medicine
  Patient:   <seeded patient name>
  DOB:       <their dob>
  Reason:    Cardiology referral — exertional chest pain
  Callback:  +1-608-555-xxxx
  ```
  Labeled lines must hit the existing extractor (Patient:, DOB:, Reason:).
- `call_records_request` — same shape; records request with
  `Records Requested:` and `Authorization:` lines → flows to roi_incoming
  and is fulfilled like any ROI.
Also add `fax_referral_partial` — a fax with letterhead and SOME labeled
fields (patient name + reason present; DOB present but patient name slightly
misspelled vs MPI, e.g. "Jame Whitfield") → extraction ok (~0.85) but match
comes back fuzzy/low (~0.55–0.65 single-candidate) → escalates with a
"closest match" question naming the candidate. Implement the fuzzy single-
candidate path in match: when no exact ilike hit, retry with a loosened
pattern (e.g. first 3 chars of first name + exact last name); if exactly one
hit → confidence 0.6, question `Closest MPI match is <Name> (DOB …, MRN …) —
is this the right patient?` and include that patient in candidates so the
review UI offers it.

### Per-field extraction confidence + provenance (the wow)

`extract_fields` now also stores, in `agent_state.extraction_meta`:
```json
{ "fields": { "patient_name": {"confidence": 0.95, "sourceLine": 4},
              "patient_dob":  {"confidence": 0.95, "sourceLine": 5}, ... } }
```
- sourceLine = 0-based line index in `source_text` the value came from.
- Heuristic confidences: labeled exact-pattern hit 0.95; value parsed from a
  CALL SUMMARY block 0.9; JSON-ish DM field 0.97; anything inferred (name
  split, fuzzy) 0.6.
- Overall extract confidence stays computed as today (don't regress
  scenario routing).

### resolve_review accepts corrections

Extend the `resolve_review` tool params: `{patientId?, queueKey?, fields?}`.
When `fields` (Record<string,string>) present: merge into `extracted_data`
(audit detail records which keys changed), re-run patient match server-side
if patient fields changed and no explicit patientId given. Keep existing
behavior fully backward-compatible.

### Batch inject + intake stats

- `injectInbound('batch_morning')` → injects this fixed mix in one call and
  returns `{itemIds: [...]}`: fax_referral_clean, fax_roi_clean,
  fax_ambiguous_patient, fax_messy, dm_records_request, call_referral,
  fax_referral_partial, fax_roi_missing_auth (8 items). Keep single-scenario
  behavior unchanged (`{itemId}`).
- `GET /api/stats/intake` → `{data: {processed, autoRouted, escalated,
  resolvedByHuman, avgClassify, avgExtract, avgMatch, byChannel: {fax: n,
  direct_message: n, phone: n, portal: n}}}` computed from audit_log +
  work_items (all-time is fine; no date math).

## 2. intake-ui

### Human-review workbench on /items/[id] (intake escalations)

When `item.queue_key === 'human_review'` and the item type is intake-ish
(anything except records_request_out), replace the current review block with
a **side-by-side workbench**:
- LEFT: the source document on the fax-paper card. When
  `agent_state.extraction_meta` exists, render line-by-line and **highlight
  the source lines** extraction pulled from; hovering a field on the right
  highlights its line (match by sourceLine), and clicking a highlighted line
  flashes the corresponding field. Phone items get a 📞 "CALL — transcribed"
  paper header variant instead of FAX.
- RIGHT, top: the blocking question (review_reason) as the headline, with
  patient candidate cards as today ("This one" → resolve_review with
  patientId) — including the new fuzzy single-candidate case.
- RIGHT, below: **editable extraction form** — every key in extracted_data
  as an input, each with its per-field confidence chip (from
  extraction_meta; green ≥0.8 / amber 0.5–0.8 / red <0.5; no chip when no
  meta). A "Confirm & route" button POSTs
  `actions {tool:'resolve_review', params:{fields: <edited values>}}`
  (include patientId too when a candidate was picked). Disable while
  in-flight; show the result.
- Keep ALL existing functionality for non-review items and outbound items
  (the W1 chase view must be untouched).

### Board (/queues) — intake at a glance

- **Stats strip** above the queue cards from `GET /api/stats/intake`:
  "Processed", "Auto-routed" (green, with % of processed), "Escalated"
  (amber), "Resolved by humans", and per-channel counts with icons
  (📠 ✉️ 📞). Graceful skeleton/hide if the endpoint errors.
- Simulate panel: add 📞 "Call: referral", 📞 "Call: records request",
  "Fax: partial/fuzzy match", and a prominent **"☀️ Morning batch (8)"**
  button (POST scenario 'batch_morning'); show "+8 items" feedback and let
  auto-tick drain it.
- Queue tables already show 📞 phone icons via the channel map — verify.

### Polish

Empty states for the workbench, smooth highlight transitions (150ms), and
keep everything on the existing design tokens.

## Acceptance (orchestrator verifies)

1. `call_referral` → phone item → classified referral, matched, routed;
   transcript renders with CALL paper header; per-field chips show on the
   item; extraction_meta lines highlight in the document.
2. `call_records_request` → roi_incoming → fulfilled end-to-end.
3. `fax_referral_partial` → escalates with the closest-match question; the
   workbench offers the fuzzy candidate; "This one" routes it with the match
   recorded.
4. `fax_messy` → workbench: edit fields manually (type a patient name +
   DOB), Confirm & route → fields merged, match re-run, item routed; audit
   shows the changed keys.
5. `batch_morning` injects 8; with auto-tick the board drains to: referrals
   +2-ish, roi_incoming completions, human_review holding exactly the
   ambiguous/messy/partial exceptions; stats strip numbers move.
6. All W1 flows (chase, portal, compose) and original flows still pass.
7. typecheck + clean build pass.
