# Devin Issue Template

Every implementation issue in Linear follows this shape. It exists so Devin (and
any agent) gets a bounded, verifiable spec and knows exactly where code goes and
where the fences are. Copy the skeleton, fill every section, keep it PR-sized.

Rules of thumb:
- **One issue = one PR-sized unit.** If it spans many files across many concerns,
  split it.
- **Reference, don't restate.** Link to `docs/architecture.md` for invariants and
  domain model instead of repeating them.
- **The "Out of scope" fence matters most.** Agents over-build without it.

---

## Skeleton

```markdown
## What & why
2–3 sentences. What this delivers and why it matters for the PoC.
Link the relevant architecture section: see docs/architecture.md "<section>".

## Where it goes
Exact paths. e.g.
- `app/api/providers/route.ts` — new route
- `lib/providers.ts` — query/search logic
- `supabase/migrations/<new>.sql` — `providers` table
Follows invariant: one app, logic in lib/, append-only migration.

## Contract
The precise interface:
- HTTP: method, path, query/body shape, response JSON, status codes
- Types: added/changed entries in `lib/types.ts`
- DB: new columns/tables (names + types)

## Acceptance criteria
Checklist Devin can self-verify, e.g.
- [ ] `GET /api/providers?specialty=cardiology` returns matching providers
- [ ] results filtered server-side (full table never sent to client)
- [ ] `pnpm typecheck` and `pnpm build` pass

## Out of scope
Explicit "do NOT do" list. e.g.
- Do NOT add auth here (separate issue)
- Do NOT create a new service or port
- Do NOT put seed data in the migration
```

---

## Why this works with Devin

The issue body *is* the design doc (Layer 3) — there is no separate generated
file. After you delegate, **Devin proposes its own implementation plan**; you
approve that plan before it writes code. That propose → approve → implement loop
is the "design agent" step, built into Devin — so a tight issue + Devin's plan
gate gives you the review checkpoint without a separate tool.
