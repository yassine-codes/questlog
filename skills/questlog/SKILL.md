---
name: questlog
description: Use when you and a founder need a living, shared roadmap you both manage — track milestones and progress as a road that grows and shrinks, log decisions the founder approves before you act on them, branch side quests off milestones, leave and refine explanations on milestone cards, and pin compactions with a synthesized resource doc. Works for any project; data is plain local JSON edited via an MCP server, a local dashboard UI, or direct file edits.
---

# Questlog

Questlog is a **shared, living roadmap** for a project — a dashboard you and the founder
co-manage, laid out as a winding **road** of milestone nodes with **side quests** branching
off. You have as much access as the founder: you read and update the same data, propose plan
changes the founder approves, leave explanations on milestone cards, and pin compactions.

It is **generic** — every project gets its own `<projectRoot>/.questlog/` data. Nothing about
any particular project is baked into the tool.

## What it is made of

- **Data** — plain files under `<projectRoot>/.questlog/`: `roadmap.json`, `decisions.json`,
  `pins.json`, `history.jsonl`, an **optional** `glossary.json` (plain-meaning dictionary;
  absent = no underlines, lint skipped), and an **optional** `sessions.json` (which AI sessions have
  written to this road; absent = empty panel). One more file lives **outside** any project — a
  user-level `~/.questlog/registry.json` (override with `QUESTLOG_REGISTRY`) that lets one server
  serve every roadmap as a world-select "overworld." **These files are the source of truth.** Full
  schema in `references/data-contract.md`.
- **MCP server** (`mcp/server.mjs`, version `1.6.0`, **thirty tools**) — a convenience layer over
  those files. Reads: `roadmap_get` (whole road or one slice), `list_unclear`, `baton_peek`
  (strictly read-only baton view), **`roadmap_list`** (read the registry — every registered road
  with id, folder, progress, milestone status breakdown and `asOf` freshness), **`history_tail`**
  (an honest history window — see below), and **`conflict_list`** (the colliding writes HELD on this
  road, each waiting on a founder ruling — §"Multiple simultaneous sessions"). Writes:
  `milestone_upsert`, `milestone_set_status`, `milestone_delete`, `quest_create`, `quest_delete`,
  `item_upsert`, `item_delete`, `item_note_add`, `asset_link`, `decision_log`,
  `decision_set_approval`, `pin_compaction`, `conflict_resolve` (record the founder's ruling on a
  held write), the jargon-proofing pair
  `clear_unclear` + `glossary_term_upsert`, the handoff trio `baton_pass` / `baton_read` /
  `brief_create`, the horizon trio `suggestions_upsert` / `suggestion_promote` /
  `suggestion_dismiss`, and the central-app trio `session_hello` (session check-in,
  §"Check in at session start"), `roadmap_register` (add a road to the overworld, optionally
  recording the parent milestone it branched from), and `roadmap_set_origin` (retrofit or correct a
  road's parent edge in the family tree).
  - **Reading another road (walking a portal).** `roadmap_get`, `list_unclear`, `baton_peek` and
    `history_tail` all take an optional **`roadmapId`** (`rm-…`, discovered with `roadmap_list`)
    that points them at any OTHER registered road. This is READ reach only — no write tool accepts
    it, so a cross-road call can never mutate another road. Walk portals with these, never with a
    filesystem escape.
  - **To READ the registry, use `roadmap_list`.** `roadmap_register` and `roadmap_set_origin` are
    mutations; never call them to observe. Probing with a write tool creates a real entry.
  - **`history_tail` is the honest history reader.** It takes `limit` (1–500, default 50), `before`
    (ISO timestamp, exclusive — page backwards with it), and `mode`. `mode:"events"` ALWAYS returns
    `totalEvents`, `returned`, `truncated`, `oldestReachable` and the window's `from`/`to`, so you
    can always tell "absent from the road" from "absent from my window". `mode:"aggregate"` counts
    the ENTIRE file by actor, action and session. `roadmap_get section:"history_tail"` remains a
    bare 50-event array with no truncation signal — prefer the tool.
  - **`sessions` carries a derived count.** `roadmap_get section:"sessions"` serves `eventCount`
    counted from `history.jsonl` at read time, plus `storedEventCount` (what the file records). The
    stored number is advisory and undercounts anything another writer appended.
- **Dashboard** (`server.mjs` + `index.html`) — a local web UI the founder opens to see the road,
  expand milestone cards, read your explanations, reply with notes, flag anything unclear, and batch
  their pending notes/flags to the helper with one "Send to agent" button. Decisions are displayed
  here; the founder approves them in chat (§2). With **no `--dir`** it runs as a **central app**: one
  port, a world-select overworld over every registered roadmap. With `--dir <projectRoot>` it is the
  classic single-project dashboard.

The MCP server and UI are **conveniences, never gatekeepers**. Any agent — including you — can
Read/Edit the JSON files directly. Prefer the tools when a server is running (they lock and
audit for you); hand-edit when it isn't.

## Read the contract first

Before you mutate anything, load `references/data-contract.md`. It defines the exact schema,
the frozen enums (`locked | available | in_progress | done | blocked` for milestones/quests;
`open | done | blocked` for items), the ID and timestamp rules, the MCP tool shapes, the UI
API, the **jargon-proofing model** (`glossary.json`, the optional `plain` and `unclear` fields,
the jargon lint), and the lock + atomic-write + history protocol. Honor all of it whether you
go through a tool or edit a file by hand.

---

## Check in at session start — session tracing

Every roadmap remembers **which AI sessions contributed to it**. So the founder can see who did
what, your **very first Questlog call each session is `session_hello`** — before the `list_unclear`
drain, before any mutation:

```
session_hello(sessionId: "<your session id>", label: "<one plain phrase naming this session's work>")
```

This caches your `{sessionId, label}` for the process lifetime, writes a check-in event to
`history.jsonl`, and seeds/updates the road's `sessions.json`. From then on, every card you create,
every status you flip, every flag you clear is **stamped with your session id** and folded into that
session's event counter — the founder sees a "Contributing Sessions" panel on the road and a session
count on the world card. Do the drain (hard rule 1) *after* the hello so the flags you clear count
toward your session too.

**Where the id comes from (resolution order, per mutating call):** an explicit `sessionId` argument
on a tool → the value you cached with `session_hello` → the `CLAUDE_SESSION_ID` environment variable.
If none resolves, nothing is stamped and no `sessions.json` is touched — writing stays fully
back-compat, so an old project or a session that never says hello just has unattributed history. Say
hello anyway: an untraced contribution is a gap in the founder's picture of who built the road.

Give `label` a **plain** phrase ("wiring the central overworld", "founding session — built questlog")
— it is founder-facing text in the sessions panel. It is free-form (not jargon-linted), but keep it
human. A later `session_hello` in the same process overwrites the cached label.

---

## Start a road — when a project has no `.questlog` yet

The session-start hook says it first: *"No road in this project yet — say 'start a road' when you
want one."* When the founder says it — in those words or any others — this is the whole procedure.

**It is a conversation, not a wizard.** Ask in prose, two or three questions a turn at most, never a
numbered form. A founder handed a form fills it with placeholder text; a founder who is asked about
their project tells you what it actually is.

**Check that there is no road first.** If `<projectRoot>/.questlog/roadmap.json` already exists you
are not starting a road, you are reading one. Never seed over a road that exists.

Three things to learn, in this order:

1. **What the project is** — a name and a one-line tagline, in the founder's own words. Keep their
   words; a tidied version is your voice, not theirs.
2. **What done looks like** — the definition of done for the main quest. It becomes the **last
   milestone**, so it has to be something you could point at and agree was finished.
3. **The first few milestones** — three to five, in order, each with a title and a one-sentence
   `plain`. Status `available`, or `locked` when it waits on something earlier. Three to five is
   the point — a road the founder can see beats a road that is finished, and milestones are dynamic
   anyway (§1).

Then **read the road back in one screen** — name, tagline, the milestones in order — and get a yes
before you write anything. **Never seed a milestone the founder did not say yes to.**

On the yes, seed it through the tools:

- **`session_hello`** first, as on any other session (§"Check in at session start").
- **`milestone_upsert`** on `q-main`, once per agreed milestone, in order, each with its `plain`.
  The first write is what creates `<projectRoot>/.questlog/` — the server builds the skeleton on
  demand (a `q-main` main quest, `project.name` = the folder name; `mcp/server.mjs`, `emptyRoadmap`).
- **The name and tagline are not a tool.** No MCP tool writes `project.name` or `project.tagline`;
  the skeleton takes the name from the folder and leaves the tagline empty. Set them the honest way
  — a direct file edit on `roadmap.json` under the third path's rules (bump `project.updatedAt`,
  append a `history.jsonl` line), or the dashboard's raw-JSON escape hatch `POST /api/file/roadmap`.
  Tell the founder which you used.
