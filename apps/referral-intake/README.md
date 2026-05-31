# referral-intake

Receives cross-org referrals from multiple inbound channels, normalizes them into a unified `Referral` object, validates sending/receiving orgs via the directory service, and tracks each referral through its lifecycle.

**Port:** `3003` (override with `PORT` env var)

---

## What it does

1. **Ingest** — accepts referrals from four channels: cloud API, fax, Direct Secure Messaging, and the central portal. Each channel has a dedicated adapter (`ChannelAdapter`) that normalizes the raw wire payload into a canonical `CreateReferralInput`.
2. **Validate** — before persisting, the service confirms that both `fromOrgId` and `toOrgId` exist in the directory service (`:3001`). Unrecognized orgs are rejected with `422`.
3. **Persist** — stores referrals in an in-memory `Map`. Each referral is assigned a UUID, stamped with `createdAt`/`updatedAt`, and initialized in `received` status.
4. **Lifecycle tracking** — status advances through a defined set of states (`received → triaged → accepted/declined → scheduled → completed`). Every transition is appended to `statusHistory` with a timestamp and optional note.

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check — returns `{ status: 'ok', service: 'referral-intake' }` |
| `POST` | `/referrals` | Create a new referral |
| `GET` | `/referrals` | List referrals (supports `?fromOrgId`, `?toOrgId`, `?status`) |
| `GET` | `/referrals/:id` | Get a single referral by ID |
| `PATCH` | `/referrals/:id/status` | Advance referral status |

### POST /referrals

Request body:

```json
{
  "fromOrgId": "org-abc",
  "toOrgId": "org-xyz",
  "channel": "cloud",
  "patient": {
    "externalId": "P-001",
    "firstName": "Jane",
    "lastName": "Smith",
    "dateOfBirth": "1980-04-15"
  },
  "request": {
    "dataType": "consult",
    "priority": "routine",
    "notes": "Cardiology follow-up"
  }
}
```

Response `201`:

```json
{
  "data": { ...Referral }
}
```

### PATCH /referrals/:id/status

Request body:

```json
{
  "status": "accepted",
  "note": "Capacity confirmed"
}
```

Valid status values: `received` | `triaged` | `accepted` | `declined` | `scheduled` | `completed` | `cancelled`

---

## Channel adapters

Each channel is implemented as a class in `src/channels/` that satisfies the `ChannelAdapter` interface:

```ts
interface ChannelAdapter {
  channel: OrgChannel;
  normalize(raw: unknown): CreateReferralInput;
}
```

| Adapter | Channel | Wire format |
|---------|---------|-------------|
| `CloudAdapter` | `cloud` | Structured JSON from another org's CE 2.0 cloud API |
| `FaxAdapter` | `fax` | OCR'd text or structured fax metadata from the fax gateway |
| `DirectAdapter` | `direct` | S/MIME-wrapped CDA or FHIR Bundle via Direct Secure Messaging |
| `PortalAdapter` | `portal` | JSON form submission from the central referral portal |

All four `normalize()` implementations are currently stubs — they throw `Error('Not implemented: <channel> normalization')`. See each file for a detailed TODO describing what the real implementation must do.

The `POST /referrals` route accepts the channel in the request body alongside the `CreateReferralInput` fields. When channel-specific ingest webhooks are wired up (e.g. a fax webhook or Direct mailbox poller), they will call the appropriate adapter's `normalize()` method and then POST to this service.

---

## Connected services

### Directory service (`DIRECTORY_URL`, default `http://localhost:3001`)

`src/services/directory-client.ts` exposes:

- `getOrg(orgId)` — fetches a full `Org` record; returns `null` on 404
- `orgExists(orgId)` — boolean convenience wrapper

Used by `POST /referrals` to validate `fromOrgId` and `toOrgId` before persisting.

### Token broker (`BROKER_URL`, default `http://localhost:3002`)

`src/services/broker-client.ts` exposes:

- `getCrossOrgToken(requestingOrgId, targetOrgId, audience)` — POSTs to `/tokens/issue` and returns a `CrossOrgToken`

Used when referral-intake needs to call another org's cloud API on behalf of the sending org — for example, to push a notification to the receiving org's endpoint when a new referral arrives.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3003` | HTTP listen port |
| `DIRECTORY_URL` | `http://localhost:3001` | Base URL for the directory service |
| `BROKER_URL` | `http://localhost:3002` | Base URL for the token broker |

---

## Development

```bash
pnpm dev        # ts-node-dev with hot reload
pnpm typecheck  # type-check without emitting
pnpm build      # compile to dist/
pnpm start      # run compiled output
```
