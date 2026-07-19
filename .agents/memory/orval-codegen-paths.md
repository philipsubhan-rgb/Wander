---
name: Orval codegen + missing paths
description: Orval uses clean:true which deletes all generated files before regenerating; every API route that imports from @workspace/api-zod or @workspace/api-client-react must have its paths in lib/api-spec/openapi.yaml or those imports will break.
---

# Orval codegen — clean wipes everything

**Rule:** Every API route that uses Orval-generated schemas/hooks **must** have its OpenAPI paths in `lib/api-spec/openapi.yaml`. Orval's `clean: true` setting deletes all generated files before regenerating. Any route not in the spec loses its generated exports.

**Why:** Car-rentals and reservations were not in the spec but their generated exports (from a prior manual run) existed in the generated files. Running `pnpm --filter @workspace/api-spec run codegen` deleted those files and broke builds + runtime imports.

**How to apply:**
- Before running `codegen`, verify every route file's imports have corresponding OpenAPI paths.
- The codegen command is: `cd lib/api-spec && pnpm run codegen` (script name is `codegen`, not `generate`).
- Shim files (outside `generated/`) in `lib/api-zod/src/` survive the clean, but the cleaner solution is to add paths to the spec.
- After adding expense paths + car-rentals + reservations to the spec and regenerating, all exports were restored.

**Direct SQL for schema changes:** Never use `drizzle-kit push` — it tries to drop the `connect-pg-simple` session table. Use raw `psql "$DATABASE_URL"` with inline SQL instead.
