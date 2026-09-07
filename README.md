# Questlog

A **shared, living roadmap** for a project — a dashboard you and an AI agent co-manage, laid
out as a winding **road** of milestone nodes with **side quests** branching off. Track progress,
log decisions the founder approves before the agent acts on them, leave and refine explanations
on milestone cards, and pin compactions with a synthesized resource doc.

It is **generic**: every project gets its own `<projectRoot>/.questlog/` data — nothing about any
particular project is baked in, and the server binds `127.0.0.1` only. The journey this is built
against, founder rulings and all, is [docs/user-journey.md](docs/user-journey.md).

**Requires Node.js 18 or newer and Claude Code.** Nothing else — zero npm dependencies, no build
step, no network calls.

![road of milestone nodes with side-quest spurs and compaction pins]
<!-- The dashboard renders a parchment world-map: a winding dirt road of status-colored nodes,
     side-quest spurs off main-quest milestones, and diamond compaction pins. -->

## Install

Two commands in Claude Code, once per machine:

```
/plugin marketplace add yassine-codes/questlog
/plugin install questlog@questlog
```

Then `/reload-plugins`. The repo root is **both** the marketplace and the plugin — the marketplace
entry's source is the marketplace root itself — so there is no subdirectory to remember and nothing
gets cloned twice. The same two from a terminal:

```
claude plugin marketplace add yassine-codes/questlog
claude plugin install questlog@questlog
```

That one install wires all of it:

- **The MCP server, once for every project.** `.mcp.json` starts `mcp/server.mjs` with
  `QUESTLOG_DIR` set to `${CLAUDE_PROJECT_DIR}`, so the server resolves whichever project you have
  open. No per-project `claude mcp add`, no `--dir`.
- **The four hooks** from `hooks/hooks.json` — `PreCompact` (pin the compaction), `SessionStart`
  (check in and brief), `Stop` (nudge if the board was never touched), and a `PostToolUse` pulse.
- **The skills**, namespaced by the plugin: `/questlog:questlog` (the road, the method, the rules),
  `/questlog:chief-of-staff` (one coordinator standing over every road), and `/questlog:reskin`
  (theme the dashboard after a game you like).
- **The commands** `/questlog:open` and `/questlog:handoff`.

**Hacking on a checkout** rather than installing: point Claude Code straight at it, no marketplace
involved.

```
claude --plugin-dir <checkout>
```

Do development that way — `claude --plugin-dir <checkout>` — and not from an installed copy as
well: with both live, the checkout and the plugin cache take turns restarting each other's server.
After a version bump, run `/plugin update` so the cache catches up.

## Your first session

Open a project that has **no road**. The session-start hook says one line and takes no action:

> Questlog is here. No road in this project yet — say "start a road" when you want one.

It creates nothing. Silence would let you forget the plugin is installed; a `.questlog/` directory
appearing in every repo you open would be hostile.

**Say "start a road"** and the skill interviews you: what the project is (a name and a tagline in
your own words), what done looks like (it becomes the last milestone, so it has to be something you
could point at and agree was finished), and the first three to five milestones. **A conversation,
not a wizard** — it asks in prose, reads the road back to you in one screen, and waits for a yes
before writing anything. On the yes it seeds `<projectRoot>/.questlog/`, registers the road in the
Overworld, and validates it.

In a project that **has** a road, the same hook checks the session in and injects a briefing: what
is blocked and why, the unclear queue in drain order, decisions awaiting approval, approved
decisions that name no milestone, save-points still waiting on synthesis, and the freshest baton.
It closes with two lines that survive truncation — a **coverage line** naming how many milestones,
decisions and horizon suggestions the road actually holds, so a session never mistakes the
briefing's slice for the whole board, and the map: **the agent offers `/questlog:open` at every
session start**, not only when something is wrong.

## Open the map

`/questlog:open` runs `desktop/launch.mjs` — zero-dependency Node, so Windows, macOS and Linux take
the same three steps.

1. **Resolve the port**: `--port` > `QUESTLOG_PORT` > `port` in `~/.questlog/config.json` > `4177`.
2. **Health-check it.** Nothing answering → cold-start `server.mjs` in **central mode** (the
   Overworld), detached, so the server outlives the command that started it. A server whose
   `/api/version` source hash differs from the code on disk has **drifted** and is restarted onto it.
3. **Open the dashboard** — an app-mode window (no tab strip, no address bar; it reads as the app it
   is) where Edge, Chrome or Chromium is found, and a plain tab through `start` / `open` /
   `xdg-open` where none is.

**The restart is always graceful, and never a force-kill.** The launcher asks the running server to
stop with `POST /api/shutdown`, waits for the port to free, then cold-starts the current code. A
server that does **not** answer shutdown is **opened as-is, untouched**. A server that does not
report `/api/version` at all is running code from before that endpoint existed — it is treated as
**maximally stale** and takes the same graceful path. A port answered by something that is not
Questlog gets a message and exit 2. Nothing is ever killed by name or by pid.

