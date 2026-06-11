# CE 2.0 — Agent Context

> Full docs: [docs/architecture.md](docs/architecture.md) · [docs/repo-guide.md](docs/repo-guide.md) · [docs/devin-issue-template.md](docs/devin-issue-template.md)

## What this is
Metered interoperability platform for healthcare — "Stripe for healthcare data exchange." Systems and AI agents call a clean, authenticated, metered API to discover providers/organizations, exchange clinical data, and orchestrate workflows like referrals. This is a PoC targeting Epic leadership.

## Key concepts
- **Interoperability core**: protocol-agnostic data exchange layer
- **Agent layer**: orchestrating AI agents as first-class workflow participants
- **Workflow engine**: cloud-native, event-driven workflow definitions
- **API surface**: external-facing integration endpoints

## What's actually built today
A single **Next.js 14 app** (App Router, TypeScript) — frontend + backend in one, deployed on **Vercel**, backed by **Supabase Postgres**.

Working on `main`: org/provider directory with specialty + location search, combined directory search, referral instructions API, and a basic "Send referral" API that inserts referral rows.

Important: do not assume open PR work has landed on `main`. As of 2026-06-01:
- `CE-17`, `CE-18`, `CE-6`, and `CE-16` are done in Linear.
- `CE-19` (enhanced send referral API) is open as PR #2 and currently conflicts with `main`.
- `CE-25` (portal auth) is open as PR #4 and currently conflicts with `main`.
- Next likely work after those PRs are resolved: `CE-21` search portal UI, then `CE-22` instructions-driven referral placement, then `CE-23` referral inbox/status, then `CE-10` MCP agent demo.

## Stack & key files
| Path | Role |
|------|------|
| `app/page.tsx` | Search UI |
| `app/api/organizations/route.ts` | `GET /api/organizations?q=` |
| `app/api/providers/route.ts` | `GET /api/providers?specialty=&org_id=&q=` |
| `app/api/directory/route.ts` | `GET /api/directory?q=` (combined) |
| `app/api/referral-instructions/route.ts` | `GET /api/referral-instructions?orgId=&providerId=` |
| `app/api/referrals/route.ts` | `POST /api/referrals` |
| `app/api/health/route.ts` | `GET /api/health` |
| `lib/supabase.ts` | Server-side Supabase client (service_role) |
| `lib/referralInstructions.ts` | Referral requirement lookup/merge logic |
| `lib/types.ts` | Shared TS types |
| `supabase/migrations/*.sql` | Schema — append-only, never edit after apply |
| `supabase/seed.sql` | Demo fixtures (separate from schema) |

## Running locally
```bash
pnpm install
pnpm dev   # http://localhost:3000
```

`.env.local` (gitignored) must contain:
```
SUPABASE_URL=https://mmvjptmuazcamuduhyzz.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<from Supabase dashboard>
```

Other scripts: `pnpm build`, `pnpm lint`, `pnpm typecheck`.

Validation notes:
- Prefer `pnpm typecheck` and `pnpm build` as the baseline checks.
- `pnpm lint` may prompt to configure ESLint on `main` if `.eslintrc` has not landed; do not treat that prompt as a code failure.
- The repo expects Node `>=20 <23`. If local Node is newer, pnpm will warn even when checks pass.

## Architecture invariants — every change must obey these
1. **One app, one deployment.** New capability = new route under `app/api/` + logic in `lib/`. No new services.
2. **DB is Supabase Postgres, server-side only.** Access via `lib/supabase.ts` (service_role). Never expose service_role key or full dataset to the browser.
3. **Schema = append-only migrations** in `supabase/migrations/`. Additive only (`ADD COLUMN`). Demo data in `supabase/seed.sql`, never in migrations.
4. **Shared logic in `lib/`, types in `lib/types.ts`.** Route handlers: parse → call lib function → respond.
5. **TypeScript strict.** Validate at the boundary (request bodies); trust internal calls.
6. **Logging**: `console.log` with structured tag (e.g. `[referral.received]`) → Vercel runtime logs.

## Database workflow
```bash
supabase migration new <name>   # creates supabase/migrations/<ts>_<name>.sql
# edit the file (additive DDL only)
supabase db push                # apply to remote DB

supabase db query --linked -f supabase/seed.sql   # run seed
supabase db query --linked "select id, name from organizations;"
```

## Deploying
**Push to `main` = production deploy** (Vercel auto-deploys). PRs get preview deploys.
Schema migrations are auto-applied on push to `main` by `.github/workflows/migrate.yml`. Local/preview/testing database changes may still need manual `supabase db push`.

Production: **https://ce-2-0.vercel.app**

## Development workflow
- Issues tracked in **Linear** (CE project)
- Branches: `feat/CE-<issue-number>-<slug>`
- PRs auto-link to Linear via branch naming
- Devin handles autonomous implementation of well-scoped Linear issues

## Linear workflow for agents
Use the Linear CLI for project status and issue selection:

```bash
linear team list
linear project list --all-teams --json
linear issue query --team CE --all-states --all-assignees --limit 100 --json --no-pager
linear issue view CE-19
linear issue start CE-21
```

In Codex desktop, the sandboxed shell may not see the macOS keyring even when the user's normal Terminal is authenticated. If `linear auth whoami` says `No API key configured` but the user has logged in, rerun Linear commands with escalated/out-of-sandbox execution so the CLI can read the keyring. Do not ask the user to re-authenticate unless `linear auth whoami` fails outside the sandbox too.

Before starting implementation from Linear:
1. Check `git status --short --branch`.
2. Read `linear issue view CE-<n>` and relevant docs in `docs/`.
3. Check open PRs if the issue is already in progress: `gh pr list --limit 20`.
4. If starting new work, use the issue branch format: `feat/CE-<issue-number>-<slug>`.
5. Keep route handlers thin: parse request -> call `lib/*` -> return response.
