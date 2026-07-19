---
name: OpenAPI path param renames cascade to API routes and Zod schemas
description: Renaming a path parameter in the OpenAPI spec requires updating Express route path strings AND all usages of req.params in the handler.
---

## The rule
When you rename a path parameter in `lib/api-spec/openapi.yaml` (e.g. `{itemId}` → `{packingItemId}`), three things must change together:
1. The path key in the YAML (e.g. `/trips/{tripId}/packing/{itemId}` → `.../{packingItemId}`)
2. The `name:` field of the parameter definition
3. In the API server route: both the Express route string (`:itemId` → `:packingItemId`) and all `params.data.itemId` accesses

**Why:** Orval regenerates Zod param schemas from the spec; if the spec says `packingItemId` but the route still does `params.data.itemId`, TypeScript errors result. Codegen does not touch the API server routes.

**How to apply:** Use `sed` on both the spec and the route file simultaneously when renaming. Check for `params.data.<oldName>` usages in all affected route files.
