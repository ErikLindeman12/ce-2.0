# Agent-Native Work Queue — Demo Script

> **Audience:** Erik (CE 2.0 pitch to Epic leadership)
> **Time needed:** ~10 minutes for the four flows
> **Prerequisites:** branch merged to main, `supabase db push` applied, seed loaded.

> ⚠️ **Before any demo:** the Supabase free-tier project pauses after ~1 week
> idle, and a paused DB breaks *everything* (including prod) with confusing
> timeouts. Check https://supabase.com/dashboard/project/mmvjptmuazcamuduhyzz —
> if INACTIVE, restore and wait ~2 minutes.

**Easiest way to drive the demo:** open `/queues`, flip **auto-tick ON**, and
use the simulate-panel buttons. The tick is the simulated world clock — it
delivers outbound responses/timeouts, advances the chase loop, and runs every
enabled agent each ~5s, so queues visibly move on their own while you narrate.
The curl blocks below are the headless equivalent (use "Tick now" / manual
ticks instead when you want to step the world frame by frame).

> **API note (post Workflow-1 upgrade):** `GET /api/work-items` and
> `GET /api/work-items/<id>` now return a `{"data": ...}` envelope with
> camelCase fields, and `POST /api/roi` returns `{"data":{"workItemId"}}` —
> adjust the older `jq` snippets below accordingly (e.g. `.data[0]`).

---

## ⭐ Workflow 1 showcase — Outgoing ROI + multi-channel chase (upgraded)

The most polished path; lead the demo with it.

1. **Compose** (`/roi/new`): pick a patient → patient card. Search an org →
   its **capability card** shows exactly which channels it supports
   (Mass General has *no email* — watch the plan skip it), the preferred
   channel starred, and a teal **On network** badge for Cleveland Clinic.
   The **channel plan stepper** and a live **fax cover-sheet preview** update
   as you type. Set **response wait** to 10s for a fast demo.
2. **The chase** (send to UCSF Medical Center — never answers): open the item.
   A chase-plan stepper tracks fax → email → SMS → voice; every attempt is a
   card with the actual rendered document ("View Fax document" — cover sheet,
   HIPAA notice, reference number). Voice shows "rang — no answer, voicemail
   left." After the last channel: Human Review with the channel-by-channel
   history.
3. **On-network tier** (send to Cleveland Clinic): no fax goes out at all —
   one **In-app** attempt appears in the **Provider Portal** (`/portal` →
   Cleveland Clinic). Respond there with "Attach requested records" → the
   Records Chaser completes the item on the next tick, audit actor
   `portal:Cleveland Clinic`. Fax is the graceful degradation for everyone
   not on the network; the portal is the upgrade path.
4. **Responsive fax org** (send to Mayo Clinic): reply arrives in ~one wait
   period with a rendered **RECORDS TRANSMITTAL** on the item; completion
   note carries the ROI reference.

---

## Setup (run once before the demo)

```bash
# Apply schema migration (new tables + contact column)
supabase db push

# Load seed data (patients, queues, agents, org contacts)
supabase db query --linked -f supabase/seed.sql

# Verify prod is up
curl -s https://ce-2-0.vercel.app/api/health
```

Expected health response: `{"status":"ok"}` (or similar from the existing health route).

Verify the work queue tables are seeded:

```bash
# Should return 5 queues
curl -s https://ce-2-0.vercel.app/api/queues | jq '.[].name'

# Should return 8 patients
curl -s https://ce-2-0.vercel.app/api/patients | jq 'length'

# Should return 3 agents
curl -s https://ce-2-0.vercel.app/api/agents | jq '.[].name'
```

---

## Flow 1 — Inbound fax intake (3 scenarios in 2 minutes)

### 1a. Clean referral → routes automatically

**UI path:** Open `/queues` → click "Inject fax_referral_clean" → click "Tick now" twice.

**curl equivalent:**

```bash
# Inject a clean cardiology referral for James Whitfield (MRN-00101)
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/inbound \
  -H 'content-type: application/json' \
  -d '{"scenario":"fax_referral_clean"}' | jq .

# Tick the world (agents run, classification + patient match + routing happens)
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/tick | jq .report.agentRun

# Tick again — item should now be in Referrals queue, status done or in_progress
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/tick | jq .

# Confirm the item landed in Referrals
curl -s "https://ce-2-0.vercel.app/api/work-items?queue=referrals" | jq '.[0] | {type, status, assignee}'
```

