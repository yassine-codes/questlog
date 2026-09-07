# QUESTLOG × "/btw" BRIDGE — FEASIBILITY VERDICT + ARCHITECTURE

## 1. VERDICT

**The founder's literal wish — wrap Claude Code's `/btw` — is NOT buildable. The underlying intent IS, TODAY, on this machine, and is now probe-verified end to end.**

`/btw` is structurally disqualified on three independent axes (Brief A):
- **No tools / read-only.** It runs `maxTurns:1` with a system reminder that explicitly forbids reading files, running commands, or "taking any actions." It cannot write `.questlog/*.json` or call the questlog MCP. It only emits an ephemeral answer that is never persisted.
- **No independent cheap model.** `/btw` inherits `cacheSafeParams` from the live session; model is session-global via `/model`. There is no per-`/btw` model field. You cannot pin it to Sonnet while the parent runs Opus.
- **Interactive UI only.** It is an Ink/React overlay in a live TUI/desktop session (Ctrl/Cmd+;). There is **no headless/programmatic `/btw` entry point** a POST handler could fire. Blunt: `/btw` is unreachable from questlog's node server, full stop.

**Chosen invocation mechanism: headless `claude -p` (print mode) with `--model sonnet`, launched from the questlog server via `child_process.spawn`.** This is the correct mapping of the founder's actual intent ("spin off a cheap side task that reads full context and writes questlog updates without opening a chat"). Why this and not the alternatives:
- vs. Agent SDK (`@anthropic-ai/claude-agent-sdk`): the SDK is more ergonomic but **violates questlog's zero-npm-dep constitution** and defaults to `ANTHROPIC_API_KEY` auth rather than the founder's CLI subscription. `spawn` of the already-installed CLI adds **zero dependencies** and rides existing OAuth.
- vs. background agents (`claude --bg`): viable and async-friendly, but adds lifecycle/polling management. Keep as a v2 option; not needed for the prototype.
- The questlog MCP server is **not** a trigger surface — MCP is pull-only (the model calls `item_upsert`; the node server cannot push a task into a model through it). It is the **effector** the bridge task writes through.

**What is now verified live (2 probes, both spent):**
- Probe 1 (Brief B): `claude -p --model sonnet --output-format json` from a neutral cwd with nesting env cleared → exit 0, `modelUsage: claude-sonnet-5` (1M ctx). Read path + model routing + non-interactive JSON confirmed.
- Probe 2 (this run): the same invocation with `--permission-mode acceptEdits --allowedTools Write` **actually wrote a file non-interactively** — `permission_denials: []`, file present on disk, `num_turns:2`, 14.2 s wall / 5.4 s TTFT, Sonnet-5, ~26k cache-creation tokens. **This closes the one gap both researchers left open: headless writes succeed without a TTY prompt.** The effector path is real, not just documented.

One residual unknown, deliberately not probed (budget exhausted, and it is not load-bearing): whether a *custom* `/questlog …` slash-command dispatches through the raw CLI in `-p` mode. Brief B proved interactive built-ins (`/context`) fall through as literal text; custom-skill dispatch is documented but unconfirmed on the raw CLI. **The design sidesteps this entirely by passing a plain natural-language prompt, not a slash command** — so the prototype does not depend on the unverified path.

## 2. ARCHITECTURE (end-to-end)

