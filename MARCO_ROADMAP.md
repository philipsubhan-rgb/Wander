# Marco Agent Roadmap (compressed)

Goal: grow Marco from a chat box into a real travel agent — staged, each stage
preview-tested and approved before the next begins. Nothing merges to `main`
or deploys to production without Phil's explicit sign-off per stage.

Pacing deal: Sassy builds, Phil reviews each stage within a day or two of it
landing in preview. The timeline below assumes that loop holds.

## Timeline

| Phase | Target dates | Milestone | Done looks like |
|---|---|---|---|
| 0 — Recon & design | Sep 21–24 | Map auth, Drizzle schema, trip queries; design doc for tool loop, confirmation gate, audit log, context loading, research-tool shape | Design ready before Munich; Phil reviews Sep 29 |
| 1 — Grounded Q&A + research | Sep 29 – Oct 8 | Authenticated chat + server-side trip context; read tools (trip summary, itinerary, reservations, flights/stays, conflict check, restaurant/event/activity search); live model test in preview | Marco answers real trip questions from real data and researches like a human |
| 2 — Propose-first actions | Oct 9–16 | Confirmation gate + audit log; write tools (itinerary add/move, reservation update) | Marco drafts changes, Phil approves in chat |
| 3 — Memory | Oct 19–28 | Per-user preferences + trip memories; multi-user data isolation | Marco knows Phil across trips |
| 4 — Polish | Oct 29 – Nov 4 | Real SSE streaming, proactive nudges | Feels alive |
| 5 — Restaurant booking | Nov 5–20 | Booking provider decision (e.g. OpenTable API) + book-behind-confirmation | Books restaurants, stores confirmation + cancellation terms |
| 6 — Flight & hotel lookup | Nov 23 – Dec 11 | Duffel (flights) + hotel provider; read-only live pricing | Real prices, ranked options, no booking yet |
| 7 — Full booking | Dec 14 – Jan 8 | Secure wallet, PII vault, quote-then-book, cancellation surfacing, receipts on trip | Books flights/hotels behind explicit confirmation |

## Rules that hold across all stages

- **Propose-first for money/final/irreversible.** Enforced in code (confirmation gate), not just suggested in a prompt.
- **The API key never leaves the server.** Frontend only talks to `/api/agent/*`.
- **Preview branch until approved.** Each stage is tested in preview; merge/deploy only on explicit approval.
- **Evals from Stage 1.** A dozen test conversations with known answers; hallucinations about reservations must fail loudly before Phil sees them.
- **Model stays swappable.** The agent-ness lives in the scaffolding (tools, memory, guardrails), not in which model answers.

## Phil's dependencies

- `MUSE_SPARK_API_KEY` from dev.meta.ai → Replit Secrets (needed for Stage 1 live test, ~Oct 5)
- Design approval Sep 29 (after Munich)
- Booking provider picks at Stages 5–6
- Review each stage within a day or two of it landing in preview — this is what keeps the timeline short

## Constraints

- No reviews needed from Phil during Munich (Sep 23–28).
- Stages 5–7 touch external providers (booking APIs, money rails) — those can slip for reasons outside our control.
- A stage isn't done until preview-tested and approved.
