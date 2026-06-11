# Wave 3 — Config-Driven Agents, Provider Portal, Phone Channel, Supervision Stats

> Builder contract for the second build wave. Everything in
> [workqueue-mvp.md](workqueue-mvp.md) still holds (invariants, existing schema,
> existing API). This wave closes the gaps between the shipped MVP and the
> vision: agents whose *configuration is the policy* (the "LangChain low-code"
> story), the external provider portal (structured response instead of fax-back),
> phone as an inbound channel, and supervision metrics.

## File ownership (three parallel builders — do not cross)

- **agent-engine** owns: new migration, `supabase/seed.sql` (append), `lib/llm.ts`,
  `lib/agentRunner.ts`, `lib/simulate.ts`, `lib/sampleDocs.ts`, `lib/tools.ts`,
  `lib/types.ts` (extend), `app/api/agents/**`, `app/api/simulate/**`.
- **provider-portal** owns: `app/portal/**` (new), `app/api/portal/**` (new),
  `lib/portal.ts` (new).
- **ui-polish** owns: `app/layout.tsx`, `app/globals.css` (may create),
  `app/page.tsx`, `app/queues/**`, `app/items/**`, `app/roi/**`, `app/agents/**`
  (pages only — calls the APIs pinned below), `app/components/**`.

---

## 1. Config-driven agent engine (agent-engine)

### The policy IS the configuration

Replace the queue-hardcoded pipelines in `lib/llm.ts` with a **generic planner**:
the next action is chosen from the *agent's allowed tools* given the *item's
state* — never from `agent.queue_key`. Concretely, first match wins:

1. `classify_document` allowed AND `confidence.classify` absent → classify.
2. `extract_fields` allowed AND `confidence.extract` absent → extract.
3. `match_patient` allowed AND no `matched_patient_id` → match.
4. `verify_requirements` allowed AND item.type === 'records_request_in' AND
   `agent_state.requirements` absent → verify (store result in agent_state.requirements).
5. `request_more_info` allowed AND requirements verified with missing auth AND
   NOT `agent_state.more_info_sent` → request_more_info (conf 0.92).