- **`roadmap_register`** so the road appears in the Overworld. Dir-mode startup auto-registers, but
  you are not starting a server here — call it and make the promise true.
- **`node schema/validate.mjs --dir <projectRoot>`**, and read the output. A road that does not
  validate is not a road.

Then say exactly two things and stop: **commit `.questlog/`** (§"Commit your .questlog/"), and
**`/questlog:open`** to look at it.

---

## Keep it in the founder's language — the jargon-proofing rules

> **Why this exists — the founder, verbatim:** *"it is so difficult to keep up with the llm
> language especially when it starts using jargon as a way to save up on tokens while i'm not an
> llm and can't possibly keep track of all that jargon and those abstractions."*

The dashboard is the founder's window, not yours. Tokens you save with an acronym or codename
you spend out of the founder's attention. Questlog gives you three mechanisms so the road always
reads for a non-engineer at a glance — a **glossary** of plain one-sentence meanings, a `plain`
register on every card, and an `unclear` flag the founder taps when something doesn't land — and
**three hard rules bind you. They are not optional and the schema lint enforces the third.**

1. **Drain `list_unclear` at session start, before any other work.** Right after your `session_hello`
   check-in, your first working call is `list_unclear`. For each flagged record it returns (oldest first), read the founder's
   context and call `clear_unclear(id, rewritten_plain)` with a genuinely plain rewrite. Only once
   the queue is empty do you start the work you came to do. A flagged card is the founder telling
   you they could not follow you — that outranks your agenda.

2. **Never write a card without a `plain` field.** Any milestone, quest, detail item, or decision
   you create or update must carry a `plain` value: the same meaning in human register — no
   abbreviations, no assumed history, one or two sentences a founder absorbs cold. The upsert tools
   (`milestone_upsert`, `item_upsert`, `decision_log`, `quest_create`) all take an optional `plain`;
   "optional" is the schema's back-compat stance, **not your license to skip it.** Fill it every time.

3. **Register a term in the glossary before its first use.** Before you write any text containing an
   acronym (`KV`, `LCP`, `Q3`), a `[[bracket-codename]]`, or a project-specific abstraction, define
   it once with `glossary_term_upsert` (a plain one-sentence meaning, plus aliases for its other
   surface forms). The jargon lint scans every text field on every write: **undefined jargon is a
   hard validation error (exit 1), so the data literally will not save.** Define it, or say it in
   plain words — those are the only two options.

See method §7 below for the mechanics; `references/data-contract.md` for the exact shapes, the
lint's stoplist and case rules, and the glossary uniqueness/dogfood invariants.

---

## The method (this is what to actually do)

### 0. Three rules that make the road currency, not archaeology

These three are the difference between a road that describes the work and a road that describes
last week. The machinery detects when one of them is broken and says so; only you can fix it.

1. Queued and in-flight work lives on the road, never only in conversation: before you start a piece
   of work, the milestone (or item) for it must already exist — create it first, then work.
2. Every decision either links to at least one milestone in `relatedMilestoneIds` or declares itself
   `standing` (a policy ruling that never becomes work) — an approved decision with neither is an
   orphan and will be surfaced until you fix it.
3. Order comes from timestamps, never file position: when you read history or evidence, sort by `ts`
   before reasoning about sequence.

### 1. Milestones are dynamic; keep them true

