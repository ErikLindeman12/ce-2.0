# CE 2.0 — Feature Map

> Mid-level implementation guide. Bridges the vision in `docs/architecture.md` to
> individual Linear issues. **Read `docs/architecture.md` first**, then use this
> when building a feature or trying to understand where your issue fits.

---

## The two user groups

CE 2.0 serves two sides of every referral:

**Referrers** — orgs initiating referrals (e.g. a primary care clinic sending a
patient to a specialist). They need to:
- Search for the right receiving org (by specialty, procedure, location, channel)
- Understand what info that org requires before sending
- Send the referral
- Track status: was it received? accepted? scheduled? completed?
- Communicate back if more information is needed

**Referees** — orgs receiving referrals (e.g. a cardiology practice getting a new
patient referral). They need to:
- See incoming referrals addressed to their org
- Update status: accepted → scheduled → completed / declined
- Notify the referrer of status changes
- Optionally hook their own systems (EMR intake, scheduling) via webhook
- Communicate back to the referrer if they need more information

Both groups are `organizations` in the DB. A user authenticates and is associated
with one org via `org_users.role` (`referrer` | `referee`).

---

## Core flows

### Flow 1: Find → [CE-17 API] [CE-21 Portal UI] [CE-10 MCP: `search_referrals`]

Referrers search for where to send a patient. The directory API accepts composable
filters and returns matching orgs and providers.

**API:** `GET /api/directory?specialty=cardiology&state=WI&channel=cloud`

**Design rule:** all filtering is DB-side (Supabase query, not post-fetch JS).
The portal UI and MCP tools both call this same endpoint — neither touches the DB
directly.

---

### Flow 2: Get requirements → [CE-18 API] [CE-22 Portal UI] [CE-10 MCP: `get_referral_instructions`]

Before sending, the referrer fetches the receiving org's required fields. Some
orgs want just patient name + DOB; others need insurance info, referring NPI, or a
specific note format. The portal form and the MCP tool both drive off this field
list — no hardcoded fields anywhere in UI or agent code.

**API:** `GET /api/organizations/[id]/referral-instructions`

**Schema:** `referral_requirements` table — `required_fields` (jsonb array of
`{key, label, type, required}`) + `custom_config` (jsonb for org-specific extras).
Falls back to a standard baseline if no custom config exists.

---

### Flow 3: Send → [CE-19 API] [CE-22 Portal UI] [CE-10 MCP: `send_referral`]

Validate the payload against the org's requirements, dispatch to the org's
`endpoint_url`, and persist the referral with a meaningful status.

**API:** `POST /api/referrals`

**Statuses on send:** `queued` (no endpoint configured) → `sent` (dispatch
succeeded) → `dispatch_failed` (endpoint errored — saved anyway, never crashes).

**Note:** dispatch is a stub HTTP POST to `organizations.endpoint_url`. Not a real
HL7/FHIR integration — that is a later phase. The structure is in place so it can
be swapped in.

---

### Flow 4: Track + notify → [CE-23]

Both user groups need a view of their referrals:

**Referrer inbox** — outbound referrals with current status. Notifications when
the referee updates status (accepted, scheduled, completed, declined).

**Referee inbox** — inbound referrals addressed to their org. Action to update
status. Notifications when a new referral arrives.

**APIs:**
- `GET /api/referrals?direction=sent|received`
- `GET /api/referrals/[id]`
- `PATCH /api/referrals/[id]/status` (referee only)

**Status lifecycle:** `queued → sent → dispatch_failed → accepted → scheduled →
completed | declined`

**Notification delivery** uses `lib/notify.ts` — a shared abstraction used by
both automated status alerts and the future messaging API (CE-26). Stub for PoC;
real channels added later.

---

### Flow 5: Receive + hook in → [CE-20] *(future)*

Receiving orgs can register a webhook URL. After a referral is saved, CE 2.0 POSTs
a signed event payload to their endpoint. Lets orgs trigger EMR intake, scheduling
systems, etc. without polling.

Configured via seed/migration for the PoC (no self-service UI yet).

---

### Flow 6: Communicate → [CE-26] *(future)*

Back-and-forth messages between orgs about a specific referral. Referrer asks:
"can you send the labs?" Referee responds: "patient needs prior auth." CE 2.0 fires
the message through whatever channel the receiving org prefers: direct (platform
inbox), email stub, fax stub, in-basket (Epic), or text.

**Shares `lib/notify.ts` with Flow 4.** The difference is: status notifications
are automated, messages are user-initiated. Same delivery infrastructure.