6. Fulfillment send: item.type 'records_request_in', requirements complete,
   NOT `agent_state.records_sent` → send via **the first allowed send tool that
   matches the org's preferred channel, else the first allowed send tool**
   (`send_fax`/`send_email`/`send_sms`/`place_call`). The send must set
   `agent_state.records_sent = true` (extend the send tool to accept a
   `state_flag` param, or set it in the planner's params).
7. Initial outbound for 'records_request_out' (no `agent_state.attempt_no`):
   same allowed-send-tool channel selection as 6.
8. `mark_complete` allowed AND (records_request_out with
   `agent_state.response_received`, or records_request_in with records_sent) → complete.
9. `advance_stage` allowed AND queue is intake AND type known → advance
   (referral→referrals, records_request_in→roi_incoming); unknown type →
   escalate (0.95, "Unknown document type…").
10. Nothing applies → `wait` (0.99).

Result: **unchecking a tool in the builder changes behavior** — remove
`send_fax` and fulfillment goes out by email; remove `match_patient` and items
flow unmatched (then fail verify, escalate). Keep all existing confidence
heuristics (classify/extract/match) exactly as shipped.

### Agent modes (shadow → supervised → autonomous)

Migration: `ALTER TABLE agents ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'autonomous'`
(values: `autonomous | supervised | shadow`). Seed: existing agents stay autonomous.

Runner behavior per decision that passes the confidence gate:
- **autonomous** — execute (as today).
- **supervised** — do NOT execute. Store
  `agent_state.pending_approval = {action, params, confidence, rationale, agentId, agentName}`,
  set `assignee='human'`, `review_reason = "Agent proposes: <action> (confidence X.XX) — approve?"`,
  move to `human_review` (keep original queue in `agent_state.return_queue`),
  audit action `propose_action`. New tool **`approve_action`** (human-only):
  executes the stored pending_approval via runTool as actor
  `human(approved:<agentName>)`, clears pending_approval, returns item to
  `agent_state.return_queue`, unassigns. **`reject_action`** (human-only):
  clears pending_approval, audit `reject_action`, escalates with question
  "Proposed <action> rejected — handle manually."
- **shadow** — do NOT execute and do NOT block: audit action `shadow_decision`
  with the full decision in detail, set `agent_state.shadow_seen[<step-key>] = true`
  so the same decision isn't re-logged every tick, leave the item untouched
  for humans/other agents.

Below-threshold behavior stays escalate (all modes).

### Per-agent stats

`GET /api/agents/[id]/stats` → from audit_log (actor = `agent:<id>`):
`{processed, actions, escalations, proposals, shadowDecisions, avgConfidence, autoRate}`
where autoRate = actions/(actions+escalations). Also
`GET /api/agents/stats` → array of the same keyed by agentId, plus totals.
(Confidence lives in `detail.confidence` of audit rows.)

### Phone channel (inbound calls → same pipeline)

Two new scenarios in `lib/sampleDocs.ts` (+ types ScenarioKey):
- `call_referral` — source_channel `phone`: an IVR/transcription artifact — a
  brief conversational transcript followed by a structured "CALL SUMMARY"
  block with labeled lines (Patient:, DOB:, From:, Reason:) so the existing
  extractor works. Use a seeded patient.
- `call_records_request` — same shape, records request, includes
  Authorization line and Records Requested.
`injectInbound` accepts them (source_channel 'phone'). No other changes — the
point of the demo is that phone is *just another adapter* into the same intake.

### Portal-channel dispatch support (for provider-portal's feature)

In the send tools / ROI dispatch: when the target org's
`contact.preferred_channel === 'portal'` (and no channel override), create the
outbound attempt with `channel='portal'`, `respond_after=null`, status `sent`.
In `tick()`: attempts with `channel='portal'` are **never** auto-responded and
**never** timed out (they wait for a human in the portal); the chase loop's
pending-guard already keeps them un-chased. Seed: set
`organizations.contact.preferred_channel = 'portal'` for **org_cleveland**
(the cloud-capable org), keep its fax/email as fallback contact info.
Export `handleAttemptResponse` from `lib/simulate.ts` (provider-portal imports
it to apply structured responses).

---

## 2. Provider portal (provider-portal)

The external org's side of the network — where a community provider answers
in-app (structured) instead of faxing back. Mock auth: an org switcher.

Pages (`app/portal/...`, plain client components, polling every 4s):
- `/portal` — org picker ("Sign in as…" dropdown of all organizations, mock).
  Stores selection in localStorage; header shows "Viewing as <org>".
- `/portal/[orgId]` — the org's inbox: all `outbound_attempts` addressed to it
  (`to_org_id = orgId`, any channel) newest first, each showing channel badge
  (📠/✉️/💬/📞/🌐 portal), subject/body, status, and — for status `sent`/
  `awaiting_response` — a **Respond** form: free-text response + a
  "records attached" toggle (for ROI requests) or "authorization attached"
  toggle (for request-more-info). Submitting POSTs `/api/portal/respond`.
  Already-responded attempts show the response read-only.

API (`app/api/portal/...` → `lib/portal.ts`):
- `GET /api/portal/inbox?orgId=` →
  `{data: [{id, workItemId, channel, attemptNo, payload, status, response, createdAt, itemType}]}`
- `POST /api/portal/respond` body
  `{attemptId, message, recordsAttached?, authorizationAttached?}` →
  marks the attempt `responded` with
  `response = {status:'responded_via_portal', message, authorization?: 'Signed authorization (portal)', received_at}`
  (set `authorization` when authorizationAttached), then calls the exported
  `handleAttemptResponse(workItemId, queueKey, response, extracted)` from
  `lib/simulate.ts` so the owning work item reopens and its agent resumes —
  identical to a simulated reply, but it came from a human at the other org.
  Audit row: actor `portal:<orgName>`, action `portal_response`.

Demo this enables: compose an ROI to Cleveland Clinic (preferred_channel
'portal') → attempt lands in Cleveland's portal inbox (no fax sent at all — the
on-network tier) → open `/portal`, respond with records attached → the Records
Chaser sees the response and completes. Fax remains the graceful degradation
for every org not on the network.

