# questlog data schema

Every questlog project stores its state as plain files under `<projectRoot>/.questlog/`:

```
<projectRoot>/.questlog/
  roadmap.json     # project meta + quests + milestones + items + assets
  decisions.json   # decision log (the approval gate)
  pins.json        # compaction pins
  glossary.json    # OPTIONAL jargon glossary (id, term, aliases, plain meaning)
  sessions.json    # OPTIONAL AI-session ledger (id, first/last seen, label, eventCount)
  conflicts.json   # OPTIONAL held colliding writes, each carrying BOTH versions
  history.jsonl    # append-only audit log, one JSON object per line
```

There is also **one user-global file**, outside any project:

```
~/.questlog/registry.json   # roadmap registry the central dashboard discovers (override with $QUESTLOG_REGISTRY)
```

These files are the **source of truth**. The MCP server and the UI server are
convenience layers over the exact same files — any agent (or a human) may
Read/Edit them directly. `schemaVersion` is `1` in every JSON file.

## Files in this folder

| File | What it is |
|---|---|
| `roadmap.schema.json` | JSON Schema (draft 2020-12) for `roadmap.json` |
| `decisions.schema.json` | JSON Schema for `decisions.json` |
| `pins.schema.json` | JSON Schema for `pins.json` |
| `glossary.schema.json` | JSON Schema for the optional `glossary.json` |
| `sessions.schema.json` | JSON Schema for the optional per-roadmap `sessions.json` |
| `conflicts.schema.json` | JSON Schema for the optional per-roadmap `conflicts.json` (held colliding writes) |
| `registry.schema.json` | JSON Schema for the user-global `~/.questlog/registry.json` |
| `history-event.schema.json` | JSON Schema for **one line** of `history.jsonl` |
| `validate.mjs` | Zero-dependency validator (stdlib only) — enforces structure **and** the cross-file rules below, plus the jargon lint |

`validate.mjs` validates one project's `.questlog/` directory, so it checks
`sessions.json` (when present) but **not** `registry.json` — the registry is a
single user-global file, not part of any project dir. `registry.schema.json` is
provided for external tooling.

The `*.schema.json` files are standard JSON Schema and can be fed to any
validator. But JSON Schema alone cannot express referential integrity
(does this `milestoneId` exist?) or uniqueness across an array — so the
authoritative check is `validate.mjs`, which enforces the full contract.

## Conventions (shared across all files)

- **Timestamps** — ISO-8601 UTC **with milliseconds**: `2026-07-18T14:03:22.000Z`. Field name is always `*At` or `ts`.
- **IDs** — lowercase, match `^[a-z]+-[a-z0-9][a-z0-9-]*$`, unique within their file, prefixed by type:
  `q-` quest, `ms-` milestone, `it-` item, `as-` asset, `note-` note, `dec-` decision, `pin-` pin, `evt-` history event.
  Human-readable slugs are preferred (`ms-setup`); generators may use `<prefix>-<8 hex>`.
- **Status enum** (quests *and* milestones): `locked | available | in_progress | done | blocked`.
- **Item status enum**: `open | done | blocked`. No other values, ever.

## Referential & cross-field rules (enforced by `validate.mjs`)

**roadmap.json**
- Exactly **one** quest has `type: "main"` (its id should be `q-main`).
- A main quest has `parentMilestoneId: null` and `side: null`.
- A side quest has `side: "left" | "right"` and a `parentMilestoneId` pointing at a milestone whose `questId` is the main quest — **one level of branching only** (side quests never branch off other side quests).
- `milestone.questId` must reference an existing quest.
- `milestone.order` is a non-negative integer, **unique within its quest**.
- `item.milestoneId` and `asset.milestoneId` must reference existing milestones.
- A milestone with `status: "blocked"` must have a non-empty `statusReason`.
- An item with `status: "blocked"` must have a non-empty `blockedReason`.
- `note.author` and item threads are chronological; note ids are unique.

**decisions.json**
- Invariant: `approved === true` ⇔ `status === "approved"` (and `approvedAt` is set). When not approved, `approvedAt` is `null`.
- The agent proposes with `approved: false`; only a founder action flips it to `true`.

