# Trip Planner

A shared group travel coordination app — the admin plans everything (trips, flights, accommodations, activities, itinerary, packing) and travelers see a beautifully organized view. Each traveler also has private notes and document storage only they can see.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080, served at `/api`)
- `pnpm --filter @workspace/trip-planner run dev` — run the frontend (served at `/`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string, `SESSION_SECRET` — session signing secret

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + Wouter + TanStack Query + shadcn/ui + Tailwind CSS + Framer Motion
- API: Express 5 + express-session + bcryptjs
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — single source of truth for all API contracts
- `lib/db/src/schema/` — Drizzle table definitions (users, trips, flights, accommodations, activities, itinerary_days, packing_items, trip_notes, travel_documents)
- `artifacts/api-server/src/routes/` — Express route handlers split by domain
- `artifacts/api-server/src/middlewares/auth.ts` — `requireAuth` and `requireAdmin` middleware
- `artifacts/trip-planner/src/` — React frontend (pages/, components/, hooks/)

## Architecture decisions

- Credential-based auth (username/password) — admin creates traveler accounts and shares credentials with them
- Admin sees all trips; travelers only see trips they're participants of
- Private data (trip notes, travel documents) is scoped to the requesting user server-side
- Packing list is shared/managed by admin but travelers can check items (both roles can PATCH packing items)
- Session stored server-side via express-session; 7-day cookie lifetime

## Product

- **Admin**: create and manage trips, add flights/accommodations/activities/itinerary/packing lists, manage traveler accounts and trip participants, write admin notes visible to all travelers
- **Travelers**: view all shared trip data, check off packing items, add private personal notes per trip, store private travel document details (passport, visa, insurance numbers)
- **Both**: see the trip timeline (chronological view of all flights, activities, accommodations and itinerary days) and summary stats

## Seed Credentials

| Role | Username | Password |
|------|----------|----------|
| Admin | `admin` | `admin123` |
| Traveler | `sarah` | `travel123` |
| Traveler | `mike` | `travel123` |
| Traveler | `emma` | `travel123` |

Sample trip: "Tokyo Family Adventure" (Sep 2026) with full flights, accommodations, activities, itinerary, and packing list pre-loaded.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- After any `lib/*` change, run `pnpm run typecheck:libs` before running `pnpm --filter @workspace/api-server run typecheck` or the leaf checks will see stale declarations
- The `tripParticipantsTable` has a composite primary key — use `onConflictDoNothing()` when adding participants
- Sessions require `credentials: 'include'` on the frontend fetch (handled in `lib/api-client-react/src/custom-fetch.ts`)

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