The road reflects reality. As work moves, update it — don't let it drift:
- Start work on a milestone → `milestone_set_status` to `in_progress` (auto-stamps `startedAt`).
- Finish → status `done` (auto-stamps `completedAt`).
- Hit a wall → status `blocked` **with a `reason`** (required) explaining exactly what's stuck.
- New work appears → `milestone_upsert` (omit `id` to create; new milestones default `locked`).
- Milestones are cheap. Add, reorder (`order`), and re-summarize freely so the founder always
  sees the current plan, not last week's.

### 2. Decisions: you propose, the founder approves, THEN you act

This is the core etiquette. When the plan should change — reprioritize, drop a milestone, hold
a deploy, swap an approach — **do not just do it**:
1. `decision_log` with a clear `title`, an honest `rationale` (*why*), and `impact` (*what
   changes in the plan*), linking `relatedMilestoneIds`. It is created `approved: false`,
   `status: "proposed"`.
2. Surface it to the founder and wait. **Approvals and revocations happen in chat** — the founder
   says yes or no to you in conversation, and **you record it** with `decision_set_approval`. Only
   the founder's word sets `approved: true`.
3. **Only after approval**, execute the roadmap edits the decision describes (change statuses,
   add/remove milestones, etc.).

If the founder says yes in-session you may `decision_log` with `approved: true` directly, but
the record must still capture rationale and impact. A rejected proposal → `approved: false`
sets `status: "rejected"`; a replaced one → set `supersededBy`.

**The dashboard displays decisions; it never solicits them (founder ruling, 2026-07-21).** There is
no approve/reject/revoke button on a decision card — a `proposed` decision shows a plain
*"standing decision — approve in chat"* label, and an approved/rejected one shows the recorded state
with who and when. The founder's verbatim reasoning: *"for approve and revoke, those usually [are]
actions that happen in chat … that should be recorded in [the] app as history, not a button that
gives the impression that i have to click something to trigger it."* So the loop is: you propose →
the founder rules **in chat** → you write that ruling into the log with `decision_set_approval`
(the UI's `POST /api/decision/approve` endpoint is how that write lands — a recorder, not a
founder-facing control). Never wait on a dashboard click; wait on the founder's words.

### 3. Milestone cards: leave explanations, refine them when asked

Each milestone expands to a **card** of `items`. Use items to give the founder context right
where they need it:
- `kind: "explanation"` — how to do a task, how something works, why it's built this way. Leave
  it on the card so the founder can come back to it. Explanations usually stay `status: "open"`.
- `kind: "task"` — a concrete to-do (`open` → `done`).
- `kind: "note_to_founder"` — something you want them to see.
- `kind: "blocker"` — a parked human action. Set `status: "blocked"` with a `blockedReason`
  naming the exact step (e.g. "paste the API key into the `.env` file"). These are the things
  only the founder can do.

When the founder replies on an item ("that explanation was unclear, elaborate on step 2"),
they add a note to that item's `notes` thread. **Respond by updating the item's `body`** via
`item_upsert` (same `id`) to make the explanation clearer, then add an `item_note_add`
(author `"agent"`) saying what you changed. The thread is the conversation; the body is the
canonical answer — keep the body correct and current.

### 4. Assets: attach the resources a milestone needs

Link the files, URLs, docs, and commands that give a milestone context with `asset_link`
(`kind: file | url | doc | command`). These render on the card as further reading for the
founder — the README for a component, the deploy command, the design doc, the dashboard URL.

### 5. Side quests: branch work off a milestone

When a stream of work spurs off the main line — a design uplift, a fleet of planning docs, a
research spike — make it a **side quest** with `quest_create`, branching off the milestone
where it diverges (`parentMilestoneId` must be a **main-quest** milestone; side quests don't
nest). Give it its own milestones (inline via `milestones: [...]`, or add later). It renders
as a horizontal branch off the road. `side` (`left`/`right`) picks which way it goes; leave it
to auto-alternate unless you have a reason.

### 5b. Horizon suggestions: possible next steps past a road-end

A **road-end** is the last milestone of the main quest or of any branch (or sub-branch). You may
float **1 to 3 horizon suggestions** past a road-end — possible next milestones the founder can
see coming. They render as **faint ghost nodes** past the end: clearly possibilities, not work.
They carry no status colour and are **never counted in any progress tally** — they live in their
own file (`.questlog/suggestions.json`), outside the road.

Each suggestion is **tagged with the anchor milestone id it was made at** (`frontierMilestoneId`,
name kept for back-compat). Think **parallel first**: `branchIndex` (0–4) picks one of up to five
genuinely **different directions**, and `seqIndex` (0–2) is the position along that direction —
**0 = the parallel root (an ALTERNATIVE, drawn fanning out beside the anchor)**, **1–2 =
CONSEQUENCES trailing after it**. Aim for roughly 3 directions, up to 5 when the horizon is broad,
each carrying 1–3 steps. Every suggestion needs a **plain** field, same as a milestone — the jargon
rules apply.

Three tools (all history-logged):
- `suggestions_upsert{frontierMilestoneId, suggestions:[{title, plain, summary?, branchIndex?, seqIndex?, order?}]}`
  — create or **replace** the whole tree (1–15) at one **anchor**. The anchor must be **done**,
  **in progress**, or a **road-end**. `branchIndex` defaults to the array index and `seqIndex` to 0,
  so a flat list of three reads as three alternatives. A fresh upsert also **clears any pending
  founder request** at that anchor (the "⊕ More horizons" chip).
- `suggestion_promote{id}` — turn a ghost into a **real milestone** (appended to its quest, status
  "available", via the normal milestone machinery). The ghost is then consumed.
- `suggestion_dismiss{id}` — drop a ghost. Nothing on the road changes.

**When to make them (doctrine).** Create them **once where they are missing** — do **not** churn
them every pass. A **legacy** set (no `branchIndex`) goes **stale** when the frontier advances past
the tagged milestone; a **grouped** set goes stale only when its anchor milestone is **deleted**.
**Regenerate** in either case — and whenever the founder presses **"⊕ More horizons"**, which
records a `suggestion_request` history event plus a pending marker in `suggestions.json`'s
`requests[]` for you to drain. Any agent
may make or refresh suggestions on the founder's ask **or its own judgment at natural moments** —
session end, or when a milestone is completed and the road grows a new end.

