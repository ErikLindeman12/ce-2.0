# Agent-Native Work Queue — Demo Script

> **Audience:** Erik (CE 2.0 pitch to Epic leadership)
> **Time needed:** ~12 minutes for the core arc; +5 for the live-build variant
> **Prerequisites:** branch merged to main, `supabase db push` applied, seed loaded.

> ⚠️ **Before any demo:** the Supabase free-tier project pauses after ~1 week
> idle, and a paused DB breaks *everything* (including prod) with confusing
> timeouts. Check https://supabase.com/dashboard/project/mmvjptmuazcamuduhyzz —
> if INACTIVE, restore and wait ~2 minutes.

**Easiest way to drive the demo:** open `/queues`, flip **auto-tick ON**, and
use the simulate-panel buttons. Injection, ROI compose, approvals, and portal
actions all pump the event loop **inline**, so most beats move the instant you
click; the tick is the simulated world clock for everything time-based — it
resolves outbound responses/timeouts and fires durable timers, then re-pumps.
The curl blocks below are the headless equivalent (use "Tick now" / manual
ticks when you want to step the world frame by frame).

> **What changed under the hood (the substrate replatform):** every occurrence
> is now an **event row** (`document.received`, `document.classified`,
> `response.received`, `attempt.timed_out`, `review.requested`,
> `human.decided`, `case.completed`, …); agents are **pure config**
> (subscriptions + tool allowlist + named policies: `chase_policy`,
> `requirements`, `send_policy`, `complete_when`); a config **Router**
> (`routing_rules` table) is the only thing that places cases in queues; review
> requests are structured rows. The four demo flows below are expressed
> **purely as seed config** — no engine code knows about referrals, ROI, or
> prior auth.

> **API note:** `GET /api/work-items`, `GET /api/work-items/<id>`,
> `GET /api/events`, and the other new endpoints return a `{"data": ...}`
> envelope with camelCase fields; `POST /api/roi` returns
> `{"data":{"workItemId"}}`. `GET /api/agents` and `GET /api/activity` still
> return raw rows (snake_case) — the `jq` paths below are already adjusted.

---

## ⭐ Workflow 1 showcase — Outgoing ROI + multi-channel chase

The most polished path; lead the demo with it.

1. **Compose** (`/roi/new`): pick a patient → patient card. Search an org →
   its **capability card** shows the resolved chase ladder — which is pure
   config: the Records Chaser's `chase_policy` (fax → fax → voice) is the
   default, Mass General's org contact overrides it to secure email → voice,
   and Cleveland Clinic / Mayo carry the **⚡ Epic · Care Everywhere** badge,
   collapsing the **channel plan stepper** to a single ⚡ step. A live **fax
   cover-sheet preview** updates as you type (served by
   `GET /api/roi/plan-preview` — same resolution the engine uses). Set
   **response wait** to 10s for a fast demo.
2. **The chase** (send to UCSF Medical Center — never answers): the composer
   only creates the case; the **agent** sends rung 1 on the `case.created`
   event. Open the item: every attempt is a card with the actual rendered
   document — #1 fax ("View Fax document" — cover sheet, HIPAA notice,
   reference number) times out, #2 fax renders with a **2ND REQUEST** banner
   (derived from the prior timed-out attempt), #3 voice shows "rang — no
   answer, voicemail left." Then Human Review: *"No response after 3 attempts
   (fax, fax, voice) — call them or close?"* with the channel-by-channel
   history.
3. **Care Everywhere tier** (send to Cleveland Clinic or Mayo): a single ⚡
   attempt goes out — a structured C-CDA query, no escalation chain — and the
   case **auto-completes ~8 seconds later** with the rendered C-CDA response
   on the item and completion note *"Records received via care_everywhere —
   ref ROI-…"*. Fax is the graceful degradation for everyone off the network;
   Care Everywhere is the upgrade path. Narrate: same agent, same ladder
   config — the network tier is just the first (and only) rung.

