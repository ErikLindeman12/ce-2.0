# CE 2.0 — Architecture

The durable source of truth for **what** CE 2.0 is and the **invariants** every
piece of work must obey. Feature designs and Linear issues reference this doc
instead of restating it. If something here is wrong, fix it *here* — don't work
around it in an issue.

Operational how-to (run/test/deploy) lives in [repo-guide.md](repo-guide.md).

## Vision

CE 2.0 is a **metered interoperability platform for healthcare** — "Stripe for
healthcare data exchange." Systems *and* AI agents call a clean, authenticated,
metered API surface to discover providers/organizations, exchange clinical data,
and orchestrate workflows like referrals. The PoC exists to pitch Epic
leadership: show the developer experience and the agent-native story end to end.

The demo we are building toward: **an AI agent, through one MCP tool call,
searches the directory and sends a referral — authenticated with an API key and
metered per call.** That single flow tells the whole story.

## Domain model

- **Organization** — a healthcare entity (hospital/system) with `capabilities`
  (channels it supports, data types it exchanges). *Built.*
- **Provider** — an individual clinician (NPI, specialty) belonging to an org.
  *Built (CE-6): `providers` table, server-side specialty/capability search.*
- **Location** — a physical site for an org/provider. *Planned.*
- **Referral** — a request to send a patient + data to a target org/provider;
  has a status lifecycle and an event log. *Basic version built.*
- **API key / token** — caller identity; exchanged for short-lived scoped
  tokens; supports on-behalf-of (OBO) delegation. *Planned.*
- **Usage event** — one metered unit of API consumption (the billing primitive).
  *Planned.*
- **Consent** — authorization for a data exchange between parties. *Later.*

## System architecture

**One Next.js app, deployed once on Vercel, backed by Supabase Postgres.** There
are no separate services. A "component" below is a route group + a `lib/` module
+ (if needed) tables — never a standalone server.

```
                 ┌────────────────────────────────────────────┐
   callers  ───> │  Next.js app on Vercel (ce-2-0.vercel.app)   │ ──> Supabase
   (browser,     │                                              │     Postgres
    agent/MCP,   │  app/api/*  route handlers  (the API surface)│
    CLI)         │  app/*      portal UI                        │
                 │  lib/*      shared logic, types, db client   │
                 │                                              │
                 │  cross-cutting: auth middleware, metering    │
                 └────────────────────────────────────────────┘
```

### Components (current + planned)
| Component | Lives in | Status |
|-----------|----------|--------|
| Directory | `app/api/organizations` + `app/api/providers` + `app/api/directory`; `lib/organizations.ts`, `lib/providers.ts`, `lib/directory.ts` | orgs + providers built; locations planned |
| Referrals | `app/api/referrals`, `lib/` routing + status | basic |
| Auth | request middleware + `api_keys`/token logic in `lib/` | planned |
| Metering | middleware that records a `usage_events` row per call | planned |
| Notifications | `app/api/subscriptions`, webhook delivery in `lib/` | planned |
| MCP server | an MCP endpoint exposing directory + referral tools | planned |
| CLI (`ce2`) | thin client over the public API (separate dir, no new server) | planned |

## Invariants — every issue must obey these

1. **One app, one deployment.** No new services, no port numbers, no separate
   `apps/*`. New capability = new route group under `app/api/` + logic in `lib/`.
2. **DB is Supabase Postgres, server-side only.** Access exclusively through
   `lib/supabase.ts` (service_role key). Never ship the service_role key or a
   full dataset to the browser — search/filter server-side.
3. **Schema = append-only migrations** in `supabase/migrations/`. Additive
   (`ADD COLUMN`), never destructive. Demo data goes in `supabase/seed.sql`, never
   in a schema migration.
4. **Shared logic in `lib/`, types in `lib/types.ts`.** Route handlers stay thin:
   parse → call a `lib` function → respond.
5. **Auth, metering, consent are cross-cutting** — implemented as middleware +
   tables, not as services.
6. **TypeScript strict.** Validate at the boundary (request bodies); trust
   internal calls.
7. **Logging is `console.log`** with a structured tag (e.g. `[referral.received]`)
   → Vercel runtime logs.
8. **Deploy = push to `main`.** Schema changes also need `supabase db push`
   (manual for now).

## Phase 1 (PoC) priorities

Order that builds toward the demo, not the old microservice order:
1. **Directory depth** (providers + capability search) — the thing agents query.
2. **API-key auth middleware** — so calls are authenticated (proves the DX).
3. **Metering** — a `usage_events` row per call (proves "Stripe for healthcare").
4. **MCP server** — the agent-facing centerpiece.
5. Referral routing, notifications, CLI — round out the story.

Auth/metering are *thin* in Phase 1: enough to demonstrate the shape, not
production-grade. Full Epic OAuth, consent, and billing come later.