### 6. Compactions: pin them and synthesize the thread

When the working thread gets too long to hold in memory and a compaction is coming (or just
happened), preserve it:
1. Run the **post-compaction synthesis workflow** in
   `references/post-compaction-synthesis.md` (planner → parallel chunk digesters →
   synthesizer → per-source lost-details reviewers → finalizer). It turns the pre-compaction
   thread into a faithful, detail-preserving resource doc under `docs/`.
2. `pin_compaction` with a 1–3 sentence `summary`, an `afterMilestoneId` for the road position,
   and `synthesisDocPath` pointing at the doc. The pin shows as a marker on the road that opens
   into the synthesis.

Run the synthesis **before** you lose the detail — a lossy one-line summary is exactly what
this workflow exists to prevent.

### 7. Jargon-proofing: the glossary, the `plain` register, the `unclear` loop

This is how the three hard rules above actually work.

**The glossary (`.questlog/glossary.json`).** An optional per-project dictionary of terms. Each
entry is `{ id, term, aliases[], plain, note?, link? }` — `id` prefixed `term-`, `term` the
canonical surface form, `aliases` its other spellings, `plain` one plain sentence, `note` optional
longer context, `link` optional doc/URL. The UI underlines every known term/alias wherever text
renders (cards, items, decisions, notes) with a dotted underline; hover — or tap on touch — pops
the plain meaning. Matching is word-boundary and **case-sensitive for all-caps terms**
(`KV` matches only `KV`), case-insensitive otherwise (`wrangler`, `PixelKit`). Manage it with
`glossary_term_upsert` (omit `id` to create, pass an existing `id` to merge); surface forms must be
unique across the whole file, and a `plain`/`note` may itself use *other defined* terms but never
an undefined one (the lint dogfoods this). When no glossary exists the UI shows no underlines and
the lint prints a warning and passes — so a project opts in simply by creating the file.

**The `plain` register.** Milestones, quests, items, and decisions each carry an optional `plain`
field — the descriptive text (a milestone/quest `summary`, an item `body`, a decision's
`rationale`+`impact`) restated in human register. **Titles never swap** — they are the map's
identity and get de-jargoned by glossary underlines instead. The header has a **Plain English
toggle**: when on, the whole dashboard swaps descriptive text to its `plain` version; a card with
no `plain` yet shows its normal text plus a subtle *(no plain version yet)* marker — content is
never hidden and nothing crashes on a missing field. This is why hard rule 2 exists: every card
you write should have a real plain version, so the toggle actually helps.

**The `unclear` loop.** Every item, milestone, and decision card carries a one-click **Unclear**
button (not quests, not pins). When the founder taps it, the record gets `unclear: true` +
`unclearAt` and a history event is logged — this is the founder saying "I could not follow this."
Your side of the loop:
- **`list_unclear`** (read-only) returns every flagged record with its context — title, current
  text, current `plain`, the founder's note thread, its milestone/quest — sorted oldest-first.
  This is the drain order for hard rule 1.
- **`clear_unclear(id, rewritten_plain)`** sets a genuinely plainer `plain`, flips `unclear` back to
  false, clears `unclearAt`, and logs the event. `targetType` is inferred from the id prefix
  (`ms-`/`it-`/`dec-`). It errors if the record is not currently flagged, so you only clear real
  flags. Rewrite until it would land for someone seeing the project cold — do not just paraphrase.

The founder can also toggle `unclear` from the UI (`POST /api/unclear`); you never set it — you
only clear it by rewriting. Draining the queue first, every session, is the whole point: it is a
standing feedback channel from a founder who cannot keep up with your shorthand.

### 8. Branch, plan, brief, build — the four-step loop

Thinking a feature through and building it are different jobs, and doing both in one thread makes
a mess: the exploring muddies the record, and the building starts before the shape is settled.
Questlog gives you four steps that keep them apart while keeping the context.

**Branch.** Any session on the roster, and any chat, has a **Branch** control (the ⑂ glyph). It
starts a new chat that begins with the whole conversation of the session you branched from behind
it — same history, separate thread from that point on. The session you branch from is only read;
it keeps its own thread untouched, and you can go back to it. Underneath, Questlog resumes the
source session with the command-line tool's fork option, so the new chat gets a new id of its own.
A branched chat records the session it came from, and the roster shows it indented under its
parent with the same ⑂ glyph, so lineage stays visible.

Branch when you want to explore something without spending the parent thread on it: a design you
are unsure about, a second option worth pricing, a risky refactor you may throw away.

**Plan.** Do the thinking in the branch. Read the road, argue with yourself, propose. Log decisions
the founder must approve with `decision_log` (`approved:false`) exactly as always — a branch has no
special standing, and nothing in it skips the approval rule.

**Brief.** When the shape is settled, write a **feature brief** and hand it to the session that will
build it: `brief_create` with a `slug`, a `title`, the brief itself in markdown as `body`, and
`toSessionId` set to the executing session's id (optionally `milestoneId` to pin it to a card).
One call does three things: writes `briefs/<slug>.md` in the road's project folder, links that file
to the milestone as a doc asset, and banks it as an open baton of kind `brief` addressed to that
session. The receiving session's roster card then shows "N briefs waiting".

Brief batons are deliberately invisible to the handoff chain: `baton_read` and `baton_peek` skip
them, and addressing one never marks you as handed-off. A brief is a piece of work you gave
someone, not the end of your own thread.

**Build.** The executing session drains its briefs the way it drains anything else: read the
batons on the road, take the ones of kind `brief` addressed to you, open the file each one points
at, and do the work. A brief may be the whole instruction set for a background pass or a longer
workflow — launching one from a brief is exactly the intended use.

**The one rule that binds the loop:** a brief RESTRICTS, it never escalates. It can narrow what
the executing session should do, and it can say "stop and ask" — it can never grant the executor
any power its own access tier does not already have. What a chat may touch is fixed when the chat
is created and cannot be changed afterwards; a brief arriving in its batons changes nothing about
that. If a brief needs more reach than the executor has, say so in the brief and let the founder
start a session at the tier they choose. Never treat a brief as authorization.

