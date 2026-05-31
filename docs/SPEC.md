# CE 2.0 — Platform Spec

## Vision

Epic is the system of record for the majority of US healthcare. The patient, provider, and organization identity layer already exists. The clinical data already exists. What doesn't exist is a clean, developer-accessible API surface over the coordination layer — referrals, scheduling, directory, communications, care transitions.

CE 2.0 makes that surface real. It is a metered API platform that lets any developer — whether building an Epic integration, a standalone healthcare app, or an AI agent — access healthcare coordination workflows through a single, well-designed API. Epic provides the identity and data. CE 2.0 provides the platform.

The model is Stripe for healthcare. Every referral sent, every directory lookup, every workflow triggered flows through the platform. Epic takes a metered cut. Third parties build on top. Epic's own products compete in the same marketplace — and win on merit, not lock-in.

---

## Guiding Principles

**1. Don't expose what you can't already get.**
The platform does not open core clinical documentation, billing records, or anything beyond USCDI / existing public interfaces. This is not a data exposure play. It is a coordination layer play.

**2. Developer-first.**
Every capability is accessible via clean REST API with SDKs, a CLI, and an MCP server. A provider's assistant should be able to manage referrals from Claude the same way they'd manage them from the portal.

**3. Agent-native.**
Structured responses, consistent identifiers, predictable pagination, webhook-first notifications. Every endpoint is designed to be called by an AI agent, not just a human.

**4. Platform, not monopoly.**
Epic's first-party apps (portal, patient chart) compete in the same ecosystem as third-party apps. The API is not artificially restricted to favor Epic products. The business model is platform fees, not captive distribution.

**5. Scoped access.**
Tokens carry explicit scopes. A third-party app that needs to read referrals cannot send them. A patient can grant an app read access to their referral history without granting org-level admin. This is table stakes for developer trust.

---

## Platform Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Access Layer                          │
│   Web Portal     CLI (ce2)     MCP Server     3rd Party Apps │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                      Platform Core                           │
│   Auth / OAuth    API Gateway    Metering    Webhooks        │
└───────────────────────────┬─────────────────────────────────┘
                            │
        ┌───────────────────┼────────────────────┐
        │                   │                    │
