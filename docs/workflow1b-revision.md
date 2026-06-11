# Workflow 1b — Domain Corrections: Care Everywhere, Realistic Ladders, Portal Flip

> Builder contract revising workflow 1 per Erik's domain feedback. Three
> corrections: (1) the provider portal is an INBOUND submission surface for
> external orgs, not a place where receiving orgs answer our outgoing
> requests; (2) the zero-fax outbound tier is Epic↔Epic **Care Everywhere**
> structured exchange, not "they log into our portal"; (3) chase ladders are
> realistic (fax → fax 2nd request → voice; or secure-email → voice) and
> **configurable in the low-code builder** — the platform just runs the
> automation and makes the current rung visible.
> All prior invariants and the other workflows keep working.

## File ownership (two parallel builders — do not cross)

- **engine**: migration (agents.config), `lib/outbound.ts`, `lib/simulate.ts`,
  `lib/tools.ts`, `lib/llm.ts`, `lib/portal.ts`, `lib/types.ts`,
  `lib/workItems.ts`, `supabase/seed.sql` (appends), `app/api/roi/**`,
  `app/api/portal/**`, `app/api/agents/**` (config field only),
  `app/api/simulate/**`.
- **ui**: `app/roi/**`, `app/items/**`, `app/queues/**`, `app/agents/**`,
  `app/portal/**`, `app/components/**`, globals.css APPENDS only.

No new npm deps. Typecheck + build must pass. Engine applies NO db changes
(orchestrator does). No git, no servers.

---

## 1. Chase ladders: steps (with repeats) + low-code configurability (engine + ui)

