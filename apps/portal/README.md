# @ce2/portal

The central web portal for **CE 2.0 — Care Everywhere**, hosted in the Epic central tenant.

Clinicians use this app to submit cross-org referrals, track referral status, and browse available organizations.

## Port

Runs on **port 3000** (`next dev -p 3000`).

## Pages

| Path | Description |
|---|---|
| `/` | Dashboard — quick-nav cards and backend service health URLs |
| `/referrals` | List of all referrals (server component, fetched fresh on each request) |
| `/referrals/new` | Submit a new referral (client component with form) |
| `/referrals/[id]` | Referral detail — patient info, status badge, status history timeline |

## Backend connections

| Service | Default URL | Env var |
|---|---|---|
| Directory | `http://localhost:3001` | `NEXT_PUBLIC_DIRECTORY_URL` |
| Referral Intake | `http://localhost:3003` | `NEXT_PUBLIC_REFERRAL_INTAKE_URL` |

All fetch calls are in `lib/api.ts`. Set the env vars above to point at the real services in staging or production.

## Development

```bash
pnpm dev          # from this directory, runs on :3000
pnpm typecheck    # tsc --noEmit
pnpm build
```

## Dependencies

- `@ce2/types` — shared TypeScript types (workspace package)
- Next.js 14 (App Router)
- React 18
- No external UI library — inline styles only