Exit codes: `0` started or opened, `1` the server never came up, `2` a foreign listener. The
launcher appends a small diary to `~/.questlog/launcher.log`, and `--silent` starts or checks the
server without opening anything — which is what the autostart entry passes.

On Windows, `desktop/Questlog.cmd` is a one-line double-click wrapper over that same launcher, and
`desktop/make-shortcut.ps1` drops a **`Questlog` Desktop shortcut** on it (current user, no admin,
no registry beyond the `.lnk`). Optional **autostart** ("start with Windows") is a single `.vbs`
file the settings panel writes into your Startup folder — no admin, no Task Scheduler; toggling it
off deletes the file.

Running the server by hand, without the plugin, is still just Node:

```
node server.mjs --dir seeds/sample-project --port 4177   # one project — the bundled demo seed
node server.mjs --port 4180                         # central mode: the Overworld
```

Point `--dir` at any folder to start a **new** project's roadmap: the first write creates
`<folder>/.questlog/` with valid skeleton files (a `q-main` quest, project name = folder name). The
page polls `/api/state` every 2 s and re-renders on change, so MCP edits and founder clicks show up
live.

### Settings & config file

Instead of environment-variable rituals, a `~/.questlog/config.json` (same folder as
`registry.json`) holds `port`, `autostart`, and the bridge switches
(`bridge.enabled` / `bridge.dryRun` / `bridge.model` / `bridge.autoTrigger`). Edit it from the
**gear (⚙) panel** in the dashboard header — plain-language checkboxes and selects, including an
*"act on each note right away"* box for `bridge.autoTrigger` (off = the batch "Send to agent" model).
The server reads `port` at startup (a port change asks for a restart); the **bridge re-reads its
config on every trigger and dispatch**, so flipping any helper switch in the panel needs no restart.
**Environment variables still win** when set (documented back-compat), and the panel greys any field
an env var is currently overriding. Fresh installs default to **bridge off, dry-run on,
auto-trigger off** — the helper's live switch is the founder's to flip and no one else's.

## Commit your .questlog/

**A project commits its road.** The server binds `127.0.0.1` only, so a teammate sees your road
solely by having the files — that is the entire sharing mechanism. Check `.questlog/` into git
beside the code it describes and a teammate who clones the repo opens the same road you do.

The Questlog engine repo ignores its *own* `.questlog/`, and that is not a counter-example: the
engine should not ship its dogfood data to everyone who installs it. Your project is not the engine.

## What it is made of

- **Data** — plain files under `<projectRoot>/.questlog/`: `roadmap.json`, `decisions.json`,
  `pins.json`, `history.jsonl` (plus optional `glossary.json` and `sessions.json`). **These
  files are the source of truth.**
- **MCP server** (`mcp/server.mjs`) — a convenience layer of **30 tools** over those files.
  Hand-rolled stdio JSON-RPC 2.0, no SDK.
  - **Reads** — `roadmap_get` (the whole road or one slice), `list_unclear`, `baton_peek`,
    `roadmap_list` (the registry: every registered road with progress and freshness),
    `history_tail` (an honest, filterable history window), and `conflict_list` (the colliding
    writes held on this road).
  - **Writes** — `milestone_upsert`, `milestone_set_status`, `quest_create`, `item_upsert`,
    `item_note_add`, `asset_link`, `decision_log`, `decision_set_approval`, `pin_compaction`.
  - **The delete trio** — `milestone_delete`, `item_delete`, `quest_delete`.
  - **The conflict pair** — `conflict_list` reads the holds, `conflict_resolve` records the ruling.
  - **The jargon-proofing pair** — `clear_unclear`, `glossary_term_upsert`.
  - **The handoff trio** — `baton_pass`, `baton_read`, `brief_create`.
  - **The horizon trio** — `suggestions_upsert`, `suggestion_promote`, `suggestion_dismiss`.
  - **The central-app trio** — `session_hello`, `roadmap_register`, `roadmap_set_origin`.
- **Dashboard** (`server.mjs` + `index.html`) — a local web UI the founder opens to see the road,
  expand milestone cards, read explanations, reply with notes, and flag anything unclear. Decisions
  are **displayed** here (approvals happen in chat, not by a button — see **Bridge** and the data
  contract). Run it with `--dir` for a single project, or with no argument as a **central app** that
  lists every registered roadmap as an overworld of worlds (see **Central app** below).
- **Validator** (`schema/validate.mjs`) — checks a `.questlog/` dir against the data contract,
  and lints every text field for undefined jargon (see **Jargon-proofing** below).
- **Glossary** (optional `<projectRoot>/.questlog/glossary.json`) — per-project jargon dictionary
  the UI reads to underline known terms and the validator uses to fail undefined ones. Absent = no
  underlines, lint prints a warning and passes.