**pins.json**
- `kind` is always `"compaction"` (future-proofed as an enum).
- `afterMilestoneId` is `null` (start of road) or an existing **main-quest** milestone id.
- `synthesisDocPath` is a path relative to `projectRoot`, or `null` if the post-compaction synthesis doc has not been produced yet.

**history.jsonl**
- One JSON object per line, never rewritten. Each event has `id, ts, actor, source, action, targetId, summary` and an optional `patch` object.
- `actor` ∈ `agent | founder | system`; `source` ∈ `mcp | ui | file`.
- `action` is a **free string** (no enum) — new event types (`ui_unclear_set`, `clear_unclear`, `glossary_term_upsert`, `session_hello`, `conflict_held`, `conflict_ruled`, `conflict_void`, …) need no validator change.
- `targetId` is an entity id or `null`.
- **`sessionId`** (optional) — a non-empty string naming the AI session that produced the event (a UUID is typical, **no** prefix rule). Absent = a pre-central event or an unattributed/founder action. The validator checks type + non-emptiness only.

## Jargon-proofing (glossary, `plain`, `unclear`, lint)

These fields are **all optional** and **back-compatible**: `schemaVersion` stays `1`, absent = old behavior, old data keeps loading unchanged.

### New optional fields

- **`plain`** (string) — on **quests, milestones, items, decisions**. A plain-register restatement of the descriptive text (milestone/quest `summary`, item `body`, decision `rationale`+`impact`). Titles never carry a plain swap — they are map identity and get de-jargoned by glossary underlines instead. Empty string is treated as absent. If present it must be a string.
- **`unclear`** (boolean) + **`unclearAt`** (timestamp|null) — on **milestones, items, decisions** (not quests, not pins). The founder's one-click "I don't understand this" flag.
  - **Invariant:** `unclear === true` ⇒ `unclearAt` is a valid ISO-8601 UTC ms timestamp. `unclear` absent or `false` ⇒ `unclearAt` must be `null` or absent.

### `glossary.json` (optional, per project)

```jsonc
{
  "schemaVersion": 1,
  "terms": [
    {
      "id": "term-sqlite",              // REQUIRED, prefix "term-", unique in file
      "term": "SQLite",                 // REQUIRED non-empty canonical surface form
      "aliases": ["sqlite3"],           // OPTIONAL, default []
      "plain": "The login wall …",      // REQUIRED non-empty, ONE plain sentence
      "note": "Longer context …",       // OPTIONAL, default ""
      "link": null                      // OPTIONAL string|null, default null
    }
  ]
}
```

- **Absent file** → the UI shows no underlines; the validator prints `WARNING: no glossary.json — jargon lint skipped` to stdout and **passes**.
- **Surface-form uniqueness:** across ALL entries, the set of surface forms (`term` + every alias) must have no duplicates. Comparison uses the case rule below.
- **Case rule:** a surface form is **case-sensitive iff it contains no lowercase letter** (`/^[^a-z]*$/`). So `KV`, `Q3`, `SPEC-004` match/compare exactly; `wrangler`, `SQLite`, `the vault` compare case-insensitively.

### Jargon lint (runs only when `glossary.json` exists)

Every prose field is scanned; any undefined jargon is a **validation ERROR (exit 1)**. `history.jsonl` is **never** scanned (append-only past).

- **Scanned fields:** `project.name`/`tagline`; quest `title`/`plain`; milestone `title`/`summary`/`statusReason`/`plain`; item `title`/`body`/`blockedReason`/`plain` + each note `body`; asset `label` (not `ref`); decision `title`/`rationale`/`impact`/`plain`; pin `label`/`summary`; **and glossary `plain`/`note` themselves (dogfooding — a plain meaning may use other *defined* terms, never undefined ones).**
- **Pre-strip:** backtick code spans (`` `…` ``) and bare URLs (`https?://…`) are removed before tokenizing — code is code, not prose.
- **Acronym tokens:** `/\b[A-Z][A-Z0-9-]*[A-Z0-9]\b/g` — catches `KV`, `LCP`, `WSL2`, `Q3`, `SPEC-004`, `CI`. Never matches inside snake_case (`WORKER_QUEUE_NAME` is skipped — `_` is a word char) or mixed-case words (`PixelKit`, `pDNS` are underline-only concerns).
- **Bracket codenames:** `/\[\[([^\[\]]+)\]\]/g` — the inner text must be a glossary surface form.
- **Stoplist** (always allowed, case-sensitive): `OK API URL HTTP HTTPS JSON JSONL MCP UI ID ISO UTC README MIT FAQ HTML CSS JS SVG PNG AI`. Consequence: emphasis-caps words (`HOLD`, `LIVE`, `NEVER`) get flagged — write `**bold**` and lowercase instead.
- **Membership:** a token/codename passes iff it is in the stoplist OR equals a glossary surface (exact for all-caps surfaces, case-insensitive otherwise).
- **Error format** (deduped per `(where, token)`):
  ```
  roadmap.items[it-spec-004].body: jargon "SPEC-004" not in glossary.json (define it or rewrite)
  decisions[dec-x].rationale: codename "[[burst-lane]]" not in glossary.json
  ```

