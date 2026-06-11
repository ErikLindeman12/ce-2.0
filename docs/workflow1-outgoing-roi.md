# Workflow 1 — Outgoing ROI + Multi-Channel Chase, Made Excellent

> Builder contract. Scope is ONE workflow: composing an outgoing records (ROI)
> request, dispatching it across channels, chasing non-responders, receiving a
> structured response (simulated or via the provider portal), and completing.
> All [workqueue-mvp.md](workqueue-mvp.md) invariants and existing behavior for
> the other flows must keep working. [wave3-spec.md](wave3-spec.md) is the
> longer-term roadmap; only the pieces restated here are in scope now.

## File ownership (three parallel builders — do not cross)

- **outbound-engine**: `lib/outbound.ts` (new), `lib/simulate.ts`, `lib/tools.ts`,
  `lib/llm.ts`, `lib/types.ts` (extend), `lib/workItems.ts`, `supabase/seed.sql`
  (append-only tweaks), `app/api/roi/**`, `app/api/simulate/**`,
  `app/api/work-items/**` (response shape additions only).
- **portal**: `app/portal/**`, `app/api/portal/**`, `lib/portal.ts` (all new).
- **ui**: `app/layout.tsx`, `app/globals.css` (may create), `app/components/**`,
  `app/roi/**`, `app/queues/**`, `app/items/**`. (NOT app/portal — portal styles
  its own pages following the same design tokens in globals.css; ui defines them
  early and portal may read that file but never edit it.)

No new npm dependencies. No DB migration needed this round (chase plan and
artifacts live in existing jsonb columns). TypeScript strict; typecheck + build
must pass.

---

## 1. outbound-engine

### lib/outbound.ts — the outbound document + channel-plan module (new)

```ts
type ChannelPlan = { channels: Channel[]; waitSeconds: number };
buildChannelPlan(org, override?: Channel, waitSeconds?: number): ChannelPlan
renderOutboundDocument(channel, kind, ctx): {subject: string; body: string; document: string}
```

- `buildChannelPlan`: ordered escalation list derived from the org's actual
  contact info — start with `contact.preferred_channel`, then append the rest
  of `[fax, email, sms, voice]` **only where the org has that contact field**
  (fax→contact.fax, email→contact.email, sms/voice→contact.phone). If
  preferred is `portal`, the plan is `['portal']` only (on-network orgs are
  answered in-app; no timeout chase — see tick rules). `override` forces that
  single channel first, followed by the normal remainder. `waitSeconds`
  defaults 30, clamp 10–120.
