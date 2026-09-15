---
name: API startup health
description: Production startup ordering required for autoscale health checks.
---

The API must begin listening before running nonessential database setup such as creating the session table.

**Why:** Autoscale publishing requires a prompt HTTP 200 from the startup health endpoint. A cold or temporarily slow PostgreSQL connection can otherwise block the listener until publishing times out.

**How to apply:** Keep the health endpoint independent of the database, open the configured port first, then run idempotent database setup asynchronously with explicit error logging.