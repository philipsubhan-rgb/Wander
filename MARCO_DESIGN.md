# Marco Agent — Stage 1 Design

Target: grounded Q&A + research in preview. Authenticated chat, server-side trip
context, model tool-calling loop with read tools. No writes (those are Stage 2).

Status: proposed — for Phil's review Sep 29+. Nothing merges to `main`.

## 1. Request flow (POST /api/agent/chat)

```
requireAuth → validate body { agentId, messages[], tripId } → assertTripAccess
→ build system prompt + server-side trip snapshot → tool-calling loop
→ audit-log every tool call → return { reply }
```

### Auth
- Add `requireAuth` (`middlewares/auth.ts`) to both agent routes. Identity via
  `getAuthUserId(req, res)` (session cookie primary, Bearer JWT fallback —
  existing pattern).
- Trip scoping: `requireTripParticipant` reads tripId from `req.params`, but
  chat carries it in the JSON body — so do a manual `trip_participants`
  lookup instead, reusing the `trips.ts:114-128` / MCP `assertTripAccess`
  idiom (`super_admin` bypass included). 403 otherwise.
- **Decision:** the client-supplied `tripContext` is no longer trusted. The
  body sends `tripId`; the server loads everything. (Kills a whole class of
  spoofing bugs and keeps payloads small.)

### Server-side context
- New loader `loadTripSnapshot(tripId)` modeled on `buildTripEvents`
  (`src/lib/timeline.ts`): `Promise.all` over `trips`, `itinerary_days`,
  `reservations`, `flights`, `accommodations`, `activities`, `car_rentals`
  (all `eq(table.tripId, tripId)`), serialized compactly and capped
  (~4000 chars, as today) into a system message.
- Schema source of truth: `lib/db/src/schema/` (`@workspace/db`).

## 2. Tool-calling loop

The Meta Model API is OpenAI-compatible, so we use its native `tools`
parameter with function definitions. Loop:

```
messages → model → tool_calls? → execute server-side (authz re-checked per call)
→ append results → model → … → final answer (or max 6 iterations → graceful stop)
```

- Each tool: zod input schema + `assertTripAccess` + structured log line —
  the exact shape already proven in `src/mcp/tools.ts`
  (`list_my_trips`, `get_trip_overview`, `get_trip_itinerary`,
  `get_trip_participants`, `get_trip_expense_summary`). We mirror that file's
  conventions so the two surfaces stay consistent.
- Per-call authorization: tools re-assert trip membership even though the
  route already did (defense in depth; cheap).
- Errors: a failed tool returns an error result to the model, not a 500 —
  the model explains what it couldn't fetch.

### Stage 1 read tools (trip data)
`get_trip_summary`, `get_itinerary`, `get_reservations`, `get_flights`,
`get_stays`, `get_activities`, `check_schedule_conflict`
(last one compares a proposed time against itinerary + reservations).

### Research tools (world, still read-only)
`search_restaurants`, `search_events`, `search_activities`.
Interface is defined now; provider is pluggable. **Open decision:** data
source per category (Google Places for restaurants is the obvious pick;
events/activities need evaluation). Needs API keys → Replit Secrets,
server-side only.

## 3. Confirmation gate (designed now, built Stage 2)

Write tools never execute directly. Flow:

1. Model emits a write tool call → server inserts a row in new table
   `agent_pending_actions`
   `(id, tripId, userId, toolName, args JSON, status, createdAt)` and replies
   with a confirmation request instead of executing.
2. Frontend renders an explicit approve/reject card.
3. On approve: server re-checks authz, executes, marks `executed`, writes the
   audit row. On reject: marks `rejected`.
4. Pending actions expire (e.g. 24h) via a sweep.

This is where Phil's money/final/irreversible rule becomes architecture:
high-stakes tools (anything touching bookings/payments, Stages 5–7) are
*always* gated; the gate is in the tool executor, not in the prompt.

## 4. Audit log

New table `agent_audit_log`
`(id, occurredAt, tripId, userId, toolName, argsSummary, resultSummary, wasWrite, pendingActionId?)`.
Every tool call writes a row; keep the MCP-style structured logger line too
(logs for tailing, DB for querying). No PII beyond what's already in the trip.

## 5. What stays the same in Stage 1

- Agent registry + picker (Marco vs Wander Assistant) unchanged.
- Mock fallback when `MUSE_SPARK_API_KEY` is unset (keeps local dev working).
- Fake typewriter UX until real SSE streaming (Stage 4).
- Model id via `MUSE_SPARK_MODEL` env (default `muse-spark-1.1`); swappable.

## 6. Evals (Stage 1, before live test)

A dozen scripted conversations against a fixture trip with known answers:
reservation lookup, conflict detection, "what's next" sequencing, and
adversarial ones (asking about bookings that don't exist — must not
hallucinate). All must pass before the live-key test.

## 7. Decisions (approved by Phil, Sep 21)

1. Research providers: **Google** — Google Places for restaurants; Places
   nearby/text search covers attractions and activities; events via text
   search. Provider is pluggable behind the tool interface.
   Needs `GOOGLE_PLACES_API_KEY` in server env (Replit Secrets).
2. `MUSE_SPARK_API_KEY` → Replit Secrets before the Stage 1 live test. Yes.
3. Client `tripContext` retired in favor of server-side loading. Yes —
   frontend sends `tripId`, server loads everything.