---

## Auth architecture

```
[CE-25: Account creation + portal auth]
        ↓
[CE-24: CLI auth + API keys]     ← OAuth/magic-link → API key issued per user
        ↓
[CE-10: MCP server]              ← uses CE2_API_KEY env var to call API

[CE-17/18/19/23: API routes]     ← Bearer key validation via lib/auth.ts
```

**Account creation (CE-25):** Supabase Auth (magic link). After sign-in, user is
joined to an org via `org_users` (`user_id`, `org_id`, `role: 'referrer' |
'referee'`).

**CLI auth (CE-24):** After authenticating, issue an API key scoped to the user's
org and role. CLI and MCP server pass `Authorization: Bearer <key>`. Usage is
logged per call (feeds metering in CE-15).

**Route protection:**
- Portal pages: protected in server components / layout (no edge middleware).
- API routes: `withAuth()` wrapper in `lib/auth.ts` — validates key, resolves org.
- **Always public:** `/api/health`, `/api/directory`, `/api/organizations`,
  `/api/providers` (directory search is intentionally open).

---

## API-first design principle

The portal UI, MCP tools, and CLI are all thin clients of the same API. This is
enforced by the architecture invariants in `docs/architecture.md`:

```
Portal UI  ──→  app/api/*  ──→  lib/*  ──→  Supabase Postgres
MCP tools  ──→  app/api/*  ──→  lib/*  ──→  Supabase Postgres
CLI        ──→  app/api/*  ──→  lib/*  ──→  Supabase Postgres
```

**When building a feature, always in this order:**
1. DB migration (`supabase/migrations/`)
2. `lib/` module (query + business logic)
3. API route handler (parse → call lib → respond)
4. UI / MCP tool / CLI (call the API, never the DB)

**Never skip the API layer.** The MCP server is a separate script that calls HTTP
endpoints — it does not import `lib/` or touch Supabase.

---

## Notification + messaging infrastructure

Both automated notifications and user-initiated messages share one delivery module:

```ts
// lib/notify.ts
notify({
  toOrgId: string,
  subject: string,
  body: string,
  channel?: 'email' | 'sms' | 'fax' | 'in_basket' | 'direct',
})
```

`channel` defaults to `organizations.preferred_message_channel`. For the PoC, all
real channels are stubs (structured console log). The abstraction is real so
channels can be implemented later without changing callers.

| Trigger | Who initiates | Issue |
|---|---|---|
| Referral status changed | Automated (system) | CE-23 |
| New referral arrived | Automated (system) | CE-23 |
| Message sent about a referral | User / agent | CE-26 |

---

## Issue dependency map

```
CE-25 (account creation)
  └→ CE-24 (CLI auth + API keys)
       └→ CE-10 (MCP server) ──────────────────────────────┐
                                                            │ also blocked by:
CE-17 (search API) ─────────────────────────────────────── ┤
CE-18 (instructions API) ───────────────────────────────── ┤
CE-19 (send API) ───────────────────────────────────────── ┘
  │
  ├→ CE-21 (search portal UI)         blocked by CE-17
  ├→ CE-22 (place referral portal UI) blocked by CE-18 + CE-19
  └→ CE-23 (view referrals + notify)  blocked by CE-19 + CE-20
       └→ CE-26 (messaging API)       future; shares lib/notify.ts

CE-20 (receive webhook)               future, currently unblocked
CE-26 (org-to-org messaging)          future, unblocked

── Infrastructure (independent, run anytime) ──
CE-11 (directory cache)               optimization for CE-17
CE-12 (testing)                       anytime
CE-13 (migrations CI)                 anytime
CE-14 (Supabase branching)            anytime
CE-15 (metering)                      cross-cutting; add after CE-24 lands
CE-16 (Vercel preview env)            in progress
```

---

## Where to start

These four issues are unblocked and independent — they can run in parallel:

| Issue | What it unblocks |
|---|---|
| **CE-17** — directory search API (filters + DB-side) | CE-21 (search UI), CE-10 (MCP search tool) |
| **CE-18** — referral instructions API | CE-22 (placement UI), CE-10 (MCP instructions tool) |
| **CE-19** — send referral API (validation + dispatch) | CE-22 (placement UI), CE-23 (view), CE-10 (MCP send tool) |
| **CE-25** — account creation + portal auth | CE-24 (CLI auth) → CE-10 (MCP server) |

After those land: CE-21, CE-22, CE-23 (UI + notifications), then CE-24 (CLI auth),
then CE-10 (MCP server — the demo centerpiece).