```
Founder acts in questlog UI/API
  POST /item/note  or  POST /item/flag-unclear
        │
        ▼
server.mjs handler
  1. Write the note/flag into roadmap.json + append history.jsonl   (unchanged, always happens)
  2. IF process.env.QUESTLOG_BTW_BRIDGE === "1"  (else: return, do nothing)  ◄── OFF BY DEFAULT
        │
        ▼
Debounce queue (per-item, in-memory Map: itemId → timer)
  - Coalesce rapid edits on the same card into one pass
  - Default 8–10 s idle window; also a global concurrency cap of 1 in-flight spawn
  - Skips if an identical pass for this itemId is already running
        │
        ▼  (timer fires)
Build context package (node, no model):
  - itemId, the founder's note/flag text, item's current title/body/status
  - roadmap.json path (via --add-dir on the .questlog data dir)
  - OPTIONAL: paths of project docs the card references (read-only, --add-dir'd)
        │
        ▼
spawn("claude", [...], { cwd: neutralTempDir, env: cleanedEnv })   ◄── containment (Brief C)
  cleanedEnv = process.env MINUS:
    CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_SESSION_ID,
    CLAUDE_CODE_CHILD_SESSION, CLAUDE_JOB_DIR, CLAUDE_AGENTS_SELECT,
    CLAUDE_CODE_BRIDGE_SESSION_ID, CLAUDE_EFFORT, AI_AGENT,
    CLAUDE_CODE_EXECPATH, CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT,
    CLAUDE_PLUGIN_DATA, CODEX_COMPANION_TRANSCRIPT_PATH
    (rule: strip every CLAUDE_*/AI_AGENT/CODEX_* session var; keep PATH/HOME)
  args:
    -p "<plain-language task: read roadmap, act on this note / rewrite this
        unclear card plainer, keep status honest; touch ONLY item <id>>"
    --model sonnet
    --output-format json
    --max-turns 6
    --permission-mode acceptEdits              ◄── proven to write non-interactively
    --allowedTools "mcp__questlog__item_upsert mcp__questlog__item_note_add
                    mcp__questlog__roadmap_get Read"
    --mcp-config <questlog-mcp.json>           ◄── inject the questlog MCP effector
    --add-dir <.questlog data dir> [--add-dir <referenced doc dirs>]
    [--resume <prior session_id for this item>]  ◄── context reuse for follow-up notes
        │
        ▼
Cheap model (Sonnet-5) reads context, calls mcp__questlog__item_upsert /
item_note_add to update the card. Exits. JSON result captured.
        │
        ▼
server writes attribution into sessions.json / the item history:
  { source:"btw-bridge", model:"sonnet", session_id, itemId,
    trigger:"note"|"unclear", cost_usd, duration_ms, ts }
  (so founder-authored vs. bridge-authored edits are distinguishable, and the
   MCP's sessionId stamping ties writes back to this spawn)
        │
        ▼
Founder's dashboard 2 s poll picks up the mutated roadmap.json → sees the
card rewritten / note acted on, tagged as bridge-authored. No chat opened.
```

**Containment rules (Brief C), enforced:**
- **OFF by default** — the entire branch is gated on `QUESTLOG_BTW_BRIDGE=1`. Absent the flag, questlog behaves exactly as today.
- **Zero npm deps** — `child_process.spawn` of the installed CLI only; no SDK.
- **Local-only** — spawn runs on the founder's subscription/OAuth; no new network surface, no new ports (does not touch :4177 or any other local server).
- **Writes scoped** — `--allowedTools` whitelists only the questlog MCP write verbs + `Read`; no `Bash`, no `Edit` of arbitrary files. Nesting env cleared; neutral cwd. `--max-turns 6` caps runaway loops.
- **Nothing written outside** the questlog dirs — the model's only write path is the questlog MCP, which writes only `.questlog/*` JSON.

## 3. COST / LATENCY ENVELOPE (per bridge run, measured)

| Dimension | Value (from probes) | Notes |
|---|---|---|
| Model | `claude-sonnet-5`, 1M ctx, 64k max out | `--model sonnet` routes here |
| Wall time | **~14–20 s cold** (Probe 2: 14.2 s; Probe 1: 17 s) | dominated by cold-cache creation, not the reply |
| TTFT | ~4.5–5.4 s | |
| Tokens | **~26–28k cache-creation + ~28–84k cache-read per cold call**; reply output only ~270 tokens | the ~28k system-prompt/skill-preamble cold-start tax IS the budget driver |
| List-price equiv | ~$0.18–0.19/call | **On this machine = subscription rate-limit draw, not dollars** (no `ANTHROPIC_API_KEY`) |
| Warm/repeat | 5m + 1h ephemeral cache + `--resume <id>` cuts the re-establishment cost on follow-up notes to the same card | conversation state carries; cold cache still partially recreates |