The MCP server and UI are **conveniences, never gatekeepers**. Any agent can Read/Edit the JSON
files directly (data-contract §4 documents the lock + atomic-write + history protocol to honor).

## Central app — one door, many worlds

Run `server.mjs` with **no** `--dir` argument and it starts in **central mode**: one server,
one port, serving a world-select **overworld** — a chunky level-select screen with one card per
registered roadmap (name, tagline, progress fraction, status dot, session count, last-updated).

```
node server.mjs --port 4180        # central mode (no --dir); reads the registry
```

- Clicking a world enters its road at `/r/<roadmapId>`; the browser Back button returns to the
  overworld, and a header switcher hops between roadmaps from inside a road.
- **Mode selection:** passing `--dir`/`--data` **or** setting `QUESTLOG_DIR` starts the existing
  single-project **dir mode** (unchanged, zero-config, back-compatible). Everything else starts
  central mode. A single-project dir server also **auto-registers** itself in the registry on
  startup, so `--dir` projects show up in the overworld automatically.

### The roadmap registry

Central mode reads a **user-level registry** at `~/.questlog/registry.json` (override the path
with the `QUESTLOG_REGISTRY` environment variable; the parent directory is created on demand).
Each entry is `{id, name, dir, addedAt, lastSeenAt}` plus an **optional `origin`** edge (see
**Roadmap family tree** below). Three ways to register a roadmap:

