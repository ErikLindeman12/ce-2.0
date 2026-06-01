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

Working features: org/provider directory with specialty search, combined directory search, "Send referral" API.

## Stack & key files
| Path | Role |
|------|------|
| `app/page.tsx` | Search UI |
| `app/api/organizations/route.ts` | `GET /api/organizations?q=` |
| `app/api/providers/route.ts` | `GET /api/providers?specialty=&org_id=&q=` |
| `app/api/directory/route.ts` | `GET /api/directory?q=` (combined) |
| `app/api/referrals/route.ts` | `POST /api/referrals` |
| `app/api/health/route.ts` | `GET /api/health` |
| `lib/supabase.ts` | Server-side Supabase client (service_role) |
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
Schema changes also need `supabase db push` (manual — not wired into CI yet).

Production: **https://ce-2-0.vercel.app**

## Development workflow
- Issues tracked in **Linear** (CE project)
- Branches: `feat/CE-<issue-number>-<slug>`
- PRs auto-link to Linear via branch naming
- Devin handles autonomous implementation of well-scoped Linear issues
