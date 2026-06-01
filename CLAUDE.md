# CE 2.0 — Claude Code Context

> **Start here:**
> - [docs/architecture.md](docs/architecture.md) — vision, domain model, and the invariants every change must obey.
> - [docs/feature-map.md](docs/feature-map.md) — how each Linear issue fits into the platform flows; the two user groups; dependency map.
> - [docs/repo-guide.md](docs/repo-guide.md) — how to run, test, and deploy; the Supabase workflow.
> - [docs/devin-issue-template.md](docs/devin-issue-template.md) — the format every implementation issue follows.

## What this is
Cloud + agent-native interoperability platform — data exchange and workflow orchestration across systems and AI agents.

## Key concepts
- **Interoperability core**: protocol-agnostic data exchange layer
- **Agent layer**: orchestrating AI agents as first-class workflow participants
- **Workflow engine**: cloud-native, event-driven workflow definitions
- **API surface**: external-facing integration endpoints

## Development workflow
- Issues tracked in Linear (CE project)
- Branches named `feat/CE-<issue-number>-<slug>`
- PRs auto-link to Linear via branch naming
- Devin handles autonomous implementation of well-scoped Linear issues
