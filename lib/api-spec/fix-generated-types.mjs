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