### Data model
- `chase_plan` becomes `{steps: ChaseStep[], waitSeconds}` where
  `ChaseStep = {channel: 'fax'|'email'|'sms'|'voice', attempt: number}` —
  attempt numbers per channel (fax #1, fax #2, voice #1). Keep reading the
  legacy `{channels:[...]}` shape wherever items still carry it.
- NEW migration: `ALTER TABLE agents ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'`.
  Records Chaser seed config: `{"chase_policy": {"steps": ["fax","fax","voice"], "waitSeconds": 30}}`
  (steps as plain channel strings in config; expand to ChaseStep at compose).
- Org-level override: `organizations.contact.chase_policy` (jsonb, same
  shape). Seed: give **org_mgh** `{"steps": ["email","voice"], "waitSeconds": 30}`
  (the secure-email org — UI labels email "Secure Email").
- Plan resolution at compose (`buildChannelPlan` rework):
  1. If target org is **Epic/Care Everywhere** (see §2) → single step
     `care_everywhere`, no chase, no timeout chase (it auto-responds fast).
  2. Else org `contact.chase_policy` if present;
  3. else the Records Chaser's `config.chase_policy`;
  4. else default `["fax","fax","voice"]`.
  Channel override param still forces the first step. Steps whose channel has
  no org contact info are skipped (e.g. no fax number → skip fax steps).
- Chase execution (`tick`): follow the item's `chase_plan.steps` IN ORDER,
  honoring repeats — a second fax step renders the "SECOND REQUEST" cover
  sheet. Keep the pending-attempt guard. After the LAST step times out →
  escalate with `"No response after <n> attempts (<step list, e.g. fax, fax,
  voice>) — call them or close?"`. Voice steps to no_response orgs keep the
  no-answer outcome.
- SMS stays in the tool registry (low-code can still add it) but appears in
  NO default ladder.

### Builder UI (the low-code part — ui)
On `/agents`, for agents whose queue is `roi_outgoing` (Records Chaser), an
**Escalation ladder editor** in the card/form: ordered step chips
(📠 Fax, ✉️ Secure Email, 💬 SMS, 📞 Voice) with add (dropdown), remove (×),
and reorder (◀▶ buttons are fine); plus the wait-seconds dial. Saving PATCHes
`{config: {chase_policy: {steps, waitSeconds}}}`. Show the ladder readout on
the card ("📠 → 📠 → 📞 · 30s").

## 2. Care Everywhere tier (engine + ui)

- Orgs whose `capabilities.channels` includes `'cloud'` are **Epic orgs**
  (Care Everywhere-capable). Seed already has several; ensure org_cleveland
  and org_mayo qualify and note which in the report.
- Outgoing ROI to an Epic org → single attempt `channel='care_everywhere'`,
  `respond_after = now() + 8s`, payload document is a structured query
  rendering ("CARE EVERYWHERE — RECORD QUERY", patient demographics block,
  requested-records block, ref number). Simulated response (~8s) is a
  structured "CARE EVERYWHERE — DOCUMENT RETURN (C-CDA summary)" transmittal.
  Auto-completes via the normal chaser flow. Never chased, never times out
  into the ladder.
- Types: add `'care_everywhere'` to OutboundChannel.
- UI: compose capability card shows an **"Epic · Care Everywhere"** indigo
  badge ("structured exchange — instant, no fax") instead of the old portal
  badge; plan stepper renders the single ⚡ Care Everywhere step; channel
  icon ⚡ (or 🔁) + label "Care Everywhere" in attempts, queue tables,
  activity. REMOVE the 'portal' channel from outgoing plans/preview entirely.

## 3. Portal flip: external orgs SUBMIT to us (engine + ui)

The persona switcher stays. The provider portal becomes the external org's
window for work they have WITH the Epic org:

- **Submit** (new): a "New records request" form in `/portal/[orgId]`:
  patient name + DOB (free text — they're external, no MPI access), records
  requested, authorization-attached checkbox, urgency. POST
  `/api/portal/submit {orgId, patientFirstName, patientLastName, patientDob,
  recordsRequested, authorizationAttached, priority?}` → creates a work item:
  `source_channel='portal'`, `type='records_request_in'`,
  `queue_key='intake'`, org_id = submitting org, `source_text` = a rendered
  "PORTAL SUBMISSION" document (structured block so the existing extractor
  scores high — include Patient:/DOB:/Records Requested:/From: lines and
  `Authorization: Signed authorization attached (portal)` only when the box
  was checked), audit actor `portal:<org>` action `portal_submission`.
  It then flows the NORMAL intake → roi_incoming pipeline; fulfillment goes
  back out via the org's contact channels as usual.
- **My requests** (replaces the old respond-inbox as the page's main list):
  the org's submitted items (work_items where org_id = theirs AND
  source_channel='portal') with live status chips mapped to plain language:
  intake/processing → "Received — processing"; waiting after
  request_more_info → **"Action needed — authorization required"** with an
  inline "Attach signed authorization" button that resolves it (marks the
  pending request_more_info attempt responded with the authorization — reuse
  the existing respond logic for EXACTLY this case); human_review → "Under
  review"; done → "Completed — records sent via <channel>" with the
  records-response document viewable.
- The old generic respond-to-any-outbound inbox section is REMOVED (external
  orgs no longer answer our outgoing ROIs in-app — that path is now Care
  Everywhere for Epic orgs and fax/voice for everyone else). lib/portal.ts
  respond logic survives only for the authorization case above.
- GET `/api/portal/requests?orgId=` powers the list (items + their
  request_more_info attempt state + final response doc).

## 4. Sample/seed touches (engine)

- Keep org_ucsf no_response (fax-ladder demo). org_mgh = secure-email ladder
  org. Cleveland + Mayo = Epic/Care Everywhere. At least one org stays plain
  fax+voice with no special config (default ladder).
- Drop the `preferred_channel: 'portal'` seed on org_cleveland (portal is no
  longer an outbound channel); replace with its Epic/cloud capability.

## Acceptance (orchestrator verifies)

1. Outgoing ROI to Mayo/Cleveland → single ⚡ Care Everywhere attempt,
   structured query + C-CDA return documents, auto-completes ~8s. No chase.
2. Outgoing ROI to UCSF → ladder runs **fax → fax (SECOND REQUEST cover
   sheet) → voice (no-answer)** → Human Review with the step-list question.
3. Outgoing ROI to MGH → ladder **Secure Email → Voice** (org override).
4. Edit the Records Chaser's ladder in /agents (e.g. fax → voice → voice),
   compose to UCSF → new plan follows the edited ladder. Readout on card.
5. Portal: as Cleveland (persona), submit a records request WITHOUT
   authorization → it appears in Epic's intake, classifies/matches/routes to
   roi_incoming; agent fires request_more_info; portal "My requests" shows
   "Action needed", attaching authorization completes the loop and the
   finished records-response document is viewable in the portal.
6. A portal submission WITH authorization flows straight through to done.
7. W1 compose/chase visuals, W2 workbench/batch, W4 modes all regress clean.
8. typecheck + build clean.
