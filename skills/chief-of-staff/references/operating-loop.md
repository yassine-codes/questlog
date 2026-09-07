# Chief-of-staff operating loop — the per-pass checklist

This is the concrete, do-this-now procedure for **one** coordination pass. Run it in order, top to
bottom, every time you are invoked. The `SKILL.md` file holds the *why* and the guardrails; this
file holds the *steps*. Nothing here overrides a NEVER-list rule or the propose-approve-then-act
decision rule — those bind at every step.

Data conventions you rely on (from the base questlog contract, do not hardcode machine paths beyond
these): each road's data lives under `<projectRoot>/.questlog/` (`roadmap.json`, `decisions.json`,
`history.jsonl`, optional `glossary.json`, `sessions.json`, `batons.json`); the central registry
lives at `~/.questlog/registry.json` (override `QUESTLOG_REGISTRY`). History events carry a
`sessionId`; batons are `baton-<8hex>` with `done` / `inFlight` / `next` / `warnings` lists and a
`status` of `open` or `picked_up`.

---

## Step 1 — Check in

1. Call `session_hello` with `label: "chief of staff — <today's date>"` on the first road you will
   touch. If you touch more than one road this pass, say hello on **each** road before you write to
   it — child roads included. This stamps every mutation you make with a clearly-labelled coordinator
   session.

## Step 2 — Read the board (in this exact order)

Do not mutate anything yet. Build the full picture first.

2. **Registry / road list.** Call `roadmap_list` — the read-only registry view (id, folder,
   progress, milestone status breakdown, `asOf`). Never call `roadmap_register` /
   `roadmap_set_origin` to observe: they mutate. Note which roads exist and which are reachable.
3. **Per-road state.** For each road, get current state (`roadmap_get`, or scoped
   `/api/r/<id>/state`): milestones, statuses, side quests, items.
4. **Unclear queue.** `list_unclear` on each road. These are founder "I couldn't follow this" flags,
   oldest first — the highest-priority drain.
5. **Proposed decisions.** Read every decision with `status: "proposed"`. **Read only — proposed
   means WAIT.** Note them; you will not act on them, and you may need to remind the founder they are
   still open.
6. **Raids.** Pull the raids view (`/api/raids` if present) for cross-cutting hot work.
7. **Roster.** Pull the session roster (`/api/sessions`). Read each session's derived status:
   **superseded** (its baton was picked up), **completed** (open baton, work handed off), **active**
   (recent pulse), **idle** (no recent pulse). This tells you who is live and who has stopped.
8. **Batons, freshest first.** `baton_read` for the open batons, newest by timestamp first. These are
   the unfinished threads other sessions left you. This is your work inbox.

Three rules bind every read in this step:

- **Cross-road reads go through the tools**: `roadmap_list` for every road, `roadmap_get(roadmapId)`
  / `history_tail(roadmapId)` to walk a portal — never a filesystem escape.
- **History**: `history_tail mode:'aggregate'` first for counts, then windowed reads; trust
  `totalEvents`/`truncated`.
- **Freshness**: a baton's cross-road numbers are prose from a moment; the child road's live state
  (`roadmap_list` `asOf`, portals) outranks them.

**Durable-doc reconciliation (standing duty, added 2026-08-01).** Each pass, check whether any
durable write-up a road leans on (a master context document, a resume brief, a fork doctrine) has
open-threads or commitments sections; if one has changed since the last pass — or has never been
reconciled — walk those sections and confirm every still-live commitment exists as a card on the
board. A commitment living only in prose goes to the **Drain** lane (land it as a milestone or item,
with `plain` fields, crediting the source doc as an asset) — or to **Escalate** if landing it would
change the plan. Why this exists: on 2026-08-01 the founder asked about a rehearsal that lived only
in the master doc's gap table and no session could find it on any road (recorded as approved
decisions on both roads).

## Step 3 — Triage every item into one of four lanes

Walk everything you gathered and sort it. Use this table:

