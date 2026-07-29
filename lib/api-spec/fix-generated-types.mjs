/**
 * Post-codegen fix: wraps `query?:UseQueryOptions<...>` with `Partial<...>` so
 * callers can pass partial query options (e.g. just `{ enabled: boolean }`)
 * without providing `queryKey` (which is required by TanStack Query v5's
 * UseQueryOptions but is auto-supplied by every generated hook).
 *
 * Run automatically as part of the `codegen` script in package.json.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Fix 1: api-zod/src/index.ts — remove duplicates and types re-export ──────
// Orval appends to this file on every run, causing duplicate `export *` lines.
// Also, generated/types/ exports TypeScript interfaces with the same names as
// the Zod schema constants in generated/api.ts (e.g. LoginResponse), causing
// TS2308. The types are redundant since callers can use z.infer<typeof X>.
const API_ZOD_INDEX = resolve(
  import.meta.dirname,
  "..",
  "..",
  "lib",
  "api-zod",
  "src",
  "index.ts",
);
writeFileSync(
  API_ZOD_INDEX,
  `export * from "./generated/api";\nexport * from "./generated/types";\n`,
  "utf8",
);

// Also remove the conflicting type files from the types index, since they
// clash with identically-named Zod schemas in generated/api.ts.
import { existsSync } from "node:fs";
const TYPES_INDEX = resolve(
  import.meta.dirname,
  "..",
  "..",
  "lib",
  "api-zod",
  "src",
  "generated",
  "types",
  "index.ts",
);
if (existsSync(TYPES_INDEX)) {
  let typesIdx = readFileSync(TYPES_INDEX, "utf8");
  // Remove lines that re-export identifiers also present in generated/api.ts
  const conflicts = [
    "loginResponse",
    "loginResponseRole",
    "inviteTripParticipantBody",
    "changeOwnPasswordInput",
  ];
  for (const c of conflicts) {
    typesIdx = typesIdx.replace(new RegExp(`^export \\* from '\\.\\/${c}';?\\n?`, "m"), "");
  }
  writeFileSync(TYPES_INDEX, typesIdx, "utf8");
  console.log("fix-generated-types: removed conflicting type re-exports from api-zod types index");
}

// Fix zod.email() → zod.string().email() — orval emits zod v4 syntax for
// format:email but the project targets zod v3.
const API_ZOD_GENERATED = resolve(
  import.meta.dirname,
  "..",
  "..",
  "lib",
  "api-zod",
  "src",
  "generated",
  "api.ts",
);
if (existsSync(API_ZOD_GENERATED)) {
  const zodContent = readFileSync(API_ZOD_GENERATED, "utf8");
  const fixedZodContent = zodContent.replace(/\bzod\.email\(\)/g, "zod.string().email()");
  if (fixedZodContent !== zodContent) {
    writeFileSync(API_ZOD_GENERATED, fixedZodContent, "utf8");
    console.log("fix-generated-types: replaced zod.email() with zod.string().email() for zod v3 compat");
  }
}

const ROOT = resolve(import.meta.dirname, "..", "..");
const TARGET = resolve(
  ROOT,
  "lib",
  "api-client-react",
  "src",
  "generated",
  "api.ts",
);

const marker = "query?:UseQueryOptions<";

function wrapWithPartial(content) {
  let result = "";
  let pos = 0;

  while (true) {
    const idx = content.indexOf(marker, pos);
    if (idx === -1) {
      result += content.slice(pos);
      break;
    }

    // Emit everything up to (but not including) the marker
    result += content.slice(pos, idx);

    // Emit the replacement opening
    result += "query?:Partial<UseQueryOptions<";

    // Walk forward past the marker to find the matching closing >
    let depth = 1;
    let i = idx + marker.length;
    while (i < content.length && depth > 0) {
      if (content[i] === "<") depth++;
      else if (content[i] === ">") depth--;
      i++;
    }
    // i now points one past the closing > of UseQueryOptions<...>
    // Emit the generic args + the existing > (which closes UseQueryOptions)
    result += content.slice(idx + marker.length, i);
    // Add a second > to close the Partial<
    result += ">";

    pos = i;
  }

  return result;
}

const original = readFileSync(TARGET, "utf8");
const fixed = wrapWithPartial(original);
const count = (original.match(/query\?:UseQueryOptions</g) ?? []).length;
writeFileSync(TARGET, fixed, "utf8");
console.log(
  `fix-generated-types: wrapped ${count} UseQueryOptions occurrence(s) with Partial<>`,
);
