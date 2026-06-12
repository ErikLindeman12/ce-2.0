# CE 2.0 — Event Substrate Spec (Phase 2 source of truth)

> The approved rearchitecture: **things that happen become events; agents react to
> events; the Router decides what humans see.** This doc pins schema, module
> contracts, the low-code config DSL, and engine invariants. Subagents implement
> against THIS document — if something here conflicts with older docs, this wins.
> Older invariants in [architecture.md](architecture.md) (one app, server-side
> Supabase, append-only migrations, logic in lib/, thin routes) still bind.

## 0. Model in three sentences

1. Every meaningful occurrence — fax arrived, doc classified, response received,
   timer elapsed, human decided — is an **event** row in an append-only log.
2. **Agents** are pure config (subscriptions + instructions + tool allowlist +
   thresholds + mode + named policies); they wake in **turns** when a subscribed
   event is delivered, call tools (which auto-emit events), and end with exactly
   one of: `report_result` / `request_human_review` / `emit_event` / `wait`.
3. The **Router** (config rules) is the only writer of queue placement; **work
   queues** are configurable human surfaces; human actions emit events back into
   the same loop.

## 1. Schema (migration `20260612*_event_substrate.sql`, idempotent, additive)

```sql
events: id uuid pk, seq bigserial (ordering), type text, case_id uuid null fk work_items on delete cascade,
  payload jsonb {}, actor text, caused_by_event_id uuid null, depth int 0,
  deliver_at timestamptz null (null=immediate, future=durable timer), delivered_at timestamptz null,
  dedupe_key text unique null, created_at
  -- index (delivered_at, deliver_at), index (case_id)
event_deliveries: id uuid pk, event_id fk cascade, agent_id fk agents, case_id uuid null fk cascade,
  status text 'pending'|'running'|'done'|'shadowed'|'skipped', turn_id uuid null, claimed_at timestamptz null,
  created_at, unique(event_id, agent_id)
review_requests: id uuid pk, case_id fk work_items cascade, agent_id fk agents null,
  kind text 'approval'|'question'|'exception', question text, proposal jsonb null
  ({action,params,confidence,rationale,state_version}), candidates jsonb null, options jsonb null,
  queue_key text null (router-written), status text 'pending'|'answered'|'void',
  answer jsonb null, answered_by text null, created_at, answered_at null
routing_rules: id uuid pk, event_type text, filter jsonb {}, queue_key fk work_queues,
  priority int 100 (lower wins, first match), owner text, enabled bool true, created_at
event_types: type text pk, description text, hidden bool false
agents: + subscriptions jsonb '[]', + owner text null
work_items: + state_version int 0, + claimed_at timestamptz null
outbound_attempts: + kind text null ('records_request'|'records_response'|'request_more_info'), + dedupe_key text unique null
work_queues: + kind text 'work' ('work'|'review'), + config jsonb '{}' ({theme, columns:[...]})
audit_log: + turn_id uuid null, + delivery_id uuid null
```

Demo reset becomes: `truncate audit_log, outbound_attempts, event_deliveries, events,
review_requests, work_items;` — **never** truncate work_queues / routing_rules /
event_types / agents (the workflows now LIVE in those tables).

## 2. TS types (lib/types.ts — written in W0, frozen for the wave)

```ts
export interface EventRow { id; seq; type; case_id; payload; actor; caused_by_event_id; depth; deliver_at; delivered_at; dedupe_key; created_at }
export interface EventDelivery { id; event_id; agent_id; case_id; status: 'pending'|'running'|'done'|'shadowed'|'skipped'; turn_id; claimed_at; created_at }
export interface ReviewRequest { id; case_id; agent_id; kind: 'approval'|'question'|'exception'; question; proposal; candidates; options; queue_key; status: 'pending'|'answered'|'void'; answer; answered_by; created_at; answered_at }
export interface RoutingRule { id; event_type; filter; queue_key; priority; owner; enabled }
export interface AgentSubscription {
  event_type: string;
  filter?: Record<string, unknown>;          // equality match against event.payload.* plus special keys case_type (case.type), source_channel
  on_event?: {                                // applied atomically BEFORE the turn
    merge_payload?: { from: string; to: string }[];  // from: 'payload.x.y'; to: 'extracted.z' | 'state.z'
    set_state?: Record<string, unknown>;             // value '$payload.x' interpolates from event payload
    clear_state?: string[];
  };
}
export type CompletionVerb = 'report_result'|'request_human_review'|'emit_event'|'wait';
// Decision.action: ToolName | CompletionVerb  (mark_complete/escalate_to_human/advance_stage REMOVED from agent vocabulary)
export interface ToolDef { description; effect: 'annotate'|'external'; execute(workItemId, params, actor, ctx?: ToolCtx): Promise<ToolResult> }
export interface ToolCtx { turnId?: string; deliveryId?: string; event?: EventRow }
```