### History event types for this feature (documented, not enum-enforced)

| action | source | actor | patch |
|---|---|---|---|
| `ui_unclear_set` | `ui` | `founder` | `{"unclear": bool}` |
| `clear_unclear` | `mcp` | `agent` | `{"unclear": false}` |
| `glossary_term_upsert` | `mcp` | `agent` | `{"term": "…"}` |
| `session_hello` | `mcp` | `agent` | `{"label": "…"}` |

## Session tracing & the roadmap registry (central app)

Two more optional, back-compatible pieces let one central dashboard serve **many**
roadmaps and record which AI sessions contributed to each. `schemaVersion` stays
`1` everywhere; absent files behave exactly as before.

### `sessions.json` (optional, per project)

Lives at `<projectRoot>/.questlog/sessions.json` next to `roadmap.json`. It is the
per-roadmap ledger of AI work sessions that have written to this road.

```jsonc
{
  "schemaVersion": 1,
  "sessions": [
    {
      "id": "4c1f0b2e-3d5a-4e6f-8a9b-0c1d2e3f4a5b", // REQUIRED free-form non-empty string (UUIDs typical),
                                                     //   NOT the id regex; unique in file; <=200 chars; no control chars
      "firstSeenAt": "2026-07-21T00:00:00.000Z",     // REQUIRED timestamp — first write from this session
      "lastSeenAt": "2026-07-21T00:05:00.000Z",      // REQUIRED timestamp — most recent write
      "label": "founding session",                   // REQUIRED string, may be ""
      "eventCount": 3                                 // REQUIRED integer >= 0 — history events stamped with this id
    }
  ]
}
```

- **Absent file** → the UI shows an empty Contributing-sessions panel and the
  validator emits **nothing at all** (not even a warning — absence is normal).
- **Present file** → validated strictly (structure, timestamps, unique non-empty
  ids, `eventCount >= 0`). A malformed `sessions.json` is a validation **error**.
- Counters are maintained by the MCP server and the UI server: every stamped
  mutation calls `upsertSession(sessionId, label?, +1)` inside the *same* lock as
  the mutation and its `history.jsonl` append, so the count never drifts.

### `~/.questlog/registry.json` (user-global)

The registry lets the central dashboard discover every roadmap on the machine. It
is **not** part of any project's `.questlog/`, so `validate.mjs` does not check it;
`registry.schema.json` is provided for external tooling.

```jsonc
{
  "schemaVersion": 1,
  "roadmaps": [
    {
      "id": "rm-questlog",                       // REQUIRED, prefix "rm-", STABLE (never regenerated for a dir)
      "name": "Questlog",                        // REQUIRED non-empty; refreshed from roadmap.json project.name, else basename
      "dir": "C:\\…\\questlog",                  // REQUIRED absolute, path.resolve()d project root (contains .questlog/)
      "addedAt": "2026-07-21T00:00:00.000Z",     // REQUIRED, set once at first registration
      "lastSeenAt": "2026-07-21T00:00:00.000Z",  // REQUIRED, bumped on every upsert
      "origin": {                                // OPTIONAL — absent OR null = a ROOT roadmap
        "roadmapId": "rm-atlas-platform",        //   REQUIRED, rm- id of the PARENT road it branched from
        "milestoneId": "ms-portal-questlog",     //   REQUIRED, ms- id of the portal milestone IN THE PARENT (any quest)
        "ts": "2026-07-21T12:00:00.000Z",        //   REQUIRED, when the edge was recorded (server-set)
        "sessionId": "4c1f0b2e-…"                //   OPTIONAL, AI session that recorded it (<=200 chars, no control chars)
      }
    }
  ]
}
```