---

## ⭐ The event timeline — show it on the first item you open

Every item detail page now has an **Event Timeline** section: the case's
causal event chain, e.g. for an inbound fax —
`document.received → case.routed intake → document.classified as referral
(95%) → fields.extracted → review.requested → case.routed human_review`.

Narrate: **"this is the audit/event log the whole platform runs on"** — agents
wake on these events, the Router places cases on these events, and the
timeline you're looking at IS the engine's actual input, not a rendering of
something else. Open it on the UCSF item from Workflow 1 and you'll see the
`case.created → attempt.created → attempt.timed_out → …` chase chain; come
back to it after every beat below — it's the proof for each one.

---

## ⭐ Workflow 2 showcase — Inbound intake + the review workbench

1. **The account toggle** (top-right): you're "Epic Health System · Network
   Console." Switching to "Provider portal as → Cleveland Clinic" turns the
   whole app into *their* teal-chrome inbox — this is how you show both sides
   of the network without confusion. Console routes are blocked while acting
   as a provider.
2. **"☀️ Morning batch (8)"** on the Queues board + auto-tick ON: eight mixed
   communications (faxes, a DM, a phone call, a garbled fax, a misspelled
   name) arrive at once and the board drains itself. The **stats strip**
   updates live: auto-routed % vs escalated — the supervision-surface story
   in one number.
3. **Phone is just another channel**: "📞 Call: referral" injects a call
   transcript with an auto-transcribed CALL SUMMARY; same pipeline, routed to
   Referrals; the item renders with a CALL header instead of FAX.
4. **The review workbench** (open anything in Human Review):
   - The *misspelled-name fax* ("Jame Whitfield"): blocking question
     "Closest MPI match is James Whitfield… is this the right patient?" with
     the candidate card — candidates now come from **structured review rows**
     (`review_requests`), not parsed strings. One click resolves it and the
     case lands in **Referrals**: the human's answer emits `human.decided` +
     a 100%-confidence `document.classified`, and the Router routes it — the
     human is just another event source.
   - The *garbled fax*: source document left, **editable extraction form**
     right with per-field confidence chips; extraction's source lines are
     highlighted in the document (hover a field → its line lights up). Type
     the correct name + DOB, **Confirm & route** — the platform re-matches
     the patient automatically and the audit log records exactly which
     fields the human corrected.
5. **The portal round-trip** (both sides in one minute): as Cleveland Clinic,
   submit a records request **without** attaching an authorization. The
   intake/ROI agents process it; the ROI Fulfillment Agent's `requirements`
   config catches the missing auth and sends `request_more_info` — the portal
   request flips to **"Action needed."** Attach the authorization → the
   response re-arms the agent, records go out, and the request shows
   **"Completed"** with the response document viewable right in the portal.
   Story: *"The agent didn't just fail — it took an outbound action, waited
   for the reply, and resumed exactly where it left off."*

---

## ⭐ Workflow 4 showcase — Configurable agents (the low-code story)

1. **The configuration IS the policy** (`/agents`): uncheck `send_fax` on the
   ROI Fulfillment Agent, inject a clean ROI fax — records go out by *email*.
   No code changed; the tool checklist is the behavior.
