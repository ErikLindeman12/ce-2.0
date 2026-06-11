# Prompt for fresh Fable session — event-driven low-code agent platform

ultracode

## Who you are and how to work

You are rearchitecting an existing, working prototype into its real form. Work in the repo at `/Users/eriklindeman/Development/CE 2.0` (note the space — always quote the path). You have ultracode opted in: use the Workflow tool and/or agent teams to parallelize aggressively — but **only in Phase 2**. Phase 1 is thinking, and I review it before you build anything.

**Phase 1 (do this first, then STOP and wait for my review):** propose the exact primitives for the architecture described below. Reading code, reading docs, and web research are fine in Phase 1 (research LangGraph / LangGraph Studio, LangFlow, n8n, and Epic's Agent Factory + Workqueue concepts for low-code agent-builder ergonomics — especially how they model loops, branches, state, and human-in-the-loop interrupts). No file edits, no migrations, no builds.

**Phase 2 (only after I approve the primitives):** build in waves — spec-first, parallel subagents with strictly disjoint file ownership, and YOU verify everything end-to-end (curl + browser screenshots) before shipping each wave. The four existing demo workflows must keep working at every step. Ship = push to main (Vercel auto-deploys).

## What exists today (read before proposing anything)

A Next.js 14 + Supabase prototype, live at https://ce-2-0.vercel.app, that already demos four workflows well: (1) outgoing records requests with rendered fax/secure-email/voice artifacts, org-capability channel plans, a configurable retry/escalation ladder, and an Epic↔Epic "Care Everywhere" instant structured tier; (2) inbound intake (fax/direct-message/phone-transcript/portal) → classify → extract (per-field confidence + source-line provenance) → patient match → route, with a human-review workbench; (3) incoming records-request fulfillment incl. request-more-info round trips; (4) a low-code agent builder: per-agent allowed-tools (the tool list IS the policy via a generic planner), confidence thresholds, shadow/supervised/autonomous modes with propose→approve/reject, per-agent stats. Plus: a provider portal where external orgs submit requests and track status, and a persona switcher (central "Network Console" vs external org's portal view).

Read in order: `CLAUDE.md`, `docs/architecture.md` (invariants — they still bind), `docs/workqueue-mvp.md`, `docs/workflow1-outgoing-roi.md`, `docs/workflow1b-revision.md`, `docs/workflow2-intake.md`, `docs/wave3-spec.md`, `docs/demo-script.md`, then skim `lib/` (especially `agentRunner.ts`, `llm.ts`, `tools.ts`, `simulate.ts`, `outbound.ts`).

## The vision to architect for

Today's limitation: agents are bound to queues, and workflow knowledge (what a "complete" item is, what happens next) is still partly baked into engine code. The real product is a **general substrate**:

- **Standard trigger points for key events** — document received, document classified, referral identified, response received, SLA/timer elapsed, human decision made, etc. A first-class event primitive.
- **Low-code agents that subscribe to trigger points** — an agent doesn't know or care about work queues. Its contract is roughly: *"when an event I care about fires, I get the case context; I do my steps (possibly loops — e.g. try calling, wait, try again); I can use tools (send fax/email/SMS, place call, structured exchange, split/rotate documents, extract, match); I can read/write durable per-case state ('already called once for this referral'); and I finish by calling an API — report_result, request_human_review(question), or emit_event."*
- **Work queues as the universal human↔agent interface** — queues are materialized routing of events/results, not things agents manipulate directly. A routing layer decides what lands where (the document-classifier agent says "this is a referral" → the router plops it into the referrals queue → a referral agent subscribed to "referral identified" picks it up → its exceptions land in a human review queue). Work queues are how *everyone* supervises the agents automating everything.
- **Composability is the entire sell.** The pitch is NOT "look how well we automated ROI." It is: *"Epic already has most of these parts — Workqueue framework, Agent Factory (low-code AI agents), In Basket, interop rails. We just need to string them together a little more and let customers/TS build crazy workflows in a low-code environment without waiting on Epic dev for every last thing."* Records release is merely the worked example; incoming referrals, document splitting/rotation, message categorization, outreach-and-escalate, prior auth chasing must all be expressible as: pick trigger points + configure agents + name the queues. Zero engine changes.
- **Epic stubbing:** this prototype runs on my personal machine because I have Fable here and not at work. Everything I build must transfer as an *argument*: each primitive needs a clean interface with an explicit mapping to its Epic equivalent (work queue ↔ Epic Workqueue framework, low-code agent ↔ Agent Factory, event ↔ Epic trigger/interconnect points, channel adapters ↔ comms infrastructure, portal ↔ external-facing surfaces) so any piece can be stubbed in/out. The prototype proves the wiring and the low-code experience, not the infrastructure.

## Phase 1 deliverable — the primitives proposal (what I will review)

Present, concisely (a doc + one diagram, no code):

1. **The primitive set** — entities and their exact responsibilities: Event/Trigger, Case (durable work item + state), Agent Definition (low-code config: subscriptions, instructions, tools, state schema, mode, gates), Tool Registry, Router (event/result → queue placement rules), Work Queue (human surface), Completion API (the only way agents end a turn: report_result / request_human_review / emit_event). Be precise about what each does NOT do — decoupling is the point (agents never touch queues; queues never run logic).
2. **The event taxonomy** — the standard trigger points, and how new ones get added without engine changes.
3. **The agent contract** — the exact API an agent runs against (context in, tools available, state get/set, completion calls out), and how loops/waits/retries are expressed in the low-code model. Compare explicitly to LangGraph's graph/state/interrupt model and say what you're borrowing and what you're simplifying — keep our deterministic-heuristic + optional-LLM dual engine.
4. **The Epic mapping table** — prototype concept → Epic equivalent → what the stub interface looks like → what I'd say to claim "Epic already has this."
5. **Migration sketch** — how today's code maps onto the new primitives: what generalizes, what gets deleted, what the four existing demos look like re-expressed as trigger subscriptions + agent configs (they must be expressible purely as configuration when this is done — that's the acceptance test of the architecture). Flag the riskiest refactors.
6. **A "new workflow in 60 seconds" demo design** — the live moment where I stand up automation for a queue that was previously a human to-do pile, entirely in the builder, shadow-mode first.

