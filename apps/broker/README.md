# @ce2/broker — Cross-Org Auth Broker

The broker is the authentication backbone for all cross-org communication in CE 2.0. Within a single organization, services already share a token issuer. The broker solves the next layer: when a service in **Org A** needs to call a service in **Org B**, it obtains a short-lived cross-org JWT from the broker. Org B then validates that token against the broker before trusting the call.

## Port

`3002` (override with `PORT` env var)

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3002` | Port the service listens on |
| `DIRECTORY_URL` | `http://localhost:3001` | Base URL of the directory service |

## Endpoints

### `GET /health`
Liveness check.
```json
{ "status": "ok", "service": "broker" }
```

### `POST /tokens/issue`
Issues a short-lived cross-org JWT.

**Request body** (`TokenIssueRequest`):
```json
{
  "requestingOrgId": "org-a",
  "targetOrgId":     "org-b",
  "audience":        "referral-service",
  "ttlSeconds":      300
}
```

**Response** (`200`):
```json
{
  "data": {
    "token":  "<signed JWT>",
    "claims": { "iss": "org-a", "sub": "org-b", "aud": "referral-service", ... }
  }
}
```

**Error responses:**
- `400` — unknown `requestingOrgId` or `targetOrgId`
- `501` — token signing not yet implemented (stub)

### `POST /tokens/validate`
Validates a cross-org JWT. Always returns `200`; failures are expressed in the body.

**Request body** (`TokenValidateRequest`):
```json
{
  "token":            "<JWT>",
  "expectedAudience": "referral-service",
  "expectedIssuer":   "org-a"
}
```

**Response:**
```json
{ "data": { "valid": true, "claims": { ... } } }
```
or
```json
{ "data": { "valid": false, "error": "token expired" } }
```

## Cross-org auth flow

```
Org A service                Broker                  Org B service
     |                          |                          |
     |-- POST /tokens/issue --> |                          |
     |<-- { token: "<JWT>" } -- |                          |
     |                          |                          |
     |-------- POST /some-endpoint (Authorization: Bearer <JWT>) -------->|
     |                          |<-- POST /tokens/validate --------------|
     |                          |--- { valid: true } ------------------>|
     |                          |                          |
     |<------------------------ 200 OK ----------------------------------|
```

1. Org A calls `POST /tokens/issue` with its own ID, the target org's ID, and the audience service name.
2. The broker verifies both orgs exist in the directory and returns a signed JWT.
3. Org A includes the JWT as a `Bearer` token in its request to Org B.
4. Org B calls `POST /tokens/validate`; the broker confirms the signature and claims.
5. Org B proceeds only if the response is `{ valid: true }`.