- **Location:** `~/.questlog/registry.json`, overridable with the `QUESTLOG_REGISTRY`
  environment variable. The parent directory is created on demand at first write.
- **Tolerant reads:** a missing or corrupt file is treated as `{schemaVersion:1, roadmaps:[]}`.
- **Upsert by resolved dir** (case-insensitive match on Windows): a repeat
  registration of the same directory updates `lastSeenAt` and refreshes `name` but
  keeps `id`, `addedAt`, and any `origin` — no duplicates.
- **Dead entries are tolerated:** a `dir` that no longer exists is reported
  `missing`, never removed automatically, never a crash.
- **Concurrency:** the registry has its **own** lock at
  `path.dirname(registryPath)/.lock` (same mkdir + atomic tmp-rename protocol as a
  `.questlog` lock). Registry operations never touch `.questlog` files and vice
  versa, so the two locks are never nested — deadlock-free by construction.

#### `origin` — the roadmap family tree (optional)

An entry MAY carry an `origin` edge naming the **parent roadmap** and **portal milestone** it
branched from. Absent or `null` = a **root**. `origin` is **registry-only operator data**: it is
**not** jargon-linted and carries **no** `plain` field (the registry is operator text, not project
prose). `schemaVersion` stays `1` — entries without `origin` are roots, so old registries load
unchanged.

- **Shape:** `{roadmapId (rm- id, required), milestoneId (ms- id, required), ts (timestamp,
  required, server-set), sessionId? (<=200 chars, no control chars)}`. `additionalProperties:false`.
- **Write-side validation** (MCP `roadmap_register` / `roadmap_set_origin`, all under the registry
  lock, before any write): pattern checks on `roadmapId`/`milestoneId`; the parent must exist in
  the registry (`E_NOT_FOUND: no roadmap <id> in registry`); **no self-edge** (`a roadmap cannot be
  its own origin`); **no cycle** — the parent chain is walked with a visited set, and an edge that
  loops back to the road (`origin would create a cycle (a -> b -> a)`) or a chain deeper than **8**
  (`origin chain exceeds depth 8`) is rejected. Milestone existence in the parent is **not** enforced
  at write time — roads evolve, and the serve-time portal overlay degrades gracefully.
- **`ts` is always server-set**, never caller-supplied.
- **Read-side tolerance:** a malformed `origin` is treated as absent (root); an `origin` naming a
  parent not in the registry is a tolerated **orphan** (greyed edge, never a crash). `validate.mjs`
  does **not** check the registry (it validates one project dir); `registry.schema.json` is the
  contract for external tooling.
- **Set / clear:** `roadmap_register` only sets an origin when none exists (matching = no-op, a
  different origin is refused). `roadmap_set_origin(dirOrId, originRoadmapId, originMilestoneId?)`
  is the explicit retrofit tool — it overwrites, and `originRoadmapId: null` clears the edge.

### How `sessionId` is resolved (MCP server)

Every mutating MCP tool accepts an optional `sessionId`. Per call it is resolved in
order: (1) the explicit `sessionId` tool argument → (2) the value cached by a
`session_hello(sessionId, label?)` call earlier in the process → (3) the
`CLAUDE_SESSION_ID` environment variable. If none resolves, the event is written
**without** a `sessionId` and `sessions.json` is left untouched (full back-compat).

## Colliding writes (`conflicts.json`, optional per project)

**Founder ruling, 2026-08-27.** When two writers change the same record, the app
must **not** keep whichever landed last. The second change is **held** — applied
to nothing and discarded by nothing — and surfaces as a decision showing **both**
versions, for the founder to rule on. While a hold is open the **first** write
stands as current, so the board stays readable rather than frozen. A warning
shown after the loss is explicitly not acceptable: in the founder's words, that
"is not a decision, it is a receipt."

This follows the standing governing principle, quoted from the decision log:
*automate observation and absence-detection, instruct interpretation.* The
machinery detects the collision; judgement resolves it.

