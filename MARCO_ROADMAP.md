# Marco Agent Roadmap

Goal: grow Marco from a chat box into a real travel agent — staged, each stage
preview-tested and approved before the next begins. Nothing merges to `main`
or deploys to production without Phil's explicit sign-off per stage.

## Timeline

| Phase | Target dates | Milestone | Done looks like |
|---|---|---|---|
| 0 — Recon & design | Sep 21–29 | Map auth, Drizzle schema, trip queries; design doc for tool loop, confirmation gate, audit log, context loading, research-tool shape | Design approved (review after Munich, Sep 29+) |
| 1 — Grounded Q&A | Sep 28 – Oct 9 | M1 authenticated chat + server-side trip context; M2 read tools (summary, itinerary, reservations, flights/stays, conflict check); M3 live model test in preview | Marco answers real trip questions from real data |
| 2 — Propose-first actions | Oct 12–23 | M4 confirmation gate + audit log; M5 write tools (itinerary add/move, reservation update) | Marco drafts changes, Phil approves in chat |
| 2.5 — Research tools | Oct 26 – Nov 6 | M6 restaurant / event / activity search tools | "Find dinner near the hotel" works with ranked picks |
| 3 — Memory | Nov 9–20 | M7 per-user preferences + trip memories; M8 multi-user data isolation | Marco knows Phil across trips |
| 4 — Polish | Nov 23 – Dec 4 | M9 real SSE streaming, proactive nudges | Feels alive |
| 5 — Restaurant booking | December | Booking provider decision (e.g. OpenTable API) + book-behind-confirmation | Books restaurants, stores confirmation + cancellation terms |
| 6 — Flight & hotel lookup | January | Duffel (flights) + hotel provider; read-only live pricing | Real prices, ranked options, no booking yet |
| 7 — Full booking | February+ | Secure wallet, PII vault, quote-then-book, cancellation surfacing, receipts on trip | Books flights/hotels behind explicit confirmation |

## Rules that hold across all stages

- **Propose-first for money/final/irreversible.** Enforced in code (confirmation gate), not just suggested in a prompt.
- **The API key never leaves the server.** Frontend only talks to `/api/agent/*`.
- **Preview branch until approved.** Each stage is tested in preview; merge/deploy only on explicit approval.
- **Evals from Stage 1.** A dozen test conversations with known answers; hallucinations about reservations must fail loudly before Phil sees them.
- **Model stays swappable.** The agent-ness lives in the scaffolding (tools, memory, guardrails), not in which model answers.

## Phil's dependencies

- `MUSE_SPARK_API_KEY` from dev.meta.ai → Replit Secrets (needed for M3 live test)
- Design approval after Munich (Sep 29+)
- Booking provider picks at Stages 5–6
- Sign-off at each ✅ before the next stage starts

## Constraints

- No reviews needed from Phil during Munich (Sep 23–28).
- Stage dates are targets; a stage isn't done until preview-tested and approved.
