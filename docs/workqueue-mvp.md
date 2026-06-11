# Agent-Native Work Queue MVP — Build Spec

> The PoC realization of [platform-model.md](platform-model.md) §3 (one delivery
> primitive) and §4 (fax parse-adapter with confidence + fallback). All
> [architecture.md](architecture.md) invariants apply: one Next.js app, Supabase
> server-side only via `lib/supabase.ts`, append-only migrations, thin route
> handlers, logic in `lib/`, TypeScript strict, `console.log` with structured tags.

## The pitch in one sentence

Messy inbound communications (faxes, direct messages) are classified, patient-
matched, and routed into stage-specific work queues; configurable AI agents pick
up the work, automate what clears a confidence threshold, take outbound actions
(fax/email/SMS/voice — all mocked), chase non-responders, and escalate only the
exceptions to humans — turning the work queue from a to-do list into a
**supervision surface**.

The core invariant from platform-model §4 holds: **structured processing queues
contain only successfully parsed items.** A low-confidence parse never advances —
it lands in Human Review with the *specific question* the agent got stuck on.

## Demo domain

Healthcare records-and-referrals intake. Two directions:

- **Inbound:** external orgs fax/DM us referrals and ROI (release of information
  / records) requests. We classify → extract → match patient → route → process.
- **Outbound:** we send ROI requests *to* external orgs (we need their records),
  then run a durable chase loop: fax → wait → retry → escalate channel → human.

---

## Schema (one new migration — idempotent DDL)

