# Questlog — the user journey

*Written 2026-08-26/27. Every ruling below is the founder's; the rest is the product as it
actually is, read from the code. This is the document packaging is built against.*

## Who this is for

**Primary:** a founder building with Claude Code who wants a living roadmap they and their
agents co-manage.
**Secondary:** a teammate who wants to *see and edit* the road — they take the same path,
they just don't have to use the agent half.

## One path, not two

There is exactly one way to run Questlog: **the browser path.**

- The **plugin** installs the agent half — MCP server, hooks, skills, commands.
- An **open command** starts the local server (if it isn't running) and opens the dashboard
  in the browser.

The single-executable path is **retired** (founder ruling, 2026-08-27). An exe was
unnecessary, its launcher was Windows-only, and Mac support was never established. Its
build tooling is archived outside the repo.

**Node is a prerequisite, and that is fine.** Almost every developer has it; the README says
so on line one and we do not design around people who don't.

## The journey, step by step

### 0. Getting it

Two commands, once per machine:

```
/plugin marketplace add yassine-codes/questlog
/plugin install questlog@questlog
```

The repo is private **only until launch** — it goes public at release. Until then, anyone
with git credentials for it can install.

Structural fact from the plugin docs: a marketplace cannot point at `./`, so the plugin
lives in a **subdirectory** of the repo.

### 1. Wiring into Claude Code

The install does all of it: registers the MCP server once for every project (it resolves
the project from `CLAUDE_PROJECT_DIR`, not a per-project `--dir`), registers the hooks from
`hooks/hooks.json`, installs both skills as `/questlog:questlog` and
`/questlog:chief-of-staff`, installs the commands. One `/reload-plugins`.

This replaces three manual acts — `claude mcp add` per project, hand-copying skills, and
the PowerShell hooks installer that refused the real settings file by design.

### 2. First session in a project with no road

The session-start hook finds no `.questlog/` and says **one line, takes no action:**

> Questlog is here. No road in this project yet — say "start a road" when you want one.

Silence would mean they forget it's installed; auto-creating a directory in every repo
they open would be hostile. *(Approved.)*

### 3. Starting a road

They say it. The skill interviews them about the project — what it is, what done looks
like, the first few milestones — and seeds `.questlog/` with a valid road. The road
auto-registers in the Overworld. **A conversation, not a wizard.** *(Approved.)*

### 4. The daily loop

Session opens → briefing off the board: blocked items, the unclear queue, decisions
waiting, the latest baton, and a coverage line saying what the briefing did not show.
The agent says hello and appears in the Roster. Work moves milestone status with evidence
attached. Decisions are proposed, approved by the founder in chat, and logged. Unclear
flags are drained into plain language. Compaction drops a save point. `/questlog:handoff`
banks a baton. The Stop hook nudges if the board was never touched.

**Founder direction (2026-08-27), scope open:** this loop should be *a graphical interface
that agents manage through the interface*, inside a cmux / tmux-like multiplexed
environment. Recorded on the board as its own locked milestone pending a design pass.

### 5. Looking at it

The open command starts the server if needed and opens the browser on the **Overworld** —
one card per registered road. Enter a road; the header offers Board, Chats, Decisions,
Plain English, Raids, Roster, Sessions, Timeline and Settings.

**The agent suggests the open command at every session start.** *(Approved.)* The launcher
logic is ported from PowerShell to Node so Mac and Linux get the same double-step.

### 6. Talking to it from the dashboard

On any card: **Chat about this card.** In the header: **Chats → New** for a board-level
chat. Pick a tier — observer, board-editor, workspace-builder, full-autonomy — each
authorized by the founder. **Branch** forks a chat carrying its whole context. From the
Roster, **Open in a terminal** spawns a real session (behind a Settings toggle). The Task
board queues work for approval. **More horizons** asks for new directions on a card.
**Distill** turns a recurring pattern into a skill. Raids shows live subagent workflows.

The chat dock spawns `claude`, so the CLI must be on the path. Plugin users have it by
definition.

### 7. Autonomy

Bridge off, dry-run on, auto-trigger off by default; the switch is the founder's to flip
in Settings. *(Kept as is.)*

### 8. The teammate

Same browser path. They install the plugin or simply run the server and open the
dashboard. The server binds `127.0.0.1`, so a teammate sees a road only if they have the
files — which is why **a project commits its `.questlog/`**: that is the sharing mechanism.
(The engine repo ignores its *own* road only because it should not ship its dogfood data.)
*(Approved.)*

### 9. Updating

Bump `version` in `plugin.json`; users get the update. Nothing else.

## What packaging has to build, read off the gaps

1. Repo layout — plugin in a subdirectory.
2. `plugin.json` + `marketplace.json`.
3. `.mcp.json` resolving the project from `CLAUDE_PROJECT_DIR`.
4. `hooks/hooks.json`, retiring `install-hooks.ps1`.
5. Both skills into `skills/`, and every hard-coded `C:/Users/…` path in the README and the
   skill references replaced with `CLAUDE_PLUGIN_ROOT`.
6. The one-line empty-project message in the session-start hook.
7. The "start a road" interview in the skill.
8. The open command, a Node launcher, and the session-start suggestion of it; the
   PowerShell launcher scripts are archived once it works.
9. "Commit your `.questlog/`" guidance in the skill and README.
10. Repo public at launch.

## Why hardening comes first

Step 8 makes multiple writers the normal case, not an edge one. The hardening pass —
delete controls, the encoding sweep, colliding writes escalated for a ruling, and the
zero-byte cleanup — is what makes that safe. It gates packaging.

## Addendum — 2026-09-07, packaging pass

*Appended, never edited above. Every ruling stands; this corrects one structural fact that the
plugin docs changed under us since 08-27.*

**§0's "a marketplace cannot point at `./`" is superseded, and with it worklist item 1, "Repo
layout — plugin in a subdirectory."** The plugin-marketplaces doc now writes its examples with a
marketplace-root source — *"When several plugin entries share one `skills/` folder at the
marketplace root (`source: "./"`), list specific subdirectories instead so each entry loads only
its own skills"* — and its validator agrees: *"As of Claude Code v2.1.196, the per-entry pass
also: includes plugins whose `source` is `.`"*. Verified on the installed CLI (2.1.263) with
`claude plugin validate` on a throwaway marketplace of exactly that shape.

So **the engine stays at the repo root and the plugin root IS the repo root** — nothing moved — and
**the install commands in §0 are unchanged**. A CLI that ever rejected `"./"` would take
`{"source": "github", "repo": "yassine-codes/questlog"}` instead: the same repo, the same two
commands, one extra clone. A structural fact corrected, not a ruling.

**The names as installed**, namespaced `<plugin>:<folder>`: skills `/questlog:questlog`,
`/questlog:chief-of-staff`, `/questlog:reskin`; commands `/questlog:handoff`, `/questlog:open`.