1. **MCP tool** — `roadmap_register(dir?, originRoadmapId?, originMilestoneId?)` (dir defaults to
   the server's project root; origin args are optional and both-or-neither).
2. **Auto-registration** — any `server.mjs --dir <project>` upserts its own entry at startup.
3. **Direct edit** — add an entry to `registry.json` by hand.

Registration upserts **by resolved absolute path** — no duplicates. A registered directory that
no longer exists is shown **greyed with a `MISSING` badge**, never a crash. See
`schema/registry.schema.json` and `schema/README.md` for the full contract.

### Roadmap family tree — origin edges

A roadmap can **branch off** another. When a side quest grows up into its own roadmap, that
promotion **births a child** rather than an orphan: the new road records where it came from. A
registry entry may carry an optional `origin`:

```jsonc
{
  "id": "rm-questlog", "name": "Questlog", "dir": "…", "addedAt": "…", "lastSeenAt": "…",
  "origin": {                              // absent OR null = a ROOT roadmap
    "roadmapId": "rm-atlas-platform",      // registry id of the PARENT road
    "milestoneId": "ms-portal-questlog",   // the portal milestone IN THE PARENT (any quest)
    "ts": "2026-07-21T12:00:00.000Z",      // when the edge was recorded (server-set)
    "sessionId": "4c1f0b2e-…"              // OPTIONAL — the AI session that recorded it
  }
}
```

`origin` is **registry-only operator data** — it is not jargon-linted and carries no `plain`
field. The edge is **permanent**: the parent's world holds the whole story of its descendants
(counts and sessions roll up recursively), and on a parent road each child's **portal milestone**
becomes a **live mirror** computed at serve time from the child's own data — the child stays the
single source of truth, so the mirror can never drift.

Two MCP tools maintain the edge (both write the registry only — no `.questlog` files, no history
event):

- **`roadmap_register(dir?, originRoadmapId?, originMilestoneId?, sessionId?)`** — origin args are
  **both-or-neither**. Register only **sets** an origin when the entry has none; a matching origin
  is a no-op and a **different** origin is refused (register never silently re-parents).
- **`roadmap_set_origin(dirOrId, originRoadmapId, originMilestoneId?, sessionId?)`** — the explicit
  retrofit/correction tool. `dirOrId` resolves by registry id (`rm-…`) or by directory path.
  It **overwrites** an existing origin; pass `originRoadmapId: null` to **clear** the edge (make
  the road a root again).

Both reject a **self-edge** (a road cannot be its own origin) and a **cycle** (an origin whose
parent chain leads back to the road), and require the parent id to already be in the registry.
An origin whose parent later leaves the registry becomes a tolerated **orphan** — a greyed edge on
the overworld, never a crash. `schemaVersion` stays `1`; entries without `origin` are roots, so
existing registries load unchanged.

### Session tracing

Every roadmap records which AI sessions contributed to it. Each `.questlog/` gains an optional
`sessions.json` — `{schemaVersion, sessions:[{id, firstSeenAt, lastSeenAt, label, eventCount}]}` —
and every `history.jsonl` event may carry an optional `sessionId`. The MCP server resolves the
session id, per mutating call, from (in order): an explicit `sessionId` tool argument, a
`session_hello(sessionId, label?)` call made once at session start (cached for the process
lifetime), or the `CLAUDE_SESSION_ID` environment variable. Every stamped MCP/UI mutation bumps
that session's counters inside the same lock as the write. The dashboard shows a **Contributing
sessions** panel per road (and a session count on each overworld card).

**Back-compat:** a missing `sessions.json` is an empty panel and produces **no** validator output;
old data with no `sessionId` on its events keeps loading unchanged. `schemaVersion` stays `1`.

## The plugin registers the MCP server

Installing the plugin is the whole registration. Its `.mcp.json` starts the server once for every
project and resolves the road from the environment rather than from a per-project `--dir`:

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

`${CLAUDE_PLUGIN_ROOT}` is the installed plugin's own directory — under `~/.claude/plugins/cache/…`
for a marketplace install, or your own checkout when you started Claude Code with `--plugin-dir`.
For a bare checkout used **without** the plugin, register it by hand with that path written out:

```
claude mcp add questlog -- node <plugin-root>/mcp/server.mjs --dir <projectRoot>
```

The MCP server honors `QUESTLOG_DIR` (default: cwd). Handshake is `initialize` → `tools/list` →
`tools/call`. Every mutation acquires a lock, writes atomically, and appends one `history.jsonl`
event. See `skills/questlog/references/data-contract.md` §3 for the full tool surface.

## Validate a project's data

```
node schema/validate.mjs --dir <projectRoot>
```

Exit 0 = valid; exit 1 prints every error (structure, enums, id regex, uniqueness, referential
integrity, decision-approval invariant, one-level side-quest branching, blocked-reason rule).

## Selftests

Fifteen of them, zero-dep, all from the app root on plain Node. Each one works on a temp copy of
the data and, where it needs a server, binds a port of its own — none of them touches a live road.

```
node currency.selftest.mjs          # evidence, claims-complete and the launch gate
node features.selftest.mjs          # horizon trees, request-more, promote/demote, expand-in-place
node layout-engine.selftest.mjs     # the road layout invariants, box by box
node sidecar-adapter.selftest.mjs   # reading a Claude Code sidecar transcript
node encoding.selftest.mjs          # every reply and every page declares utf-8
node delete.selftest.mjs            # the board deletes the same way the tools do
node conflict.selftest.mjs          # a colliding write is held, and the ruling applies it
node privacy.selftest.mjs           # no private marker in any tracked file
node chat.selftest.mjs              # the chat dock end to end, without spawning a model
node continuity.selftest.mjs        # batons, the roster and resuming a session
node config.selftest.mjs            # /api/config, /api/version, /api/shutdown and autostart
node registry.selftest.mjs          # registry hygiene, and that a read tool never writes
node bridge.selftest.mjs            # the bridge's containment: debounce, kill switch, env hygiene
node batch.selftest.mjs             # one dispatch, one session: the batch prompt and its worklist
node dispatch.selftest.mjs          # a dispatch end to end, notes marked and un-marked
```

Every one of them runs on a fresh clone. The road they read is
`seeds/sample-project`, which ships with the repo, so none of this needs data that only one laptop
has. Four of them read more when there is more to read: `currency`, `features` and `layout-engine`
also sweep every road registered in your Overworld, read-only and through temp copies, and
`sidecar-adapter` sweeps whatever Claude Code transcripts this checkout has accumulated. When there
is nothing to sweep they print a `SKIP` line naming what was missing and stay green — a selftest
that goes red because it is on somebody else's machine is telling you about the machine, not the
code.

The encoding one reads the source as well as running it: it scans every `res.writeHead(` in the
repo and fails by file and line if a reply would ship without a charset. Several of the others read
the source the same way — chat's render checks lift `itemCard()` straight out of `index.html` and
run it, and registry's handshake check reads the version out of `mcp/server.mjs` rather than
pinning a number that would go stale.

The privacy one reads only the source: it walks `git ls-files` and fails by file and line on any
private marker — a name, a handle, an absolute home path, a real session id, a key shape. Its
marker table lives inside the test, because a table kept anywhere else is one somebody forgets to
ship.

The first eight print only failures unless given `--verbose` (the sidecar-adapter one has no such
flag). The last seven name every assertion as they go, always — they were written to be read while
they ran, and that is worth keeping.

Those last seven spent their lives under `docs/`, in the folders that held the proof runs they were
written alongside. The proofs were made out of a real road and left with it; the tests were real
and current, so they moved up here to sit beside their siblings.

## Jargon-proofing

Agents save tokens by leaning on abbreviations and codenames; the founder can't keep up. Questlog
makes undefined jargon **mechanically invalid** and gives the founder plain-language escape hatches.
Four pieces work together, all back-compatible (`schemaVersion` stays **1**; every new field is
optional, so old data keeps loading):

1. **Glossary as data** — `<projectRoot>/.questlog/glossary.json` holds `terms`, each with an
   `id` (prefix `term-`), a canonical `term`, optional `aliases`, a one-sentence `plain` meaning,
   an optional longer `note`, and an optional `link`. The dashboard underlines any known term or
   alias wherever text renders and shows the plain meaning on hover/tap. Matching is
   word-boundary, case-sensitive for ALL-CAPS terms (e.g. `KV`, `Q3`) and case-insensitive
   otherwise (e.g. `wrangler`, `PixelKit`).

2. **Plain field + toggle** — milestones, quests, items, and decisions gain an optional `plain`
   text field (human register, no abbreviations). The dashboard's **Plain English** toggle swaps
   the descriptive text dashboard-wide; records missing a `plain` value show their normal text plus
   a subtle "(no plain version yet)" marker. Titles never swap — they are de-jargoned by glossary
   underlines instead.

3. **Jargon lint** — `node schema/validate.mjs --dir <projectRoot>` scans every text field for
   ALL-CAPS acronyms (2+ chars, minus a small stoplist like `API`/`URL`/`JSON`/`MCP`/`UI`/`ID`)
   and `[[bracketed-codenames]]`. Any hit not defined in `glossary.json` (as a term or alias) is a
   validation **ERROR** naming the exact token and location, exit 1. A missing `glossary.json`
   prints `WARNING: no glossary.json — jargon lint skipped` and passes.

4. **Unclear flag loop** — every milestone, item, and decision card has a one-click "unclear"
   button. The founder flags anything they don't understand; the agent drains the queue.

### API surface (jargon-proofing)

- `GET /api/state` gains a `glossary` key (the file content, or `{schemaVersion:1, terms:[]}` when
  absent), so the UI can underline terms. `rev` now also tracks `glossary.json`'s mtime, so glossary
  edits trigger a re-render. Older servers omit the key; the UI treats `undefined` as "no underlines".
- `POST /api/unclear` — the toggle. Body `{"targetType":"milestone"|"item"|"decision","id":"…",
  "unclear":true|false}`. Under the usual lock it sets `unclear` (+ `unclearAt` timestamp when true,
  `null` when false), bumps timestamps, writes atomically, and appends one `ui_unclear_set` history
  event. Returns the full updated record; `400` on a bad payload, `404` when the id is unknown.
- `POST /api/file/glossary` — the escape hatch now also accepts a full `glossary.json` overwrite.

### Deleting from the board

The MCP tools could always delete; the dashboard could not, so taking a milestone, a side quest or
a card off the road meant opening `roadmap.json` in an editor. Both surfaces now run the same rules
— `deletion.mjs` owns the dependent story, the cascade, and the reference scrub — and differ only
in how they report.

- `POST /api/delete` (dir mode) / `POST /api/r/<id>/delete` (central mode). Body
  `{"targetType":"milestone"|"item"|"quest","id":"…","force":false}`. Under the usual lock it
  removes the record, writes atomically, and appends exactly one history event —
  `ui_milestone_delete`, `ui_item_delete` or `ui_quest_delete` — whose `patch` carries the FULL
  deleted record plus everything that cascaded, because history is the only recovery path.
  Returns `{deleted, cascaded, scrubbed}`.
- **Nothing travels alone silently.** A milestone holding items, assets or side quests — or a quest
  holding milestones — answers `409 {"error":"E_CONFLICT", "message":…, "dependents":[{id,type,
  title}, …]}` and changes nothing. Only a literal `"force":true` cascades. The dashboard renders
  that list and asks a second time; the founder decides whether the whole branch goes.
- **The scrub.** A deleted `ms-`/`q-` id is referenced from `decisions.json`, `pins.json` and
  `suggestions.json`, and the validator errors on every dangling one. So the delete owns the
  cleanup: a decision loses the dead link but survives (the judgement was still made), a pin loses
  its anchor and floats to the road start (`afterMilestoneId: null`), and a suggestion anchored to
  something that no longer exists is dropped. What was scrubbed rides in the history event too.
- `400` on a bad `targetType` or id, or on the main quest (which is never deletable); `404` when the
  id is unknown. The UI never calls this without a two-step inline confirm first — no browser
  dialog, per the house rule for founder-facing destructive controls.

### MCP tools (jargon-proofing)

- `list_unclear` — read-only. Returns every flagged milestone/item/decision, oldest first (drain
  order), each with its current text, `plain`, and founder context (item note threads, parent
  milestone). No history event.
- `clear_unclear` — input `{id, rewritten_plain}` (`targetType` inferred from the id prefix). Sets
  the record's `plain` to the rewrite, clears `unclear`/`unclearAt`, and appends a `clear_unclear`
  event. Errors if the record is not currently flagged.
- `glossary_term_upsert` — input `{id?, term, plain, aliases?, note?, link?}`. Creates a term (omit
  `id`) or merges into an existing one, enforcing that no surface form (term or alias) is duplicated
  across the glossary. Appends a `glossary_term_upsert` event.
- `milestone_upsert`, `item_upsert`, `decision_log`, `quest_create` each gain an optional `plain`
  parameter (and `quest_create` also accepts `plain` on inline milestones). `roadmap_get`'s
  `section` enum gains `"glossary"`, returning the `terms` array.

The agent workflow (check `list_unclear` at session start, never write a card without a `plain`,
register any new term before first use) is enforced by the Questlog skill's rules.

## Colliding writes become a ruling

**The founder's ruling, 2026-08-27.** When two writers change the same record, questlog does **not**
keep whichever landed last. The second change is **held** — applied to nothing and discarded by
nothing — and surfaces as a decision showing **both** versions, for the founder to make the call.
While a hold is open the **first** write stands as current, so the board stays readable rather than
frozen, and the second sits on the card as a contested change. A warning shown after the loss is
explicitly not acceptable: in the founder's words, that *"is not a decision, it is a receipt."*

This follows the standing governing principle, quoted from the project's own decision log:
*automate observation and absence-detection, instruct interpretation.* The machinery detects the
collision; judgement resolves it. Nothing here decides anything on the founder's behalf.

### How a collision is detected

A write is stale when the version it was **based on** is no longer the version on disk — not merely
when two writes happened. That version is a content hash derived at read time and stored **nowhere**:

```js
recordVersion(rec) = sha1(JSON.stringify(rec)).slice(0, 12)   // conflicts.mjs
```

Both servers import the one function, so they cannot disagree about what stale means. It beats
`updatedAt` twice over: it catches a hand edit that forgot to bump one, and it covers decisions,
which carry no `updatedAt` at all.

**Nothing is added to `roadmap.json`** — no version field, no contested marker on any record. The
versions are served as their own `versions` key on `GET /api/state`, and the holds live in their own
file, `.questlog/conflicts.json` (absent until something collides).

Where a writer's basis comes from:

- **The dashboard** sends `baseVersion` with every write it makes, read from the `versions` map the
  state poll just handed it. The drawer re-renders on each poll, so the basis is always the version
  actually on screen.
- **An MCP caller** may state one outright: every guarded tool takes an optional `baseVersion`.
- **Otherwise** the MCP server uses what *this process* last served for that id (`roadmap_get` on its
  own road, `list_unclear`, and every successful write). One MCP process is one agent session, so
  "what this process last read" is exactly "the version this writer based its change on".
- **A write with no basis at all** — never read here, no `baseVersion` — is a **blind write** and goes
  through unchanged. That is documented back-compat, not an oversight: a direct file edit by hand
  carries no basis either, and pretending otherwise would be a lie rather than a safeguard.

### What a hold looks like

Detection and hold are **one critical section**, inside the write's existing lock, or two stale
writers could both believe they were first. The road file is not written; `conflicts.json` gains one
entry carrying both whole records, and history gains a `conflict_held` event.

- **MCP** answers `E_CONTESTED` — deliberately not `E_CONFLICT`, which delete already owns with the
  meaning "this record has dependents". The message carries the conflict id, both versions as JSON,
  and the sentence *"Held, not applied and not discarded. Raise it with the founder as a decision
  showing both versions, then call `conflict_resolve` with the ruling."*
- **The dashboard** gets `409 {"error":"E_CONTESTED","conflict":{…}}` and treats it as a soft outcome:
  no dialog, no alert. The header grows a **⚖ n contested** badge, the card grows a contested line,
  and the conflict view lists the argument with the two versions side by side — **Standing (first
  write)** against **Held (second write)**, only the fields that actually differ.

### Giving the ruling

Two ways, one file, same result:

- **In the browser** — the ⚖ badge opens the conflict view; each open hold offers *Keep the standing
  version* / *Apply the held version* behind the same two-step strip the delete control uses.
- **In chat** — `conflict_list` reads the holds, `conflict_resolve {id, keep}` records the ruling.

`keep:"current"` lets the first write stand. `keep:"held"` writes the held version over the record —
the **whole** record, exactly as it was shown side by side, not a field merge. A held *delete* is
re-run at ruling time against today's road: if dependents appeared while the hold sat open, the
ruling fails with that list and the conflict stays open, honestly, rather than taking more than the
founder agreed to. Either way both versions stay on record with the ruling written next to them
(`conflict_ruled`). Deleting a contested record voids its open holds (`conflict_void`) — there is
nothing left to argue about, and an open hold on a missing record is a validation error.

**A held glossary term can be ruled on from the board too.** The dashboard's apply path branched on
a decision and on the roadmap and on nothing else, so *Apply the held version* on a contested term
answered `404 E_NOT_FOUND` and left the hold open, while the identical ruling through
`conflict_resolve` succeeded. It swaps the term whole now — the same swap the tool does, through the
same lock and history path — and `conflict.selftest.mjs` holds it there.

### The escape hatch refuses instead

`POST /api/file/<name>` overwrites a whole file, so there is no single record to show two versions of
and no card to sit a contested change on. It takes an optional `?baseRev=<rev>` instead: when it does
not match `GET /api/state`'s `rev`, the write is refused with `409 {"error":"E_STALE","rev":…}`
**before** the loss. Absent `baseRev` = today's behaviour, unchanged.

### What is exempt, and why

Each of these says so in a comment at its own site:

- **Appends never collide.** `POST /api/note` and `item_note_add` add to a thread; two notes on one
  card are two notes, not one lost note.
- **Create paths.** There is no prior version to have been stale against.
- **`quest_create`, `suggestions_upsert`/`promote`/`dismiss`.** New records, and the horizon file is
  agent-only.
- **`/api/promote` and `/api/demote`, and the MCP delete tools.** Structural multi-record moves, and
  deletes entered from the tool side. **A known gap, stated rather than hidden** — the dashboard's
  delete *is* guarded, and every delete path voids the holds on what it removes.
- **config, skins, the task board.** Not road data.

## Bridge (prototype, off by default)

The bridge lets founder notes become a background roadmap update. Rather than each note or
`unclear` flag spawning its own run, they **accumulate as pending work**: the founder goes over the
whole roadmap — leaving notes, tapping Unclear — then presses **one** central **"Send to agent"**
button. The server assembles every pending note and standing flag into **one structured worklist**
(one entry per card, with its milestone/quest context, current text, all undispatched founder notes
verbatim, and its unclear flag) and spawns **one** cheap headless Claude (Sonnet) session that works
the list in order, rewriting each card through the questlog tools — no chat window, no clicking
approve on each step. One dispatch = one session for the whole list; on success-start the consumed
notes/flags are marked dispatched, and a failed or timed-out run un-marks them so nothing is lost.
The full feasibility write-up is in `docs/bridge-design.md`; the module is `bridge.mjs`; the data +
endpoint contract is in `skills/questlog/references/data-contract.md` §8.

**It is off by default and safe by default.** Nothing spawns unless you turn it on, and
even turned on it starts in a look-but-don't-touch ("practice") mode. The old per-note eager
behavior is still available behind `bridge.autoTrigger` (default off) for anyone who wants it.

### The pending badge and the "Send to agent" button

In the dashboard header a **badge** counts the pending work — undispatched founder notes plus
standing `unclear` flags — and one **"Send to agent"** button dispatches them all. Each waiting
founder note wears a small *"waiting to send"* chip in its thread. Both the badge and button hide
when nothing is pending. Pressing the button `POST`s `/api/dispatch` (dir mode) or
`/api/r/<id>/dispatch` (central mode) with an empty body; the server responds `E_BRIDGE_DISABLED`
(bridge off), `E_BRIDGE_BUSY` (a run already in flight), or `E_NOTHING_PENDING` (nothing waiting),
and otherwise starts the one batch session. In practice ("dry-run") mode it writes the exact command
and full worklist to the log and marks nothing.

### Turning it on

Two environment settings, read once when the server starts:

| Setting | Default | Meaning |
|---|---|---|
| `QUESTLOG_BTW_BRIDGE` | unset (off) | Set to `1` to enable the bridge at all. Anything else and the whole feature is inert — the server behaves exactly as before. (Also `bridge.enabled` in `config.json`.) |
| `QUESTLOG_BTW_DRYRUN` | `1` (dry) | The default even when enabled. In dry mode the server only **writes down the exact command it would run** (plus the full worklist and a context package file) to a log — it spawns nothing, and marks nothing dispatched. Set to `0` to actually run it. (Also `bridge.dryRun`.) |
| `QUESTLOG_BTW_AUTOTRIGGER` | unset (**off**) | `1` restores the old per-note eager behavior (each note/flag starts its own run). Off — the default — is batch-only: notes pile up until you press "Send to agent". (Also `bridge.autoTrigger`.) |

So the first thing that ever happens, once you flip `QUESTLOG_BTW_BRIDGE=1` and press
"Send to agent", is that the dispatch appends one `bridge-dryrun-batch` line and a worklist file
you can read. Going live is the single deliberate step of also setting `QUESTLOG_BTW_DRYRUN=0`.

Optional knobs (all have safe defaults, none required):

| Setting | Default | Meaning |
|---|---|---|
| `QUESTLOG_BTW_DEBOUNCE_MS` | `8000` | (Eager mode only.) How long rapid edits on one card wait and merge into a single run. |
| `QUESTLOG_BTW_TIMEOUT_MS` | scales with batch size | Hard cap on a run; the child is stopped past it. For a batch of N cards the default is `min(900000, 120000 + 60000·(N−1))` ms; setting this pins it. |
| `QUESTLOG_BTW_MODEL` | `sonnet` | The model the background run uses. |
| `QUESTLOG_BTW_MAX_TURNS` | scales with batch size | A second cap against a run that loops. For N cards the default is `min(60, max(8, 4 + 4·N))`; setting this pins it. |
| `QUESTLOG_BTW_CLAUDE_BIN` | `claude` | The Claude command to run (a full path if it isn't on your `PATH`). |
| `QUESTLOG_BTW_LOG` | `<project>/.questlog/bridge/bridge.log` | Where the founder-readable log goes. |
| `QUESTLOG_BTW_KILL` | `<project>/.questlog/bridge/KILL` | The kill-switch file (see below). |

### The kill switch

Create the kill-switch file (by default `<project>/.questlog/bridge/KILL`, any contents)
and the bridge stops: a pending run is abandoned before it starts, and a run already in
flight is told to quit. Delete the file to allow runs again. It is a plain file so the
founder can make or remove it with anything — no command needed.

### What keeps it contained

Every one of these is enforced in `bridge.mjs`, not just advised:

- **Off unless asked.** No flag, no bridge.
- **Dry by default.** Enabled still means "write the command down," not "run it," until you say so.
- **One at a time.** Only one background run happens at once; a dispatch while one is in flight is refused (`E_BRIDGE_BUSY`), never parallelized.
- **Nothing lost on failure.** A live dispatch marks its notes/flags dispatched at success-start; a run that times out, errors, or is killed un-marks exactly its own cards (the pending work returns to the waiting list) and logs `dispatch_failed`.
- **It always stops.** A hard time limit and a turn limit (both scaling with the batch size) end a run that overruns; the kill switch ends it on demand.
- **Clean, top-level run.** The child is started from a throwaway temporary folder with every Claude/agent environment variable stripped, so it is never a nested run.
- **Narrow reach.** The child is given **only** the questlog tools it needs plus read access, and **only** the questlog tool server pointed at this one project — it cannot see your other tool servers, run shell commands, or edit files outside the project's `.questlog`. Its one and only way to change anything is the questlog server, which only ever writes inside `<project>/.questlog/`.
- **Always attributed.** The run checks in as a session labeled `bridge`, so every change it makes shows up in that road's Contributing Sessions panel, plainly marked as bridge-authored rather than founder- or you-authored.

The exact command the bridge builds, with each part explained, lives in the "Bridge"
section of the questlog skill (`SKILL.md`).

## Desktop app

The double-click survives, and it is thinner than it was: `desktop/Questlog.cmd`,
`desktop/make-shortcut.ps1` and the icon generator are Windows conveniences wrapped around the one
cross-platform launcher described under **Open the map** above. **The single executable is retired;
the plugin plus `/questlog:open` is the one path.**

## Updating

Bump `version` in `.claude-plugin/plugin.json`. Claude Code uses that version as its cache key, so
users pick the new code up on `/plugin update`. Nothing else — no build, no publish step, no
artifact to ship.

## At release

Make the repository public and bump `version` in `.claude-plugin/plugin.json`. The version is the
cache key, so that bump is the whole release.

## Layout

```
questlog/
  .claude-plugin/
    plugin.json         # the plugin manifest — name, version, license, repository
    marketplace.json    # one entry, source "./" — the repo root is the plugin root
  .mcp.json             # registers mcp/server.mjs, QUESTLOG_DIR=${CLAUDE_PROJECT_DIR}
  index.html            # single-file dashboard (inline CSS/JS, no CDN)
  server.mjs            # UI server + JSON API (127.0.0.1 only); dir mode or central mode
  bridge.mjs            # "/btw" bridge (prototype) — off by default; see the Bridge section
  mcp/server.mjs        # MCP server (stdio JSON-RPC, 30 tools)
  hooks/
    hooks.json          # the four hook registrations, ${CLAUDE_PLUGIN_ROOT}-relative
    sessionstart.mjs    # check in + brief, or one line on a project with no road
    precompact.mjs      # drop a save-point pin before the transcript is compacted
    stop.mjs            # up to three gentle nudges when a session stops
    posttooluse-pulse.mjs  # heartbeat + focus line on the session's row
    lib.mjs             # shared hook plumbing (ctx, lock, history)
  skills/
    questlog/           # /questlog:questlog — the road, the method, the rules
    chief-of-staff/     # /questlog:chief-of-staff — one coordinator over every road
    reskin/             # /questlog:reskin — theme the dashboard after a game
  commands/
    open.md             # /questlog:open — start the server if needed, open the Overworld
    handoff.md          # /questlog:handoff — bank a baton before stopping or compacting
  schema/               # JSON schemas + validate.mjs + README
  desktop/              # optional no-terminal conveniences
    launch.mjs          # the launcher: health-check, graceful drift restart, open the map
    Questlog.cmd        # one-line double-click wrapper over launch.mjs
    make-shortcut.ps1   # one-time: create the Questlog Desktop shortcut
    make-ico.mjs        # generate questlog.ico from the favicon design
  skins/                # built-in dashboard skins
  docs/
    user-journey.md     # the journey this is built against — every founder ruling
    bridge-design.md    # the bridge feasibility write-up
  seeds/
    sample-project/     # the demo road every selftest also runs on
  LICENSE               # MIT
```

## License

MIT — see [LICENSE](LICENSE).
