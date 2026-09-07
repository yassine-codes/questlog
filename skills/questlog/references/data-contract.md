# Questlog Data Contract (reference)

Condensed, authoritative reference for the on-disk data model, the MCP tool surface, and
the UI server API. Everything here is **generic** — nothing is project-specific. When you
edit `.questlog/*.json` by hand, or call an MCP tool, or hit the UI API, this is the shape
you must honor. Plain files are the source of truth; MCP and the UI server are convenience
layers over the same files.

---

## 0. Global invariants

- **Data location:** `<projectRoot>/.questlog/` — 3 JSON files + 1 JSONL file (below).
- **Node:** >= 18. **Zero npm dependencies** (stdlib only). No network calls, no secrets in data.
- **Timestamps:** ISO-8601 UTC with milliseconds, e.g. `"2026-07-18T14:03:22.000Z"`.
  Field name always ends in `At` (e.g. `createdAt`) or is exactly `ts`.
- **IDs:** lowercase, match `^[a-z]+-[a-z0-9][a-z0-9-]*$`, unique within their file. Prefix by type:
  - `q-` quest · `ms-` milestone · `it-` item · `as-` asset · `dec-` decision · `pin-` pin ·
    `note-` note · `evt-` history event · `term-` glossary term.
  - Human-readable slugs preferred (`ms-setup`); generators may use `<prefix>-<8 hex>`.
- **Status enum (milestones AND quests):** `"locked" | "available" | "in_progress" | "done" | "blocked"`. No other values, ever.
- **Item status enum:** `"open" | "done" | "blocked"`.
- **Every writer** (MCP server, UI server, or any script) must: acquire lock → read →
  mutate → bump `updatedAt` → atomic write → append history event → release lock (§4).
- **Jargon-proofing (optional, fully back-compat):** `schemaVersion` stays **1**. Milestones,
  quests, items, and decisions may carry an optional `plain` string; milestones, items, and
  decisions may additionally carry `unclear` (boolean) + `unclearAt` (ts). The `glossary.json`
  file is optional per project. Every one of these is absent = original behavior; old data loads
  unchanged with no migration. See §2.5 (glossary schema) and §6 (jargon lint). The founder-facing
  discipline that drives all of this lives in SKILL.md ("Keep it in the founder's language").
- **Central app + registry + session tracing (optional, fully back-compat):** `schemaVersion`
  stays **1** everywhere. A **user-level roadmap registry** (`~/.questlog/registry.json`, §2.7)
  lets one server on one port serve *many* roadmaps as a world-select "overworld"; each
  `.questlog/` may carry an optional **`sessions.json`** (§2.6) tracing which AI sessions have
  written to that road; and `history.jsonl` events may carry an optional **`sessionId`** (§2.4).
  All three are absent = the original single-project, single-`--dir` behavior — old dirs load
  unchanged with no migration. See §7 for the mode/routing model and §2.6–2.7 for the schemas.
- **Roadmap family tree (origin edges, optional, fully back-compat):** `schemaVersion` stays **1**.
  A registry entry (§2.7) may carry an optional **`origin`** object naming the **parent roadmap** and
  the **portal milestone** it was promoted from; absent or `null` = a **root**. This lets the central
  app draw the overworld as a **family tree**, overlay each child's portal milestone with a
  **serve-time computed mirror** of the child's live state (§5.3), and roll a parent's **full story**
  up across all live descendants (own + recursive descendant counts, plus a deduped-by-id session
  union). Entries without `origin` load unchanged as roots — today's registry migrates with no edits.
  Cycles and over-deep chains are rejected on write and defused on read (§2.7). `origin` is
  **registry data only** — never written into any `.questlog` file, never jargon-linted; the child
  road stays the single source of truth for its own progress and disk is never rewritten to mirror it.

---

## 1. File layout

```
<projectRoot>/.questlog/
  roadmap.json     # project meta + quests + milestones + items + assets
  decisions.json   # decision log
  pins.json        # compaction pins
  history.jsonl    # append-only audit log, one JSON object per line
  glossary.json    # OPTIONAL plain-meaning dictionary (jargon-proofing); absent = no underlines, lint skipped
  sessions.json    # OPTIONAL session-tracing roster (§2.6); absent = empty panel, no validator output
```

Plus one **user-level** file outside any project, shared across all roadmaps:

```
~/.questlog/registry.json    # OPTIONAL roadmap registry (§2.7); path overridable via QUESTLOG_REGISTRY.
                             # Powers the central app's world-select. Absent = central mode shows an empty overworld.
```

---

## 2. Schemas

### 2.1 `roadmap.json`

```jsonc
{
  "schemaVersion": 1,                          // integer, always 1
  "project": {
    "name": "Sample Project",                  // shown in UI header
    "tagline": "A tiny demo roadmap",          // one line, may be ""
    "createdAt": "2026-07-18T10:00:00.000Z",
    "updatedAt": "2026-07-18T14:03:22.000Z"    // bumped on ANY roadmap.json write
  },

  "quests": [
    {
      "id": "q-main",              // exactly one quest has type "main"; its id SHOULD be "q-main"
      "type": "main",              // "main" | "side"
      "title": "Launch",
      "parentMilestoneId": null,   // null for main; REQUIRED milestone id for side quests (branch point)
      "side": null,                // null for main; "left" | "right" for side quests (side of road)
      "order": 0,                  // integer; sort key among sibling side quests of same parent
      "status": "in_progress",     // status enum; agent maintains it
      "plain": "",                 // OPTIONAL jargon-proofing. Plain-register restatement of the quest. Absent/"" = none
      "createdAt": "2026-07-18T10:00:00.000Z",
      "updatedAt": "2026-07-18T10:00:00.000Z"
    }
  ],

  "milestones": [
    {
      "id": "ms-portal",
      "questId": "q-main",         // must reference an existing quest
      "order": 1,                  // integer; position along its quest's road, ascending, 0-based; unique per quest
      "title": "Portal live",      // <= 60 chars target (UI truncates gracefully)
      "summary": "One to three sentences, may be \"\".",
      "status": "done",            // status enum
      "statusReason": "",          // free text; REQUIRED non-empty when status is "blocked"
      "eta": null,                 // optional ISO date string or null
      "startedAt": "2026-07-18T10:00:00.000Z",   // null until work starts
      "completedAt": "2026-07-18T12:00:00.000Z", // null until done
      "plain": "",                 // OPTIONAL. Plain-register restatement of title+summary. Absent/"" = none (UI shows "(no plain version yet)")
      "unclear": false,            // OPTIONAL. true = founder flagged this card as not landing. Absent/false = not flagged
      "unclearAt": null,           // OPTIONAL. REQUIRED valid ts when unclear===true; null/absent otherwise
      "unclearDispatchId": null,   // OPTIONAL. batch-dispatch marker; set when this standing flag was sent to the helper (pattern ^disp-…). Both-or-neither with unclearDispatchedAt. See §8
      "unclearDispatchedAt": null, // OPTIONAL. ISO ts the flag was dispatched; both-or-neither with unclearDispatchId
      "createdAt": "2026-07-18T10:00:00.000Z",
      "updatedAt": "2026-07-18T12:00:00.000Z"
    }
  ],

  "items": [                       // the expandable card contents
    {
      "id": "it-deploy-steps",
      "milestoneId": "ms-portal",  // must reference an existing milestone
      "order": 0,
      "kind": "explanation",       // "task" | "explanation" | "note_to_founder" | "blocker"
      "title": "How to redeploy the portal",
      "body": "Plain text / markdown-lite. UI renders **bold**, `code`, bare URLs, line breaks.",
      "status": "open",            // "open" | "done" | "blocked"; explanations usually stay "open"
      "blockedReason": "",         // REQUIRED non-empty when status "blocked" (e.g. parked human action)
      "plain": "",                 // OPTIONAL. Plain-register restatement of body. Absent/"" = none (UI shows "(no plain version yet)")
      "unclear": false,            // OPTIONAL. true = founder flagged this card. Absent/false = not flagged
      "unclearAt": null,           // OPTIONAL. REQUIRED valid ts when unclear===true; null/absent otherwise
      "unclearDispatchId": null,   // OPTIONAL. batch-dispatch marker (pattern ^disp-…); both-or-neither with unclearDispatchedAt. See §8
      "unclearDispatchedAt": null, // OPTIONAL. ISO ts; both-or-neither with unclearDispatchId
      "notes": [                   // threaded conversation on this item, chronological
        {
          "id": "note-a1b2c3d4",
          "author": "founder",     // "founder" | "agent"
          "body": "This explanation was unclear — elaborate on step 2?",
          "ts": "2026-07-18T13:00:00.000Z",
          "pending": true,         // OPTIONAL. true = a founder note awaiting a batch dispatch. Absent = NOT pending (back-compat: old notes never sweep in). ONLY POST /api/note sets this. See §8
          "dispatchId": null,      // OPTIONAL. set (pattern ^disp-…) when a live dispatch consumed this note; both-or-neither with dispatchedAt
          "dispatchedAt": null     // OPTIONAL. ISO ts the note was dispatched; both-or-neither with dispatchId
        }
      ],
      "createdAt": "2026-07-18T10:00:00.000Z",
      "updatedAt": "2026-07-18T13:05:00.000Z"
    }
  ],

  "assets": [                      // resources linked to a milestone (context for the founder)
    {
      "id": "as-portal-readme",
      "milestoneId": "ms-portal",
      "kind": "file",              // "file" | "url" | "doc" | "command"
      "label": "Portal README",
      "ref": "C:\\path\\to\\README.md",  // file path, URL, doc path, or shell command string
      "addedAt": "2026-07-18T10:00:00.000Z"
    }
  ]
}
```