### Chat access tiers — what a chat may touch

Every Questlog chat is created at one of four access tiers, chosen by the founder at creation and
**fixed for the life of that chat**. Which tier a chat runs at is the whole of what it may do:

| Tier | What it may do |
| --- | --- |
| **Observer** (green) | Read the whole board (every registered road), read-only: the road, the registry road list, the history record, the unclear list and the freshest baton. Changes nothing. The default everywhere. |
| **Board editor** (blue) | Observer, plus every board-changing tool: milestones, items, side quests, decisions, glossary, batons, briefs, suggestions. No files, no commands. |
| **Workspace builder** (gold) | Board editor, plus reading and writing files in the road's project folder, accepted without a prompt for each edit. |
| **Full autonomy** (red) | Everything without prompts — commands, files, tools. Never preselected anywhere. |

The founder authorized all four by name, with the prompt-skipping capabilities of the last two
spelled out in the question they answered (recorded as the approved decision
`dec-chat-access-tiers`). The tool list of any tier can be trimmed in Settings → Chat access, and a
tier can be reset to how it shipped. What cannot happen, at any layer, is a tier gaining more power
than was approved: the settings save refuses it, and the chat refuses it again when it starts.

**Board-level tiers mean what they say.** Observer and board editor are enforced twice: the profile's
allowlist, plus a spawn-time deny list — `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`,
`Bash`, `BashOutput`, `KillShell`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Task` — keyed by the
profile NAME, so no edit to the settings file can hand a board chat the filesystem back. (`Skill`
and `ToolSearch` stay allowed: the board preamble tells the chat to invoke the chief-of-staff skill,
and with the file and command surface denied they load instructions, not data.) Workspace builder
and full autonomy keep file access — it is what those tiers are.

**Read scope, pending.** Observer's row above reads "the whole board" because the read tools now
reach every registered road (`roadmap_list`, and `roadmapId` on the read tools). That is strictly
read-only and gains no write reach anywhere, but it is wider than the `dec-chat-access-tiers`
wording the founder approved ("read *the road*", singular). It is logged on the Questlog road as
decision `dec-a471ce6c`, status **proposed** — until the founder approves it, treat this row as a
proposal, not a grant.

---

## Running the dashboard

The one `server.mjs` runs in **two modes**, chosen only by whether you point it at a project:

**Central app (many roadmaps, one door)** — the founder's home base. No `--dir`:

```
node server.mjs --port 4177
```

It reads the user-level registry (`~/.questlog/registry.json`) and serves a **world-select
overworld** laid out as a **lineage family tree**: one 2011-style world node per registered
roadmap, connected by drawn routes so a promoted child branches off the parent (and portal
milestone) it came from — Super Mario World map energy, consistent with the road art. Each node
shows its name and status, its own progress, and — when it has descendants — a **full-story**
roll-up (`story D/T` across itself plus every descendant) and a unique contributing-session count.
Roots sit as anchors; a road with no recorded parent is simply a root, so N roadmaps on one graph
stay clean because only family structure lives on the overworld — each road's contents stay on its
own page. Clicking a world opens its road at `/r/<roadmapId>`; a header switcher hops between roads;
browser Back returns to the overworld. A roadmap whose folder has gone missing shows greyed, never a
crash; a child whose parent is missing draws a greyed stub edge instead of crashing.

**Single project (classic, zero-config)** — one road, exactly today's behavior. Pass `--dir`:

```
node server.mjs --dir <projectRoot> --port 4177
```

Dir mode also **auto-registers** that project into the registry on startup (upsert-by-absolute-dir,
no duplicates), so simply running a road once makes it appear in the overworld.

(Defaults: `QUESTLOG_PORT` or 4177 in both modes; DIR mode is selected by `--dir`/`--data` or
`QUESTLOG_DIR`, otherwise CENTRAL. Binds `127.0.0.1` only; `charset=utf-8` on every response.) Open
`http://127.0.0.1:4177`. The page polls every 2 s and re-renders on change, so your MCP edits and the
founder's clicks show up live. Tell the founder the URL; that's their window into everything.

### Opening it — no terminal needed

**`/questlog:open` is the whole story**, and you suggest it at every session start. The command runs
`node desktop/launch.mjs`, which starts the server if it is down and opens the Overworld in the
browser. The founder should never have to remember a port or a URL.

The launcher is zero-dependency Node, so Windows, macOS and Linux take the same steps. It resolves
the port (`--port` > `QUESTLOG_PORT` > `~/.questlog/config.json` > 4177), health-checks it, and
cold-starts `server.mjs` in central mode — detached, so it outlives the command — when nothing
answers. When the running server is older than the code on disk (**version drift**, read from
`/api/version`) it restarts it, and the restart is **always graceful**: it asks the server to stop
via `POST /api/shutdown`, waits for the port to free, then cold-starts the current code. It never
force-kills, so a server that does not answer shutdown is opened as-is, and a port answered by
something that is not Questlog gets a message and exit 2 rather than a kill. A server that does
**not** report `/api/version` predates that endpoint and is treated as **maximally stale** — the same
graceful path, never a pass-through. Then it opens the dashboard as its own app window where a
Chromium browser is found, and a plain tab where one is not.

On Windows `desktop/Questlog.cmd` is a one-line wrapper over that same launcher for a double-click,
and `desktop/make-shortcut.ps1` puts a Desktop shortcut on it; nothing else is Windows-specific.
Port and the bridge switches live in `~/.questlog/config.json`, editable from the **gear (⚙)
settings panel**; the server reads the port at startup while the bridge re-reads its config each
trigger and dispatch, so toggling the helper needs no restart. **Fresh installs default to bridge
off, dry-run on, auto-trigger off** — those live switches stay the founder's to flip.

### Registering roadmaps in the overworld