**What to show:** Audit trail on `/items/<id>` — three steps logged: classify_document (0.95 confidence), extract_fields (0.90), match_patient (0.97), advance_stage to `referrals`. Every step has actor, rationale, and confidence visible.

---

### 1b. Ambiguous patient → Human Review with specific question

```bash
# Inject the Maria Garcia referral (no DOB — two candidates in MPI)
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/inbound \
  -H 'content-type: application/json' \
  -d '{"scenario":"fax_ambiguous_patient"}' | jq .itemId

# Tick — agent classifies and extracts, then match_patient returns confidence 0.45
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/tick | jq .

# Item should be in human_review with a specific review_reason
ITEM_ID=$(curl -s "https://ce-2-0.vercel.app/api/work-items?queue=human_review" | jq -r '.[0].id')
curl -s "https://ce-2-0.vercel.app/api/work-items/$ITEM_ID" | jq '{reviewReason: .item.review_reason, candidates: .patientCandidates}'
```

**What to show on UI:** Human Review queue shows the item with the review_reason prominently: "Two patients named Maria Garcia (DOB 1981-03-04 vs 1990-07-22). Which one?" — two patient candidate chips let the reviewer click to resolve. After clicking, the item routes to Referrals.

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

curl -s -X POST https://ce-2-0.vercel.app/api/simulate/tick | jq .

# Verify it landed in human_review (classify confidence ~0.3, extract ~0.15)
curl -s "https://ce-2-0.vercel.app/api/work-items?queue=human_review" | \
  jq '.[] | {id, reviewReason: .review_reason, confidence}'
```

---

## Flow 2 — Incoming ROI: happy path and missing authorization

### 2a. Clean ROI request → agent fulfills automatically

```bash
# Inject a clean ROI request for Susan Chen from Mass General (org_mgh)
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/inbound \
  -H 'content-type: application/json' \
  -d '{"scenario":"fax_roi_clean"}' | jq .

# Two ticks: intake agent classifies→extracts→matches→routes to roi_incoming,
# then ROI Fulfillment Agent verifies→send_fax→mark_complete
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/tick | jq .
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/tick | jq .

# View outbound attempt (records sent back to Mass General via fax)
curl -s "https://ce-2-0.vercel.app/api/work-items?queue=roi_incoming" | \
  jq '.[0] | {status, assignee}'
```

**What to show:** Item detail page shows a fax outbound attempt with status `responded` (after a tick resolves it), then item moves to `done`.

---

### 2b. ROI missing authorization → agent requests more info → reply arrives → completes

```bash
# Inject ROI with "Authorization: to follow" (triggers request_more_info)
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/inbound \
  -H 'content-type: application/json' \
  -d '{"scenario":"fax_roi_missing_auth"}' | jq .

# Tick 1: intake processes it into roi_incoming
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/tick | jq .

# Tick 2: ROI agent fires request_more_info outbound to Kaiser (org_kaiser)
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/tick | jq .

# Tick 3: simulated reply arrives (authorization provided), item back to open
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/tick | jq .

