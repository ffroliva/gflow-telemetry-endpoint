# gflow-telemetry-endpoint

Cloudflare Worker + D1 ingest endpoint for `gflow-cli` weekly usage metrics.

References:
- Issue discussion: [ffroliva/gflow-cli#1164](https://github.com/ffroliva/gflow-cli/issues/1164)
- Client specification: [`docs/TELEMETRY.md`](https://github.com/ffroliva/gflow-cli/blob/main/docs/TELEMETRY.md)

---

## The Central Idea: Weekly Totals Only

The endpoint collects aggregated statistics without tracking users or individual installs across weeks. Reports are received, validated, added into weekly aggregate counters, and immediately discarded.

### What It Stores

1. **`totals` table**: Aggregated counts `(week, field, key, n)`.
   - `reports/all`: total reports received in the given ISO week.
   - `country`: 2-letter ISO country code derived at the Cloudflare edge (or `XX` if unknown).
   - Scalar fields: `version`, `python`, `os`, `arch`, `installer`, `install_age`, `storage`.
   - Command & tool counters: `commands`, `flags`, `exits`, `durations`, `transitions`, `models`, `modes`, `aspects`, `outcomes`, `mcp_clients`, `crashes`, `tools`.
   - V1 crosses: `x:os_exit`, `x:version_exit`, `x:storage_exit`, `x:os_install_age`, `x:installer_update_exit`.
2. **`seen` table**: Ephemeral duplicate suppression `(report_id, expires)`.
   - Stores random 16–64 char `report_id` with an expiration timestamp (`now + 14 days`). Expired rows are purged automatically with each incoming batch.

### What It Never Stores

- **No user or installation identifiers**: No persistent user ID, device ID, or hardware UUID.
- **No IP addresses**: Request IP is never stored or logged anywhere.
- **No request bodies**: The raw payload is never stored, logged, or echoed.
- **No per-report rows**: Once aggregated, individual report structure ceases to exist.
- **No prompts, inputs, paths, or secrets**: Positional prompt text, local filenames, filesystem paths, storage URIs, and credentials never leave the client and are rejected if sent.
- **No free-form error text or raw stack traces**: Unexpected errors use structured code fingerprints (e.g. `TimeoutError <- <playwright> <- ...`).
- **No logging**: Worker observability and logpush are disabled; request data is never printed to `console.log`.

---

## Endpoint Contract

`POST /v1/report`

### Reply Table

| Status | Meaning | Client Action |
|---|---|---|
| `204 No Content` | Report ingested successfully or duplicate `report_id` suppressed. Empty body. | Mark week sent; keep local history. |
| `400 Bad Request` | Validation failure (unknown keys, bad format, count > 1e6, out-of-range week). | Mark week sent (do not retry invalid payload). |
| `410 Gone` | Server kill-switch active (`STOPPED != "0"`). | Permanently disable upload (`upload_disabled`). |
| `413 Payload Too Large` | Declared `Content-Length > 16384` or stream body > 16 KB. | Mark week sent (do not retry). |
| `429 Too Many Requests` | D1 write limit or quota exceeded. Header `Retry-After: <seconds>` points past next 00:00 UTC. | Wait `Retry-After` + random jitter before retrying. |
| `503 Service Unavailable` | Database error. Atomic batch guarantees no partial writes remain. | Retain week locally; retry on subsequent day. |

---

## Server Kill Switch (`STOPPED`)

The Worker environment variable `STOPPED` provides an immediate, zero-deploy remote stop:
- When set to `"0"` (default), the Worker operates normally.
- When set to any other value (e.g. `"1"`), the Worker returns `410 Gone` to every request immediately before reading the request body.
- When `gflow-cli` receives `410`, it persists `upload_disabled = true` locally and stops sending reports permanently.

---

## Development & Testing

All tests run locally inside Miniflare and `workerd` using Vitest:

```bash
# Run tests
npm test

# Typecheck TypeScript definitions
npm run typecheck
```

---

## Deployment

Deployments are performed by the maintainer using Wrangler:

```bash
# Apply migrations to remote D1
CLOUDFLARE_ACCOUNT_ID=6e84ee0d4c899e5b5fa648302e0bfba9 npx wrangler d1 migrations apply gflow-telemetry --remote

# Deploy worker
CLOUDFLARE_ACCOUNT_ID=6e84ee0d4c899e5b5fa648302e0bfba9 npx wrangler deploy
```