Then STOP and ask for my review. Iterate on the primitives with me before any Phase 2 work.

## Phase 2 expectations (after approval)

- Waves of parallel subagents (or Workflow-tool pipelines), each with a written spec doc in `docs/` pinning contracts and file ownership before spawning. You verify each wave E2E yourself: scripted curl acceptance runs AND browser screenshots, plus regression of all existing demo flows, before committing.
- Keep the deterministic heuristic engine as the default reasoning path (demos must work with no API key); the Anthropic path stays behind each agent's `model` field.
- Update `docs/demo-script.md` per wave; log shipped milestones as Done issues in Linear (team "CE 2.0", project "Phase 1 — PoC", relate to CE-35…CE-38).
- Commit style: descriptive message + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Operational survival guide (learned the hard way — trust this)

- **Supabase free tier pauses the DB after ~1 week idle** (project `mmvjptmuazcamuduhyzz`). Symptom: confusing connection timeouts everywhere, including Supabase's own Management API. Check status / restore first whenever anything fails: `POST https://api.supabase.com/v1/projects/mmvjptmuazcamuduhyzz/restore`, wait ~2 min.
- Supabase access token: macOS keychain `security find-generic-password -s "Supabase CLI" -w`, strip the `go-keyring-base64:` prefix and base64-decode. Run SQL/DDL via the Management API: `POST https://api.supabase.com/v1/projects/<ref>/database/query` with `{"query": "..."}` (the CLI's `db query --linked` only works while the project is awake). Migrations must be idempotent (`IF NOT EXISTS`) because CI re-applies them on merge.
- `vercel env pull` returns EMPTY strings for the sensitive Supabase vars — fetch the service-role key via Management API `/api-keys?reveal=true` and write `.env.local` (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) yourself.
- `lib/supabase.ts` pins `cache: 'no-store'` on the client's fetch — Next's Data Cache silently serves stale Supabase reads in route handlers without it. Never remove.
- Dev server lands on **port 3001** (3000 is occupied). If API routes start returning HTML or `MODULE_NOT_FOUND ./vendor-chunks/...`: stale `.next` corruption — stop the server, `rm -rf .next`, restart. Run `pnpm build` only while the dev server is stopped.
- App Router route files may export ONLY handlers — shared helpers go in `lib/` (a stray export breaks `next build`, not typecheck).
- Deploy = push to main. Reset demo data with `truncate audit_log, outbound_attempts, work_items;` (preserves patients/orgs/queues/agents seeds).
- Subagents will cross file-ownership lines and test against the shared dev server if you let them — pin ownership per file in every spawn prompt, forbid git/DB/server operations by subagents, and treat their "done" reports as claims to verify, not facts.