---

## 3. UI polish (ui-polish)

Make it look like a product, not a prototype. No UI libraries — hand-rolled
CSS is fine (a `globals.css` with CSS variables / utility classes, imported in
layout). Keep ALL existing functionality and API calls working; you are
restyling and *adding the small new controls below*, not rearchitecting.

Direction: clean clinical SaaS — near-white background, one accent
(deep indigo), generous whitespace, 8px radius cards with soft borders +
subtle shadows, SF/system font stack, 13–14px body, uppercase letter-spaced
section labels, smooth 150ms transitions, status colors used sparingly
(green=done/auto, amber=waiting/review, red=failed/low-confidence,
indigo=agent activity).

Specifics:
1. `app/layout.tsx` — refined top nav (product name "CE 2.0 — Network Console",
   active-link state, add **Portal** link → `/portal`).
2. `/queues` — polished board cards (count typography, hover lift, per-queue
   accent stripe); **add a supervision stat strip** above the cards from
   `GET /api/agents/stats`: "Items auto-handled", "Escalated to humans",
   "Agent actions", "Avg confidence" (graceful if endpoint 404s while
   agent-engine is in flight). Simulate panel as a tidy toolbar (group inbound
   scenario buttons incl. the two NEW phone scenarios `call_referral` and
   `call_records_request` with 📞 icons; auto-tick as a labeled switch).
   Activity feed: cleaner rows, actor chips (agent=indigo, human=blue,
   system=gray, portal=teal), relative times.
3. `/queues/[key]` — table polish: row hover, sticky header, confidence shown
   as a small meter bar + value, channel icons incl. 📞 phone and 🌐 portal.
4. `/items/[id]` — the showpiece: fax/source doc on subtle paper texture
   (monospace, faint top "FAX" header), audit timeline with a vertical rail +
   dots per entry, attempts as channel-iconed cards with status pills and the
   respond_after countdown. **Add supervised-mode UI**: when
   `item.agent_state.pending_approval` exists, render an approval banner
   ("<agentName> proposes <action> (confidence X) — rationale") with
   **Approve** → POST actions `{tool:'approve_action', params:{}}` and
   **Reject** → `{tool:'reject_action', params:{}}`.
5. `/agents` — builder polish + **mode selector** (three-state control
   autonomous/supervised/shadow with one-line explanations, PATCH `{mode}`),
   and per-agent mini-stats (from `/api/agents/[id]/stats`: processed,
   auto-rate, escalations; graceful 404).
6. `/roi/new` and `/` (directory) — consistent restyle.
7. Empty states with a small illustration-ish glyph + one-line hint everywhere.

---

## Acceptance (I verify all of these)

1. Unchecking `send_fax` on the ROI Fulfillment Agent makes the next clean ROI
   go out via email. Re-check restores fax.
2. Mode=supervised on ROI Fulfillment: next clean ROI produces an approval
   banner; Approve executes the send and completes; Reject escalates.
   Mode=shadow: decisions appear in audit as `shadow_decision`, items don't move.
3. `call_referral` flows phone → intake → classified/matched → referrals.
4. ROI to Cleveland goes out as channel `portal` (no fax), shows in
   `/portal/[cleveland]`, structured response completes the item. ROI to a
   fax org still chases fax→email→sms→voice on timeout.
5. `/api/agents/stats` returns sane numbers; stat strip renders.
6. Every page visibly redesigned; all four original flows still pass.
7. `pnpm typecheck` and `pnpm build` clean.
