---
name: api-client-react dist rebuild
description: When to rebuild lib/api-client-react/dist after codegen changes so trip-planner's TS project references stay in sync.
---

## Rule
After Orval codegen adds or changes hooks in `lib/api-client-react/src/generated/api.ts`, run:

```bash
cd lib/api-client-react && pnpm exec tsc -p tsconfig.json
```

**Why:** `artifacts/trip-planner` uses TypeScript project references (`references: [{ path: "../../lib/api-client-react" }]`). Project references use compiled `.d.ts` from `outDir` (dist/), not the raw source, even though `package.json exports` points to `./src/index.ts`. If `dist/` is stale, typecheck fails with "has no exported member" for any newly generated hook.

**How to apply:** Any task that runs `pnpm run codegen` (or otherwise modifies generated/api.ts) must also rebuild the dist before running typechecks. The package has no `build` script — run tsc directly.