A roadmap appears in the central app once it is in the registry. Three ways in, all upsert-by-dir
(the resolved absolute project path is the identity — no duplicates):
- **`roadmap_register(dir?, originRoadmapId?, originMilestoneId?)`** — the MCP tool. Adds/refreshes
  the entry for `dir` (default the server's project root). Pass `originRoadmapId`+`originMilestoneId`
  (both or neither) to record the parent it branched from when registering a promoted child. It only
  touches `registry.json` — no `.questlog` writes, no history event.
- **Auto-registration** — running `server.mjs --dir <projectRoot>` upserts that project on startup
  (it never sets or changes an origin — an auto-registered road is a root until you record its edge).
- **Direct edit** — hand-edit `~/.questlog/registry.json` (respect the §2.7 shape and its lock).

To add or correct a parent edge on an already-registered road, use **`roadmap_set_origin(dirOrId,
originRoadmapId, originMilestoneId)`** — the explicit retrofit/correction tool (pass
`originRoadmapId: null` to clear a wrong edge). `roadmap_register` deliberately never silently
re-parents a road that already carries a *different* origin; that permanence lives behind the
dedicated tool. Self-edges and cycles are rejected on write, so you cannot make a road its own
ancestor.

Point the registry elsewhere for tests or multi-user setups with the `QUESTLOG_REGISTRY` env var.

## Editing the data: three equal paths

1. **MCP tools** — preferred when the MCP server is registered. They validate, lock, write
   atomically, and append history for you. See the tool table in `references/data-contract.md`.
2. **The dashboard** — the founder's path: add notes on items, flag cards unclear, and batch it all
   to the helper with "Send to agent". (Decisions are approved in chat, not here; the UI also has a
   raw-JSON escape hatch via `POST /api/file/:name`.)
3. **Direct file edits** — always available. Read the JSON, edit it, keep `schemaVersion: 1`,
   respect every enum and referential rule, bump `project.updatedAt` on `roadmap.json`, and
   append a `history.jsonl` line (`source: "file"`, `action: "file_edit"`, one-sentence
   `summary`). Do this when no server is running, or for surgery the tools don't expose — setting
   `project.name` or `project.tagline`, for instance, which no tool writes.

**Deleting is tool territory now.** `milestone_delete`, `item_delete` and `quest_delete` — and the
board's own delete button — refuse while dependents exist unless you pass `force`, scrub the dead id
out of `decisions.json`, `pins.json` and `suggestions.json` so the road still validates, and bank
the whole removed record in `history.jsonl` for recovery. A hand-deleted milestone does none of that
and leaves the dangling references the validator errors on.

Whatever path you use, the data is the same files. Don't treat any layer as the only way in.

### Commit your .questlog/

**A project commits its road.** The server binds `127.0.0.1` only, so a teammate sees your road
solely by having the files — that is the entire sharing mechanism. Check `.questlog/` into git
beside the code it describes and a teammate who clones the repo opens the same road you do.

The Questlog engine repo ignores its *own* `.questlog/`, and that is not a counter-example: the
engine should not ship its dogfood data to everyone who installs it. Your project is not the engine.

## Registering the MCP server

**The plugin already did it.** Questlog ships a `.mcp.json` at its plugin root that registers the
server once for every project:

```json
{
  "mcpServers": {
    "questlog": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs"],
      "env": { "QUESTLOG_DIR": "${CLAUDE_PROJECT_DIR}" }
    }
  }
}
```

There is no per-project `--dir`: the server resolves the road from `QUESTLOG_DIR`, which Claude Code
fills with the project you have open. Install the plugin once and the tools are there in every repo.

For a bare checkout used **without** the plugin — a clone you are hacking on — register it by hand
(`<plugin-root>` is the checkout's own directory, written out in full — nothing substitutes it here):

```
claude mcp add questlog -- node <plugin-root>/mcp/server.mjs --dir <projectRoot>
```

If the data dir doesn't exist yet, the server creates `<projectRoot>/.questlog/` with valid
skeleton files (a `q-main` quest, project name = folder name) on first write.

---

## The bridge (prototype) — a batch of founder notes becomes one background pass

The bridge is an **off-by-default** capability on the dashboard server: a **cheap headless
Claude (Sonnet) run** that reads the roadmap and rewrites cards through the questlog tools — no
chat window opened, no per-step approval. Module: `bridge.mjs` (zero dependencies; it runs the
installed `claude` command, no library). Design write-up: `docs/bridge-design.md`.

**How it fires — batch dispatch (founder ruling, 2026-07-21).** Founder notes and `unclear` flags
**do not each spawn a run**. They **accumulate as pending work**; the founder goes over the whole
roadmap — writing notes, tapping Unclear — and then presses **one** central **"Send to agent"**
button. The server assembles every pending note and standing flag into **one structured worklist**
(one entry per card, carrying its milestone/quest context, current text, all undispatched founder
notes verbatim, and its unclear flag) and spawns **ONE** bridge session whose prompt is that list.
The founder's verbatim wish: *"I go over the roadmap[,] view all notes … write all my notes … click
unclear and everything, and then i would have one central button that launches all those into one
session as a well structured input … the agent would have something like a list to go through."*
One dispatch = one session for the whole list. On success-start the consumed notes/flags are marked
dispatched; a failed or timed-out run un-marks them so nothing is lost. Full data + endpoint contract:
`references/data-contract.md` §8.

The old *per-note* behavior (every note/flag starts its own pass) survives only behind a config
opt-in — **`bridge.autoTrigger`, default off**. Off is the questlog default; leave it off unless a
founder deliberately wants the eager mode.

**You almost never touch this directly** — the server wires it in for you: notes and flags land as
pending work through the normal endpoints, and the "Send to agent" button (`POST /api/dispatch`) is
what actually spawns the helper. What you need to know:

### Two settings gate everything

- **`QUESTLOG_BTW_BRIDGE`** — unset means the bridge does nothing at all; `1` enables it. (Also
  settable as `bridge.enabled` in `config.json`.) A dispatch with the bridge off returns
  `409 E_BRIDGE_DISABLED`.
- **`QUESTLOG_BTW_DRYRUN`** — defaults to `1` (dry) even when enabled. Dry ("practice mode") means
  the server writes down the exact command it *would* run plus the full worklist, to a log the
  founder can read, and spawns nothing — and it marks **nothing** dispatched. `0` is the one
  deliberate step to actually run it. (Also `bridge.dryRun` in `config.json`.)

A third switch governs *when* it fires: **`bridge.autoTrigger`** (`QUESTLOG_BTW_AUTOTRIGGER=1`),
**default false** — off = the batch model above (notes pile up until "Send to agent"); on = the old
per-note eager behavior. Enforced in `BRIDGE.trigger()`, re-read every trigger, so flipping it in
Settings needs no restart.

Optional knobs (all defaulted, env-only): `QUESTLOG_BTW_DEBOUNCE_MS` (8000), `QUESTLOG_BTW_TIMEOUT_MS`,
`QUESTLOG_BTW_MODEL` (sonnet), `QUESTLOG_BTW_MAX_TURNS`, `QUESTLOG_BTW_CLAUDE_BIN` (claude),
`QUESTLOG_BTW_LOG`, `QUESTLOG_BTW_KILL`. For a batch of N cards the turn and time budgets **scale with
N** unless the env caps are set: `maxTurns = min(60, max(8, 4 + 4·N))`,
`timeoutMs = min(900000, 120000 + 60000·(N−1))` — an env value overrides absolutely. Runtime files live
under `<project>/.questlog/bridge/` (a `bridge.log`, one context package + one `worklist-<dispatchId>.json`
per dispatch, and the `KILL` kill-switch file); the validator ignores that folder.

### The command it builds, and why each part is there

The background run is spawned (no shell) as roughly:

```
claude
  -p "<plain worklist task: check in as a bridge session, read the roadmap, then work
      through N listed cards IN ORDER — clear each unclear flag with a plain rewrite,
      act on each founder note, fill every plain field, leave one agent note per item>"
  --model sonnet                 # the cheap side-task model
  --output-format json           # a machine-readable result the server captures + logs
  --max-turns <min(60,max(8,4+4·N))>  # scales with the N cards in the worklist; stops a run that loops
  --permission-mode acceptEdits  # lets the allowed tools act without a typed approval
  --session-id <uuid>            # the run's session id — the same one it says hello with
  --mcp-config <temp file>       # hands it ONLY the questlog tool server, pointed at this project
  --strict-mcp-config            # and ONLY that server — it cannot see your other tool servers
  --add-dir <projectRoot>        # lets Read see this project (the run's own folder is a throwaway temp dir)
  --allowedTools <the questlog verbs it needs> Read
```

(A single-card run from the eager `bridge.autoTrigger` mode uses the same argv with a one-card task
and the flat `QUESTLOG_BTW_MAX_TURNS` default. The tool whitelist is identical either way.)

The `--allowedTools` whitelist is the narrow write scope: `session_hello`, `roadmap_get`,
`list_unclear`, `clear_unclear`, `item_upsert`, `item_note_add`, `milestone_upsert`,
`milestone_set_status`, and `Read` — **no** shell, **no** file-write tool, **no** editing
anything outside the questlog tools. Together with `--strict-mcp-config` this means the run's
only way to change anything is the questlog tool server, which only ever writes inside
`<projectRoot>/.questlog/`. This is deliberately narrower than path-scoped file writes: the
run cannot touch files at all, only call questlog verbs.

### Containment invariants (all enforced in `bridge.mjs`)

- **Off unless enabled; dry unless made live** — the two settings above.
- **One run at a time** — a dispatch is refused with `409 E_BRIDGE_BUSY` while any per-item run or
  batch is reserved/in flight (a synchronous `reserveBatch()` guards it); a second trigger waits,
  never parallelizes.
- **Nothing lost on failure** — a live dispatch marks its notes/flags dispatched at success-start;
  a timeout/error/killed run un-marks exactly its own cards (restores `pending`, deletes the dispatch
  ids) and logs `dispatch_failed`.
- **Debounced** — in the eager per-note mode, quick repeated edits to one card merge into a single run.
- **Time-bounded and killable** — a hard timeout and turn cap end an overrun; the `KILL` file
  aborts a pending run and stops one in flight.
- **Clean, top-level spawn** — started from a throwaway temp folder with every
  `CLAUDE*`/`AI_AGENT`/`CODEX*` environment variable stripped, so it is never a nested run.
- **Attributed** — the run's first act is `session_hello(sessionId, label: "bridge")`, so
  every write it makes is stamped into that road's `sessions.json` under a **`bridge`** label.
  In the Contributing Sessions panel the founder can tell bridge-authored edits apart from
  founder- or agent-authored ones. The session row looks like
  `{ id, firstSeenAt, lastSeenAt, label: "bridge", eventCount }`, same shape as any session.

If you are the bridge run yourself (you were spawned by this), you will notice the `bridge`
label is already chosen for your `session_hello` — use it. Your task is a **worklist of N cards**:
work them **in order**, touch **only** the cards listed and their own note threads (drain nothing
else), clear each flagged card with `clear_unclear` and act on each founder note with the matching
upsert, and honor every normal questlog rule (a `plain` field on every card you write, no undefined
jargon). Add one short agent note per **item** you touch; a milestone or decision rewrite is itself
the answer. When every entry is handled, stop.

---

## Etiquette checklist

- **Say hello first** — the very first call each session is `session_hello(sessionId, label)`, so all
  your writes are traced to a named session on the road's Contributing Sessions panel.
- **Keep the road honest** — statuses reflect reality, always.
- **Drain `unclear` first** — right after the hello, open with `list_unclear`; rewrite each flagged
  card plainer with `clear_unclear` before starting anything else.
- **Every card gets a `plain`** — never write a milestone, quest, item, or decision without its
  human-register restatement filled in.
- **Define jargon before you use it** — register any acronym, `[[codename]]`, or abstraction with
  `glossary_term_upsert` before it appears in text; the lint rejects undefined jargon outright.
- **Propose, don't impose** — log plan changes as decisions and wait for the founder's approval
  before executing them. **Approvals and revocations happen in chat**; you record the founder's
  ruling with `decision_set_approval`. The dashboard displays a decision's state — it never asks the
  founder to click approve.
- **Explain in place** — leave clear explanations on cards; when the founder says one is
  unclear, fix the item's body and note what changed.
- **Name the exact parked action** — blockers should tell the founder precisely what only they
  can do.
- **Pin and synthesize compactions** — don't let a long thread evaporate.
- **Audit trail is sacred** — every mutation appends one honest one-sentence history event; the
  founder reads these. Never rewrite `history.jsonl`.
- **Order comes from timestamps, never file position** — `history.jsonl` is append-ordered, not
  time-ordered: a bridge or child run can append an event stamped earlier than lines already on
  disk (decision `dec-time-ordering`). Sort by the `ts` field before reasoning about sequence. The
  `history_tail` tool already does; a raw file read does not.
- **Say "not in my window" when that is what you mean** — Saying something is NOT on the board
  requires a whole-record read. If your view is windowed or scoped — history_tail returned
  truncated:true, or a road you cannot reach — say 'not in my window', never 'not on the board'.
- **No secrets in the data, no network calls** — keep it local-first and shareable.

---

## Parallel work and the promotion rule

Parallelism is normal on a single road — several milestones `in_progress` at once is healthy,
not a smell. Decide where work lives by its relationship to the goal:

- **Same goal, same road.** Work that serves this project's finish line stays on this roadmap,
  no matter how parallel it runs. Never split a roadmap for convenience — the single-glance
  answer to "where are we?" is the tool's core value.
- **Detour in service of the goal → side quest.** It branches off a milestone, runs beside the
  road, and rejoins in meaning if not in geometry.
- **Own definition of done → promote it into a child roadmap.** The test: *if this project shipped
  tomorrow, would that track still matter?* If yes, promote it — but promotion **converts**, it
  never detaches (see below).

### Promotion converts a side quest into a child roadmap — it never detaches

A side quest that starts needing its own side quests has mechanically outgrown its map (side quests
don't nest in v1) — that's the promotion signal. Promoting it does **not** cut it loose: it converts
the side quest into a **child roadmap that still belongs to this one**. The founder, verbatim: *"the
roadmaps that branch off of main roadmaps should still belong to that main roadmap … so that first
roadmap can hold the entire story."* The steps:

1. **Give the new track its own `.questlog`** (its own `--dir`), with its own quests and milestones.
   It becomes a real road in its own right.
2. **Collapse the old side quest into ONE milestone on the parent road — the portal node.** This
   milestone is the visible anchor of the parent→child edge on the map. Keep it a normal milestone
   (title, `plain`, items, assets as usual); you do **not** hand-maintain its progress or status.
3. **Record the family edge.** Register the child with its origin pointing at the parent road *and*
   at that portal milestone: `roadmap_register(dir, originRoadmapId, originMilestoneId)` — or, to
   retrofit a road that is already registered, `roadmap_set_origin(dirOrId, originRoadmapId,
   originMilestoneId)`. The edge is **permanent registry data** (`origin {roadmapId, milestoneId,
   ts}`); promotion **births a child, never an orphan**. A root cannot become its own descendant —
   self-edges and cycles are rejected.

Once the edge exists, three things happen automatically and stay honest with **zero** ongoing agent
effort:

- **The overworld becomes a family tree.** The child gets its own **world node** drawn as a branch
  off its parent. N roads on one graph stay visually clean because each road's *contents* live on its
  own page — only family structure lives on the overworld. A child whose parent folder went missing
  draws a greyed stub edge, never a crash.
- **The portal milestone becomes a computed mirror.** When the central server serves the parent road,
  it overlays the portal milestone (the one named by the child's `origin.milestoneId`) with a **live
  roll-up computed at serve time** from the child's actual data — progress fraction, overall status,
  last-updated — and the card links into the child road in-app. **Disk is never rewritten for
  mirroring**; the child is the single source of truth, so drift is impossible. This replaces the old
  hand-kept mirror: you no longer nudge the portal's status by hand, and there is nothing to keep in
  sync.
- **The parent holds the entire story.** From the parent road (and its overworld node) the founder
  sees a **full-story roll-up**: own milestones plus recursively rolled-up descendant state (e.g.
  *own 10/13 + descendants 12/18*). Session tracing follows the same rule — a road's full-story
  session trace is its own `sessions.json` UNION every descendant's, deduped by session id, counts
  summed, each attributed to the road(s) it touched. The root answers both *"where is everything?"*
  and *"who built all of it?"*.

A promoted road earns its own **world** on the family-tree overworld the moment it is registered, so
the founder can reach it directly from the world-select screen as well as through the portal node.

Promotion is a plan change: log it as a decision and get founder approval first. `session_hello`
etiquette is unchanged — say hello on every road you write to, child roads included.

## Multiple simultaneous sessions

All mutations through the UI server or MCP server are serialized by a cross-process lock
(`.questlog/.lock/`), with atomic file writes and stale-lock reclamation — any number of
sessions and browser tabs are safe at that level. Two edits to the **same record** do not silently
resolve: a write whose basis is a version that is no longer current is **HELD** — never applied,
never discarded — and waits on a founder ruling. Read the holds with `conflict_list`, show the
founder both versions, and record their ruling with `conflict_resolve`. The central app changes
nothing here: each roadmap keeps its **own** `.questlog/.lock`, so the one central server locks
roads independently and interoperates with
dir-mode and MCP servers pointed at the same road. The registry has a **separate** lock of its own,
never nested with a roadmap lock (`sessions.json` rides its roadmap's mutation lock, never a
new one). The etiquette that follows:

- **Working alone** (one session): direct file edits or MCP tools, either is fine.
- **Multiple sessions writing** (or any doubt): MCP tools ONLY — direct file edits bypass the
  lock and can race.
- **Deletions are tool territory** — `milestone_delete`, `item_delete`, `quest_delete`, or the
  board's delete button. They take the same lock, refuse a delete with dependents unless `force`,
  scrub the dead id out of the other files, and bank the removed record in history. Hand-deleting
  while another session writes is the one reliable way to leave the road invalid.

## Encoding rule (hard-won, three incidents)

Every HTML page ships `<meta charset="utf-8">` as its first line, AND every server response
declares `charset=utf-8` in its Content-Type header. Never rely on browser guessing — on
Windows the fallback is Windows-1252 and every checkmark and emoji becomes mojibake (e.g.
`âœ“` for a checkmark). When writing files from PowerShell or Python on Windows, always pass
an explicit utf-8 encoding.