2. **Triggers are visible and editable**: each agent card shows its event
   subscriptions as **⚡ chips** (e.g. ⚡ document.classified · as=referral).
   Open the edit form: a **Triggers** section (event-type dropdown + filter
   key/values), an **Advanced policies (JSON)** editor for the named-policy
   DSL, and a **"⚡ Fire sample"** button per trigger — it replays the latest
   event of that type and reports how many agent turns ran ("⚡ replayed —
   N agent turns ran"). This is how you debug a workflow without touching the
   queues.
3. **The autonomy ladder** — each agent has a three-state mode:
   - **Shadow**: the agent's deliveries are marked `shadowed` and it records
     what it *would* do (audit shows `shadow_decision` entries) but executes
     **nothing** — run a new agent in shadow for a week before trusting it.
     Flipping out of shadow **replays** the shadowed decisions for real.
   - **Supervised**: annotation steps (classify/extract/match/verify) run
     free, but externally-acting tools pause for approval — the item lands in
     Human Review with an amber banner: *"ROI Fulfillment Agent proposes:
     send_fax (0.93)"* + rationale. **Approve** executes the stored proposal
     verbatim (audit actor `human(approved:ROI Fulfillment Agent)`), and the
     `human.decided` event re-activates the agent — watch the case
     auto-complete in the same pump. **Reject** escalates.
   - **Autonomous**: acts on anything above the confidence threshold.
   Mode + the threshold slider = shadow → supervised → autonomous without
   rebuilding anything.
4. **Per-agent supervision stats** on each card: processed, auto-rate %,
   escalations, proposals, shadow decisions — the "agents did X% of the work"
   number, per agent.

---

## ⭐ The 60-second workflow — prior auth (close with this)

The centerpiece: a **brand-new workflow stood up entirely as configuration** —
trigger, ladder, completion rule, queue — zero engine changes. It's already
seeded; the demo is watching it come alive.

1. **Inject** "📑 Prior auth fax" from the Simulate panel.
2. **Config classifies it**: the Intake Agent's `classify_rules` config
   (matches "prior auth" → type `prior_auth`) tags it; a **routing rule**
   (`document.classified {as: prior_auth} → prior_auth`) places it in the new
   **Prior Auth** queue. Open the event timeline to prove it.
3. **Shadow-first**: the Auth Chaser is seeded in **shadow mode**. It woke on
   the classification and recorded its would-be rung-1 fax **without acting**
   — show the `shadow_decision` in the activity feed and the shadow count on
   its agent card.
4. **Flip it live**: in the builder, switch Auth Chaser to **autonomous** — a
   **"▶ replayed N shadowed decisions"** pill appears and the rung-1 fax goes
   out immediately. Open the item: the attempt card and the
   `attempt.created` event are right there.

Narration: *"A brand-new workflow — trigger, ladder, completion rule, queue —
stood up entirely as configuration; zero engine changes; shadow-first like
ART."*

### Live-build variant (for longer demos)

Same flow as prior auth, but built on stage: in `/agents`, **create a new
agent from scratch** — name it, add a Trigger subscribing it to an event type,
check its tools, set **shadow** mode, save. Hit **"⚡ Fire sample"** on the
trigger → the latest matching event replays, the agent runs a turn, and its
shadow decision shows up in the activity feed. From blank form to observable
agent behavior in about two minutes, without leaving the browser.

---

## Setup (run once before the demo)

```bash
# Apply schema migrations (event substrate tables + columns)
supabase db push

# Load seed data (patients, queues, agents, routing rules, event types)
supabase db query --linked -f supabase/seed.sql

# Verify prod is up
curl -s https://ce-2-0.vercel.app/api/health
```

Expected health response: `{"status":"ok"}` (or similar from the existing health route).

Verify the config tables are seeded (these ARE the workflows):

```bash
# Should return 6 queues (incl. Prior Auth)
curl -s https://ce-2-0.vercel.app/api/queues | jq '.[].name'

# Should return 8 patients
curl -s https://ce-2-0.vercel.app/api/patients | jq 'length'

# Should return 4 agents (Intake, ROI Fulfillment, Records Chaser, Auth Chaser)
curl -s https://ce-2-0.vercel.app/api/agents | jq '.[].name'

# The Router's config — 5 seed rules
curl -s https://ce-2-0.vercel.app/api/routing-rules | jq '.data[] | {event_type, filter, queue_key}'

# The event taxonomy (powers builder dropdowns + the timeline)
curl -s https://ce-2-0.vercel.app/api/event-types | jq '.data[].type'
```

### Demo reset (between runs)

Truncate the **runtime** tables only — the workflows now LIVE in the config
tables, so never truncate those:

```sql
truncate audit_log, outbound_attempts, event_deliveries, events,
  review_requests, work_items;
-- NEVER truncate: work_queues, routing_rules, event_types, agents
-- (seed-preserved config — that's the whole point).
```

---

## Flow 1 — Inbound fax intake (3 scenarios in 2 minutes)

### 1a. Clean referral → routes automatically

**UI path:** Open `/queues` → click "Fax: Referral (clean)" — the inline pump
runs the whole cascade at injection time; no tick needed.

**curl equivalent:**

```bash
# Inject a clean cardiology referral for James Whitfield (MRN-00101).
# The response includes how many agent turns the inline pump ran.
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/inbound \
  -H 'content-type: application/json' \
  -d '{"scenario":"fax_referral_clean"}' | jq '{itemId, turns}'

# Confirm the item landed in Referrals
curl -s "https://ce-2-0.vercel.app/api/work-items?queue=referrals" | \
  jq '.data[0] | {type, status, queueKey}'

# The causal chain — this IS the engine's input
ITEM_ID=$(curl -s "https://ce-2-0.vercel.app/api/work-items?queue=referrals" | jq -r '.data[0].id')
curl -s "https://ce-2-0.vercel.app/api/events?caseId=$ITEM_ID" | \
  jq '.data[] | {type, actor}'
```

**What to show:** `/items/<id>` — the **Event Timeline**:
`document.received → case.routed intake → document.classified (0.95) →
fields.extracted → patient.matched (0.97) → case.routed referrals`, plus the
audit trail with actor, rationale, and confidence on every step.

---

### 1b. Ambiguous patient → Human Review with specific question

```bash
# Inject the Maria Garcia referral (no DOB — two candidates in MPI).
# The agent classifies + extracts inline, then match_patient comes back 0.45
# → it files a structured review request and the Router places the case.
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/inbound \
  -H 'content-type: application/json' \
  -d '{"scenario":"fax_ambiguous_patient"}' | jq .itemId

# Item is in human_review with a structured review row (kind: question)
ITEM_ID=$(curl -s "https://ce-2-0.vercel.app/api/work-items?queue=human_review" | jq -r '.data[0].id')
curl -s "https://ce-2-0.vercel.app/api/work-items/$ITEM_ID" | \
  jq '.data | {question: .reviews[0].question, candidates: .patientCandidates}'
```

**What to show on UI:** Human Review queue shows the item with the question
prominently: "Two patients named Maria Garcia (DOB 1981-03-04 vs 1990-07-22).
Which one?" — two patient candidate chips let the reviewer click to resolve.
After clicking, `human.decided` is emitted and the Router lands it in
Referrals.

**Resolve via curl:**

```bash
# Pick the 1981 Maria Garcia (MRN-00102)
PATIENT_ID=$(curl -s https://ce-2-0.vercel.app/api/patients | jq -r '.[] | select(.mrn=="MRN-00102") | .id')

curl -s -X POST "https://ce-2-0.vercel.app/api/work-items/$ITEM_ID/actions" \
  -H 'content-type: application/json' \
  -d "{\"tool\":\"resolve_review\",\"params\":{\"patient_id\":\"$PATIENT_ID\"}}" | jq .
```

---

### 1c. Garbled OCR fax → Human Review (low confidence)

```bash
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/inbound \
  -H 'content-type: application/json' \
  -d '{"scenario":"fax_messy"}' | jq .

# Verify it landed in human_review (classify confidence ~0.3, extract ~0.15)
curl -s "https://ce-2-0.vercel.app/api/work-items?queue=human_review" | \
  jq '.data[] | {id, reviewReason, confidence}'
```

---

## Flow 2 — Incoming ROI: happy path and missing authorization

### 2a. Clean ROI request → agent fulfills automatically

```bash
# Inject a clean ROI request for Susan Chen from Mass General (org_mgh).
# Inline pump: intake classifies→extracts→matches, Router places it in
# roi_incoming, ROI Fulfillment Agent verifies requirements → sends records.
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/inbound \
  -H 'content-type: application/json' \
  -d '{"scenario":"fax_roi_clean"}' | jq '{itemId, turns}'

# The outbound resolves after its simulated response window (~20-40s; auto-tick
# covers this in the UI). Headless: wait, then tick — the response.received
# event re-activates the agent and complete_when closes the case.
sleep 40
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/tick | jq .report.agentRun

curl -s "https://ce-2-0.vercel.app/api/work-items?queue=roi_incoming" | \
  jq '.data[0] | {status, assignee}'
```

**What to show:** Item detail shows the fax outbound attempt, then status
`done` with the `case.completed {result: records_sent}` event on the timeline.

---

### 2b. ROI missing authorization → agent requests more info → reply arrives → completes

This is the `requirements` policy in action — `has_auth` fails its
`not_matches "to follow"` predicate, so the agent fires the configured
`on_missing` request instead of sending records.

```bash
# Inject ROI with "Authorization: to follow" — the inline pump runs all the
# way through the agent's request_more_info outbound to Kaiser (org_kaiser).
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/inbound \
  -H 'content-type: application/json' \
  -d '{"scenario":"fax_roi_missing_auth"}' | jq '{itemId, turns}'

# Wait out the response window (~20-40s; auto-tick covers this in the UI),
# then tick: the simulated reply arrives (authorization provided). The
# subscription's on_event merges it into extracted and clears requirements —
# the agent re-verifies (auth now present) → sends records.
sleep 40
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/tick | jq .report.agentRun

# One more window + tick: the records_response resolves → complete_when → done.
sleep 40
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/tick | jq .report.agentRun
```

**Story:** "The agent didn't just fail — it took an outbound action, waited
for the reply, and resumed exactly where it left off. And 'resumed' is
literal: the response *event* re-armed the same config-defined checks."

---

## Flow 3 — Outgoing ROI: Care Everywhere tier and the "never answers" org

### 3a. Care Everywhere org — single ⚡ attempt, auto-completes

```bash
# Compose an outgoing ROI to Mayo Clinic (on-network: channels include 'cloud').
# The route creates the case and emits case.created — the Records Chaser sends
# the C-CDA query itself (the route creates NO attempt).
PATIENT_ID=$(curl -s https://ce-2-0.vercel.app/api/patients | jq -r '.[] | select(.mrn=="MRN-00101") | .id')

ITEM_ID=$(curl -s -X POST https://ce-2-0.vercel.app/api/roi \
  -H 'content-type: application/json' \
  -d "{\"patientId\":\"$PATIENT_ID\",\"orgId\":\"org_mayo\",\"recordsRequested\":\"All cardiology notes from 2024\"}" \
  | jq -r '.data.workItemId')

# Care Everywhere always responds ~8s after the query — wait, then tick.
sleep 9
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/tick | jq .report.agentRun

# Done, with the config-templated completion note
curl -s "https://ce-2-0.vercel.app/api/work-items/$ITEM_ID" | \
  jq '.data | {status: .item.status, attempts: [.attempts[] | {channel, status}], events: [.events[].type]}'
```

**What to show:** one `care_everywhere` attempt, the rendered C-CDA response,
and the completion note "Records received via care_everywhere — ref ROI-…" —
that note is a `complete_when` template
(`Records received via {{state.last_channel}} — ref ROI-{{case.id8}}`), pure
seed config.

---

### 3b. Never-answers org (UCSF) → fax → fax (2ND REQUEST) → voice → Human Review

The ladder is the Records Chaser's `chase_policy` (steps `[fax, fax, voice]`).
One rung per turn: each `attempt.timed_out` event wakes the agent for the next
rung — pass `waitSeconds` to keep the demo fast.

```bash
# Compose to UCSF (org_ucsf, simulation: no_response) with a 10s wait
ITEM_ID=$(curl -s -X POST https://ce-2-0.vercel.app/api/roi \
  -H 'content-type: application/json' \
  -d "{\"patientId\":\"$PATIENT_ID\",\"orgId\":\"org_ucsf\",\"recordsRequested\":\"Neurology notes 2024\",\"waitSeconds\":10}" \
  | jq -r '.data.workItemId')

# Each tick past a wait window times out the rung; the event drives the next.
for i in 1 2 3; do
  sleep 11
  echo "=== Tick $i ==="
  curl -s -X POST https://ce-2-0.vercel.app/api/simulate/tick | \
    jq '{timedOut: .report.timedOutAttempts, agentRun: .report.agentRun.processed}'
done

# Exhausted → structured review request, Router places it in human_review
curl -s "https://ce-2-0.vercel.app/api/work-items/$ITEM_ID" | \
  jq '.data | {queue: .item.queueKey, question: .reviews[0].question}'
```

**What to show on UI:** numbered attempts — #1 Fax (timed out), #2 Fax with
the **2ND REQUEST** banner, #3 Voice ("rang — no answer, voicemail left") —
then Human Review with *"No response after 3 attempts (fax, fax, voice) —
call them or close?"* The event timeline shows the full
`case.created → attempt.created → attempt.timed_out → … → review.requested`
chain.

---

## Flow 4 — Agent builder: config changes behavior

### 4a. Raise the Intake Agent threshold → previously-clean faxes escalate

```bash
# Get the Intake Agent's current ID
AGENT_ID=$(curl -s https://ce-2-0.vercel.app/api/agents | jq -r '.[] | select(.name=="Intake Agent") | .id')

# Raise threshold to 0.99 — now even 0.95 classify confidence fails the gate
curl -s -X PATCH "https://ce-2-0.vercel.app/api/agents/$AGENT_ID" \
  -H 'content-type: application/json' \
  -d '{"confidence_threshold":0.99}' | jq '{name, confidence_threshold}'

# Inject a normally-clean fax — it escalates to Human Review at injection time
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/inbound \
  -H 'content-type: application/json' \
  -d '{"scenario":"fax_referral_clean"}' | jq '{itemId, turns}'

curl -s "https://ce-2-0.vercel.app/api/work-items?queue=human_review" | \
  jq '.data[0].reviewReason'

# Restore for normal operation
curl -s -X PATCH "https://ce-2-0.vercel.app/api/agents/$AGENT_ID" \
  -H 'content-type: application/json' \
  -d '{"confidence_threshold":0.8}' | jq '{name, confidence_threshold}'
```

**UI:** `/agents` → edit Intake Agent threshold → save → inject scenario →
watch it escalate instead of routing.

### 4b. Fire a sample event (the builder's debug loop)

```bash
# Replay the latest document.received event and report how many turns ran —
# this is what the "⚡ Fire sample" button does per trigger row.
curl -s -X POST https://ce-2-0.vercel.app/api/events \
  -H 'content-type: application/json' \
  -d '{"replayType":"document.received"}' | jq '.data.turns'
```

### 4c. The config surfaces (everything the builder edits is just rows)

```bash
# Agent subscriptions + named policies
curl -s https://ce-2-0.vercel.app/api/agents | \
  jq '.[] | {name, mode, subscriptions: [.subscriptions[].event_type], policies: (.config | keys)}'

# Routing rules — add one with POST /api/routing-rules {event_type, filter, queue_key}
curl -s https://ce-2-0.vercel.app/api/routing-rules | \
  jq '.data[] | {event_type, filter, queue_key, priority}'

# Event taxonomy
curl -s https://ce-2-0.vercel.app/api/event-types | jq '.data[].type'
```

---

## Flow 5 — Prior auth: the 60-second workflow (headless)

```bash
# 1. Inject — Intake classifies it prior_auth via config classify_rules; the
#    routing rule places it in the Prior Auth queue; the Auth Chaser (seeded
#    in SHADOW mode) records its would-be fax without acting.
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/inbound \
  -H 'content-type: application/json' \
  -d '{"scenario":"fax_prior_auth"}' | jq '{itemId, turns}'

ITEM_ID=$(curl -s "https://ce-2-0.vercel.app/api/work-items?queue=prior_auth" | jq -r '.data[0].id')

# 2. Proof of shadow: the decision is in the audit feed, but NO attempt exists
curl -s "https://ce-2-0.vercel.app/api/activity?limit=5" | \
  jq '.[] | select(.action=="shadow_decision") | {actor, action}'
curl -s "https://ce-2-0.vercel.app/api/work-items/$ITEM_ID" | jq '.data.attempts | length'   # → 0

# 3. Flip the Auth Chaser to autonomous — the PATCH replays the shadowed
#    deliveries inline and reports how many.
AGENT_ID=$(curl -s https://ce-2-0.vercel.app/api/agents | jq -r '.[] | select(.name=="Auth Chaser") | .id')
curl -s -X PATCH "https://ce-2-0.vercel.app/api/agents/$AGENT_ID" \
  -H 'content-type: application/json' \
  -d '{"mode":"autonomous"}' | jq '{name, mode, replayed}'

# 4. The rung-1 fax went out immediately
curl -s "https://ce-2-0.vercel.app/api/work-items/$ITEM_ID" | \
  jq '.data | {attempts: [.attempts[] | {channel, status}], events: [.events[].type]}'
```

**What to show:** the whole workflow — trigger (`classify_rules` +
subscription), ladder (`chase_policy` fax → fax → voice), completion rule
(`complete_when` on `response_received`), escalation question, and queue — is
the Auth Chaser's seed rows. `git log` shows zero engine changes.

---

## Activity feed verification

```bash
# Last audit events across all items (the live feed on /queues) — raw rows
curl -s "https://ce-2-0.vercel.app/api/activity?limit=10" | \
  jq '.[] | {actor, action, created_at}'

# The platform-wide event log (no caseId filter)
curl -s "https://ce-2-0.vercel.app/api/events?limit=15" | \
  jq '.data[] | {type, actor}'
```

---

## Vercel runtime logs (during demo)

Open in a terminal alongside the demo:

```bash
vercel logs https://ce-2-0.vercel.app --follow
```

Agent turns log `[runner.turn] {deliveryId, agentName, caseId, action,
confidence}`. The pump logs `[dispatcher.*]` rounds and deliveries. Manual
emissions log `[events.emitted_api]` / `[events.replayed]`; mode flips log
`[agents.updated]`; ticks log `[simulate.tick]`. These are the structured tags
from `console.log` per the architecture invariant.

---

## Key talking points

1. **Everything that happens is an event** — the timeline on every item is
   the engine's actual input, not a report. Audit and execution are the same
   data; nothing happens without a trace.
2. **Workflows are rows, not code** — all five flows (referrals, intake, ROI
   both directions, prior auth) are agent subscriptions, named policies, and
   routing rules in seed.sql. Standing up prior auth touched zero engine
   files.
3. **Same tool, human or agent** — buttons on `/items/<id>` call the exact
   same `runTool` path as agent turns; an approved proposal executes verbatim
   as `human(approved:<agent>)` behind state-version fences.
4. **The Router is the only thing that places work** — agents never touch
   queues; humans see exactly what the config rules send them. Supervision is
   a routing rule, not a special case.
5. **Shadow-first rollout, like ART** — a new agent observes in shadow,
   proposes in supervised, acts in autonomous; flipping modes replays what it
   would have done. The threshold slider and mode are the human-in-the-loop
   knobs.
6. **Durable and idempotent** — deliveries are at-least-once with idempotent
   external effects (attempt dedupe keys); the tick is safe to run every 5
   seconds from two tabs at once. Heuristics-only operation (no API key)
   fully works.
7. **No new npm deps** — the entire substrate runs on the existing Next.js +
   Supabase stack. Zero new services.
