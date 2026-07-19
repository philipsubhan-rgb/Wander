---
name: Orval + TanStack Query v5 UseQueryOptions fix
description: Orval 8.21.0 generates non-partial UseQueryOptions which requires queryKey — post-codegen script patches the generated file.
---

## The rule
After every codegen run, the generated `lib/api-client-react/src/generated/api.ts` must have `query?:UseQueryOptions<` replaced with `query?:Partial<UseQueryOptions<` (each occurrence needs a second closing `>` added).

**Why:** TanStack Query v5 made `queryKey` required in `UseQueryOptions`. Orval 8.21.0 generates `query?:UseQueryOptions<...>` for hook options, meaning every caller must supply `queryKey`. But every generated hook already auto-derives `queryKey`, so callers only ever need partial options like `{ enabled: !!id }`.

**How to apply:** `lib/api-spec/fix-generated-types.mjs` runs automatically as part of `pnpm run codegen` in `lib/api-spec/package.json`. The script bracket-matches to correctly add the wrapping `Partial<>` and its extra closing `>`.

Also: do NOT use `format: email` in the OpenAPI spec — Orval generates `zod.email()` which fails because the generated Zod file imports from the v3 compat path, not `zod/v4`.
