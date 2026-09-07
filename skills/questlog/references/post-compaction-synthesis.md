# Post-Compaction Synthesis Workflow (reusable template)

When a long working thread is about to be **compacted** (summarized and truncated so the
model can keep going), raw detail is lost forever unless you capture it first. This workflow
turns the pre-compaction thread into a durable **synthesis document** — a resource the founder
and future agents can read to recover what happened — and pins it on the roadmap.

It is a **fan-out / fan-in** pipeline: one planner splits the thread, many workers digest
chunks in parallel, one synthesizer merges, per-source reviewers claw back lost details, and
a finalizer produces the doc. It is **generic** — nothing here is specific to any one project.

> **When to run:** just before an expected `/compact`, when the founder says "we're losing
> the thread," or right after a compaction if you still have the pre-compaction transcript.
> The output is a markdown doc + a `pin_compaction` entry linking to it.

---

## Roles (the five stages)

```
                         ┌─────────────┐
                         │  1 PLANNER  │  split thread into N chunks + define doc outline
                         └──────┬──────┘
                    ┌───────────┼───────────┐   (parallel, zero shared state)
              ┌─────▼────┐ ┌────▼─────┐ ┌───▼──────┐
              │2 DIGESTER│ │2 DIGESTER│ │2 DIGESTER│  one per chunk → structured digest
              └─────┬────┘ └────┬─────┘ └───┬──────┘
                    └───────────┼───────────┘
                         ┌──────▼──────┐
                         │3 SYNTHESIZER│  merge digests into one draft against the outline
                         └──────┬──────┘
                    ┌───────────┼───────────┐   (parallel, one reviewer per chunk/source)
              ┌─────▼────┐ ┌────▼─────┐ ┌───▼──────┐
              │4 REVIEWER│ │4 REVIEWER│ │4 REVIEWER│  compare draft vs its chunk → lost details
              └─────┬────┘ └────┬─────┘ └───┬──────┘
                    └───────────┼───────────┘
                         ┌──────▼──────┐
                         │ 5 FINALIZER │  fold in gaps, write doc, update pin
                         └─────────────┘
```

Each stage can be a subagent dispatch (parallel where marked) or, for a short thread, a set
of sequential passes you do yourself. The value is the **structure**, not the parallelism —
even single-handed, running these five passes beats one lossy summary.

---

## Stage 1 — Planner

Input: the full pre-compaction thread (transcript, scratch notes, tool logs).

Do:
1. **Chunk the thread** into N coherent segments — by topic, by milestone worked, or by time
   window. Aim for chunks a single worker can digest without further splitting (roughly one
   major thread of work each). Record exact boundaries so every worker knows its slice.
