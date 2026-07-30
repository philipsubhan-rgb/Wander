# Wander MCP Read-Only Server

A minimal, read-only [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server embedded in the Wander API server. It lets AI clients (Claude, MCP Inspector, custom agents) query a user's trips, itinerary, participants, and expense balances without any write access.

---

## Architecture

The MCP server lives entirely within the existing `artifacts/api-server` workspace, isolated in `src/mcp/`:

```
artifacts/api-server/src/mcp/
  auth.ts       Auth adapter — resolves Wander user from session/JWT/dev token
  tools.ts      Five read-only MCP tools, registered per-request
  router.ts     Express router: POST/GET/DELETE /mcp, GET /mcp/health
  index.ts      Module re-exports
  mcp.test.ts   Automated tests
```

**Transport:** Streamable HTTP (`@modelcontextprotocol/sdk` v1.x `StreamableHTTPServerTransport`). Not legacy SSE.

**Per-request server:** A fresh `McpServer` is created for each HTTP request, bound to the authenticated user. This avoids cross-request auth leakage and keeps the server stateless.

**Reused logic:** Tools reuse existing DB queries and the `minimizeDebts` function from `src/routes/expenses.ts`. No duplicate business logic.

---

## Endpoint

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/mcp` | MCP JSON-RPC requests (tool calls, listings) |
| `GET` | `/mcp` | MCP SSE event stream |
| `DELETE` | `/mcp` | MCP session termination |
| `GET` | `/mcp/health` | Secret-free health/diagnostics |

The MCP endpoint is mounted **outside** the `/api` prefix so MCP clients can reach it at a stable path.

---

## Local Development

### 1. Start the API server

```bash
pnpm --filter @workspace/api-server run dev
```

The server listens on the port assigned by the `PORT` environment variable (configured by Replit workflows).

### 2. Required Replit Secrets

For normal JWT/session authentication, no extra secrets are needed beyond what the server already requires (`SESSION_SECRET`, `DATABASE_URL`).

For the **development-only bearer token** (see [Development Auth Token](#development-auth-token)):

| Secret | Description |
|--------|-------------|
| `MCP_DEV_TOKEN` | A long random string used as the dev bearer token |
| `MCP_DEV_USER_ID` | Integer ID of the Wander user the dev token maps to |

### 3. Enable dev token auth

Set these environment variables **in addition to** the secrets above:

```bash
MCP_DEV_AUTH_ENABLED=true   # must be the literal string "true"
NODE_ENV=development         # dev token is blocked in production
```

---

## Authentication

### Standard auth (web / mobile)

The MCP server accepts the same credentials as the REST API:

- **Session cookie** — set by the browser after logging in to the web app
- **Wander JWT Bearer token** — returned by `POST /api/auth/login`; pass as `Authorization: Bearer <token>`

### Development-only bearer token

For local AI client development, a pre-configured static token can authenticate as a specific Wander user. This is disabled by default and blocked in production:

```
Authorization: Bearer <value of MCP_DEV_TOKEN secret>
```

Requirements (all must be true simultaneously):
- `NODE_ENV` ≠ `"production"`
- `MCP_DEV_AUTH_ENABLED=true`
- `MCP_DEV_TOKEN` is set and non-empty
- `MCP_DEV_USER_ID` is a valid integer that resolves to an existing DB user
- The incoming token byte-for-byte matches `MCP_DEV_TOKEN`

### Future OAuth path

The auth adapter in `src/mcp/auth.ts` is structured to accept an additional auth branch. An OAuth / delegated-user layer would be inserted before the dev-token check without changing any tool code.

### Auth limitations

- No OAuth / PKCE delegated auth in this version
- The dev token has no expiry — rotate `MCP_DEV_TOKEN` if it is leaked
- Token values are never logged (the logger redacts `Authorization` headers)

---

## Available Tools

All tools are annotated `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`.

### `list_my_trips`

Returns trips the authenticated user is authorized to view.

**Inputs:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | `"planning" \| "confirmed" \| "active" \| "completed"` | No | Filter by status |
| `includePast` | `boolean` | No | Include trips with past end dates (default: `false`) |

**Returns:** Array of `{ tripId, name, destination, startDate, endDate, status, participantCount, isTripAdmin }`.

**Example:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "list_my_trips",
    "arguments": { "status": "active", "includePast": false }
  }
}
```

---

### `get_trip_overview`

Returns basic trip information and item counts.

**Inputs:**
| Field | Type | Required |
|-------|------|----------|
| `tripId` | `integer` | Yes |

**Returns:** Trip metadata plus `counts: { participants, flights, accommodations, activities, expenses, packingItems, packingChecked }`.

**Example:**
```json
{ "method": "tools/call", "params": { "name": "get_trip_overview", "arguments": { "tripId": 42 } } }
```

---

### `get_trip_itinerary`

Returns timeline events for a trip — itinerary days, flights, accommodations, activities, car rentals — sorted by date and time.

**Inputs:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tripId` | `integer` | Yes | |
| `date` | `string` (`YYYY-MM-DD`) | No | Filter to a single date |

**Returns:** `{ tripId, date, events: [{ id, type, date, title, description, location, time, notes, ... }] }`.

**Sanitization:** Confirmation codes, private booking references, and participant PII are excluded.

**Example:**
```json
{ "method": "tools/call", "params": { "name": "get_trip_itinerary", "arguments": { "tripId": 42, "date": "2026-09-03" } } }
```

---

### `get_trip_participants`

Lists the participants of a trip. Returns only information appropriate for other trip members.

**Inputs:**
| Field | Type | Required |
|-------|------|----------|
| `tripId` | `integer` | Yes |

**Returns:** `{ tripId, participants: [{ participantId, displayName, role, isTripAdmin }] }`.

**Sanitization:** Password hashes, email addresses, usernames, tokens, and session data are never returned.

**Example:**
```json
{ "method": "tools/call", "params": { "name": "get_trip_participants", "arguments": { "tripId": 42 } } }
```

---

### `get_trip_expense_summary`

Returns expense totals, per-participant balances, and simplified settlement recommendations. Read-only — does not create, modify, reimburse, or delete any expense records.

**Inputs:**
| Field | Type | Required |
|-------|------|----------|
| `tripId` | `integer` | Yes |

**Returns:** `{ tripId, totalSpent, currency, balances: [{ userId, name, totalPaid, totalOwed, net }], settlements: [{ fromName, toName, amount }] }`.

Settlement calculation uses the same `minimizeDebts` algorithm as the REST balance endpoint.

**Example:**
```json
{ "method": "tools/call", "params": { "name": "get_trip_expense_summary", "arguments": { "tripId": 42 } } }
```

---

## MCP Inspector Testing Steps

1. Install MCP Inspector: `npx @modelcontextprotocol/inspector`
2. Choose **Streamable HTTP** transport
3. Set the URL to: `https://<your-replit-dev-domain>/mcp`
4. Add the header: `Authorization: Bearer <your-jwt-token>`  
   (Get a token from `POST /api/auth/login` → `token` field in response)
5. Click **Connect** — the server name `wander-group-travel` should appear
6. Open **Tools** tab → you should see five tools
7. Call `list_my_trips` with `{}` — should return your trips
8. Call `get_trip_overview` with `{ "tripId": <id> }` — should return counts
9. Verify unauthenticated: remove the Authorization header → connection should be rejected with 401

---

## Security Constraints

- **Read-only:** No tool modifies, creates, or deletes any data. `db.insert`, `db.update`, and `db.delete` are never called from tool handlers.
- **Scoped access:** Every trip-scoped tool calls `assertTripAccess(userId, role, tripId)` before any DB query. Users can only see trips they participate in; `super_admin` sees all trips.
- **No trust in arguments:** User IDs are derived exclusively from the verified authentication context, never from tool arguments.
- **Sanitized output:** `passwordHash`, `email`, `username`, confirmation codes, session tokens, and JWT secrets are never included in tool responses.
- **Audit logging:** Every tool call logs `{ tool, userId, tripId?, outcome }` via pino. Tokens and secrets are never logged.
- **Dev token production block:** The dev token check returns `null` immediately when `NODE_ENV === "production"`.
- **No OpenAPI exposure:** The `/mcp` endpoint is not in `lib/api-spec/openapi.yaml` and is invisible to Orval codegen.

---

## How to Disable the MCP Endpoint

Remove the `app.use(mcpRouter)` line from `artifacts/api-server/src/app.ts` and redeploy. No database changes or secret rotation required.

Alternatively, set `MCP_DISABLED=true` and add a guard at the top of `router.ts` (not currently implemented — full removal is simpler and safer).

---

## Known Future Work

- **OAuth / delegated auth:** The auth adapter has a documented extension point. A PKCE OAuth flow would let AI clients authenticate as real Wander users without sharing long-lived tokens.
- **Streaming results:** Large itineraries could be streamed via SSE using the `GET /mcp` transport rather than buffered in a single response.
- **Pagination:** `list_my_trips` returns all trips; large accounts may want cursor-based pagination.
- **Resource endpoints:** Itinerary days and expense records could be exposed as MCP Resources (not just Tools) for reference-style access.
- **Rate limiting:** MCP tool calls are not currently rate-limited independently of the REST API.
- **Session-based transport:** The current stateless mode creates a new server per request. A stateful session mode (with `sessionIdGenerator: () => randomUUID()`) would enable server-sent notifications.