Predicate DSL (used by `complete_when`, `requirements`):
```ts
type Pred = { path: string;            // 'state.x' | 'extracted.x' | 'case.type' | 'case.matched_patient_id'
  op: 'eq'|'neq'|'exists'|'absent'|'matches'|'not_matches'|'in'; value?: unknown };
type Cond = { all?: Pred[]; any?: Pred[] };
```

Agent `config` named policies (all optional — presence gates the planner skill):
```ts
config: {
  chase_policy?: { steps: string[]; waitSeconds: number; on_exhausted?: { question?: string } };
  requirements?: { flag: string; path: string; op; value?; and?: Pred[];
                   on_missing?: { message?: string; max_requests?: number } }[];
  send_policy?: { document_kind: 'records_response'|'records_request'; set_flag?: string;
                  when?: Cond };
  complete_when?: { when: Cond; outcome: { result: string; note?: string } }[];  // {{state.x}}/{{case.id8}} templates in note
  classify_rules?: { matches: string; type: string }[];   // extends builtin keyword map
}
```

## 3. Module contracts & file ownership

| Module | Owns | Contract |
|---|---|---|
| `lib/events.ts` (W0, Claude) | emit + register | `emitEvent({type, caseId?, payload?, actor, causedBy?, depth?, afterSeconds?, dedupeKey?}): Promise<EventRow|null>` — inserts event (dedupe_key conflict → returns existing, no error), upserts event_types. NEVER throws on dedupe conflict. |
| `lib/caseState.ts` (W0, Claude) | versioned case state | `mergeCaseState(caseId, {set?, clear?, mergeExtracted?}, expectedVersion?)` — single UPDATE with jsonb merge + `state_version = state_version + 1`, optional `WHERE state_version = expected` (returns {ok, version}). All agent_state writes go through this. |
| `lib/dispatcher.ts` (W1-A) | the pump | `pumpEvents({maxRounds?=3, deadlineMs?=8000}): Promise<PumpReport>` — (1) lease sweep: work_items in_progress + assignee like 'agent:%' + claimed_at < now-60s → release; deliveries running→pending. (2) deliver due events (`delivered_at is null and (deliver_at is null or deliver_at <= now)` ordered by seq, optimistic stamp `where delivered_at is null`): for each, run Router placement, insert delivery rows for matching enabled-agent subscriptions (status pending; skip if case status='done' unless filter opts in), refuse depth>16 → exception review_request instead. (3) run pending deliveries FIFO per case (order by event seq; one at a time per case; claim delivery pending→running, claim case via existing assignee idiom incl. claimed_at; claim failure → delivery back to pending, retry next pump/tick). Loops rounds until quiescent, maxRounds, or deadline. Called by tick AND inline by emitting API routes. |
| `lib/router.ts` (W1-A) | placement | `routeEvent(event)` — first matching enabled rule by priority: `update work_items set queue_key=rule.queue_key where id=case_id`; emit `case.routed` (case.routed itself is NEVER routed/subscribed — cycle guard). Built-in: event `case.moved {to}` → place to payload.to (powers the manual move button). Also stamps review_requests.queue_key when event_type='review.requested'. The ONLY queue_key writer. |
| `lib/simulate.ts` (W1-A) | world-sim only | tick() = resolve due attempts EVENT-FIRST (emit `response.received`/`attempt.timed_out` with dedupe_key `attempt:{id}:{outcome}`, THEN update attempt status guarded `where status in ('sent','awaiting_response')`) + `pumpEvents()`. Chase loop DELETED (Chaser agent owns it). injectInbound: create case + emit `document.received`. buildSimulatedResponse keyed on `attempt.kind` + channel (care_everywhere → C-CDA; request_more_info → authorization), NOT queue_key. Keep: portal-originated request_more_info never auto-answered (case.source_channel='portal' + attempt.kind check); care_everywhere always responds, never times out; org contact.simulation='no_response' → timed_out (+voice no-answer outcome response). Done-case responses still emitted; dispatcher skips delivery to done cases. |
| `lib/tools.ts` (W1-B) | tool registry | Every tool gets `effect` + accepts `ctx`. AUTO-EMIT (via lib/events.ts, causedBy ctx.event, actor preserved): classify_document → `document.classified {as, confidence}` (also reads agent classify_rules via params); extract_fields → `fields.extracted {fieldCount}`; match_patient → `patient.matched {patientId, confidence}` on success; send_* / request_more_info → `attempt.created {attemptId, channel, kind}` (info only). NEW TOOLS: `send_care_everywhere` (renders C-CDA query, attempt kind records_request channel care_everywhere respond_after now+8s), `send_voice` (alias of place_call — fixes the UI ghost button). Send tools: set attempt.kind (records_response iff params.state_flag==='records_sent' else records_request; request_more_info → request_more_info), set dedupe_key from ctx (`${deliveryId}:${tool}:${attemptNo}`) — on unique conflict return existing attempt as success; write state via mergeCaseState ({attempt_no:+1, last_channel}, plus state_flag); derive SECOND REQUEST framing from the case's latest timed_out attempt (no chase context plumbing). REMOVED from agent vocabulary: advance_stage, mark_complete, escalate_to_human (human/manual paths preserved — see lib/reviews.ts + case.moved). approve_action/reject_action/resolve_review move to lib/reviews.ts. effect map: classify/extract/match/verify=annotate; all sends/request_more_info=external. verify_requirements becomes a generic predicate evaluator over agent config.requirements → writes state.requirements {flag:bool} + confidence.verify. |
| `lib/llm.ts` (W1-C) | planner | `reason(input)` interface UNCHANGED; ReasoningInput gains optional `event`. heuristicDecision becomes the GENERIC SKILL LIBRARY, each skill gated only on (tools ∩ config-presence ∩ state predicates ∩ event type) — NEVER on case.type/queue_key literals: S0 complete_when (evaluate FIRST → report_result w/ templated note); S1 classify if no confidence.classify (uses agent config.classify_rules + builtin map); S2 extract; S3 match if no matched_patient_id (questions preserved verbatim); S4 verify if config.requirements present and state.requirements absent; S5 request-missing if a requirement failed && !state.more_info_sent (message from on_missing.message; if on_missing.max_requests exceeded → request_human_review); S6 send-per-send_policy if config.send_policy, when-cond passes, set_flag unset → pickSendTool(channel) with params.state_flag; S7 ladder if config.chase_policy: init state.chase_plan from config+org if absent (buildChannelPlan), cursor=state.attempt_no||0, next step exists → send via pickSendTool(steps[cursor]) (care_everywhere→send_care_everywhere); response_received? S0 catches it; steps exhausted → request_human_review(on_exhausted.question || 'No response after N attempts (steps) — call them or close?'); S8 wait. LLM path: serialize named policies into system prompt; output Decision may use completion verbs. Keep classifyHeuristic/extractHeuristic/matchPatientHeuristic sub-engines + confidences verbatim. |
| `lib/agentRunner.ts` (W1-D) | turns | `runDeliveryTurn(delivery, event, agent)` (called by dispatcher): apply subscription.on_event via mergeCaseState; loop ≤4: reason() → confidence gate (decision.confidence < threshold → completion request_human_review using decision.question) → MODE GATE AT THE BOUNDARY: shadow → audit 'shadow_decision' (incl. would-be completion), mark delivery 'shadowed', release case, END (executes NOTHING — fixes the old leak); supervised + (tool.effect==='external' OR completion report_result) → create review_request kind 'approval' (proposal incl. state_version) + emit review.requested, release case, END; else runTool(..., ctx). Completion handling: report_result → status 'done' + emit `case.completed {result}`; request_human_review → insert review_request (kind question/exception, candidates from decision) + emit `review.requested {reviewId, kind}`, release case (assignee unassigned — review row is the human-side lock, one pending review per (case,agent)); emit_event → emitEvent(depth+1); wait → noop. Mark delivery done; audit rows carry turn_id+delivery_id. Old runAgents() poll loop DELETED. |
| `lib/reviews.ts` (W1-D) | human decisions | `answerReview(reviewId, answer, actor)`: kind approval+approve → fences (proposal.state_version === case.state_version else void+emit re-trigger; tool still in agent.tools; agent enabled) → execute proposal via runTool as `human(approved:<agent>)` → answered + emit `human.decided`. approve+reject → answered + create kind 'exception' review ('Proposed X rejected — handle manually'). kind question (workbench resolve): apply {fields, patientId} via mergeCaseState/extracted merge + re-match if patient fields changed w/o id; if type confirmed/changed → emit `document.classified {as, confidence:1}` as actor human (Router routes it — replaces the old hardcoded resolve routing map); answered + emit `human.decided` (delivery targeted at requesting agent_id only). |

