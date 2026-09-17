---
name: Externalized runtime dependencies
description: Prevents production startup failures caused by bundler externalization and transitive packages.
---

Any package intentionally externalized from a server bundle must be declared directly by the server package that imports it at runtime. A transitive dependency is not sufficient under pnpm's isolated dependency layout.

**Why:** A build can succeed while the generated server fails at startup with `ERR_MODULE_NOT_FOUND` when the externalized package is not linked into the importing workspace.

**How to apply:** When adding or changing the API bundler's external list, inspect the generated bundle for external imports and add each required runtime package directly to the API package manifest. Verify by building and starting the production artifact, then requesting its health endpoint.