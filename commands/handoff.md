---
description: Bank this session's work into a questlog baton before stopping/compacting
---

Bank the current session's work into a **questlog baton** so the next session (or
the next you, post-compaction) can pick up the thread cleanly.

Do this now:

1. **Summarize the session** into four short lists:
   - **done** — what you actually finished this session.
   - **inFlight** — work that is half-done / mid-edit right now.
   - **next** — the concrete next steps you would take if you kept going.
   - **warnings** — landmines, gotchas, or fragile spots the next session must know.

2. **Pass the baton.** Call the `baton_pass` MCP tool with:
   - `label` — a one-line name for this handoff.
   - `done`, `next` — required lists (from step 1).
   - `inFlight`, `warnings` — optional lists (from step 1).
   - `docPath` — optional path to a longer write-up if you made one.
   - `sessionId` — your session id if `session_hello` was not called this process.

3. **If this handoff is happening right before a compaction**, also call
   `pin_compaction` with a `summary` and, ideally, a `synthesisDocPath` pointing
   at the fuller synthesis document — so the save-point on the road carries a real
   write-up instead of a "synthesis pending" placeholder.

Keep every list terse and factual. The baton is a runway for the next session,
not a diary.