┌───────▼──────┐   ┌────────▼──────┐   ┌────────▼──────┐
│  Directory   │   │  Referrals    │   │  (Future)     │
│  orgs        │   │  send         │   │  Scheduling   │
│  providers   │   │  receive      │   │  Messaging    │
│  patients    │   │  route        │   │  Prior Auth   │
│  locations   │   │  notify       │   │  ...          │
└──────────────┘   └───────────────┘   └───────────────┘
```

---

## Module Specs

### 1. Auth & API Access

**What it is:** Epic OAuth integration with scope-based tokens, plus API key management for non-interactive (machine-to-machine) access.

**Token types:**
- `user_token` — issued via OAuth, tied to a specific Epic user (provider, patient, staff). Carries identity and org context.
- `org_token` — issued to an org-level integration. Scoped to org resources.
- `api_key` — static key for server-to-server use. No user context. Rate-limited.

**Scopes (examples):**
```
referrals:read         — view referrals for the authed user/org
referrals:send         — submit new referrals
referrals:manage       — update status, assign, close
directory:read         — search orgs, providers, patients
directory:admin        — add/edit directory entries (Epic internal)
notifications:manage   — configure notification preferences
```

**Access patterns:**
- Web Portal: Epic OAuth implicit flow
- CLI: OAuth device flow (`ce2 auth login` → opens browser)
- MCP Server: API key passed via environment variable
- 3rd Party App: standard OAuth authorization code flow with PKCE

**What we are NOT building yet:** full Epic OAuth integration (mock for PoC). The shape is correct; the backend is stubbed against a mock identity provider.

---

### 2. Directory

**What it is:** A searchable registry of every entity in the healthcare network — organizations, locations, providers, patients, and what each supports.

**Entities:**
- `Organization` — health system, clinic, payer, pharma company, etc.
- `Location` — physical site within an org (hospital, clinic, pharmacy)
- `Provider` — physician, NP, PA, etc. — includes specialty, NPI, org affiliation
- `Patient` — lightweight identity record linked to Epic MPI (not exposed directly; access requires patient-scoped token)
- `Capability` — what referral types an org/provider accepts, via what channels, with what requirements

**Key endpoints:**
```
GET  /directory/orgs                  — search organizations
GET  /directory/orgs/:id              — get org by ID
GET  /directory/providers             — search providers (by name, specialty, location, NPI)
GET  /directory/providers/:id
GET  /directory/locations
GET  /directory/capabilities?orgId=&type=referral  — what can I send this org?
```

**Search design:** full-text + structured filters. `GET /directory/providers?specialty=cardiology&zip=02115&accepts=referrals` returns ranked results with capability info attached. Designed to power both human search (portal autocomplete) and agent lookup (Claude asking "find me a cardiologist near Boston who accepts referrals from Mass General").

---

### 3. Referrals

**What it is:** A single `POST /referrals` endpoint that accepts a structured referral payload and routes it to the correct receiving channel based on directory capabilities. Handles inbound parsing from fax and Direct.

**Sending a referral:**
```
POST /referrals
{
  "toProviderId": "prov_abc123",       // or toOrgId, toLocationId
  "patientId": "pat_xyz789",
  "type": "consult",                   // consult | procedure | imaging | labs | ...
  "priority": "routine",              // routine | urgent | stat
  "notes": "...",
  "attachments": [...]
}
```

Platform looks up `toProviderId` in directory, checks their capabilities, and routes:
- If target is on CE 2.0: delivers via API + notifies
- If target has Direct address: sends via Direct Secure Message
- If target is fax-only: sends via e-fax
- Caller doesn't need to know which — that's the platform's job.

**Receiving a referral:**
- Inbound fax → OCR + parse → normalize to standard Referral payload → `POST /referrals` internally
- Inbound Direct → parse CDA/FHIR attachment → normalize → route
- Inbound API: any CE 2.0 participant can POST directly

**Referral lifecycle:**
```
draft → sent → delivered → acknowledged → accepted | declined → scheduled → completed | cancelled
```

Each transition is an event. Subscribers receive webhooks. Referral status is always queryable.

**Key endpoints:**
```
POST   /referrals              — send a referral
GET    /referrals              — list (filtered by status, date, from/to)
GET    /referrals/:id          — get referral + full status history
PATCH  /referrals/:id/status   — update status (receiving side)
GET    /referrals/:id/events   — full event log
```

---

### 4. Notifications

**What it is:** The delivery layer for referral events. When a referral status changes, interested parties are notified via their preferred channel.

**Channels:**
- `webhook` — HTTP POST to a registered endpoint (primary for apps/agents)
- `email` — plain or structured
- `sms` — text to provider or staff mobile
- `in_app` — portal notification feed
- `epic_inbox` — In Basket message (Epic-native, future)

**Configuration:**
Each user/org configures notification preferences per event type. "Notify me via SMS when a referral I sent is accepted. Notify my staff via webhook when any inbound referral arrives."

**What agents get:** webhooks are the primary channel for AI agents. An org can register a webhook endpoint and their agent receives structured JSON for every referral event, in real time.

---

### 5. Access Layer

**Web Portal**
Next.js app. Core workflows: search directory, send referral, view referral status, manage notification preferences. This is the human-facing surface — it demonstrates the platform but is not the product.

**CLI (`ce2`)**
```bash
ce2 auth login
ce2 directory search --type provider --specialty cardiology --zip 02115
ce2 referrals send --to prov_abc123 --patient pat_xyz789 --type consult
ce2 referrals list --status pending
ce2 referrals watch   # streams events in real time
```

**MCP Server**
Exposes directory search, referral send/list/update as MCP tools. Claude (or any MCP-compatible agent) can call these natively. A provider assistant running in Claude can manage their entire referral queue via conversation.

---

## Business Model (Noted — Not Built Yet)

Metered API pricing. Every API call is logged with caller identity, token scope, and resource type. Billing is usage-based with a tier structure (like Twilio / Stripe). Epic-internal usage may be excluded or discounted. Third-party apps pay per call or per referral event. Enterprise orgs negotiate flat rates with overages.

This requires: a metering service (log every request), a billing integration (Stripe or similar), and a developer dashboard (usage graphs, invoices, API key management).

---

## What Is Explicitly Out of Scope

- Core clinical documentation (encounter notes, problem lists, medication reconciliation)
- Billing / claims / coding workflows
- Anything that would allow a third party to display or edit the patient chart in a way that competes with Epic's EHR
- Any data exposure beyond USCDI + existing public interfaces

---

## Phase 1 Scope (Proof of Concept)

Goal: demonstrate the end-to-end developer experience well enough to show Epic leadership what this platform feels like.

**Target demo:** A developer (or AI agent) can, in under 10 lines of code or one conversation with Claude:
1. Search the directory for a cardiologist in a given city
2. See that provider's referral capabilities
3. Send a referral — platform routes it correctly
4. Get notified when the referral is accepted

**Phase 1 components:**
1. `auth` — mock Epic OAuth, scoped API keys, token validation middleware
2. `directory` — search across orgs/providers, capability lookup (in-memory seed data)
3. `referrals` — send endpoint with mock routing logic, status updates, event log
4. `notifications` — webhook delivery + email stub
5. `portal` — minimal UI showing the above flows
6. `cli` — `ce2 auth`, `ce2 directory search`, `ce2 referrals send/list`
7. `mcp` — MCP server wrapping directory + referrals

**What makes the PoC compelling:** the MCP demo. Claude asks "find me a cardiologist near Boston who takes referrals from Mass General" → searches directory → returns ranked results → "send a consult referral to Dr. Smith for patient Jane Doe" → referral sent, webhook fires, status tracked. That's the demo.