W2 owners: routes agent (app/api/roi, simulate, work-items actions→reviews, agents PATCH w/ shadow-replay, NEW app/api/events + event-types + routing-rules + reviews), portal agent (lib/portal.ts + portal routes), workItems agent (lib/workItems.ts mappers: synthesize agentState.pending_approval + review_reason + patientCandidates from pending review_requests; by-queue for kind='review' queues = cases joined on pending review_requests.queue_key). seed.sql: Claude.
W3 owners: builder agent (app/agents/page.tsx), queues agent (app/queues/*), item agent (app/items/[id] minimal + portal page check).

## 4. Engine invariants (every implementer must preserve)

> **As-built amendments (E2E-verified):**
> - **One rung per turn:** a tool that parks the case in `waiting` (sends,
>   request_more_info) ends the turn — the next world event re-activates the
>   agent. Without this a chase ladder fires every rung in one turn.
> - **Review placement is a routing rule, not a view:** `review.requested →
>   human_review` physically routes the case (Router-owned, still pure config);
>   return-to-origin is derived from the case's `case.routed` history (latest
>   non-review queue), NOT the creation-time snapshot — a review opened mid-turn
>   races the same turn's classification routing.
> - **`human.decided` re-activates the requesting agent** via a targeted
>   delivery; an approved send + re-activation lets `complete_when` close the
>   case in the same pump.

1. Deliveries are at-least-once; external effects are idempotent (attempt dedupe_key) → effectively-once.
2. One in-flight turn per case (assignee claim + claimed_at lease; sweep only releases stale AGENT claims, never 'human').
3. Claim failure never consumes an event — delivery stays pending.
4. Subscriptions match only cases with status open|waiting (done-case guard).
5. depth>16 or >10 turns/case/min → exception review_request, not execution.
6. Shadow executes nothing, marks deliveries 'shadowed'; mode flip re-pends them (in agents PATCH).
7. Approve executes the stored proposal verbatim behind state_version + allowlist fences.
8. Router is the only queue_key writer. Agents/tools never touch queue_key/status('done' only via report_result)/assignee(runner only).
9. Heuristic-only operation (no API key) fully works; every optimistic-guard UPDATE pattern survives double-tick (two tabs).
10. All four demo beats + portal flow keep working at every committed wave; API envelope/shapes preserved (?queue=key, item.queue_key, camelCase mappers); state keys chase_plan/attempt_no/last_channel/extraction_meta frozen.

## 5. Seed config (W2 — the demos as data)

event_types: the taxonomy. routing_rules: document.received→intake(100); document.classified{as:referral}→referrals(100); document.classified{as:records_request_in}→roi_incoming(100); document.classified{as:prior_auth}→prior_auth(100); review.requested→human_review(100).
work_queues: + prior_auth ('Prior Auth', kind work); human_review gets kind 'review'.
Agents (subscriptions + policies; thresholds/tools/instructions kept):
- Intake Agent: subs [document.received]; tools classify/extract/match; classify_rules incl. prior_auth.
- ROI Fulfillment Agent: subs [document.classified{as:records_request_in}, response.received{case_type:records_request_in} w/ on_event merge authorization→extracted + clear requirements + set response_received]; requirements (has_patient/has_records/has_auth w/ not_matches 'to follow', on_missing message + max_requests 2); send_policy {document_kind records_response, set_flag records_sent, when all_requirements}; complete_when state.records_sent.
- Records Chaser: subs [case.created{case_type:records_request_out}, attempt.timed_out{case_type:records_request_out} w/ on_event noop, response.received{case_type:records_request_out} w/ on_event set response_received+last_channel]; chase_policy (existing); complete_when state.response_received → 'records_received' note 'Records received via {{state.last_channel}}'.
- Auth Chaser (NEW, mode shadow): subs [document.classified{as:prior_auth}, attempt.timed_out{case_type:prior_auth}, response.received{case_type:prior_auth} w/ set response_received]; chase_policy {steps:[fax,fax,voice], waitSeconds:30}; complete_when response_received → 'auth_received'.
sampleDocs: + fax_prior_auth scenario.

## 6. Acceptance (per wave, verified by Claude before commit)

curl: inject fax_referral_clean → pump → lands referrals w/ document.received/classified/case.routed events. fax_ambiguous_patient → review_request kind question w/ candidates → answer → routed. ROI compose UCSF → rung1 inline → tick past timeouts → rung2 SECOND REQUEST → voice no-answer → exhausted → review 'call them or close?'. ROI Cleveland → care_everywhere attempt → ~8s → C-CDA response → case.completed. Portal submit w/o auth → request_more_info attempt → action_needed → attach auth → response.received → records_response → completed. Supervised: proposal review → approve executes / unchecking tool → reject w/ reason. Shadow: deliveries shadowed, nothing executes; flip mode → replay. Prior-auth: inject → classify prior_auth → routed prior_auth queue → Auth Chaser (shadow) shadows the rung-1 send; flip live → fax renders.
Browser: screenshots of queues board, item detail w/ events timeline + review banner, builder w/ subscriptions, portal.