- `renderOutboundDocument` produces the REAL artifact for each attempt
  (`kind`: 'records_request' | 'request_more_info' | 'records_response'):
  - **fax**: a monospace cover sheet, ~40 lines: header block
    (`*** FACSIMILE COVER SHEET ***`, TO/FAX#/FROM/DATE/RE/PAGES), HIPAA
    confidentiality notice, then the request letter: patient (name/DOB/MRN),
    records requested, authorization statement, reply-by instructions with a
    reference number `ROI-<first 8 of item id>`, attempt number when > 1
    ("SECOND REQUEST — prior fax sent <n> attempts ago" style).
  - **email**: subject `Records Request — <Patient> (ref ROI-…)` + 8–12 line
    professional body.
  - **sms**: single ≤240-char message with the ref number and a callback.
  - **voice**: a call script (greeting, who we are, what we need, the ref
    number, callback) — this is what the "agent" would say.
  The `document` string is stored in the attempt's `payload.document` and the
  item detail UI renders it. Deterministic (no randomness beyond Date for the
  date line).

### Dispatch + chase upgrades

- `POST /api/roi` body gains optional `waitSeconds` (number) — flows into the
  plan. Response unchanged (`{itemId}`).
- At compose time store `agent_state.chase_plan = {channels, waitSeconds}` and
  `agent_state.kind='records_request'` on the work item.
- All send tools (`send_fax/send_email/send_sms/place_call`) render their
  payload via `renderOutboundDocument` (subject/body/document) instead of the
  current hardcoded strings — for BOTH agent sends and chase sends and the
  roi_incoming fulfillment/request_more_info sends (kind picked by context).
- The tick chase follows `agent_state.chase_plan.channels` (fall back to the
  current [fax,email,sms,voice] when absent) and uses `chase_plan.waitSeconds`
  for each attempt's `respond_after`. Escalation question must name the actual
  channels tried: `"No response after N attempts across <ch1>/<ch2>/… — call
  them or close?"`.
- **Voice outcomes**: when a voice attempt to a `no_response` org times out,
  set its `response = {outcome:'no_answer', note:'Rang 45s — no answer. Voicemail
  left with callback number and reference.'}` alongside status `timed_out`
  (the attempt card can then show the outcome).
- **Portal channel**: attempts with `channel='portal'` get `respond_after=null`,
  are never auto-responded/timed-out by tick, and never chased (they wait for
  the human in the portal). Status flows `sent` → (portal responds) `responded`.
- **Received-records artifact**: the simulated ROI response now includes
  `response.document` — a short monospace "RECORDS TRANSMITTAL" summary
  (patient, date range, page count, sending org). The chaser's mark_complete
  note becomes `Records received via <channel> — ref ROI-…`.
- Export `handleAttemptResponse` from `lib/simulate.ts` (portal imports it).
- Seed (idempotent UPDATEs appended): `org_cleveland` →
  `contact.preferred_channel='portal'` (keep its other contact fields);
  ensure `org_ucsf` keeps `simulation='no_response'`; ensure at least one org
  has ONLY fax+phone (no email) so its plan visibly skips email —
  pick one existing seeded org and note which in your report.

### API shape additions (pin — ui builds against these)

- Work-item LIST rows (`GET /api/work-items?queue=`) must now include
  `agent_state` (they already include extracted_data/confidence).
- `GET /api/work-items/<id>` unchanged keys (`item`, `auditTrail`,
  `outboundAttempts`) — attempts now carry `payload.document` and richer
  `response` objects.
- `GET /api/organizations?q=` already returns `contact` — verify it does;
  if not, add it (ui needs channels + preferred for the org card).

## 2. portal (the on-network response surface)

Pages (`app/portal/...`, client components, poll 4s, import design tokens by
using the same CSS variables/utility classes from `app/globals.css` — read it,
never edit it; if it doesn't exist yet, use clean inline styles consistent with
the indigo/near-white direction):

- `/portal` — "Provider Portal" landing: org picker ("Continue as <org>" cards
  for every org), selection → `/portal/<orgId>` (also remember in localStorage
  and auto-offer "Continue as <last org>").
- `/portal/[orgId]` — that org's inbox: every `outbound_attempts` row with
  `to_org_id = orgId`, newest first. Card per attempt: channel badge
  (🌐 In-app for portal, else 📠/✉️/💬/📞 "via fax/email/…"), subject, the
  rendered `payload.document` behind a "View document" expander, status pill,
  attempt #. For status `sent`/`awaiting_response`: a **Respond** panel —
  free-text message + checkbox "Attach requested records" (kind
  records_request) / "Attach signed authorization" (kind request_more_info —
  infer from payload.subject containing 'Additional Information' or a
  `payload.kind` field if outbound-engine provides one) → POST respond.
  Responded attempts show the response read-only with timestamp.

API:
- `GET /api/portal/inbox?orgId=` → `{data: attempts[]}` (raw attempt rows +
  `itemType`, `patientName` via joins — portal staff see who it's about).
- `POST /api/portal/respond` `{attemptId, message, recordsAttached?, authorizationAttached?}`:
  set attempt `responded` with `response = {status:'responded_via_portal',
  message, received_at, document?: '...RECORDS TRANSMITTAL (portal)...' when
  recordsAttached, authorization: 'Signed authorization provided via portal'
  when authorizationAttached}`, audit row actor `portal:<org name>` action
  `portal_response`, then call `handleAttemptResponse` (imported from
  lib/simulate.ts) so the owning item reopens and its agent resumes next tick.
  Reject double-responses (409 if already responded).

## 3. ui (polish focused on this workflow + the global shell)

Create `app/globals.css` with design tokens and import in layout: near-white
bg (#fafbfc), ink (#16181d), one accent (indigo #4f46e5), borders #e6e8ee,
radius 8px, soft shadow, system font stack, 13.5px body, uppercase 11px
letter-spaced section labels, 150ms ease transitions. Status colors: green
#16a34a, amber #d97706, red #dc2626, teal #0d9488 (portal). Keep every page
functional — restyle, don't rearchitect.

1. **`app/layout.tsx`** — refined nav: "CE 2.0 · Network Console", active link
   state, links: Directory, Queues, New ROI Request, Agents, **Portal** (new).
2. **`/roi/new` — the compose experience (the star of this round)**:
   - Patient select → compact patient card (name, DOB, MRN).
   - Org search → on selection an **org capability card**: each channel the
     org supports as an icon chip (fax/email/sms/voice from `contact`, portal
     when `preferred_channel='portal'`), preferred channel starred, and an
     "On network" teal badge for portal orgs ("delivered in-app — no fax").
   - **Channel plan preview**: computed client-side with the same rules as
     buildChannelPlan (preferred first, then channels the org has contact
     for; portal → single step): a horizontal stepper "1 📠 Fax → wait 30s →
     2 ✉️ Email → …". Updates live with the override select and wait dial.
   - **Response-wait dial**: segmented control 10s / 20s / 30s / 60s
     (default 30) → sent as `waitSeconds`.
   - **Document preview**: live monospace preview of the fax cover sheet /
     email for the first planned channel as the form is filled (client-side
     render mirroring renderOutboundDocument's layout is fine — label it
     "Preview").
   - Submit → redirect to the item as today.
3. **`/queues/[key]`** for `roi_outgoing` — add a **Chase progress** column:
   icon strip of the item's `agent_state.chase_plan.channels` with per-channel
   state from its attempts (✓ green responded, ✗ red timed out, ● amber
   pulsing in-flight, ○ gray pending) + "attempt n/N". General table polish
   (hover, sticky header, confidence as mini meter bar) applies to all queues.
4. **`/items/[id]`** — outbound showcase: attempts as cards with channel icon,
   attempt #, status pill, live countdown to next world action ("response or
   timeout in ~Ns"), **"View document" expander rendering payload.document on
   a fax-paper card** (slight texture/border, monospace), and response block
   (incl. response.document when present, and voice `no_answer` outcomes).
   Add a **chase stepper** at the top of outbound items (same component idea
   as compose preview, showing actual progress). Keep all existing manual
   actions working. General polish: audit timeline with vertical rail + dots,
   section labels, paper card for inbound source_text too.
5. **`/queues` board** — light polish only this round (cards + simulate panel
   tidy; the full board redesign comes with workflow 2): but DO restyle with
   the new tokens so the app feels coherent.
6. Empty states everywhere relevant ("No outbound attempts yet — the agent
   sends on the next tick").

## Acceptance (orchestrator verifies)

1. Compose to a fax-preferred org: capability card + plan stepper + document
   preview render; item created with chase_plan; attempt 1 is a real rendered
   fax cover sheet visible on the item.
2. Chase to org_ucsf at 10s wait: channels escalate per plan with one attempt
   each, voice shows the no-answer outcome, escalation question lists the
   actual channels, Human Review shows it.
3. The no-email org's plan visibly skips email (compose preview AND actual
   chase).
4. Compose to Cleveland (portal org): no fax — single portal attempt; it
   appears in /portal/<cleveland> with the document; responding with records
   attached completes the item next tick; audit shows `portal:<org>`.
5. Responsive fax org: response carries a RECORDS TRANSMITTAL document
   rendered on the item; completion note has the ref number.
6. All original flows (intake, incoming ROI, agent builder) still pass.
7. typecheck + build clean; every touched page visibly nicer.