| Lane | When | What you do |
|------|------|-------------|
| **Drain** | The item is safe to clear now and only records reality — an `unclear` you can rewrite plainly, a baton `next` step you can execute, a status the world already justifies. | Do it now, as yourself, one honest history event per mutation. |
| **Delegate** | The thread belongs to a specific other session, or needs a resume/message. | Route it **only** via a tool you discovered at runtime (Step 5). If no such tool exists, leave a clean baton (Step 6) and record the missing capability as a finding. |
| **Escalate** | It is a founder-class decision — a real fork, a NEVER-list item, a config/consent change, a plan change. | `decision_log` it as `proposed`, then write the one-screen briefing (Step 7). Do **not** act. |
| **Park** | It is not actionable now and not the founder's to decide — waiting on an external event, blocked on another session's in-flight work. | Leave it; note it in the baton `next`/`warnings` and the end-of-pass summary. |

## Step 4 — Drain the drain lane

9. **Unclears.** For each flagged card (oldest first), write a genuinely plain rewrite and
   `clear_unclear(id, rewritten_plain)`. Rewrite until it lands for someone seeing the project cold —
   do not merely paraphrase.
10. **Executable baton steps.** For each open baton whose `next` list has steps you can do now,
    do them and log the work as the coordinator session. Every card you write still gets a `plain`
    field; still define any jargon before use (the lint rejects undefined jargon).
11. **Honest statuses.** Where a milestone's real state has moved and the change records *reality*
    (not a plan change), update it (`milestone_set_status`, with a `reason` on `blocked`).

Stop draining the instant a change would alter the **plan** rather than record a **fact** — that is
an escalation, not drain.

## Step 5 — Delegate only via discovered tools

12. **Discover your tools.** Check what you actually have this pass — use tool-discovery (e.g.
    `ToolSearch` for deferred/MCP tools) and read your real tool list. **Never assume** a
    messaging, resume, or handoff tool exists; never name one from memory.
13. **If a fit exists, use it** to resume or message the right session and route the thread.
14. **If none exists,** do not improvise a worse mechanism. Leave a clean baton (Step 6) so the next
    session that says hello can pick the thread up, and record the expected-but-missing capability as
    a **finding** in your summary (Step 8) — name exactly what you needed and could not find.

## Step 6 — Hand off before you end (baton_pass)

15. Before ending the pass, `baton_pass` for each thread you advanced but did not finish. Fill all
    four lists honestly:
    - **`done`** — what you actually completed this pass.
    - **`inFlight`** — what is mid-stream and who/what it waits on.
    - **`next`** — the concrete, executable steps the next session should take first.
    - **`warnings`** — anything that could bite the next session (a fragile state, a proposed decision
      still open, a tool you couldn't reach).
    A good baton is the difference between a clean pickup and a stranded thread. Write `next` steps
    concrete enough that a session with no memory of this pass can execute them.

## Step 7 — Escalate in one screen

16. For each founder-class decision, after `decision_log` (proposed), present it in the mandatory
    one-screen briefing — verbatim shape:

    ```
    Decision needed: <the choice, as a choice, one line>
    Context (≤3 lines): <only what's needed to weigh it>
    Options:
      A — <option> · <one-line tradeoff>
      B — <option> · <one-line tradeoff>
      C — <option, only if a real third exists> · <one-line tradeoff>
    My recommendation: <A/B/C> — <why, one line>
    If you do nothing: <the default outcome / cost of inaction>
    ```

    One screen, three options at most, always a recommendation and an inaction line. Then **wait** —
    the founder rules in chat, you record it with `decision_set_approval`, and only after approval do
    you execute the decision's edits.

## Step 8 — End-of-pass summary to the founder

17. Close the pass with a short, plain summary:
    - **Drained:** the unclears you cleared and the baton steps / statuses you advanced.
    - **Handed off:** the batons you passed and to whom/what they wait on.
    - **Escalated:** the founder-class decisions now waiting on their word (each already shown in the
      one-screen format).
    - **Still open / parked:** proposed decisions untouched, threads waiting on external events.
    - **Tools I needed but didn't have:** any messaging/resume/handoff capability you expected and
      could not find — stated as a finding, so a missing tool surfaces instead of hiding.

Then stop. The skill is dormant until the next invocation; you do nothing between passes.