2. **Draft the doc outline** — the sections the final synthesis must contain. A good default:
   - *What we set out to do* (the goal at thread start)
   - *What actually happened* (chronological, per milestone/quest)
   - *Decisions made* (with rationale — cross-reference `decisions.json`)
   - *Current state* (where the roadmap stands now: statuses, blockers)
   - *Open threads & parked items* (what's unfinished, what's waiting on the founder)
   - *Key assets* (files, paths, URLs, commands that matter going forward)
   - *Gotchas / hard-won knowledge* (things that cost time; don't relearn them)
3. Emit a **manifest**: `{chunks: [{id, boundary, hint}], outline: [...section titles...]}`.

Guardrail: chunks must **cover the whole thread with no gaps**. Overlap at boundaries is fine;
holes are not.

---

## Stage 2 — Chunk Digesters (parallel, one per chunk)

Input: one chunk + the shared outline.

Each digester independently produces a **structured digest** of only its chunk:
- Bullet timeline of what happened in this slice.
- Every **decision** touched (what, why, approved or not).
- Every **concrete artifact**: file paths, commands, config keys, URLs, IDs — verbatim.
- Every **parked / blocked** item (human action needed, and exactly what).
- **Gotchas**: errors hit and how they were resolved; dead ends; surprising facts.
- Map each point to the outline section it feeds.

Rules:
- **Do not summarize away specifics.** Exact paths, exact commands, exact error text are the
  whole point — a lossy summary defeats the workflow.
- Zero communication between digesters. Each sees only its chunk.
- If your chunk references something clearly defined in another chunk, note the reference;
  don't guess its content.

Output per worker: a digest keyed by outline section.

---

## Stage 3 — Synthesizer

Input: all digests + the outline.

Do:
1. Merge every digest into a single **draft document** following the outline.
2. Resolve overlaps and order events chronologically where sections are timeline-shaped.
3. Preserve **all** concrete artifacts (paths/commands/IDs) — carry them through verbatim.
4. Flag any contradiction between digests inline as `⚠️ CONFLICT: …` for reviewers to arbitrate.
5. Keep the draft complete over terse — it's easier to trim in Stage 5 than to re-find lost facts.

Output: `draft.md` aligned to the outline, plus the list of source chunks (so reviewers can map).

---

## Stage 4 — Lost-Details Reviewers (parallel, one per source chunk)

Input: the draft + **the one chunk this reviewer owns**.

Each reviewer does a **recall audit against its own source**:
- Re-read the assigned chunk. List every fact, artifact, decision, and gotcha in it.
- Check each against the draft. Report anything **missing, softened, or distorted**.
- Resolve any `⚠️ CONFLICT` that involves its chunk with the ground-truth from the source.
- Output a **gap list**: `[{missing_or_wrong, where_in_source, suggested_fix}]`. Empty is a valid result.

Rule: reviewers judge only fidelity to their source — not style. Their job is to make sure the
compaction did not quietly drop something that will be needed later.

---

## Stage 5 — Finalizer

Input: `draft.md` + all reviewer gap lists.

Do:
1. Fold every confirmed gap back into the document; arbitrate conflicts using reviewer findings.
2. Tighten prose **without** dropping concrete artifacts. Keep the doc scannable — headings,
   short paragraphs, code fences for paths/commands.
3. Add a one-paragraph **TL;DR** at the top: where the project stands and the single most
   important next action.
4. **Write the doc** to `<projectRoot>/docs/compaction-<n>-synthesis.md` (or a project-chosen
   path). This path is what the pin references.
5. **Pin it on the roadmap:** call `pin_compaction` with a 1–3 sentence `summary`, the
   `afterMilestoneId` for the road position (default: last non-locked main-quest milestone),
   and `synthesisDocPath` set to the doc's path (relative to `projectRoot`). If you produced
   the doc after the pin already existed, edit the pin's `synthesisDocPath` to fill it in.
6. Optionally `asset_link` the doc to the current milestone so it also shows on that card.

Result: the thread is now recoverable. The founder sees a compaction marker on the road that
opens straight into a faithful, detail-preserving resource doc.

---

## Single-agent fast path (short threads)

If the thread is small and spinning up subagents is overkill, run the same five passes yourself,
sequentially, in one session:

1. Outline + chunk boundaries (Stage 1).
2. Digest each chunk in turn, writing structured notes (Stage 2).
3. Merge into a draft (Stage 3).
4. Re-read each chunk once more, red-teaming the draft for dropped detail (Stage 4).
5. Finalize, write the doc, `pin_compaction` (Stage 5).

The discipline — **digest before you synthesize, then audit recall against each source** — is
what prevents the lossy-summary failure mode. Keep it even at small scale.

---

## Dispatching the parallel stages (if you use subagents)

- Give each worker **only its chunk** and the shared outline — no more. Independent tasks,
  no shared state, so they run truly in parallel.
- Tell each worker to **discover its own tools at runtime** (it may need file-read or MCP
  tools) rather than assuming a fixed toolset, and to report any tool it expected but lacked.
- Collect all digests before starting the synthesizer; collect all gap lists before the finalizer.
- Only the finalizer writes to `.questlog/` (via MCP `pin_compaction` / `asset_link`) — workers
  return text, they don't mutate shared data. This keeps the lock uncontended.