**Referential rules**
- A side quest's `parentMilestoneId` must point at a milestone whose `questId` is `"q-main"`.
  Only one level of branching — side quests do not nest off other side quests.
- Deleting an entity is a direct-file-edit operation: remove the object AND its dependents
  (a removed milestone's items and assets). MCP v1 exposes no delete tools.

**Jargon-proofing field rules** (validated in `validate.mjs`; see §6)
- `plain`: if present, a string (may be `""`, treated as absent). Restates the **descriptive text**
  only (quest/milestone `summary`, item `body`) — titles are never restated here; they get
  de-jargoned by glossary underlines instead.
- `unclear`: if present, a boolean. `unclear === true` ⇒ `unclearAt` must be a valid ts.
  `unclear` absent/false ⇒ `unclearAt` must be `null` or absent. Applies to milestones and items
  (and decisions, §2.2) — **not** quests, **not** pins.
- The founder sets `unclear` (UI); the agent clears it only by supplying a plainer `plain`
  (`clear_unclear`, §3). Both `plain` and `unclear`/`unclearAt` are preserved across upserts that
  don't mention them — merges must never drop them.

### 2.2 `decisions.json`

```jsonc
{
  "schemaVersion": 1,
  "decisions": [
    {
      "id": "dec-defer-auth",
      "ts": "2026-07-18T11:00:00.000Z",        // when proposed
      "title": "Defer login until the first paying customer",
      "rationale": "Building sign-in before anyone needs it delays the launch for no one.",
      "impact": "auth milestone moves to locked; launch stays on schedule.",
      "relatedMilestoneIds": ["ms-launch"],    // may be []
      "proposedBy": "agent",                   // "agent" | "founder"
      "approved": false,                       // THE approval gate. Agent proposes false; only founder flips true.
      "approvedAt": null,                      // ISO string when approved set true, else null
      "status": "proposed",                    // "proposed" | "approved" | "rejected" | "superseded"
      "supersededBy": null,                    // decision id or null
      "plain": "",                             // OPTIONAL. Plain-register restatement of rationale+impact. Absent/"" = none
      "unclear": false,                        // OPTIONAL. true = founder flagged this decision. Absent/false = not flagged
      "unclearAt": null,                       // OPTIONAL. REQUIRED valid ts when unclear===true; null/absent otherwise
      "unclearDispatchId": null,               // OPTIONAL. batch-dispatch marker (pattern ^disp-…); both-or-neither with unclearDispatchedAt. See §8
      "unclearDispatchedAt": null              // OPTIONAL. ISO ts; both-or-neither with unclearDispatchId
    }
  ]
}
```

Decisions have no `updatedAt`; a `plain`/`unclear` change bumps nothing but the record's own
fields (and appends a history event). Same `plain`/`unclear`/`unclearAt` rules as §2.1.

**Invariant:** `approved === true` ⇔ `status === "approved"` (and `approvedAt` set). Execute
plan-affecting roadmap edits only after the linked decision is approved (skill etiquette, §3 of SKILL.md).

**Approvals happen in chat (founder ruling, 2026-07-21).** The dashboard **displays** a decision's
state; it never solicits it. There is **no** approve/reject/revoke button on the card — a `proposed`
decision shows a "STANDING DECISION — approve in chat" label; an `approved`/`rejected` one shows the
recorded state and who/when. The founder approves or revokes **in chat** and the agent records it with
`decision_set_approval` (MCP) / `POST /api/decision/approve` (the endpoint stays — it is how the agent
writes the chat ruling into the log, not a founder-facing control). So `approved`/`approvedAt`/`status`
move exactly as before; only the founder-facing buttons are gone.

### 2.3 `pins.json`

```jsonc
{
  "schemaVersion": 1,
  "pins": [
    {
      "id": "pin-compaction-1",
      "ts": "2026-07-18T12:30:00.000Z",
      "kind": "compaction",                    // only value for now; future-proof
      "label": "Compaction #1",
      "afterMilestoneId": "ms-portal",         // road position: marker on segment after this main-quest milestone; null = start
      "summary": "Thread covered WSL setup through portal launch.",
      "synthesisDocPath": "docs/compaction-1-synthesis.md"  // path relative to projectRoot, or null if not yet produced
    }
  ]
}
```

### 2.4 `history.jsonl` — append-only, one event per line, never rewritten

```jsonc
{"id":"evt-c3d4e5f6","ts":"2026-07-18T13:05:00.000Z","actor":"agent","source":"mcp","action":"item_upsert","targetId":"it-deploy-steps","summary":"Expanded deploy explanation after founder note","patch":{"body":"..."},"sessionId":"4c1f0b2e-3d5a-4e6f-8a9b-0c1d2e3f4a5b"}
```

Fields:
- `id`, `ts`
- `actor`: `"agent" | "founder" | "system"`
- `source`: `"mcp" | "ui" | "file"`
- `action`: the tool name, or `"ui_note_add"`, `"ui_decision_approve"`, `"file_edit"`, `"seed"`.
  `action` is a **free string** (no validator enum) — new event types need no schema change.
  Jargon-proofing and session tracing add these (all documented, none enum-enforced):

  | action | source | actor | when | patch |
  |---|---|---|---|---|
  | `ui_unclear_set` | `ui` | `founder` | founder toggles the Unclear button (`POST /api/unclear`) | `{"unclear": <bool>}` |
  | `clear_unclear` | `mcp` | `agent` | agent clears a flag with a plain rewrite (`clear_unclear` tool) | `{"unclear": false}` |
  | `glossary_term_upsert` | `mcp` | `agent` | agent defines/merges a glossary term | `{"term": "<surface form>"}` |
  | `session_hello` | `mcp` | `agent` | an AI session checks in at session start (`session_hello` tool) | `{"label": "<label or empty>"}` |
  | `ui_dispatch` | `ui` | `founder` | founder presses "Send to agent" (`POST /api/dispatch`); one event per press | `{"dispatchId","count","dryRun"}` |
  | `dispatch_done` | `ui` | `system` | the helper's batch run finished (live only) | `{"dispatchId","status":"done"}` |
  | `dispatch_failed` | `ui` | `system` | the batch run timed out / errored / was killed; its cards were put back in the waiting list (live only) | `{"dispatchId","status","unmarked"}` |
  | `seed` | `file` | `agent` | seed build / bulk hand-edit (incl. `glossary.json`, `sessions.json`) | — |
- `targetId`: entity id or `null`
- `summary`: one human sentence — this is the audit trail founders read
- `patch`: optional object of changed fields (omit for large bodies)
- `sessionId`: **OPTIONAL** non-empty string. Present = the AI session that produced this event
  (validator checks type + non-emptiness only — no prefix rule, UUIDs are typical). Absent = a
  pre-tracing event, a founder/UI action, or an unattributed write. Every event carrying a
  `sessionId` also bumps that session's counters in `sessions.json` (§2.6) inside the **same lock**.

**`history.jsonl` is never jargon-linted** — it is an append-only record of the past; scanning it
would retroactively invalidate history when the glossary changes.

### 2.5 `glossary.json` — OPTIONAL plain-meaning dictionary

The founder-language dictionary. **Optional per project:** absent → the UI shows no underlines and
the jargon lint prints `WARNING: no glossary.json — jargon lint skipped` and passes. Present → it
is structurally validated and the lint (§6) is enforced.

```jsonc
{
  "schemaVersion": 1,                          // const 1
  "terms": [
    {
      "id": "term-sqlite",                     // REQUIRED. prefix "term-", matches ^[a-z]+-[a-z0-9][a-z0-9-]*$, unique in file
      "term": "SQLite",                        // REQUIRED non-empty. Canonical surface form exactly as it appears in text
      "aliases": ["sqlite3"],                  // OPTIONAL, default []. Other surface forms; array of non-empty strings
      "plain": "A small database that lives in one file inside the project, so nothing else has to be installed.",
                                               // REQUIRED non-empty. ONE plain sentence, human register, no other UNDEFINED jargon
      "note": "Chosen for the demo because it needs no server of its own.",
                                               // OPTIONAL string, default "". Longer context, shown in the expanded tooltip
      "link": null                             // OPTIONAL string|null, default null. URL or repo-relative doc path
    }
  ]
}
```

**Surface form** = a term's `term` plus each of its `aliases`. Two invariants:
- **Uniqueness:** across ALL entries, no surface form may repeat (compared under the §6 case rule —
  all-caps forms compared case-sensitively, others case-insensitively). `SQLite` and
  `cf access` collide; `KV` and `kv` do not.
- **Dogfood:** `plain` and `note` are themselves jargon-lint-scanned (§6). A plain meaning may *use*
  other **defined** terms, never an undefined one — so the dictionary can't smuggle in fresh jargon.

Managed with `glossary_term_upsert` (§3) or hand-edited (append a `seed`/`file_edit` history event).

### 2.6 `sessions.json` — OPTIONAL session-tracing roster

Per-`.questlog` record of which AI sessions have written to this road. **Optional:** absent → an
empty roster `{schemaVersion:1, sessions:[]}` everywhere (empty UI panel), and the validator emits
**no output at all** — not even a warning; a missing file is the normal, back-compat state.
Present-but-malformed → validator **errors** (§6).

```jsonc
{
  "schemaVersion": 1,                          // const 1
  "sessions": [
    {
      "id": "4c1f0b2e-3d5a-4e6f-8a9b-0c1d2e3f4a5b",
                                               // REQUIRED. Free-form non-empty string (UUIDs typical), NOT the ID_RE.
                                               // Unique in file, max 200 chars, no control chars. This is the sessionId
                                               // stamped on history events (§2.4).
      "firstSeenAt": "2026-07-21T00:00:00.000Z",  // REQUIRED ts. Set once, when the session first writes.
      "lastSeenAt": "2026-07-21T00:05:00.000Z",   // REQUIRED ts. Bumped on every write attributed to this session.
      "label": "founding session - built questlog + both roads",
                                               // REQUIRED string, may be "". Human label from session_hello (§3).
      "eventCount": 3                          // REQUIRED integer >= 0. Number of history events stamped with this id.
    }
  ]
}
```

**`upsertSession(sessionId, label?, delta)` semantics** (every writer implements identically):
called **inside the same per-roadmap lock** as the mutation it accounts for, *after* the history
event is appended.
- Find the session by `id`. **Found** → `lastSeenAt = nowIso()`, `eventCount += delta`, and
  overwrite `label` **only** when a non-empty `label` argument is given (a blank/absent label never
  clears an existing one).
- **Absent** → create `{id, firstSeenAt: now, lastSeenAt: now, label: label || "", eventCount: delta}`.
- Atomic write (§4). `schemaVersion` stays 1. This file **rides the mutation's lock** — it is never
  read-modified-written under a separate lock acquisition (§4).

`sessions.json` is **not jargon-linted** — session labels are free-form operator text, like
`history.jsonl`, not founder-facing roadmap prose. The validator checks structure only.

### 2.7 `registry.json` — OPTIONAL user-level roadmap registry

The central app's index of known roadmaps. **Not** inside any `.questlog/` — it is a **user-level**
file. Path resolution (identical in `server.mjs` and `mcp/server.mjs`): `process.env.QUESTLOG_REGISTRY`
if set, else `path.join(os.homedir(), ".questlog", "registry.json")`. The parent directory is created
on demand at the first **write** (`mkdirSync(..., {recursive:true})`). **All reads are tolerant:** a
missing or corrupt file reads as `{schemaVersion:1, roadmaps:[]}` — never a crash.

```jsonc
{
  "schemaVersion": 1,                          // const 1
  "roadmaps": [
    {
      "id": "rm-questlog",                     // REQUIRED. ID_RE, prefix "rm-", unique in file. STABLE: never
                                               // regenerated for an existing dir once assigned.
      "name": "Questlog",                      // REQUIRED. Display fallback; refreshed on each upsert from the dir's
                                               // roadmap.json project.name, else path.basename(dir).
      "dir": "C:\\path\\to\\questlog",
                                               // REQUIRED. path.resolve()d absolute PROJECT ROOT (NOT the .questlog subdir).
      "addedAt": "2026-07-21T00:00:00.000Z",   // REQUIRED ts. Set once at first registration.
      "lastSeenAt": "2026-07-21T00:00:00.000Z", // REQUIRED ts. Bumped on every upsert (dir-mode startup auto-register,
                                               // roadmap_register / roadmap_set_origin call).
      "origin": {                              // OPTIONAL. Absent OR null = a ROOT roadmap (no parent). See below.
        "roadmapId": "rm-atlas-platform",      // REQUIRED. Registry id of the PARENT roadmap. Matches ^rm-[a-z0-9][a-z0-9-]*$.
        "milestoneId": "ms-portal-questlog",   // REQUIRED. The ms- id of the PORTAL milestone IN THE PARENT road this
                                               // road branched from — ANY quest (a promoted side quest's milestones live
                                               // on the side quest). NOT existence-checked at write time (roads evolve;
                                               // the serve-time overlay degrades gracefully, §5.3).
        "ts": "2026-07-21T12:00:00.000Z",      // REQUIRED ts. When the edge was recorded (server-set, never caller-supplied).
        "sessionId": "4c1f0b2e-3d5a-4e6f-8a9b-0c1d2e3f4a5b"
                                               // OPTIONAL. AI session that recorded the edge; free-form non-empty string,
                                               // <=200 chars, no control chars. Omitted when none resolves.
      }
    }
  ]
}
```

**Origin edges — the roadmap family tree (optional, back-compat).** An entry may carry an optional
`origin` object recording which roadmap + portal milestone it was promoted from. Absent or `null`
= a **root**. `origin` is **registry data only** (operator-level, like `name`) — it is *not*
jargon-linted, carries no `plain`, and is never written into any `.questlog` file. `schemaVersion`
stays **1**; entries without `origin` are roots and load unchanged (today's 2-entry registry needs
no migration).

`registry.schema.json` validates `origin` as `type:["object","null"]`,
`required:["roadmapId","milestoneId","ts"]`, `additionalProperties:false` with an optional
`sessionId` (`type:"string", minLength:1, maxLength:200`). `schema/validate.mjs` does **not** change:
it validates project `.questlog` dirs only, and the registry stays outside its scope.

**Write-side origin validation** (both `roadmap_register` and `roadmap_set_origin`, §3), executed
under the **registry lock**, all checks before write:
1. `roadmapId` matches `^rm-[a-z0-9][a-z0-9-]*$` and `milestoneId` matches the `ms-` id pattern
   (`E_VALIDATION` otherwise).
2. **Parent must exist:** an entry with `id === origin.roadmapId` must already be in the registry
   (`E_NOT_FOUND: no roadmap <id> in registry`). The milestone's existence in the parent's
   `roadmap.json` is **not** enforced at write time — roads evolve, and the serve-time overlay
   degrades gracefully (§5.3).
3. **No self-edge:** `origin.roadmapId === <own id>` → `E_VALIDATION: a roadmap cannot be its own
   origin`.
4. **No cycle (depth ≤ 8):** walk the parent chain from `origin.roadmapId`, following each entry's
   `origin.roadmapId`, with a visited set. If the chain reaches the target's own id →
   `E_VALIDATION: origin would create a cycle (<chain joined with " -> ">)`. If the walk exceeds
   **depth 8** → `E_VALIDATION: origin chain exceeds depth 8`. Missing/malformed links end the walk
   (orphans are legal).
5. `origin.ts = nowIso()` — server-set, never caller-supplied. `origin.sessionId` is stamped only
   when a session id resolves (standard order, §3) **and** an origin is being set. These are
   **registry-only** operations: no history event, no `sessions.json` touch, no `.questlog` write,
   and never a nested roadmap lock (§4).

**Read-side tolerance (`server.mjs` lineage build, CENTRAL mode only).** The registry is read
lock-free and every malformity degrades, never crashes; registry **array order** makes it all
deterministic:
- A malformed `origin` (wrong types / bad patterns) is treated as **absent** → the entry is a root.
- An `origin` naming a `roadmapId` **not in the registry** = an **orphan**: kept, flagged
  `orphan:true`, `origin` echoed so the UI can draw a greyed stub edge — never silently a plain root.
- An edge that would close a **cycle** against already-accepted edges (a hand-edited registry) is
  dropped; the deeper node becomes a root flagged `lineageError:"cycle"`.
- A chain deeper than **8** is cut; the too-deep node becomes a root flagged
  `lineageError:"too_deep"`.
- Direct children of a parent are ordered by (`origin.ts` ascending, then child id); descendant
  enumeration everywhere is **pre-order DFS** in that order.

Dir mode never builds lineage (no registry semantics — a flat single road, unchanged).

**Upsert-by-dir algorithm** (both writers — the UI server and the MCP server — implement identically):
1. `resolved = path.resolve(inputDir)`. Entry match uses
   `sameDir(a,b) = process.platform==="win32" ? a.toLowerCase()===b.toLowerCase() : a===b`.
2. **Match found** → update `lastSeenAt = nowIso()`; refresh `name` (from `<dir>/.questlog/roadmap.json`
   `project.name` if readable, else `path.basename(resolved)`); **keep `id` and `addedAt` unchanged**.
3. **No match** → new entry. `id = "rm-" + slug` where
   `slug = path.basename(resolved).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")`;
   if `slug` is empty or fails `^[a-z0-9][a-z0-9-]*$`, use 8 random hex chars instead; if the resulting
   id already belongs to a *different* dir, append `-` + 4 random hex chars. `addedAt = lastSeenAt = nowIso()`.
4. The whole read-modify-write runs under the **registry lock** (§4), with explicit utf-8 on every write.

**Dead entries are tolerated everywhere.** A `dir` that no longer exists (or whose `roadmap.json` is
unreadable) is reported `missing:true` by `/api/registry` (§5), rendered as a greyed "missing" card
in the overworld — never removed automatically, never a crash.

**Ways to register** a roadmap (all upsert-by-dir, no duplicates):
(a) the MCP tool `roadmap_register(dir?, originRoadmapId?, originMilestoneId?)` (§3 — the origin args
optionally record a promoted child's parent edge); (b) auto-registration when `server.mjs --dir`
starts on a project (fired once in the `listen` callback; any failure logs one stderr warning and
never crashes the server — auto-registered roads are always roots); (c) a direct hand-edit of
`registry.json` (respect the shape and the lock). A road's parent edge is added or corrected after
the fact with `roadmap_set_origin` (§3), which edits an existing entry rather than registering.

### 2.8 `suggestions.json` — OPTIONAL horizon suggestions (possible next milestones)

Absent file = no suggestions (normal, back-compatible). Present = validated strictly.
Suggestions are **possibilities floated past a road-end**, NEVER milestones and NEVER counted in
any tally — they live in their own file so `roadmap.json`'s strict schema is untouched.

```jsonc
{
  "schemaVersion": 1,
  "suggestions": [
    {
      "id": "sg-1a2b3c4d",                  // "sg-" + 8 hex
      "frontierMilestoneId": "ms-…",        // the road-end this was made at (the TAG)
      "questId": "q-…",                     // the quest the frontier milestone belongs to
      "title": "…",                         // short title (non-empty)
      "plain": "…",                         // REQUIRED plain meaning (jargon-linted)
      "summary": "…",                       // optional longer text
      "order": 0,                           // legacy chain position; kept as the deterministic tie-break
      "branchIndex": 0,                     // OPTIONAL 0-4: which of up to 5 PARALLEL directions
      "seqIndex": 0,                        // OPTIONAL 0-2: position along it (0 = the parallel root)
      "createdAt": "…Z", "updatedAt": "…Z"
    }
  ],
  "requests": [                             // OPTIONAL, additive: pending founder asks (F2)
    { "id": "rq-1a2b3c4d", "milestoneId": "ms-…", "requestedAt": "…Z", "sessionId": "…" }
  ]
}
```
Rules: **max 15 per anchor** (5 directions x 3 steps) when the group carries `branchIndex`, **max 3**
for a LEGACY group that does not; no two records may claim the same `(branchIndex, seqIndex)` seat;
`frontierMilestoneId` and `questId` must resolve in `roadmap.json`. A **legacy** record is stale once
its anchor is no longer a road-end; a **grouped** record is stale only when its anchor milestone is
**deleted**. A fan tagged to a **portal** milestone re-anchors **at render time** to the last real
(non-portal) milestone of that quest — the file is never rewritten. Rendered as faint dashed ghost
nodes: parallel roots fan out **beside** the anchor (glyph ‖), sequential children trail **after**
their root (glyph →). Tools: `suggestions_upsert` (replace the tree at one anchor; also clears that
anchor's pending request), `suggestion_promote` (ghost → real milestone, then consumed),
`suggestion_dismiss` (§3). `requests[]` is written by `POST /api/request-suggestions`
`{milestoneId, sessionId?}` (history `suggestion_request`) — the server holds **no LLM**; agents
drain the ask through `suggestions_upsert`. Registry hygiene (§5.2): the overworld refuses to
register temp/scratch paths and offers a per-card two-step remove.

---

## 3. MCP tool surface

Server: `node mcp/server.mjs --dir <projectRoot>` (also honors `QUESTLOG_DIR`; default cwd).
stdio, newline-delimited JSON-RPC 2.0. Handshake `initialize` → `tools/list` → `tools/call`.

**Result shape:** success → `{"content":[{"type":"text","text":"<JSON string of result>"}]}`.
Domain failure → `{"content":[{"type":"text","text":"E_CODE: message"}],"isError":true}`
(never a JSON-RPC error for domain problems). Codes: `E_VALIDATION`, `E_NOT_FOUND`,
`E_PARENT_NOT_FOUND`, `E_LOCK_TIMEOUT`, `E_IO`.

| Tool | Input | Result | Notes |
|---|---|---|---|
| `roadmap_get` | `{section?: "all"\|"project"\|"quests"\|"milestones"\|"items"\|"assets"\|"decisions"\|"pins"\|"glossary"\|"sessions"\|"batons"\|"suggestions"\|"history_tail"}` (default `"all"`) | requested slice; `"all"` = `{roadmap, decisions, pins}` (**unchanged** for back-compat); `"glossary"` = the `terms` array; `"sessions"` = the `sessions` array; `"suggestions"` = the `suggestions` array (empty when the file is missing); `history_tail` = last 50 events | read-only, no history event, **no `sessionId` param, no stamp** |
| `milestone_upsert` | `{id?, questId, title, summary?, order?, status?, statusReason?, eta?}` | full milestone | omit `id` → create (`status` default `"locked"`, `order` default max+1). Provided existing `id` → merge given fields |
| `milestone_set_status` | `{id, status, reason?}` | full milestone | sets `statusReason`; auto-sets `startedAt` on first `in_progress`, `completedAt` on `done` (clears if leaving `done`). `reason` required for `blocked` |
| `quest_create` | `{id?, title, parentMilestoneId, side?: "left"\|"right", milestones?: [{title, summary?, status?}]}` | `{quest, milestones}` | creates side quest (`type:"side"`); `side` default alternates by sibling count; inline milestones created in order, first `available`, rest `locked` unless given |
| `item_upsert` | `{id?, milestoneId, kind, title, body?, status?, order?, blockedReason?}` | full item | create/merge like milestone_upsert; `notes` never replaced by this tool |
| `item_note_add` | `{itemId, body, author?: "agent"\|"founder"}` (default `"agent"`) | full item | appends to `notes` thread |
| `asset_link` | `{milestoneId, kind, label, ref, id?}` | full asset | |
| `decision_log` | `{id?, title, rationale, impact?, relatedMilestoneIds?, proposedBy?: "agent"\|"founder", approved?: boolean}` | full decision | default `proposedBy:"agent"`, `approved:false`, `status:"proposed"`. `approved:true` → `status:"approved"`, `approvedAt:now` |
| `decision_set_approval` | `{id, approved: boolean}` | full decision | `true` → approved/approvedAt; `false` → status `"rejected"` |
| `pin_compaction` | `{label?, afterMilestoneId?, summary, synthesisDocPath?}` | full pin | default label `"Compaction #<n>"`; default `afterMilestoneId` = last non-locked main-quest milestone |
| `list_unclear` | `{}` | `{count, unclear: [...]}` sorted by `unclearAt` **ascending** (oldest first — drain order) | **read-only, no history event.** Each entry: `{targetType, id, title, text, plain, unclearAt, ...context}`. Milestones carry `questId`; items carry `milestoneId`+`milestoneTitle`+the full `notes` thread; decisions carry `text` = `"<rationale>\n<impact>"`. This is the session-start queue (SKILL.md hard rule 1) |
| `clear_unclear` | `{id, rewritten_plain}` (both required; `targetType` inferred from `ms-`/`it-`/`dec-` prefix) | full record | sets `plain = rewritten_plain`, `unclear = false`, `unclearAt = null`, bumps timestamps; `E_NOT_FOUND` if missing, `E_VALIDATION` if the record is not currently flagged. History `action:"clear_unclear"` |
| `glossary_term_upsert` | `{id?, term, plain, aliases?, note?, link?}` (`term`+`plain` required non-empty) | full term entry | omit `id` → create with a generated `term-…` id; existing `id` → merge. Enforces §2.5 surface-form uniqueness. Creates `glossary.json` (skeleton `{schemaVersion:1, terms:[]}`) if absent. History `action:"glossary_term_upsert"` |
| `session_hello` | `{sessionId (required non-empty string), label?}` | full session record (§2.6) | **Session-start check-in (SKILL.md "Check in at session start" — the first call of every session).** Caches `{id,label}` in a process-lifetime variable (later hellos overwrite). Then, under the roadmap lock: appends one history event `{action:"session_hello", actor:"agent", source:"mcp", targetId:null, summary:'AI session "<label or first 8 chars of id>" checked in', patch:{label}, sessionId}` and `upsertSession(sessionId, label, 1)`. Creates the `.questlog/` skeleton on demand like any writer |
| `roadmap_register` | `{dir?, originRoadmapId?, originMilestoneId?, sessionId?}` (default `dir`=`PROJECT_ROOT`) | the registry entry (§2.7) | `path.resolve`s `dir`; `E_NOT_FOUND` if the directory does not exist on disk. **Registry hygiene:** refuses a temp/scratch path — any path segment equal (case-insensitive) to `Temp` or `scratchpad`, or a path under `os.tmpdir()` — with `E_VALIDATION` (escape hatch `QUESTLOG_ALLOW_TEMP=1`). Upserts by dir under the **registry lock** (§2.7 / §4). `originRoadmapId`/`originMilestoneId` are **both-or-neither** (`E_VALIDATION`); when given: entry has **no** origin → validate (§2.7) + set it; **same** origin (`roadmapId`+`milestoneId` equal) → no-op; **different** origin → `E_VALIDATION: <id> already has an origin; use roadmap_set_origin to change it`. **No history event, no `.questlog` writes** — registry only |
| `roadmap_set_origin` | `{dirOrId (required), originRoadmapId (required, string\|null), originMilestoneId?, sessionId?}` | the full updated registry entry (§2.7) | Retrofit/correct a road's parent edge. Target: `dirOrId` matching `^rm-[a-z0-9][a-z0-9-]*$` resolves by registry id, else it is `path.resolve`d and matched by dir (`sameDir`); `E_NOT_FOUND` if unresolved. `originRoadmapId: null` **clears** the origin (deletes the field — the escape hatch for a wrong edge). Otherwise `originMilestoneId` is required and the edge is validated (§2.7); **overwrite is allowed** (this is the explicit correction tool). Bumps the target's `lastSeenAt`. **No history event, no `.questlog` writes** — registry only |
| `baton_peek` | `{}` | the freshest baton, or `null` | **STRICTLY read-only** view of the freshest baton — never claims, never writes, never appends history. For observer/read-only sessions (the observer whitelist uses this, not `baton_read`). |
| `suggestions_upsert` | `{frontierMilestoneId, suggestions:[{title, plain, summary?, branchIndex?, seqIndex?, order?}] (1–15), sessionId?}` | `{frontierMilestoneId, suggestions:[…], requestsCleared}` | Create or **replace** the whole horizon TREE at one **anchor** (`frontierMilestoneId` must exist AND be `done` / `in_progress` / a road-end, else `E_VALIDATION`). Each needs `title`+`plain`; `branchIndex` (0–4, one of up to 5 **parallel directions**) defaults to the array index, `seqIndex` (0–2, position along that direction; 0 = the parallel root) defaults to 0, and no two may share a seat. Also clears any pending founder request at that anchor. Writes `suggestions.json` (§2.8). History `suggestions_upsert` |
| `suggestion_promote` | `{id, sessionId?}` | the new milestone | Promote a ghost `sg-…` into a real milestone (its quest, next order, status `"available"`, `plain`/`summary` carried over) via the normal milestone machinery, then **consume** the ghost. History `suggestion_promote` (patch `{milestoneId}`) |
| `suggestion_dismiss` | `{id, sessionId?}` | `{dismissed:id}` | Delete a ghost `sg-…`. Nothing on the road changes. History `suggestion_dismiss` |

**Existing tools gain optional jargon-proofing params (back-compat, all optional):**
`milestone_upsert`, `item_upsert`, and `decision_log` each accept `plain` (applied like `summary`);
`quest_create` accepts a quest `plain` and a `plain` on each inline milestone. **Merge semantics:**
an upsert must preserve any existing `plain` / `unclear` / `unclearAt` it was not given — it never
regresses them to defaults. (Setting/clearing `unclear` is done only via `POST /api/unclear` and
`clear_unclear`, never through these upserts.)

**The 11 mutating tools gain an optional `sessionId` input property and stamp it** — namely
`milestone_upsert`, `milestone_set_status`, `quest_create`, `item_upsert`, `item_note_add`,
`asset_link`, `decision_log`, `decision_set_approval`, `pin_compaction`, `clear_unclear`,
`glossary_term_upsert`. When a session id resolves (order below), the tool stamps `sessionId` on its
history event **and** calls `upsertSession(id, undefined, 1)` inside its existing lock, *after*
`appendHistory` — so the stamp and the counter bump share one critical section (§4). Read-only
`roadmap_get` and `list_unclear` take no `sessionId` param and never touch `sessions.json`.

**`sessionId` resolution order (pinned, evaluated per mutating call):** (1) an explicit `sessionId`
argument on the tool call → (2) the value cached by the last `session_hello` in this process → (3)
`process.env.CLAUDE_SESSION_ID` if non-empty. **If none resolves: no stamp, no `sessions.json`
touch** — full back-compat with pre-tracing behavior.

**Origin-edge sessionId (registry tools).** `roadmap_register` and `roadmap_set_origin` resolve a
session id by the **same order** above, but they are **registry-only** operations: when an id
resolves *and* an origin is being set, it is stamped as `origin.sessionId` (§2.7) — there is **no**
history event and **no** `sessions.json` touch (either would need a roadmap lock, and registry ops
never nest locks, §4). Clearing an origin (`originRoadmapId: null`) writes no `sessionId`.

The MCP server reports `SERVER_INFO` version `"1.3.0"` with **16 tools** — the 13 originals
(all keeping their exact current behavior) plus `session_hello`, `roadmap_register`, and
`roadmap_set_origin`.

Every mutation appends exactly one history event with `source:"mcp"`, `actor` = input
`author`/`proposedBy` when present else `"agent"`.

---

## 4. Locking + atomic writes (for any writer, incl. hand-edits via a script)

- **Lock:** `fs.mkdirSync("<dataDir>/.lock")` (atomic). On `EEXIST`: if lock dir `mtime`
  older than 5000 ms, remove it (stale) and retry immediately; else retry every 50 ms up to
  3000 ms total, then fail `E_LOCK_TIMEOUT`. Release with `rmdirSync` in a `finally`.
- **Atomic write:** `JSON.stringify(data, null, 2)` → write `<file>.tmp-<pid>` in the same
  dir → `fs.renameSync` over the target.
- **History:** `fs.appendFileSync(historyPath, JSON.stringify(evt) + "\n")` while holding the lock.
- Read-modify-write of any file happens entirely inside the lock. `.lock` and `*.tmp-*` are
  never listed as data.

**Session tracing rides the mutation's lock.** `sessions.json` (§2.6) is read-modified-written
inside the **same** critical section as the mutation and history append it accounts for (via
`upsertSession`, called after `appendHistory`) — never with a separate lock acquisition.

**Registry has its own lock.** `registry.json` (§2.7) is guarded by
`path.join(path.dirname(registryPath), ".lock")` using the exact same mkdir protocol (5000 ms stale
reclaim, 3000 ms timeout, ~50 ms spin) + atomic tmp-rename write. Both `server.mjs` and
`mcp/server.mjs` implement this identically. **Registry reads are lock-free and tolerant** — a
missing/corrupt file reads as an empty registry; a stale-by-one-poll read in the world-select is fine.

**No lock nesting, ever.** Registry operations never touch `.questlog` files and vice versa: a writer
never holds the registry lock while acquiring a roadmap lock, or the reverse. This makes deadlock
impossible by construction. In the **central app** each roadmap's mutations take **that roadmap's own**
`.questlog/.lock` — there is no global mutation lock, so writes to different roadmaps (and cooperating
dir-mode / MCP servers on the same roadmap) proceed independently.

**Editing files by hand (no server):** it is safe to Read then Edit a `.questlog/*.json` file
directly when no server is writing. Keep `schemaVersion: 1`, bump `project.updatedAt` on
`roadmap.json`, respect every enum and referential rule above, and append a `history.jsonl`
line with `source:"file"`, `action:"file_edit"`.

---

## 5. UI server API (read/write over the same files)

`node server.mjs [--dir <projectRoot>] [--port 4177]` (env `QUESTLOG_DIR`/`QUESTLOG_PORT`; port
default 4177 in both modes). Binds `127.0.0.1` only; every response declares `charset=utf-8`.

**Mode selection (§7).** **DIR mode** iff a `--dir`/`--data` arg is given OR `QUESTLOG_DIR` is set —
one fixed roadmap, byte-for-byte the classic single-project server (plus the additions below).
Otherwise **CENTRAL mode** — the world-select app that serves many roadmaps from the registry.
Both modes serve `GET /api/mode` → `{"mode":"dir"}` or `{"mode":"central"}` (the UI's boot probe;
the UI treats a 404 as `"dir"` for old-server back-compat).

### 5.1 DIR mode (classic single-project — unchanged paths, plus additions)

- `GET /` , `GET /index.html` → `index.html`.
- `GET /api/state` → `{"rev":"<mtimes+size hash>","roadmap":{...},"decisions":{...},"pins":{...},"glossary":{...},"sessions":{...},"suggestions":{schemaVersion:1,suggestions:[…]},"historyTail":[last 30 events]}`. The additive `suggestions` key (§2.8; empty skeleton when the file is missing) and `suggestions.json`'s mtime are folded into `rev`. Missing files → valid empty skeletons (`glossary` → `{schemaVersion:1, terms:[]}`; `sessions` → `{schemaVersion:1, sessions:[]}`); `rev` now folds in `sessions.json`'s mtime as well as `glossary.json`'s, so session and glossary edits trigger re-render. `rev = [mtime(roadmap), mtime(decisions), mtime(pins), mtime(glossary), size(history), mtime(sessions)].join("-")`. Old servers omit `glossary`/`sessions` → the UI shows no underlines and an empty Sessions panel. UI polls every 2000 ms, re-renders only when `rev` changes. **Dir mode has no registry semantics — `/api/state` never carries `lineage`/`portals`/`fullStory` (§5.3), not even as `null`, and its `rev` is unchanged.**
- `POST /api/note` `{"itemId","body","sessionId?"}` → appends founder note (author `"founder"`), history `ui_note_add`, returns updated item. **The new note is marked `pending:true`** (batch-dispatch waiting work, §8) — this is the ONLY writer that sets `pending`. When `sessionId` is a non-empty string, stamp it on the history event and `upsertSession(sessionId, undefined, 1)` inside the same lock.
- `POST /api/decision/approve` `{"id","approved":bool,"sessionId?"}` → records a decision approval/rejection, history `ui_decision_approve`, returns decision. `sessionId?` stamped as above. **This endpoint is how the AGENT writes a chat ruling into the log (founder ruling, §2.2)** — the founder approves/revokes in chat; there is no founder-facing button. Contract unchanged.
- `POST /api/unclear` `{"targetType":"milestone"|"item"|"decision","id","unclear":bool,"sessionId?"}` → the founder's Unclear toggle. Under lock: find the record (milestone/item in `roadmap.json`, decision in `decisions.json`); set `unclear`, `unclearAt = nowIso()` when true else `null`, **and DELETE any `unclearDispatchId`/`unclearDispatchedAt` (setting unclear true OR false re-queues the flag as pending work, §8)**, bump the record's `updatedAt` (decisions have none — skip) and `project.updatedAt` for roadmap targets; history `ui_unclear_set` (actor `"founder"`). `sessionId?` stamped as above. Returns the full updated record. `400 {"error":"E_VALIDATION",...}` on bad targetType/id/unclear; `404 {"error":"not_found","message":"no <targetType> <id>"}`.
- `POST /api/dispatch` `{"sessionId?"}` (body may be `{}`) → the "Send to agent" button: assemble every pending note + standing flag into ONE worklist and hand it to the bridge helper as a single batch session. Full contract in **§8**. History `ui_dispatch`; live runs later append `dispatch_done`/`dispatch_failed`.
- `POST /api/request-suggestions` `{"milestoneId","sessionId?"}` → the founder's **"⊕ More horizons"**
  control on any milestone card. Records the ask only (**no LLM in the server**): appends a
  `suggestion_request` history event and an entry in `suggestions.json`'s additive `requests[]`
  (§2.8); asking twice re-stamps rather than duplicating. `suggestions_upsert` at that anchor clears
  it. `404` for an unknown milestone.
- `POST /api/promote` `{"questId","targetDir","sessionId?"}` → promote a **side quest** into its own
  registered road, in this crash-safety order: (1) write the child road, (2) verify it reads back,
  (3) rewrite the parent so the whole sub-tree collapses to **one portal milestone**, (4) registry
  upsert with `origin{roadmapId, milestoneId, ts}` (self-edge / cycle refused), (5) history on both
  roads + a `decisions.json` entry. A crash before (3) leaves the parent completely intact.
  Doctrine: *same goal stays inline; an own definition of done earns its own map.*
- `POST /api/demote` `{"childId","sessionId?"}` → the reverse: **refused** (`409 E_HAS_CHILDREN`) if
  the child has children of its own; otherwise the child's main quest re-inlines as a side quest at
  the portal's quest, the portal milestone is deleted, every dangling reference to it is stripped and
  the promotion ruling is marked `supersededBy`, the registry entry (and edge) is removed, and both
  histories are logged. The child folder is **left on disk as an archive**, never deleted.
- `POST /api/file/:name` (`roadmap|decisions|pins|glossary`) body = full JSON → validates
  `schemaVersion===1` + parse, atomic-writes under lock, history `file_edit` (escape hatch). **No
  `sessionId` support.**
- **Auto-registration:** in the `server.listen` callback, upsert this `PROJECT_ROOT` into the
  registry (§2.7 algorithm, registry lock). Any failure logs one stderr warning and never crashes.
- `/r/*` and `/api/registry` → 404 in dir mode.
- Anything else → 404 `{"error":"not_found"}`; invalid body → 400 `{"error":"E_VALIDATION","message":...}`.

### 5.2 CENTRAL mode (world-select app, no `--dir`)

- `GET /` and `GET /r/<id>` (path matching `^/r/[a-z0-9-]+$`) → `index.html` (the client decides what
  to render; unknown ids simply produce API 404s the client handles). Any other static path → 404.
- `GET /api/registry` →
  ```jsonc
  {
    "rev": "<mtime(registry)>-<per-entry mtime(roadmap.json)>-<per-entry mtime(sessions.json)>-...",  // join("-"), 0 for missing files
    "roadmaps": [
      { "id": "rm-questlog", "name": "Questlog", "tagline": "…", "dir": "C:\\…\\questlog",
        "addedAt": "…", "lastSeenAt": "…", "missing": false,
        "progress": { "done": 3, "total": 5 },   // milestones with status done / all milestones (all quests)
        "status": "in_progress",                  // the main quest's status; "available" fallback
        "sessionCount": 1,                        // sessions.json array length
        "updatedAt": "2026-07-20T22:55:46.025Z",  // roadmap.json project.updatedAt
        // --- family-tree additions (§2.7): purely additive, all existing fields byte-identical ---
        "origin": { "roadmapId": "rm-atlas-platform", "milestoneId": "ms-portal-questlog", "ts": "…" },
                                                  // echoed from the registry (null when a root; sessionId included if present)
        "orphan": false,                          // true = origin names a PARENT not in the registry
        "lineageError": null,                     // null | "cycle" | "too_deep" (read-side lineage flags, §2.7)
        "children": ["rm-child-a"],               // direct child registry ids, sorted by (origin.ts asc, then id)
        "fullStory": {                            // null for a missing entry
          "own":         { "done": 3, "total": 6 },
          "descendants": { "done": 12, "total": 18 },  // LIVE descendants only, recursive, depth<=8
          "missingDescendants": 0,                // descendant roads whose dir/roadmap.json is unreadable (excluded from counts)
          "sessionCount": 4 } }                   // UNIQUE session ids across own + live descendants' sessions.json
    ]
  }
  ```
  A `missing:true` entry (dir absent OR `roadmap.json` unreadable) → `tagline:""`, `progress:null`,
  `status:null`, `sessionCount:null`, `updatedAt:null`, `fullStory:null`, `name` from the registry
  entry (`origin`/`orphan`/`lineageError`/`children` still computed from the registry). Live entries
  read `name`/`tagline` from `roadmap.json`, falling back to the registry `name`. The family-tree
  keys are **purely additive** — an old server (or a registry with no `origin` anywhere) omits them,
  and the UI treats every roadmap as a root, degrading to a flat row of anchors. `rev` already folds
  every entry's `roadmap.json`+`sessions.json` mtimes plus the registry mtime, so it needs no change.
  **Reads are lock-free and tolerant** (§4); central mode never bumps `lastSeenAt` on reads.
- `POST /api/registry/unregister` `{"id"}` → remove ONE registry entry under the registry lock, atomic-write, return `{"removed": <entry>}`. **Registry-only — the road's `.questlog/` bytes on disk are NEVER touched.** `400` on a missing/blank `id`; `404 {"error":"not_found","message":"no roadmap <id>"}` for an unknown id. A live road re-registers itself on its next dir-mode start. (The overworld exposes this as a per-card two-step remove — no browser `confirm()`.)
- **Per-roadmap, id-scoped API** — executed against that roadmap's `.questlog`:
  `GET /api/r/<id>/state`, `POST /api/r/<id>/note`, `POST /api/r/<id>/decision/approve`,
  `POST /api/r/<id>/unclear`, `POST /api/r/<id>/dispatch`, `POST /api/r/<id>/file/<name>`. The
  **mutation** endpoints have request/response contracts **byte-identical** to their dir-mode
  equivalents (including the `sessionId?` additions and the §8 dispatch contract). `GET /api/r/<id>/state` returns the dir-mode `/api/state` payload **plus**
  the additive family-tree keys and extended `rev` of §5.3 (dir-mode `/api/state` never gains them).
  Unknown id → 404 `{"error":"not_found","message":"no roadmap <id>"}`. Registered-but-missing dir →
  404 `{"error":"E_MISSING_DIR","message":"registered dir not found: <dir>"}` (state AND mutations).
- Central mode does **not** serve the unprefixed `/api/state` / `/api/note` / … endpoints (they 404).

### 5.3 Family-tree serve-time additions to `/api/r/<id>/state` (CENTRAL mode only)

Central mode's per-roadmap `GET /api/r/<id>/state` returns everything the dir-mode `/api/state`
returns — the `roadmap`/`decisions`/`pins`/`glossary`/`sessions`/`historyTail` slices **exactly as
read from disk, never mutated** — **plus three additive top-level keys** and an **extended `rev`**.
**Dir-mode `/api/state` gains none of these — not even as `null`** — so the classic single-project
server stays byte-for-byte unchanged.

```jsonc
{
  "rev": "<own rev>-<mtime(registry)>-<per-descendant mtime(roadmap.json)>-<mtime(sessions.json)>…",
                                        // descendants in pre-order; 0 for a missing file. Dir-mode rev unchanged.
  // …roadmap / decisions / pins / glossary / sessions / historyTail EXACTLY as on disk…,
  "lineage": {
    "origin": { "…": "…" },                            // this road's own origin (null when a root); orphan/error echoed
    "orphan": false, "lineageError": null,             // null | "cycle" | "too_deep"
    "parent": { "id": "rm-atlas-platform", "name": "Atlas", "missing": false },
                                                       // null when a root; missing:true when the parent dir is unreadable
    "children": [ { "id": "rm-questlog", "name": "Questlog", "missing": false,
                    "originMilestoneId": "ms-portal-questlog",
                    "progress": { "done": 3, "total": 6 },   // that child's FULL-STORY counts (own + its descendants); null when missing
                    "status": "in_progress", "updatedAt": "…" } ]  // DIRECT children only
  },
  "portals": [                                         // one per DIRECT child (matching rule below)
    { "milestoneId": "ms-portal-questlog", "milestoneMissing": false,
      "childId": "rm-questlog", "childName": "Questlog", "childMissing": false,
      "progress": { "done": 3, "total": 6 },           // child full-story roll-up (own + its descendants)
      "status": "in_progress",                         // child's main-quest status — SAME rule as the world card
                                                       // ("available" fallback); null when childMissing
      "updatedAt": "…" } ],                            // child roadmap.json project.updatedAt; null when missing
  "fullStory": {
    "own": { "done": 3, "total": 6 }, "descendants": { "done": 12, "total": 18 },
    "missingDescendants": 0,
    "roads": 2,                                        // live roads counted (self + live descendants)
    "sessions": [                                      // UNION of self + descendant sessions.json, deduped by id
      { "id": "4c1f0b2e-…",
        "label": "founding session - built questlog + both roads",  // own road's label if non-empty,
                                                       // else first non-empty in pre-order
        "firstSeenAt": "<min across roads>", "lastSeenAt": "<max across roads>",
        "eventCount": 9,                               // SUM across roads
        "roads": [ { "id": "rm-atlas-platform", "name": "Atlas", "eventCount": 5 },
                   { "id": "rm-questlog", "name": "Questlog", "eventCount": 4 } ] }
    ]                                                  // sorted lastSeenAt DESC
  }
}
```

**Serve-time portal overlay (pinned; disk is never touched).** For the road being served, for each
**direct child** (depth-1 only — grandchildren roll up inside the child):
1. Read the child's full-story counts (recursive, depth-capped, live-descendants-only) + main-quest
   status + `project.updatedAt` — all tolerant, per-file, lock-free reads.
2. Match the child's `origin.milestoneId` against **this** roadmap's `milestones[].id` — **any
   quest**, not main-quest-only (a portal milestone can sit on a side quest — e.g.
   `ms-portal-questlog` lives on side quest `q-tooling`, so main-quest-only matching would miss it).
3. **Milestone found** → emit a `portals[]` entry with `milestoneMissing:false`. **Not found**
   (renamed/deleted in the parent) → still emit it with `milestoneMissing:true`; the UI shows it in
   the Full Story panel with a "portal milestone not on this road" note — no map overlay, no crash,
   and **the server writes nothing to repair it**.
4. The `roadmap` payload stays **byte-equivalent to the file** — the overlay lives only in the
   separate `portals` array. This keeps `POST /api/r/<id>/file/roadmap` round-trip-safe (no computed
   data can leak to disk) and makes drift impossible: the child is the single source of truth. Cost
   is one extra JSON read per descendant per poll; with the 2 s poll and single-digit road counts
   this is negligible — no caching layer.

**URL routing (both the server routes and the client parse):** plain full-page navigations, no
pushState. An overworld card click navigates to `/r/<id>`; the in-road switcher navigates to
`/r/<otherId>` or `/`; browser Back returns to the overworld. Client route parse:
`location.pathname === "/"` → (central) world-select; `/^\/r\/([a-z0-9-]+)$/` → the road view for
that id (which sets `API_PREFIX = "/api/r/"+id`; dir mode uses `API_PREFIX = "/api"`).

---

## 6. Jargon lint (`node schema/validate.mjs <projectRoot>`)

Runs as part of validation. It turns **undefined jargon into invalid data**: any acronym or
`[[codename]]` in a scanned text field that isn't in `glossary.json` is a **validation ERROR
(exit 1)**. No glossary file → the lint prints `WARNING: no glossary.json — jargon lint skipped`
and passes. This is the mechanical enforcement behind SKILL.md hard rule 3.

**Case rule (shared with UI matching).** A surface form is **case-sensitive iff it contains no
lowercase letter** (test `/^[^a-z]*$/`). So `KV`, `Q3`, `F-1` match only exactly; `wrangler`,
`PixelKit`, `the vault`, `pDNS` match case-insensitively.

**Fields scanned.** roadmap: `project.name`, `project.tagline`; quest `title`,`plain`; milestone
`title`,`summary`,`statusReason`,`plain`; item `title`,`body`,`blockedReason`,`plain` and each
note `body`; asset `label` (**not** `ref` — paths/commands are code). decisions:
`title`,`rationale`,`impact`,`plain`. pins: `label`,`summary`. glossary: `plain`,`note` (dogfood).
**`history.jsonl`, `sessions.json`, and `registry.json` are never scanned** — history is an
append-only past record, and session labels / registry names are free-form operator text, not
founder-facing roadmap prose. The validator still checks their *structure* when present (§2.6–2.7):
a malformed `sessions.json` is an error, but a **missing** one produces no validator output at all.

**Pre-strip** per field before tokenizing: remove backtick code spans (`` /`[^`]*`/g ``) and bare
URLs (`/https?:\/\/[^\s]+/g`) — code and links are not prose.

**Acronym token:** `/\b[A-Z][A-Z0-9-]*[A-Z0-9]\b/g` — starts uppercase, ≥2 chars, only `A-Z 0-9 -`,
ends uppercase/digit. Catches `KV`, `LCP`, `WSL`, `Q3`, `GB1`, `F-1`, `IG-5`, `SPEC-004`, `CI`.
Never matches inside snake_case (`WORKER_QUEUE_NAME` — `_` breaks `\b`) and never matches mixed-case
(`PixelKit`, `pDNS` are underline concerns, not lint errors).

**Stoplist** (exact, case-sensitive — always allowed even if undefined):
`["OK","API","URL","HTTP","HTTPS","JSON","JSONL","MCP","UI","ID","ISO","UTC","README","MIT","FAQ","HTML","CSS","JS","SVG","PNG","AI"]`.
Consequence: emphasis-caps prose (`HOLD`, `LIVE`, `NEVER`) gets flagged — write `**bold**` instead.

**Bracket-codenames:** `/\[\[([^\[\]]+)\]\]/g` — the inner text must be a glossary surface form
(case rule above). An unmatched `[[name]]` is the same class of error.

**Membership:** a token/codename passes iff it is in the stoplist OR equals a glossary surface form
(case-sensitive compare for all-caps surfaces, case-insensitive otherwise). Any non-passing hit is
an error. Dedupe: report each `(where, token)` pair once.

**Error format** (same `where: message` shape as other validator lines):
```
roadmap.items[it-spec-004].body: jargon "SPEC-004" not in glossary.json (define it or rewrite)
decisions[dec-x].rationale: codename "[[burst-lane]]" not in glossary.json
```
Fix each by either defining the term (`glossary_term_upsert`) or rewriting the text in plain words.

---

## 7. The central app: one door, many worlds (modes, routing, session tracing)

The founder's directive: *"instead of multiple ports it should be a central app… all the roadmaps
should be discoverable and traced with the appropriate set of session ids that contribute to it."*
Four capabilities, all fully back-compat with the classic single-`--dir` server:

**1 — Central app (one server, one port).** `node server.mjs` with **no** `--dir`/`QUESTLOG_DIR`
starts in **CENTRAL mode** (§5.2): it reads the registry (§2.7) and serves a **world-select
"overworld"** — one chunky level-select card per registered roadmap (name, tagline, progress
fraction, status dot, session count, last-updated). Clicking a world enters its **road view** at
`/r/<roadmapId>`; a header switcher hops between roads; browser Back returns to the overworld. The
existing `--dir` single-project mode (**DIR mode**, §5.1) keeps working unchanged, so open-source
users who want zero config lose nothing. Mode is chosen purely by presence of `--dir`/`--data`/
`QUESTLOG_DIR`, probed by the UI via `GET /api/mode`.

**2 — Discoverable registry** (`~/.questlog/registry.json`, §2.7; override with `QUESTLOG_REGISTRY`).
Roadmaps register three ways — the `roadmap_register` MCP tool, auto-registration when
`server.mjs --dir` boots, or a direct file edit — all upsert-by-resolved-dir so there are no
duplicates. Dead entries (dir deleted) survive as greyed "missing" cards, never crashing the app.

**3 — Session tracing.** Each `.questlog` gains an optional `sessions.json` roster (§2.6); every
`history.jsonl` event may carry a `sessionId` (§2.4). The MCP server resolves the id from an
explicit tool arg → a cached `session_hello(sessionId, label?)` (called once at session start; the
skill mandates it) → `env CLAUDE_SESSION_ID` (§3). Every MCP/UI mutation that resolves an id bumps
that session's counters. The road view shows a **Contributing Sessions** panel; the world card shows
the count. Missing `sessions.json` = empty panel, no validator output — never an error.

**4 — Roadmap family tree (origin edges, portals, full-story roll-up).** A registry entry (§2.7) may
carry an optional `origin {roadmapId, milestoneId, ts}` naming the parent road + portal milestone it
was promoted from; absent/null = a root. Promotion **converts** a side quest into a child roadmap and
records this edge — it never detaches (SKILL.md "Parallel work and the promotion rule"). From it the
central app draws the overworld as a **family tree** (children branch off their parent), overlays each
child's portal milestone with a **serve-time computed mirror** of the child's live state (§5.3 — disk
is never rewritten, so drift is impossible), and rolls a parent's **full story** up across all live
descendants (own + recursive descendant counts, plus a deduped-by-id session union answering "who
built all of it?"). Edges are set via `roadmap_register(…, originRoadmapId, originMilestoneId)` or
retrofitted/corrected via `roadmap_set_origin` (§3); self-edges and cycles are rejected on write and
defused on read (§2.7). All of it is additive to `/api/registry` (§5.2) and `/api/r/<id>/state`
(§5.3); entries without `origin` are roots and everything degrades to the flat overworld — full
back-compat.

**Locking recap (§4):** three lock domains, never nested — each roadmap's own `.questlog/.lock`
(mutations + `sessions.json` ride it together), and the registry's own `.lock`. Registry reads and
world-select reads are lock-free and tolerant; `rev` fields catch a stale-by-one-poll read up.

---

## 8. Batch dispatch — pending work and the "Send to agent" button

**Founder ruling (2026-07-21).** Founder notes and `unclear` flags **no longer auto-trigger** the
bridge helper. They accumulate as **pending work**; the founder goes over the whole roadmap, leaves
notes and flags, then presses **ONE** "Send to agent" button. The server assembles every pending
signal into one structured **worklist** and spawns **ONE** bridge session that works the list in
order. This is the questlog **default** — the old per-note behavior survives only behind a config
opt-in (`bridge.autoTrigger`, below). All fields here are OPTIONAL and additive: old data with no
dispatch markers loads unchanged, and a historic note is never swept into the first dispatch.

### 8.1 Pending markers (the data)

- **Founder notes** (`items[].notes[]`) carry `pending` / `dispatchId` / `dispatchedAt` (§2.1).
  A note is **pending** iff `author === "founder" && pending === true`. `POST /api/note` is the ONLY
  writer that sets `pending:true`; the MCP `item_note_add` does **not** (a chat-transcribed note is
  already handled in chat). Absent `pending` = not pending.
- **Standing flags** (milestones, items, decisions) carry `unclearDispatchId` /
  `unclearDispatchedAt` (§2.1, §2.2). A flag is **pending** iff `unclear === true && !unclearDispatchId`.
  A flag raised before this feature existed has no `unclearDispatchId`, so it **is** pending — intended.
- **Invariants** (validator, §6-adjacent): `dispatchId`/`unclearDispatchId` match `^disp-[a-z0-9][a-z0-9-]*$`;
  the id + its `…At` timestamp are **both-or-neither**; `pending` is a boolean when present. A
  dispatched-then-cleared flag simply drops both fields (re-flagging re-queues via `POST /api/unclear`);
  leftover-but-consistent fields are tolerated — only a broken pattern, a lone half of a pair, or an
  invalid timestamp is an error.

### 8.2 `POST /api/dispatch` (dir) · `POST /api/r/<id>/dispatch` (central)

Body `{}` (optional `sessionId`, stamped on `ui_dispatch`). Flow:
1. Bridge off (`!cfg.enabled`) → `409 {"error":"E_BRIDGE_DISABLED"}`.
2. Synchronous `reserveBatch()` fails (a run/reservation is already in flight) → `409 {"error":"E_BRIDGE_BUSY"}`.
3. Under the roadmap lock, assemble the worklist (§8.3). Zero entries → release the reservation,
   `409 {"error":"E_NOTHING_PENDING"}`.
4. **Practice mode** (`cfg.dryRun`): mark **nothing**; append `ui_dispatch` (`dryRun:true`); the
   helper writes the worklist + context package to `<dataDir>/bridge/` and spawns nothing.
   `200 {"ok":true,"dryRun":true,"dispatchId","count","entries","contextPackagePath"}`.
5. **Live**: in the same lock, stamp every consumed note (`pending:false` + `dispatchId` + `dispatchedAt`)
   and flag (`unclearDispatchId` + `unclearDispatchedAt`), atomic-write roadmap and/or decisions,
   append `ui_dispatch` (`dryRun:false`); respond immediately `200 {"ok":true,"dryRun":false,"dispatchId","count","entries"}`
   and run the batch in the background.
6. On the run settling: `done` → append `dispatch_done`; timeout/error/killed → **un-mark** the cards
   whose `dispatchId` matches this run (restore `pending:true`, delete the dispatch fields — nothing is
   lost) and append `dispatch_failed` with `unmarked` = the count restored. All inside the lock.

`entries` (response summary only) = `[{targetType, id, title, noteCount, unclear}]`; the full worklist
lives in the context package. One `dispatchId` (`genId("disp")` → `disp-` + 8 hex) per press is shared
by every consumed note/flag, the history events, the context package, and `worklist-<dispatchId>.json`.

### 8.3 The worklist shape (server assembler → prompt → `<dataDir>/bridge/worklist-<id>.json`)

One entry per **card**, carrying its notes AND its flag together. Entry order: ascending by the card's
earliest pending signal (the min of its pending note timestamps and `unclearAt`) — oldest first, drain
order.

```jsonc
{
  "dispatchId": "disp-ab12cd34", "ts": "<ISO>", "projectName": "<roadmap.project.name>",
  "entries": [
    { "n": 1, "targetType": "item" | "milestone" | "decision", "id": "it-…|ms-…|dec-…",
      "title": "…",
      "questId": "q-…", "questTitle": "…", "milestoneId": "ms-…", "milestoneTitle": "…",
                                     // items: resolved via their milestone's quest; milestones: own quest;
                                     // decisions OMIT these and instead carry relatedMilestoneIds + relatedMilestoneTitles
      "currentText": "<item.body | milestone.summary | rationale + \"\\n\" + impact>",
      "currentPlain": "<plain or \"\">",
      "unclear": true|false, "unclearAt": "<ts|null>",   // reflects the PENDING flag
      "notes": [ { "noteId": "note-…", "body": "<verbatim founder words>", "ts": "…" } ] }
                                     // pending founder notes only, verbatim, ts ascending; may be [] (unclear-only entry)
  ]
}
```

### 8.4 The batch prompt & run budgets (`bridge.mjs`)

`buildBatchPrompt({worklist, sessionId})` renders a plain, list-driven task (same voice/containment as
the single-card prompt): check in as the `bridge` session, `roadmap_get` once, then work each entry in
order — clear a flagged card with `clear_unclear` (full plain rewrite), act on each note with the
matching upsert (same id, always fill `plain`), add one short agent note per touched **item** (a
milestone/decision rewrite is itself the answer). Tool whitelist is **unchanged** — `session_hello`,
`roadmap_get`, `list_unclear`, `clear_unclear`, `item_upsert`, `item_note_add`, `milestone_upsert`,
`milestone_set_status`, `Read` (decision entries reach `clear_unclear`, which already handles `dec-` ids;
no `decision_*` tool is added). Budgets scale with N = `entries.length` (founder env caps override
absolutely): `maxTurns = QUESTLOG_BTW_MAX_TURNS ?? min(60, max(8, 4 + 4*N))`;
`timeoutMs = QUESTLOG_BTW_TIMEOUT_MS ?? min(900000, 120000 + 60000*(N-1))`. Every other containment
invariant is identical to the single-card run (kill-switch, SIGTERM→SIGKILL, `cleanEnv`, neutral
`mkdtemp` cwd, `--model`/`--strict-mcp-config`/`--add-dir`/`--allowedTools`, `bridge` attribution). Log
kinds: `bridge-dryrun-batch`, `bridge-spawn-batch`, `bridge-done-batch`.

### 8.5 Config: `bridge.autoTrigger` (default **false**)

Read in `readBridgeConfig` (`bridge.mjs`): env `QUESTLOG_BTW_AUTOTRIGGER` set → `value === "1"`; else
`config.json` `bridge.autoTrigger === true`; else **false**. `computeEffectiveConfig` (server) reports
it with a source of `env`|`config`|`default`, mirroring `bridge.enabled`/`dryRun`/`model`, and
`validateConfigBody`/`handleConfigPost` accept a boolean `bridge.autoTrigger`. Enforcement lives in
`BRIDGE.trigger()`: per-note/flag auto-triggering is **inert** unless `cfg.enabled && cfg.autoTrigger === true`
— so on the questlog default (false), `handleNote`/`handleUnclear` still call `BRIDGE.trigger(...)` but it
no-ops, leaving the work pending for a batch dispatch.