### The version

A write is stale when the version it was **based on** is no longer the version on
disk. That version is derived at read time and stored **nowhere**:

```js
recordVersion(rec) = sha1(JSON.stringify(rec)).slice(0, 12)
```

It lives in `conflicts.mjs`, which both servers import, so the two surfaces
cannot disagree about what stale means. It beats `updatedAt` twice over: it
catches a hand edit that forgot to bump one, and it covers decisions, which
carry no `updatedAt` at all.

**Nothing is added to `roadmap.json`.** No version field, no contested marker on
any record — `roadmap.schema.json` is `additionalProperties: false` and the
derived-layer rule says the served `roadmap` must stay exactly what is on disk.
Versions are served as their own `versions` key on `GET /api/state`, and the
holds live in their own file.

### The file

```jsonc
{
  "schemaVersion": 1,
  "conflicts": [
    {
      "id": "cf-1a2b3c4d",                  // REQUIRED, prefix "cf-", unique in file
      "ts": "2026-09-07T10:00:00.000Z",     // REQUIRED, when it was held
      "status": "open",                     // REQUIRED: open | ruled | void
      "targetType": "milestone",            // REQUIRED: milestone|item|quest|decision|term
      "targetId": "ms-mvp",                 // REQUIRED, and while OPEN it must still exist
      "source": "mcp",                      // REQUIRED: mcp | ui
      "actor": "agent",                     // REQUIRED: agent | founder
      "action": "milestone_set_status",     // REQUIRED, the tool or ui_* action held
      "baseVersion": "9f1c0b3d4e5a",        // REQUIRED, what the writer was working from
      "currentVersion": "3c7e21aa90bb",     // REQUIRED, what was actually on disk
      "current":  { "id": "ms-mvp" },       // REQUIRED, the whole first-write record
      "proposed": { "id": "ms-mvp" },       // REQUIRED, the whole held record — or null for a held delete
      "input":    { "id": "ms-mvp" },       // REQUIRED, the raw call minus sessionId/baseVersion
      "ruling": { "keep": "held",           // PRESENT IFF status is "ruled"
                  "ts": "2026-09-07T10:05:00.000Z", "by": "founder" }
    }
  ]
}
```

- **Absent file** → nothing has ever collided here. The validator emits **nothing
  at all** (not even a warning — absence is normal), same as `batons.json`.
- **`ruling` exists iff `status` is `"ruled"`.** A `"void"` conflict carries
  `voidReason` instead: the record was deleted, so there is nothing left to rule
  on. Voided, never removed — the argument still happened.
- **An OPEN conflict's `targetId` must still be on the road.** Every delete path
  voids the holds on what it removes; a dangling open conflict means one of them
  forgot, and that is a validation error.
- **Conflict snapshots are never jargon-linted.** They are copies of records that
  were already linted where they live, and the held version may legitimately use
  a term nobody has defined yet. The lint must never be the thing that blocks a
  hold.

### History event types for this feature (documented, not enum-enforced)

| action | source | actor | patch |
|---|---|---|---|
| `conflict_held` | `mcp` \| `ui` | `agent` \| `founder` | `{"conflictId", "baseVersion", "currentVersion"}` |
| `conflict_ruled` | `mcp` \| `ui` | `founder` | `{"keep", "conflictId"}` |
| `conflict_void` | `mcp` \| `ui` | `agent` \| `founder` | `{"conflictId", "voidReason"}` |

## Validate a project

```sh
node schema/validate.mjs <projectRoot>       # dir that contains .questlog/
node schema/validate.mjs --dir <projectRoot>
node schema/validate.mjs                      # defaults to the current directory
```

Exit code `0` = valid, `1` = one or more errors (printed to stderr, one per line).
The validator can also be imported: `import { validateDir } from "./schema/validate.mjs"` returns a `string[]` of error messages (empty = valid).

The seed dataset in `../seeds/` validates clean and is the best worked example
of every field — a main quest, a side quest hanging off it, a locked milestone
short of the road end, a horizon fan, two decisions (one approved, one still
proposed), a glossary, a pin, and a session roster:

```sh
node schema/validate.mjs seeds/sample-project   # the bundled demo road
```