New migration in `supabase/migrations/`. **All DDL must be idempotent**
(`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `ON CONFLICT DO
NOTHING` style guards) because it may be applied both manually via
`supabase db query` and later by the CI `db push` on merge to main.

```sql
-- mock MPI
patients (
  id uuid pk default gen_random_uuid(),
  first_name text not null, last_name text not null,
  dob date not null, mrn text unique not null,
  phone text, created_at timestamptz default now()
)

work_queues (
  key text pk,                  -- 'intake', 'referrals', 'roi_incoming', 'roi_outgoing', 'human_review'
  name text not null, description text,
  sort_order int default 0
)

work_items (
  id uuid pk default gen_random_uuid(),
  type text not null default 'unknown',      -- referral | records_request_in | records_request_out | unknown
  queue_key text not null references work_queues(key),
  status text not null default 'open',       -- open | in_progress | waiting | done | error
  source_channel text not null,               -- fax | direct_message | portal
  source_text text,                            -- the raw fax/DM body (rendered monospace in UI)
  extracted_data jsonb not null default '{}',
  matched_patient_id uuid references patients(id),
  org_id text references organizations(id),    -- external org involved
  confidence jsonb not null default '{}',      -- per-step scores e.g. {"classify":0.93,"match":0.41}
  assignee text not null default 'unassigned', -- 'agent:<id>' | 'human' | 'unassigned'
  review_reason text,                          -- the specific question for Human Review
  agent_state jsonb not null default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
)

agents (
  id uuid pk default gen_random_uuid(),
  name text not null,
  queue_key text not null references work_queues(key),
  enabled boolean not null default true,
  instructions text not null default '',
  tools text[] not null default '{}',          -- allowed tool names
  confidence_threshold numeric not null default 0.8,
  model text not null default 'heuristic',     -- 'heuristic' | anthropic model id
  created_at timestamptz default now()
)

outbound_attempts (
  id uuid pk default gen_random_uuid(),
  work_item_id uuid not null references work_items(id),
  channel text not null,                       -- fax | email | sms | voice
  attempt_no int not null default 1,
  to_org_id text references organizations(id),
  to_contact jsonb not null default '{}',      -- {fax, email, phone} snapshot
  payload jsonb not null default '{}',         -- {subject, body}
  status text not null default 'sent',         -- sent | awaiting_response | responded | timed_out | failed
  respond_after timestamptz,                   -- when the simulated world may respond
  response jsonb,                              -- simulated response payload
  created_at timestamptz default now(),
  updated_at timestamptz default now()
)

audit_log (
  id bigint generated always as identity pk,
  work_item_id uuid references work_items(id),
  actor text not null,                         -- 'agent:<name>' | 'human' | 'system'
  action text not null,                        -- tool name or event
  detail jsonb not null default '{}',
  created_at timestamptz default now()
)

-- contact book for outbound channels (additive to existing table)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact jsonb NOT NULL DEFAULT '{}';
-- e.g. {"fax":"+1-608-555-0142","email":"records@mercygeneral.example","phone":"+1-608-555-0143","preferred_channel":"fax"}
```

Indexes: `work_items(queue_key, status)`, `outbound_attempts(status, respond_after)`,
`audit_log(work_item_id)`.

### Seed (extend `supabase/seed.sql`, idempotent)

- 8 mock patients (varied names/DOBs; include **two patients named "Maria Garcia"
  with different DOBs** — fuel for the ambiguous-match demo).
- 5 queues: Intake, Referrals, ROI — Incoming, ROI — Outgoing, Human Review.
- `contact` jsonb on existing orgs (fax/email/phone + preferred_channel; make at
  least one org fax-only and one that "never answers" — see simulation flags).
- 3 default agents:
  - **Intake Agent** → queue `intake`, tools `[classify_document, extract_fields, match_patient, advance_stage, escalate_to_human]`, threshold 0.8.
  - **ROI Fulfillment Agent** → queue `roi_incoming`, tools `[verify_requirements, send_fax, send_email, mark_complete, request_more_info, escalate_to_human]`, threshold 0.8.
  - **Records Chaser** → queue `roi_outgoing`, tools `[send_fax, send_email, send_sms, place_call, mark_complete, escalate_to_human]`, threshold 0.7.

---

## lib/ modules

### `lib/llm.ts` — model-agnostic reasoning helper
`reason(input: ReasoningInput): Promise<Decision>` where Decision =
`{action: string, params: object, confidence: number, rationale: string, question?: string}`.
- If `ANTHROPIC_API_KEY` is set **and** agent.model !== 'heuristic': call Anthropic
  Messages API (default `claude-haiku-4-5-20251001`) with a JSON-output prompt.
  Wrap in try/catch — **on any API error, fall back to the heuristic engine.**
- **Heuristic engine (the default, must fully power the demo with no API key):**
  deterministic classification/extraction over `source_text` using regex/keyword
  rules. Sample documents (below) are written so the heuristics work:
  - classify: "REFERRAL" / "referral" keywords → referral; "RELEASE OF INFORMATION",
    "records request", "ROI" → records_request_in; none → unknown w/ confidence 0.3.
  - extract: labeled lines (`Patient:`, `DOB:`, `MRN:`, `From:`, `Reason:`, etc.).
    Confidence scales with how many expected fields were found; the "messy" sample
    omits labels so extraction confidence comes back low.
  - match_patient: against `patients` by name+DOB. Exact name+DOB → 0.97.
    Name only, single hit → 0.85. Multiple hits (the two Maria Garcias) → 0.45
    with `question: "Two patients named Maria Garcia (DOB 1981-03-04 vs 1990-07-22). Which one?"`.
    No hit → 0.2 with question.

### `lib/tools.ts` — the shared tool registry
One typed map `TOOLS: Record<string, ToolDef>`; every execution writes an
`audit_log` row (actor, action, detail incl. params + result + confidence).
Humans (buttons) and agents invoke **the same functions** via
`runTool(toolName, workItemId, params, actor)`.

Tools: `classify_document`, `extract_fields`, `match_patient`,
`verify_requirements`, `advance_stage` (params: queue_key, type),
`send_fax`, `send_email`, `send_sms`, `place_call` (each: create
`outbound_attempts` row with `respond_after = now() + 20–40s` simulated;
set item status `waiting`), `request_more_info`, `mark_complete`,
`escalate_to_human` (params: question → sets queue `human_review`,
assignee `human`, `review_reason`), `resolve_review` (human-only: apply a
correction e.g. chosen patient id, then route onward).

### `lib/workItems.ts` — CRUD + queue queries
List by queue with patient/org joins, get detail (item + audit trail + outbound
attempts), counts per queue.

### `lib/agentRunner.ts` — the supervision loop
`runAgents(): Promise<RunReport>`:
for each enabled agent → fetch up to 5 eligible items in its queue
(`status='open'` or (`status='waiting'` ready to resume), not assignee 'human') →
set `assignee='agent:<id>'` → step the item through the agent's pipeline:
1. Build context (item + extracted so far + agent.instructions + allowed tools).
2. `reason()` → Decision.
3. `decision.confidence >= agent.confidence_threshold` → execute via `runTool`
   (only if tool is in agent.tools) and continue stepping (max ~4 tool calls/run);
   else → `escalate_to_human` with `decision.question ?? rationale`.
Log `[agent.run]` per action. Concurrency-safe enough via the assignee claim.

**Pipelines by queue (encode as the agent-type behavior in the runner):**
- `intake`: classify → extract → match → advance_stage (referral→`referrals`,
  records_request_in→`roi_incoming`; unknown/low conf → escalate).
- `roi_incoming`: verify_requirements (needs matched patient + requested-records
  description + authorization line present) → if complete: send records back via
  requester org's preferred channel (send_fax/send_email) → mark_complete.
  If missing info → request_more_info (outbound to requester) → waiting.
- `roi_outgoing`: handled mostly by the **tick** (chase loop below); the agent
  composes/sends the initial request if a fresh item appears, and when a
  response arrives → mark_complete ("records received").

### `lib/simulate.ts` — the mocked world
- `injectInbound(scenario)`: creates a work item in `intake` from a canned
  document. Scenarios (store full texts in `lib/sampleDocs.ts`):
  1. `fax_referral_clean` — well-labeled cardiology referral fax for a seeded patient.
  2. `fax_roi_clean` — well-labeled ROI request fax (org requests records for a seeded patient, includes authorization line).
  3. `fax_ambiguous_patient` — referral for "Maria Garcia" with **no DOB** → two-candidate match → Human Review.
  4. `fax_messy` — unlabeled, garbled OCR-ish text → low classify/extract confidence → Human Review.
  5. `dm_records_request` — structured direct message (clean JSON-ish payload) → sails through, demonstrating same pipeline / higher confidence on clean input.
  6. `fax_roi_missing_auth` — ROI request without authorization → ROI agent fires request_more_info outbound.
- `tick()`: advances the world; **must be idempotent and safe to call every few seconds**:
  1. Outbound attempts where `status='sent'/'awaiting_response'` and
     `respond_after <= now()`: if target org's `contact.simulation = 'no_response'`
     → `timed_out`; else → `responded` with a canned response (e.g. records
     received confirmation; for request_more_info → the missing field arrives and
     gets merged into extracted_data, item back to `open`).
  2. **Chase escalation** for `roi_outgoing` items with a timed-out attempt:
     next attempt on next channel in `[fax, email, sms, voice]` (attempt_no+1);
     after voice times out → escalate_to_human("No response after 4 attempts
     across fax/email/SMS/voice — call them or close?").
  3. `runAgents()`.
  Return a report of everything that happened (UI shows it as an activity feed).

## API routes (thin, under `app/api/`)

- `GET /api/queues` — queues + item counts.
- `GET /api/work-items?queue=` — list w/ joins; `GET /api/work-items/[id]` — detail (item, audit, attempts, patient candidates if review).
- `POST /api/work-items/[id]/actions` — `{tool, params}` executed as actor 'human'.
- `GET|POST /api/agents`, `PATCH /api/agents/[id]` — agent config CRUD.
- `POST /api/roi` — compose outgoing ROI: `{patientId, orgId, recordsRequested, channel?}` → creates `roi_outgoing` item + first outbound attempt (uses org preferred channel unless overridden).
- `POST /api/simulate/inbound` — `{scenario}`.
- `POST /api/simulate/tick` — runs tick, returns report.
- `GET /api/activity?limit=30` — recent audit_log joined to items (the live feed).

## UI (App Router pages, polling every 4s — no Realtime, no new UI deps; match the existing portal's plain-React + inline-style aesthetic; add nav links in `app/layout.tsx`)

- `/queues` — board: card per queue (count, badge color), live activity feed,
  **simulate panel**: one button per scenario + "Tick now" + auto-tick toggle
  (when on, the page POSTs /api/simulate/tick every 5s — this is what makes
  agents/world advance during a demo).
- `/queues/[key]` — item table (created, type, channel, patient, status,
  confidence summary, assignee) + per-row quick actions; Human Review rows show
  `review_reason` prominently with resolution controls (e.g. pick between
  patient candidates → `resolve_review`).
- `/items/[id]` — left: source document (monospace fax rendering) + extracted
  data + confidence chips; right: audit timeline (actor, action, rationale,
  confidence, time) + outbound attempts (channel icons, attempt #, status,
  response) + manual tool buttons (the same tools, human-invoked).
- `/roi/new` — compose outgoing ROI request: patient picker (seeded patients),
  org picker (existing directory search), records-requested textarea, channel
  override; submit → redirects to the created item.
- `/agents` — list + create/edit form: name, queue select, tool checkboxes,
  instructions textarea, threshold slider (0–1), model select
  (`heuristic` | `claude-haiku-4-5`), enabled toggle.

## Acceptance criteria (the four demo flows — each must work via UI and be verifiable via curl)

1. **Inbound fax intake:** inject `fax_referral_clean` → within 2 ticks the item
   is classified `referral`, patient matched ≥0.9, routed to Referrals queue,
   full audit trail visible. Inject `fax_ambiguous_patient` and `fax_messy` →
   both land in Human Review with their *specific* questions; resolving the
   Maria Garcia choice routes the item onward.
2. **Incoming ROI:** inject `fax_roi_clean` → ROI agent verifies, sends records
   back via requester's preferred channel (visible outbound attempt), marks
   complete. Inject `fax_roi_missing_auth` → agent fires request_more_info;
   the simulated reply arrives on a later tick; agent then completes.
3. **Outgoing ROI + chase loop:** compose via /roi/new to the "never answers"
   org → fax times out → email → SMS → voice → Human Review escalation, all
   visible as numbered attempts. To a responsive org → response arrives →
   item completes ("records received").
4. **Agent builder:** edit Intake Agent threshold to 0.99 → previously-clean
   faxes now escalate to Human Review (shadow-mode story); create a new agent
   via the form and see it act on the next tick.

## API contract (pinned — UI and routes are built in parallel against these exact shapes)

All responses are `{data: ...}` on success, `{error: {message}}` with non-200 on
failure. API uses camelCase; DB uses snake_case (map in `lib/`).

```
GET  /api/queues
  → {data: [{key, name, description, sortOrder, count}]}

GET  /api/work-items?queue=<key>
  → {data: WorkItemSummary[]}
  WorkItemSummary = {id, type, queueKey, status, sourceChannel, createdAt,
    updatedAt, assignee, reviewReason, confidence, extractedData,
    patient: {id, firstName, lastName, dob, mrn} | null,
    org: {id, name} | null}

GET  /api/work-items/<id>
  → {data: {item: WorkItemSummary & {sourceText, agentState},
            audit: [{id, actor, action, detail, createdAt}],
            attempts: [{id, channel, attemptNo, status, toContact, payload,
                        response, respondAfter, createdAt}],
            patientCandidates: [{id, firstName, lastName, dob, mrn}]}}
  (patientCandidates non-empty when the item is in human_review over an
   ambiguous patient match)

POST /api/work-items/<id>/actions   body {tool, params}
  → {data: {ok: true, result}}

GET  /api/agents → {data: Agent[]}
POST /api/agents   body {name, queueKey, instructions, tools,
                         confidenceThreshold, model, enabled} → {data: Agent}
PATCH /api/agents/<id>  (partial body) → {data: Agent}
  Agent = {id, name, queueKey, enabled, instructions, tools,
           confidenceThreshold, model, createdAt}

GET  /api/patients → {data: [{id, firstName, lastName, dob, mrn}]}

POST /api/roi   body {patientId, orgId, recordsRequested, channel?}
  → {data: {workItemId}}

POST /api/simulate/inbound   body {scenario}
  → {data: {workItemId, queueKey}}

POST /api/simulate/tick
  → {data: {events: [{itemId, actor, action, summary}]}}

GET  /api/activity?limit=30
  → {data: [{id, workItemId, actor, action, detail, createdAt}]}
```

Existing `GET /api/organizations?q=` is reused for the org picker.

## Non-goals (MVP)

Auth (portal stays open), real channel I/O, real OCR, Supabase Realtime,
metering, RLS, the external-provider portal (Wave 2).
