# CE 2.0 — Repo Guide

How this repo is wired and how to run, test, and deploy it. This is the
operational companion to the product vision in [AGENTS.md](../AGENTS.md) / [CLAUDE.md](../CLAUDE.md).

## What's actually built today

A single **Next.js 14 app** (App Router, TypeScript) that is both the frontend
**and** the backend — there is no separate server. It's deployed on **Vercel**
and backed by a **Supabase Postgres** database.

The working vertical slice:
- A search page listing healthcare **organizations** (the directory).
- **Providers** (clinicians: name, NPI, specialty) under organizations, with
  server-side specialty/capability search and a combined directory search.
- A **"Send referral"** action that POSTs a referral and persists it.

Everything else in CLAUDE.md (workflow engine, agent layer, etc.) is vision, not
yet code.

## How it all connects

```
Browser ──> Next.js app on Vercel ──> Supabase Postgres
            (ce-2-0.vercel.app)        (project ref mmvjptmuazcamuduhyzz)
            │
            ├─ app/page.tsx          UI (client component, debounced search)
            ├─ app/api/organizations search the org directory   (GET)
            ├─ app/api/referrals     accept + persist a referral (POST)
            └─ app/api/health        liveness check             (GET)
```

- The API routes are **serverless functions** — same deployable as the
  frontend, no separate backend to manage.
- They talk to Postgres **server-side only**, via the Supabase **service_role**
  key (held as a Vercel env var, never shipped to the browser). The directory is
  proprietary, so we never dump the full table to the client.
- Logging is `console.log` → **Vercel runtime logs** (`vercel logs <url>`).

### Key files
| Path | Role |
|------|------|
| `app/page.tsx` | Search UI + "Send referral" button |
| `app/layout.tsx` | Nav/shell |
| `app/api/organizations/route.ts` | `GET /api/organizations?q=` |
| `app/api/providers/route.ts` | `GET /api/providers?specialty=&org_id=&q=` |
| `app/api/directory/route.ts` | `GET /api/directory?q=` (combined orgs + providers) |
| `app/api/referrals/route.ts` | `POST /api/referrals` |
| `app/api/health/route.ts` | `GET /api/health` |
| `lib/organizations.ts` | Org query + search logic |
| `lib/providers.ts` | Provider query + specialty/capability search |
| `lib/directory.ts` | Combined orgs + providers search |
| `lib/supabase.ts` | Lazy server-side Supabase client |
| `lib/types.ts` | Shared TS types |
| `supabase/migrations/*.sql` | Schema (append-only, ordered) |
| `supabase/seed.sql` | Demo org + provider fixtures (NOT part of schema) |
| `scripts/devin` | Auditable bash wrapper over the Devin v3 API (create/status/watch/list) |

## Running locally

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

Local dev needs the same two env vars the deployment uses. Create
`.env.local` (gitignored):

```
SUPABASE_URL=https://mmvjptmuazcamuduhyzz.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role key from Supabase dashboard or CLI>
```

Other scripts: `pnpm build`, `pnpm start`, `pnpm lint`, `pnpm typecheck`.

## Environment variables

Two vars, both server-side:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (secret — service_role, bypasses RLS)

On Vercel they live in the **Production** environment. Manage via CLI:
```bash
vercel env ls production
vercel env add SUPABASE_SERVICE_ROLE_KEY production   # paste value when prompted
```
**Env var changes only take effect on a new deployment.** After changing one,
trigger a fresh deploy (`vercel --prod --force`, or push a commit).

## Database & Supabase workflow

The DB lives in Supabase. You interact with it through the **Supabase CLI**,
which authenticates via your stored access token (Management API) — that's why
schema/query commands never ask for the Postgres password.

**Schema changes are migrations** — append-only, never edited once applied:
```bash
supabase migration new <name>     # creates supabase/migrations/<ts>_<name>.sql
# edit the file: ALTER TABLE ... ADD COLUMN ... (additive, non-destructive)
supabase db push                  # applies pending migrations to the remote DB
```
Adding a column does **not** touch existing rows. Keep DDL in migrations and
demo/seed data in `supabase/seed.sql` (separate concerns).

**Seeding / ad-hoc SQL** (no dashboard needed):
```bash
supabase db query --linked -f supabase/seed.sql        # run a SQL file
supabase db query --linked "select id, name from organizations;"   # inline SQL
```
Note: `db push` applies *schema*; it does **not** run `seed.sql`. Seed the
remote separately with the `db query` command above.

> Gotcha (already fixed, here for context): tables created via the Management
> API don't inherit default grants, so `service_role` needed explicit
> `GRANT`s — see `20260531181918_grant_app_roles.sql`. New tables are covered by
> the `alter default privileges` in that migration.

## Deploying

**Deploy = push to `main`.** The GitHub repo (`ErikLindeman12/ce-2.0`) is
connected to Vercel, so:
- Push to `main` → automatic **Production** deploy.
- Open a PR → automatic **Preview** deploy at its own URL.

Manual fallback (rarely needed): `vercel --prod` from the repo root.

Production URL: **https://ce-2-0.vercel.app**

## Verifying it works

```bash
curl -s https://ce-2-0.vercel.app/api/health
curl -s "https://ce-2-0.vercel.app/api/organizations?q=ucsf"
curl -s -X POST https://ce-2-0.vercel.app/api/referrals \
  -H 'content-type: application/json' \
  -d '{"toOrgId":"org_ucsf","toOrgName":"UCSF Medical Center","patient":{"firstName":"Jane","lastName":"Doe","dateOfBirth":"1985-04-12"},"request":{"dataType":"labs","priority":"routine"}}'

vercel logs https://ce-2-0.vercel.app          # runtime logs
```

Automated tests (unit + Playwright e2e for portal and API) are not set up yet —
tracked in **CE-12**.

## Day-to-day: what you touch

| Task | Where | Auto-applied on deploy? |
|------|-------|------|
| App / UI / API code | edit, commit, **push to `main`** | Yes (Vercel) |
| Deploy | **just push** | Yes |
| Schema change | new migration file, commit, then **`supabase db push`** | No — manual push for now |
| Seed / query data | `supabase db query` | n/a |
| Env vars | `vercel env` + redeploy | n/a |

So **app code and deploys are pure git** — push and Vercel handles the rest.
The one thing git does *not* yet do for you is apply schema to Supabase: after
committing a migration you still run `supabase db push` manually. Wiring that
into CI (Supabase GitHub integration or a GitHub Action) is a future task. Until
then, Supabase touches are limited to: schema pushes, seeds, and ad-hoc queries.

## Delegating to Devin

Issues are tracked in **Linear** (CE 2.0 team). Devin is connected to Linear as
an agent, so the normal flow is **Linear-native**: open an issue, press `A`, type
`devin`, Enter. Devin starts a session (issue → In Progress), proposes a plan as
a comment, implements on a branch, and opens a PR that auto-links back. Merging
the PR moves the issue to Done automatically. Triggers: **assign/delegate to
Devin**, **@devin** in a comment, or the **`devin` label**.

For scripted/automated launches outside Linear there's also `scripts/devin`, a
thin auditable wrapper over the **Devin v3 REST API** (reads `DEVIN_API_TOKEN` +
`DEVIN_ORG_ID` from env): `scripts/devin create "<prompt>"`, `status <id>`,
`watch <id>`, `list`. Prefer the Linear trigger for issue work so sessions and
PRs auto-link; use the script for ad-hoc/automation cases.