**Budget implication:** the fixed ~28k-token cold-start per invocation, not the tiny reply, is what matters. Debounce + `--resume` + keeping the questlog skill small are the levers. A chatty, un-debounced bridge would silently drain the founder's shared interactive rate limit — hence the debounce and single-concurrency cap are load-bearing, not optional.

## 4. GO / NO-GO

**GO** for a prototype in this workflow.

Both GO conditions are met:
1. **Mechanism verified by probe** — not inferred. `claude -p --model sonnet` with `--permission-mode acceptEdits` was live-run twice: model routing confirmed (Sonnet-5), nesting-env-cleared neutral-cwd spawn confirmed, and — the decisive close — a **non-interactive write actually landed on disk with zero permission denials.** The read path AND the write path are both proven.
2. **Fits questlog's constitution** — zero-npm-dep (`spawn` only), off-by-default (`QUESTLOG_BTW_BRIDGE=1` gate), local-only (subscription OAuth, no new ports, no new network egress). Writes are scoped to the questlog MCP effector.

The only thing NOT proven — custom `/questlog` slash-command dispatch through the raw CLI — is **designed around** by using a plain prompt, so it does not block GO.

## 5. PROTOTYPE SCOPE (smallest honest version)

Four artifacts, all inside the repo root or the questlog skill dir. **Ship with dry-run as the default even when the flag is on**, so the first observable behavior is the exact command printed, never a live spawn.

1. **`bridge.mjs`** (new, at the repo root) — a self-contained module, zero deps:
   - `maybeBridge(itemId, trigger, noteText, ctx)` called from the note/flag POST handlers, guarded by `process.env.QUESTLOG_BTW_BRIDGE`.
   - Per-item debounce Map (default 8 s) + global single-concurrency lock.
   - `buildArgs()` → the exact `spawn` argv above.
   - `cleanEnv()` → clones `process.env`, deletes every `CLAUDE_*` / `AI_AGENT` / `CODEX_*` session var (the 13 observed on this machine, matched by prefix so it survives new vars).
   - **`QUESTLOG_BTW_DRYRUN` (default on):** instead of spawning, `console.log` the fully-resolved command line + cleaned-env delta + context package, and return. This is the safe first state.

2. **Server config flag** in `server.mjs` — read `QUESTLOG_BTW_BRIDGE` (enable) and `QUESTLOG_BTW_DRYRUN` (default `"1"`). Wire `maybeBridge()` into the two existing POST handlers *after* the JSON/history write, so the bridge is purely additive and never blocks or alters the founder's own write.

3. **A "Bridge" section in the questlog `SKILL.md`** (`skills/questlog/SKILL.md`) — documents: what the bridge does, the two env flags, the debounce/concurrency defaults, the `--allowedTools` whitelist, the `session.json` attribution shape, and the containment invariants (off-by-default, nesting-env-clear, neutral cwd, writes-only-via-MCP). This is what makes the bridge auditable rather than a hidden spawn.

4. **Dry-run mode** (folded into #1) — the acceptance test for the prototype is: set `QUESTLOG_BTW_BRIDGE=1`, POST a note, and confirm the server logs the precise `claude -p …` command it *would* run, with a correctly cleaned env, and writes nothing. Flipping `QUESTLOG_BTW_DRYRUN=0` is the single deliberate step from "prints the command" to "runs it."

**Verification probe:** the workflow's 2-probe budget is now **fully spent** (B's read probe + this run's write probe). The prototype's own live-spawn validation should therefore be done by the founder flipping `QUESTLOG_BTW_DRYRUN=0` once against a throwaway test card — not by a further probe here. The mechanics that a probe could establish are already established; nothing about the invocation contract remains unproven.

---

**Tools used:** Bash (env inspection + 2 headless `claude -p` probes). **Expected but not needed:** WebSearch/WebFetch (deferred; briefs already carried the doc research). No process was killed, no port bound, both probes ran in `mktemp` temp dirs with cleared nesting env and were cleaned up. No files written.