# Tick 4: ROI agent verifies (auth now present) → sends records → mark_complete
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/tick | jq .
```

**Story:** "The agent didn't just fail — it took an outbound action, waited for the reply, and resumed exactly where it left off."

---

## Flow 3 — Outgoing ROI + chase loop (the "never answers" org)

### 3a. Responsive org — records arrive

```bash
# Compose an outgoing ROI to Mayo Clinic (org_mayo, preferred_channel: email)
PATIENT_ID=$(curl -s https://ce-2-0.vercel.app/api/patients | jq -r '.[] | select(.mrn=="MRN-00101") | .id')

curl -s -X POST https://ce-2-0.vercel.app/api/roi \
  -H 'content-type: application/json' \
  -d "{\"patientId\":\"$PATIENT_ID\",\"orgId\":\"org_mayo\",\"recordsRequested\":\"All cardiology notes from 2024\"}" | jq .

# Tick: simulated response arrives (Mayo answers)
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/tick | jq .

# Records Chaser sees response_received → mark_complete
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/tick | jq .
```

---

### 3b. Never-answers org (UCSF) → fax → email → SMS → voice → Human Review

```bash
# Compose an outgoing ROI to UCSF (org_ucsf, simulation: no_response)
curl -s -X POST https://ce-2-0.vercel.app/api/roi \
  -H 'content-type: application/json' \
  -d "{\"patientId\":\"$PATIENT_ID\",\"orgId\":\"org_ucsf\",\"recordsRequested\":\"Neurology notes 2024\"}" | jq .itemId

# Each tick advances one step in the chase: fax timeout → email → SMS → voice → escalate
for i in 1 2 3 4 5; do
  echo "=== Tick $i ==="
  curl -s -X POST https://ce-2-0.vercel.app/api/simulate/tick | jq '{chaseAttempts: .report.chaseAttempts, escalations: .report.escalations}'
done
```

**What to show on UI:** Item in ROI — Outgoing shows numbered outbound attempts: #1 Fax (timed out), #2 Email (timed out), #3 SMS (timed out), #4 Voice (timed out), then it appears in Human Review with message "No response after 4 attempts across fax/email/SMS/voice — call them or close?"

---

## Flow 4 — Agent builder: threshold edit changes behavior

### 4a. Raise the Intake Agent threshold → previously-clean faxes escalate

```bash
# Get the Intake Agent's current ID
AGENT_ID=$(curl -s https://ce-2-0.vercel.app/api/agents | jq -r '.[] | select(.name=="Intake Agent") | .id')

# Raise threshold to 0.99 — now even 0.95 classify confidence fails the gate
curl -s -X PATCH "https://ce-2-0.vercel.app/api/agents/$AGENT_ID" \
  -H 'content-type: application/json' \
  -d '{"confidence_threshold":0.99}' | jq '{name, confidence_threshold: .confidenceThreshold}'

# Inject a normally-clean fax — it will now escalate to Human Review
curl -s -X POST https://ce-2-0.vercel.app/api/simulate/inbound \
  -H 'content-type: application/json' \
  -d '{"scenario":"fax_referral_clean"}' | jq .

curl -s -X POST https://ce-2-0.vercel.app/api/simulate/tick | jq .

# Should now be in human_review (shadow mode — lower confidence than the new threshold)
curl -s "https://ce-2-0.vercel.app/api/work-items?queue=human_review" | jq '.[0].review_reason'
```

**UI:** Go to `/agents` → edit Intake Agent threshold → save → inject scenario → watch it escalate instead of routing.

### 4b. Restore threshold for normal operation

```bash
curl -s -X PATCH "https://ce-2-0.vercel.app/api/agents/$AGENT_ID" \
  -H 'content-type: application/json' \
  -d '{"confidence_threshold":0.8}' | jq .
```

---

## Activity feed verification

```bash
# Last 30 audit events across all items (the live feed on /queues)
curl -s "https://ce-2-0.vercel.app/api/activity?limit=10" | \
  jq '.[] | {actor, action, createdAt}'
```

---

## Vercel runtime logs (during demo)

Open in a terminal alongside the demo:

```bash
vercel logs https://ce-2-0.vercel.app --follow
```

All agent steps log `[agent.run] {agentName, itemId, step, action, confidence, rationale}`. Each tool call logs its name. Tick events log `[simulate.tick] {event, ...}`. These are the structured tags from `console.log` per the architecture invariant.

---

## Key talking points

1. **Same tool, human or agent** — the action buttons on `/items/<id>` call the exact same `runTool` code path as agent steps. No parallel implementation.
2. **Audit trail is the truth** — every action (automated or human) writes an `audit_log` row with actor, rationale, and confidence. Nothing happens without a trace.
3. **Confidence is first-class** — the threshold slider on `/agents` is the human-in-the-loop knob. At 0.99 the agent is purely a recommender; at 0.7 it drives most completions autonomously.
4. **Durable chase loop** — the tick() function is idempotent and safe to call every 5 seconds. The simulated world advances with `respond_after` timestamps, not sleeps.
5. **No new npm deps** — the entire work queue runs on the existing Next.js + Supabase stack. Zero new services.
