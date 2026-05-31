# @ce2/directory

Central Directory service for CE 2.0. This is the registry of all healthcare organizations (tenants) in the platform — every other service queries it to resolve org IDs, endpoint URLs, and capabilities before making cross-org calls.

Runs on **port 3001**.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/orgs` | List all orgs. Accepts `?active=true\|false` filter. |
| `GET` | `/orgs/:id` | Get org by ID |
| `GET` | `/orgs/slug/:slug` | Get org by tenant slug |
| `POST` | `/orgs` | Create a new org |
| `PUT` | `/orgs/:id` | Update an existing org |

All responses use a `{ data: ... }` wrapper. Errors return `{ error: string }`.

## Role in the system

The directory is the foundational service everything else depends on. Before any service routes a request to another org's endpoint, it calls the directory to:

1. Confirm the target org is active
2. Resolve the org's `endpointUrl`
3. Check that the org's `capabilities` include the required channel and data types

Two seed orgs are loaded on startup (Mayo Clinic and Mass General) so the service is immediately queryable without any setup.

## Dev

```
pnpm dev      # ts-node-dev with hot reload
pnpm build    # compile to dist/
pnpm start    # run compiled output
pnpm typecheck
```
