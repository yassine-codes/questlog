#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Chat dock self-tests — NO live claude spawn. Exercises:
//   * access profiles -> exact spawn argv per tier (all four), incl. the two
//     tiers the founder authorised a permission mode for
//   * the escalation ceiling: a hand-edited profile table can never widen a
//     profile past AUTHORIZED_CEILING (layer (b), re-clamped at spawn)
//   * legacy mode -> flag mapping (observer/standard) kept for old records
//   * branch/fork argv: --resume <parent> --fork-session --session-id <new>
//   * stream-json parser against fixture lines (text deltas, tool_use, result)
//   * anchoring preamble builder bounded (<=600/field, <=4000 whole) board+card
//   * chat record round-trip: create -> send -> chats.json + <id>.jsonl + road
//     sessions.json all updated (via an INJECTED fake-claude spawn)
//   * SSE ring-buffer replay on connect
//   * concurrency: E_CHAT_BUSY (409) + E_CHAT_CAP (429)
//   * timeout / error path appends an error line, status back to idle
// Run: node chat.selftest.mjs
// ---------------------------------------------------------------------------
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  modeFlags, profileFlags, spawnFlags, clampPermissionMode,
  DEFAULT_PROFILES, AUTHORIZED_CEILING, BOARD_WRITE_TOOLS,
  BOARD_DENY_TOOLS, BOARD_LEVEL_PROFILES, WINDOW_HONESTY_RULE,
  buildChatArgs, makeStreamParser, OBSERVER_READ_TOOLS,
  buildBoardPreamble, buildMilestonePreamble, buildPreamble,
  readChatsIndex, findChat, readTranscript,
  handleChatCreate, handleChatList, handleChatGet, handleChatSend, handleChatStream,
  isChatRunning, totalInFlight, _resetRuntime, _emitForTest,
  // F-A — the double-render fix
  streamSinceFromUrl, _streamCursor, _ringFor, _markPersisted,
  // P1-P5 + wave 1
  chatTimeoutMs, chatIdleTimeoutMs, chatRetries, claudeSessionExists, claudeProjectSlug,
  classifyChatFailure, killMessage, hasAssistantLine, beatToLine,
  CHAT_TIMEOUT_DEFAULT_MS, CHAT_IDLE_TIMEOUT_DEFAULT_MS, CHAT_RETRIES_DEFAULT,
  TOOL_INPUT_CAP, TOOL_OUTPUT_CAP,
} from "./chat.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_MJS = path.resolve(__dirname, "./chat.mjs");

let passed = 0;
const ok = (name) => { console.log("  ok -", name); passed++; };
const skip = (name, why) => { console.log("  SKIP -", name, "(" + why + ")"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- temp home + a temp road ----------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "questlog-chat-test-"));
const HOME = path.join(TMP, "home");
const ROAD = path.join(TMP, "road");
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(path.join(ROAD, ".questlog"), { recursive: true });
const ENV = { ...process.env, QUESTLOG_REGISTRY: path.join(HOME, "registry.json"), QUESTLOG_CHAT_CLAUDE_BIN: "fake-claude" };

function makeCtx(root) {
  const dataDir = path.join(root, ".questlog");
  return {
    root, dataDir, lockDir: path.join(dataDir, ".lock"),
    files: {
      roadmap: path.join(dataDir, "roadmap.json"),
      decisions: path.join(dataDir, "decisions.json"),
      pins: path.join(dataDir, "pins.json"),
      glossary: path.join(dataDir, "glossary.json"),
      history: path.join(dataDir, "history.jsonl"),
      sessions: path.join(dataDir, "sessions.json"),
      batons: path.join(dataDir, "batons.json"),
    },
  };
}
const CTX = makeCtx(ROAD);
// Seed a roadmap with a milestone + item + history so archaeology has something.
fs.writeFileSync(CTX.files.roadmap, JSON.stringify({
  schemaVersion: 1,
  project: { name: "Test Road", tagline: "" },
  quests: [], milestones: [{ id: "ms-alpha", title: "Alpha milestone", summary: "Ship the thing.", status: "in_progress" }],
  items: [{ id: "it-1", milestoneId: "ms-alpha", title: "task", body: "do it" }],
  assets: [],
}), "utf8");
fs.writeFileSync(CTX.files.sessions, JSON.stringify({ schemaVersion: 1, sessions: [{ id: "sess-old", label: "bridge", firstSeenAt: "2026-07-01T00:00:00.000Z", lastSeenAt: "2026-07-01T00:00:00.000Z", eventCount: 1 }] }), "utf8");
fs.appendFileSync(CTX.files.history, JSON.stringify({ ts: "2026-07-01T00:00:00.000Z", targetId: "ms-alpha", sessionId: "sess-old", action: "milestone_upsert" }) + "\n", "utf8");
fs.writeFileSync(CTX.files.batons, JSON.stringify({ schemaVersion: 1, batons: [{
  id: "baton-0000abcd", ts: "2026-07-02T00:00:00.000Z", fromSessionId: "sess-old", toSessionId: null,
  label: "hand off alpha", done: ["scaffold"], inFlight: ["wiring"], next: ["tests"], warnings: ["watch the lock"],
  docPath: null, status: "open",
}] }), "utf8");

const DEPS = {
  env: ENV, mode: "central",
  resolveRoadCtx: (roadId) => (roadId === "rm-test" ? { ctx: CTX, roadId, root: CTX.root } : null),
};

// ---- fake res / req --------------------------------------------------------
function fakeRes() {
  return {
    code: null, headers: null, body: "", chunks: [], ended: false,
    writeHead(code, headers) { this.code = code; this.headers = headers; },
    write(s) { this.chunks.push(s); },
    end(s) { if (s !== undefined) this.body = s; this.ended = true; },
  };
}
function jsonOf(res) { return JSON.parse(res.body); }

// ---- fake claude spawn: streams fixture lines, then closes -----------------
function makeFakeSpawn(lines, { exitCode = 0, emitError = null, errCode = null, stderrText = null } = {}) {
  return function fakeSpawn() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.pid = 12345;
    setImmediate(() => {
      if (emitError) {
        const err = new Error(emitError);
        if (errCode) err.code = errCode;
        child.emit("error", err);
        return;
      }
      for (const l of lines) child.stdout.write(l + "\n");
      if (stderrText) child.stderr.write(stderrText);
      setImmediate(() => child.emit("close", exitCode));
    });
    return child;
  };
}

const FIXTURE_LINES = [
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } } }),
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: " world" } } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello world" }, { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x/y.txt" } }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "line one\nline two" }] } }),
  JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.0123, duration_ms: 4200, num_turns: 2, is_error: false }),
];

// A MULTI-TOOL stream in true chronological order: prose, tool, prose, tool,
// prose. This is the fixture that proves F1 — the founder's whole complaint was
// that this shape came out as all-prose-then-all-tools.
const ORDERED_FIXTURE = [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "I'll check the roadmap first." }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "questlog-chief-of-staff" } }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Launching skill: questlog-chief-of-staff" }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "The board has six milestones." }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "C:/road/roadmap.json" } }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "{\"milestones\":[]}" }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Two of them are blocked." }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "git status" } }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "nothing to commit", is_error: false }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "The tree is clean." }] } }),
  JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.5, duration_ms: 9000, num_turns: 4, is_error: false }),
];

// ===========================================================================
// 0. ACCESS TIERS — exact flags per profile. This is the argv assertion the
//    contract's done-means (2) asks for: what each authorised tier spawns with.
// ===========================================================================
const DENY_FLAGS = ["--disallowedTools", BOARD_DENY_TOOLS.join(",")];
const OBS_FLAGS = ["--allowedTools", DEFAULT_PROFILES.observer.allowedTools.join(","), ...DENY_FLAGS];
const BE_FLAGS = ["--allowedTools", DEFAULT_PROFILES["board-editor"].allowedTools.join(","), ...DENY_FLAGS];
const WB_FLAGS = ["--permission-mode", "acceptEdits", "--allowedTools", DEFAULT_PROFILES["workspace-builder"].allowedTools.join(",")];
const FA_FLAGS = ["--permission-mode", "bypassPermissions"];
{
  assert.deepStrictEqual(profileFlags("observer"), OBS_FLAGS, "observer => read allowlist only");
  assert.deepStrictEqual(profileFlags("board-editor"), BE_FLAGS, "board-editor => board allowlist, no permission mode");
  assert.deepStrictEqual(profileFlags("workspace-builder"), WB_FLAGS, "workspace-builder => acceptEdits + board allowlist + Read/Edit/Write");
  assert.deepStrictEqual(profileFlags("full-autonomy"), FA_FLAGS, "full-autonomy => bypassPermissions ONLY, no allowlist");
  // The two authorised bypass tiers carry EXACTLY their authorised mode.
  assert.strictEqual(WB_FLAGS[WB_FLAGS.indexOf("--permission-mode") + 1], AUTHORIZED_CEILING["workspace-builder"]);
  assert.strictEqual(FA_FLAGS[FA_FLAGS.indexOf("--permission-mode") + 1], AUTHORIZED_CEILING["full-autonomy"]);
  // Only those two names have a ceiling at all.
  assert.deepStrictEqual(Object.keys(AUTHORIZED_CEILING).sort(), ["full-autonomy", "workspace-builder"],
    "AUTHORIZED_CEILING names exactly the two tiers the founder authorised a permission mode for");
  assert.ok(Object.isFrozen(AUTHORIZED_CEILING), "AUTHORIZED_CEILING is frozen");
  // observer + board-editor carry NO permission mode, ever.
  for (const p of ["observer", "board-editor"]) {
    assert.ok(!profileFlags(p).includes("--permission-mode"), `${p} carries no --permission-mode`);
  }
  // board-editor has the questlog write tools but NO file/command tools.
  const beTools = DEFAULT_PROFILES["board-editor"].allowedTools;
  for (const t of BOARD_WRITE_TOOLS) assert.ok(beTools.includes(t), `board-editor includes ${t}`);
  for (const t of ["Read", "Edit", "Write", "Bash"]) assert.ok(!beTools.includes(t), `board-editor must NOT include ${t}`);
  // roadmap_register / roadmap_set_origin are registry topology — excluded by default.
  for (const t of ["mcp__questlog__roadmap_register", "mcp__questlog__roadmap_set_origin"]) {
    assert.ok(!beTools.includes(t), `board-editor default excludes ${t} (registry topology)`);
  }
  // workspace-builder = board-editor + exactly Read/Edit/Write.
  assert.deepStrictEqual(
    DEFAULT_PROFILES["workspace-builder"].allowedTools.filter((t) => !beTools.includes(t)),
    ["Read", "Edit", "Write"], "workspace-builder adds exactly Read/Edit/Write over board-editor");
  // Unknown profile name => observer flags (safe default preserved).
  assert.deepStrictEqual(profileFlags("no-such-tier"), OBS_FLAGS, "unknown profile => observer flags");
  assert.deepStrictEqual(profileFlags(undefined), OBS_FLAGS, "undefined profile => observer flags");
  ok("access tiers: exact argv for all four profiles; only the two authorised tiers carry a permission mode");
}

// ===========================================================================
// 0b. ESCALATION CEILING (layer b) — a hand-edited config can never widen.
//     THIS is the founder-edit-rejection assertion: a config table that adds a
//     bypass flag to observer must produce NO permission-mode flag at spawn.
// ===========================================================================
{
  const tampered = JSON.parse(JSON.stringify(DEFAULT_PROFILES));
  tampered.observer.permissionMode = "bypassPermissions";          // the attack
  tampered["board-editor"].permissionMode = "acceptEdits";          // subtler attack
  tampered["workspace-builder"].permissionMode = "bypassPermissions"; // widen an authorised tier
  assert.deepStrictEqual(profileFlags("observer", tampered), OBS_FLAGS,
    "hand-edited observer with bypassPermissions is CLAMPED back to no permission mode");
  assert.ok(!profileFlags("board-editor", tampered).includes("--permission-mode"),
    "hand-edited board-editor with acceptEdits is CLAMPED (no ceiling for that name)");
  assert.ok(!profileFlags("workspace-builder", tampered).includes("bypassPermissions"),
    "workspace-builder cannot be widened past its authorised acceptEdits");
  assert.deepStrictEqual(profileFlags("workspace-builder", tampered),
    ["--allowedTools", tampered["workspace-builder"].allowedTools.join(",")],
    "a widened workspace-builder falls back to allowlist-only (mode dropped, tools kept)");
  // A custom profile invented in config has no ceiling: no permission mode ever.
  const custom = { ...DEFAULT_PROFILES, "my-tier": { label: "Mine", allowedTools: ["mcp__questlog__roadmap_get"], permissionMode: "bypassPermissions" } };
  assert.deepStrictEqual(profileFlags("my-tier", custom), ["--allowedTools", "mcp__questlog__roadmap_get"],
    "a custom profile never gets a permission mode, whatever the config says");
  // clampPermissionMode is the single predicate behind all of it.
  assert.strictEqual(clampPermissionMode("observer", "bypassPermissions"), null);
  assert.strictEqual(clampPermissionMode("full-autonomy", "bypassPermissions"), "bypassPermissions");
  assert.strictEqual(clampPermissionMode("full-autonomy", "acceptEdits"), null, "an unauthorised-for-that-name mode is dropped, not substituted");
  assert.strictEqual(clampPermissionMode("workspace-builder", "acceptEdits"), "acceptEdits");
  assert.strictEqual(clampPermissionMode("workspace-builder", null), null, "restricting DOWN to null is always allowed");
  // Comma injection through a config tool list can't smuggle a second flag.
  const inj = { ...DEFAULT_PROFILES, observer: { label: "o", allowedTools: ["ok_tool", "bad,--permission-mode"], permissionMode: null } };
  assert.deepStrictEqual(profileFlags("observer", inj), ["--allowedTools", "ok_tool", ...DENY_FLAGS], "tool names with commas are dropped (the board deny list still lands)");
  ok("ceiling: a config that adds a bypass flag to observer/board-editor is clamped to nothing at spawn; customs get none");
}

// ===========================================================================
// 0c. HARNESS-4 — AUTHORITATIVE BOARD PROFILES. The declared allowlist used
//     not to be the effective one: the headless layer auto-allowed Read/Grep/
//     Glob, so a board-level chat could answer by grepping the filesystem
//     (its 83.3% measured the filesystem, not the profile). The deny list is
//     table-keyed by profile NAME at spawn time, so config cannot remove it.
// ===========================================================================
{
  assert.ok(Object.isFrozen(BOARD_DENY_TOOLS), "BOARD_DENY_TOOLS is frozen");
  assert.ok(Object.isFrozen(BOARD_LEVEL_PROFILES), "BOARD_LEVEL_PROFILES is frozen");
  assert.deepStrictEqual([...BOARD_DENY_TOOLS],
    ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "BashOutput", "KillShell", "Glob", "Grep", "WebFetch", "WebSearch", "Task"],
    "the deny list is exactly the file/command/fetch surface");
  assert.deepStrictEqual([...BOARD_LEVEL_PROFILES], ["observer", "board-editor"],
    "exactly the two board-level tiers are authoritative");

  // ARGV: observer + board-editor carry --disallowedTools with the exact list.
  for (const p of ["observer", "board-editor"]) {
    const argv = profileFlags(p);
    const i = argv.indexOf("--disallowedTools");
    assert.ok(i >= 0, `${p} argv carries --disallowedTools`);
    assert.strictEqual(argv[i + 1], BOARD_DENY_TOOLS.join(","), `${p} deny argv is the exact frozen list`);
    // deny comes AFTER the allowlist, and deny beats allow in Claude Code.
    assert.ok(i > argv.indexOf("--allowedTools"), `${p} denies after it allows`);
  }
  // A DENIED READ, asserted as a denied Read: "Read" is present in the deny
  // argv and absent from the allow argv, for both board tiers.
  for (const p of ["observer", "board-editor"]) {
    const argv = profileFlags(p);
    const allow = argv[argv.indexOf("--allowedTools") + 1].split(",");
    const deny = argv[argv.indexOf("--disallowedTools") + 1].split(",");
    assert.ok(deny.includes("Read"), `${p}: Read is DENIED`);
    assert.ok(!allow.includes("Read"), `${p}: Read is not in the allowlist either`);
    for (const t of ["Grep", "Glob", "Bash", "Write", "Edit", "Task", "WebFetch"]) {
      assert.ok(deny.includes(t), `${p}: ${t} is denied`);
    }
    // Skill + ToolSearch stay ALLOWED deliberately (buildBoardPreamble invokes
    // the chief-of-staff skill; both are loaders with no data reach).
    assert.ok(!deny.includes("Skill"), `${p}: Skill stays allowed (the board preamble depends on it)`);
    assert.ok(!deny.includes("ToolSearch"), `${p}: ToolSearch stays allowed`);
  }
  // workspace-builder / full-autonomy: untouched by definition.
  for (const p of ["workspace-builder", "full-autonomy"]) {
    assert.ok(!profileFlags(p).includes("--disallowedTools"), `${p} carries NO --disallowedTools (file access is what that tier IS)`);
  }
  // TAMPER: a config that adds Read to board-editor's allowlist still yields
  // Read in the deny argv — deny beats allow, so it is dead argv.
  {
    const tampered = JSON.parse(JSON.stringify(DEFAULT_PROFILES));
    tampered["board-editor"].allowedTools.push("Read", "Bash", "Grep");
    const argv = profileFlags("board-editor", tampered);
    const allow = argv[argv.indexOf("--allowedTools") + 1].split(",");
    const deny = argv[argv.indexOf("--disallowedTools") + 1].split(",");
    assert.ok(allow.includes("Read"), "the tampered allowlist did reach argv (we are not silently filtering)");
    assert.ok(deny.includes("Read") && deny.includes("Bash") && deny.includes("Grep"),
      "a config-injected Read/Bash/Grep is STILL denied — the deny list is table-keyed by NAME, not read from config");
    assert.strictEqual(argv[argv.indexOf("--disallowedTools") + 1], BOARD_DENY_TOOLS.join(","),
      "config cannot shrink or reorder the deny list");
  }
  // Renaming does not help: an unknown profile falls through to observer flags,
  // which carry the deny list too.
  assert.deepStrictEqual(profileFlags("board-editor-but-sneaky"), OBS_FLAGS,
    "an invented board-ish profile name falls back to observer — deny list included");
  ok("HARNESS-4: observer/board-editor argv denies the exact file/command surface; workspace-builder/full-autonomy carry none; a tampered allowlist is dead argv");
}

// ===========================================================================
// 0d. HARNESS-2 wiring + PROMPT-1 — the read whitelist reaches the new tools,
//     and the window/board honesty rule is verbatim in BOTH preambles.
// ===========================================================================
{
  assert.ok(OBSERVER_READ_TOOLS.includes("mcp__questlog__roadmap_list"),
    "OBSERVER_READ_TOOLS includes roadmap_list (read the registry without mutating)");
  assert.ok(OBSERVER_READ_TOOLS.includes("mcp__questlog__history_tail"),
    "OBSERVER_READ_TOOLS includes history_tail (an honest, truncation-signalling window)");
  // Still no write tool sneaked in with them.
  for (const t of ["register", "set_origin", "baton_read", "upsert", "_delete", "pin_", "clear_"]) {
    assert.ok(!OBSERVER_READ_TOOLS.join(",").includes(t), `the read whitelist still contains no write token "${t}"`);
  }
  assert.strictEqual(WINDOW_HONESTY_RULE,
    "Saying something is NOT on the board requires a whole-record read. If your view is windowed or scoped — history_tail returned truncated:true, or a road you cannot reach — say 'not in my window', never 'not on the board'.",
    "the honesty rule is the exact contracted sentence");
  const bp = buildBoardPreamble({ projectName: "P", root: "/r" });
  const mp = buildMilestonePreamble({ projectName: "P", milestone: { title: "T", status: "done" } });
  assert.ok(bp.includes(WINDOW_HONESTY_RULE), "the board preamble carries the honesty rule");
  assert.ok(mp.includes(WINDOW_HONESTY_RULE), "the milestone preamble carries the honesty rule");
  // It survives the length clamp even when every field is oversized.
  const big = "x".repeat(5000);
  const bpBig = buildBoardPreamble({ projectName: big, root: big });
  const mpBig = buildMilestonePreamble({
    projectName: big, milestone: { title: big, status: big, summary: big, plain: big },
    baton: { label: big, done: [big], inFlight: [big], next: [big], warnings: [big] },
    builtBy: { count: 3, labels: [big, big] },
  });
  assert.ok(bpBig.includes(WINDOW_HONESTY_RULE) && bpBig.length <= 4000, "the rule survives a 4000-char clamp (board)");
  assert.ok(mpBig.includes(WINDOW_HONESTY_RULE) && mpBig.length <= 4000, "the rule survives a 4000-char clamp (milestone)");
  ok("HARNESS-2 wiring + PROMPT-1: roadmap_list/history_tail are on the read whitelist; the honesty rule is verbatim in both preambles and clamp-proof");
}

// ===========================================================================
// 1. Legacy modeFlags mapping incl. the safe default (old records still run).
// ===========================================================================
{
  // REMEDIATED contract: observer = ONLY the read-only allowlist, NO
  // --permission-mode (plan mode blocks all MCP execution — proven by live probe).
  const OBS = ["--allowedTools", OBSERVER_READ_TOOLS.join(",")];
  assert.deepStrictEqual(modeFlags("observer"), OBS, "observer => read-only allowlist, no permission-mode");
  assert.deepStrictEqual(modeFlags("standard"), [], "standard => no flag");
  assert.deepStrictEqual(modeFlags("anything-else"), OBS, "unknown => SAFE default (read-only allowlist)");
  assert.deepStrictEqual(modeFlags(undefined), OBS, "undefined => SAFE default (read-only allowlist)");
  // observer must carry NO permission-mode flag (plan would block MCP entirely).
  assert.ok(!modeFlags("observer").includes("--permission-mode"), "observer carries NO --permission-mode");
  assert.ok(!modeFlags("anything-else").includes("--permission-mode"), "unknown default carries NO --permission-mode");
  // exact read-only whitelist, and NO write/history tool may appear.
  assert.deepStrictEqual(OBSERVER_READ_TOOLS,
    ["mcp__questlog__roadmap_get", "mcp__questlog__list_unclear", "mcp__questlog__baton_peek",
      "mcp__questlog__roadmap_list", "mcp__questlog__history_tail"],
    "observer whitelist is exactly the five read-only questlog tools (baton_peek — strictly-read — not baton_read; plus the registry read and the honest history window)");
  // Observer purity: the write-capable baton_read must NOT be on the observer whitelist.
  assert.ok(!OBSERVER_READ_TOOLS.includes("mcp__questlog__baton_read"),
    "observer whitelist must NOT include baton_read (it can claim/write on pickUp)");
  const WRITE_TOKENS = ["upsert", "set_status", "_create", "note_add", "asset_link", "decision_log",
    "set_approval", "pin_compaction", "clear_unclear", "glossary", "_delete", "baton_pass",
    "session_hello", "register", "set_origin"];
  const wl = OBSERVER_READ_TOOLS.join(",");
  for (const t of WRITE_TOKENS) assert.ok(!wl.includes(t), `observer whitelist must not contain write token "${t}"`);
  ok("modeFlags: observer=read allowlist (no permission-mode), standard=none, unknown/undefined => safe default; zero write tools");
}

// ===========================================================================
// 2. buildChatArgs shape; standard has NO permission flag; no forbidden strings.
// ===========================================================================
{
  const obs = buildChatArgs({ prompt: "P", model: "sonnet", sessionId: "sid", isFirst: true, mode: "observer", mcpConfigPath: "/t/m.json" });
  for (const f of ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", "--session-id", "--mcp-config"]) {
    assert.ok(obs.includes(f), `first/observer argv missing ${f}`);
  }
  assert.ok(!obs.includes("--strict-mcp-config"), "chat MUST NOT pass --strict-mcp-config");
  assert.ok(!obs.includes("--resume"), "first send uses --session-id not --resume");
  assert.ok(!obs.includes("--permission-mode"), "observer argv carries NO --permission-mode (plan blocks MCP)");
  assert.strictEqual(obs[obs.indexOf("--allowedTools") + 1], OBSERVER_READ_TOOLS.join(","), "observer argv threads the read-only whitelist");
  // No write tool token may appear anywhere in the observer argv.
  {
    const obsJoined = obs.join(" ");
    for (const t of ["upsert", "set_status", "_create", "decision_log", "set_approval", "baton_pass", "_delete", "session_hello", "register", "set_origin", "clear_unclear"])
      assert.ok(!obsJoined.includes(t), `observer argv must not contain write token "${t}"`);
  }

  const std = buildChatArgs({ prompt: "P", model: "sonnet", sessionId: "sid", isFirst: false, mode: "standard", mcpConfigPath: "/t/m.json" });
  assert.ok(!std.includes("--permission-mode"), "standard passes NO permission flag");
  assert.ok(!std.includes("--allowedTools"), "standard passes NO --allowedTools");
  assert.ok(std.includes("--resume") && !std.includes("--session-id"), "subsequent send uses --resume");

  // ---- exact per-tier argv (contract done-means 2) -------------------------
  const argvFor = (profile, extra) => buildChatArgs(Object.assign({
    prompt: "P", model: "sonnet", sessionId: "sid", isFirst: true, profile, mcpConfigPath: "/t/m.json",
  }, extra || {}));
  const HEAD = ["-p", "P", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", "sonnet", "--session-id", "sid"];
  const TAIL = ["--mcp-config", "/t/m.json"];
  assert.deepStrictEqual(argvFor("observer"), [...HEAD, ...OBS_FLAGS, ...TAIL], "observer argv exact");
  assert.deepStrictEqual(argvFor("board-editor"), [...HEAD, ...BE_FLAGS, ...TAIL], "board-editor argv exact");
  assert.deepStrictEqual(argvFor("workspace-builder"), [...HEAD, ...WB_FLAGS, ...TAIL], "workspace-builder argv exact (acceptEdits)");
  assert.deepStrictEqual(argvFor("full-autonomy"), [...HEAD, ...FA_FLAGS, ...TAIL], "full-autonomy argv exact (bypassPermissions, no allowlist)");
  // A stored profile WINS over a stale legacy mode on the same record.
  assert.deepStrictEqual(spawnFlags({ profile: "observer", mode: "standard" }), OBS_FLAGS, "profile beats legacy mode");
  assert.deepStrictEqual(spawnFlags({ mode: "standard" }), [], "no profile => legacy mode path");

  // ---- BRANCH / FORK argv --------------------------------------------------
  const forked = argvFor("observer", { parentSessionId: "parent-sess-1" });
  const ri = forked.indexOf("--resume");
  assert.ok(ri >= 0, "fork uses --resume");
  assert.strictEqual(forked[ri + 1], "parent-sess-1", "fork resumes the PARENT session id");
  assert.strictEqual(forked[ri + 2], "--fork-session", "--fork-session follows --resume");
  assert.strictEqual(forked[ri + 3], "--session-id", "--session-id pins the new id (plan A)");
  assert.strictEqual(forked[ri + 4], "sid", "the new chat id is the pinned session id");
  // A branch's SECOND send resumes its own id, never the parent's again.
  const forked2 = buildChatArgs({ prompt: "P", model: "sonnet", sessionId: "sid", isFirst: false, profile: "observer", parentSessionId: "parent-sess-1", mcpConfigPath: "/m" });
  assert.ok(!forked2.includes("--fork-session"), "later sends never fork again");
  assert.strictEqual(forked2[forked2.indexOf("--resume") + 1], "sid", "later sends resume the branch's own id");

  // Nothing the founder did NOT authorise may ever appear, in any tier.
  const NEVER = ["dontAsk", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--permission-mode auto", "--permission-mode manual"];
  for (const profile of ["observer", "board-editor", "workspace-builder", "full-autonomy", "weird", undefined]) {
    const a = buildChatArgs({ prompt: "P", model: "m", sessionId: "s", isFirst: true, profile, mcpConfigPath: "/m" }).join(" ");
    for (const bad of NEVER) assert.ok(!a.includes(bad), `argv (profile=${profile}) must not contain ${bad}`);
  }
  // The two bypassing strings appear ONLY under their authorised tier.
  for (const [profile, str] of [["observer", "bypassPermissions"], ["board-editor", "bypassPermissions"],
    ["observer", "acceptEdits"], ["board-editor", "acceptEdits"], ["full-autonomy", "acceptEdits"], ["workspace-builder", "bypassPermissions"]]) {
    const a = buildChatArgs({ prompt: "P", model: "m", sessionId: "s", isFirst: true, profile, mcpConfigPath: "/m" }).join(" ");
    assert.ok(!a.includes(str), `${profile} argv must not contain ${str}`);
  }
  ok("buildChatArgs: exact per-tier flags, no --strict-mcp-config, no unauthorised permission string in any tier");
}

// ===========================================================================
// 2b. The superseded safety header was REWRITTEN, not silently deleted, and
//     the two bypass strings appear in chat.mjs only inside the authorised
//     ceiling / profile table. (The old test asserted those strings were
//     absent from the file entirely — that assertion is superseded by
//     dec-chat-access-tiers; leaving it green would have been a stale test.)
// ===========================================================================
{
  const src = fs.readFileSync(CHAT_MJS, "utf8");
  assert.ok(src.includes("dec-chat-access-tiers"), "chat.mjs header cites the governing decision");
  assert.ok(/SUPERSEDES|superseded/.test(src), "chat.mjs states the earlier ruling was superseded, not silently dropped");
  assert.ok(!src.includes("dontAsk"), "chat.mjs never mentions dontAsk");
  assert.ok(!src.includes("dangerously-skip-permissions"), "chat.mjs never constructs --dangerously-skip-permissions");
  // Both bypass strings must be reachable ONLY through AUTHORIZED_CEILING /
  // DEFAULT_PROFILES — never as a literal handed to args.push.
  for (const bad of ["bypassPermissions", "acceptEdits"]) {
    assert.ok(!new RegExp(`push\\([^)]*["']${bad}["']`).test(src), `${bad} is never pushed into argv as a literal`);
  }
  ok("chat.mjs: header rewritten citing dec-chat-access-tiers; bypass strings live only in the frozen ceiling/profile table");
}

// ===========================================================================
// 3. stream-json parser against fixture lines.
// ===========================================================================
{
  const parser = makeStreamParser();
  const events = [];
  for (const l of FIXTURE_LINES) for (const e of parser.push(l)) events.push(e);
  const deltas = events.filter((e) => e.type === "delta").map((e) => e.text);
  assert.deepStrictEqual(deltas, ["Hello", " world"], "text deltas emitted in order");
  const tool = events.find((e) => e.type === "tool");
  assert.ok(tool && tool.name === "Read" && /file_path/.test(tool.detail), "tool_use => tool event with a legacy compact detail");
  // F2 — the FULL structured input rides the event now; the 240-char clip is
  // demoted to `detail` and the frontend generates the resting summary.
  assert.deepStrictEqual(tool.input, { file_path: "/x/y.txt" }, "the full structured input rides the tool event");
  assert.strictEqual(tool.toolUseId, "toolu_1", "the tool_use id rides the event so results can correlate");
  assert.strictEqual(typeof tool.seq, "number", "every tool event carries a seq");
  // F2 — tool_result off a `user` line, correlated back to its chip.
  const tr = events.find((e) => e.type === "tool_result");
  assert.ok(tr, "a tool_result event is emitted (it was dropped entirely before)");
  assert.strictEqual(tr.toolUseId, "toolu_1", "the result names the tool_use it belongs to");
  assert.strictEqual(tr.output, "line one\nline two", "the result output is captured");
  assert.strictEqual(tr.outputIsError, false, "a clean result is not flagged as an error");
  const result = events.find((e) => e.type === "result");
  assert.ok(result && result.costUsd === 0.0123 && result.durationMs === 4200 && result.numTurns === 2 && result.isError === false, "result mapped");
  // `done` is now the RUN CONTROLLER's to emit — with bounded retry a failed
  // attempt must not close the turn in the UI.
  assert.ok(!events.some((e) => e.type === "done"), "the parser no longer emits done (the run controller owns it, exactly once per send)");
  const st = parser.state();
  assert.ok(Array.isArray(st.beats), "state() returns ordered beats");
  assert.strictEqual(st.beats.length, 2, "one prose beat + one tool beat");
  assert.strictEqual(st.beats[0].kind, "text");
  assert.strictEqual(st.beats[0].text, "Hello world", "prose merged into the open panel");
  assert.strictEqual(st.beats[1].kind, "tool");
  assert.strictEqual(st.beats[1].output, "line one\nline two", "the result was folded onto the tool beat for persistence");
  // malformed / unknown lines are ignored, not thrown
  assert.deepStrictEqual(parser.push("{not json"), [], "malformed line ignored");
  assert.deepStrictEqual(parser.push(JSON.stringify({ type: "system", subtype: "init" })), [], "unknown type ignored");
  ok("stream parser: deltas, tool_use with FULL input, tool_result correlated, result; done is the controller's; malformed tolerated");
}

// ===========================================================================
// 3b. F1 — ORDERED BEATS. The founder's complaint, as an assertion: a
//     multi-tool stream must come out prose->tool->prose->tool->prose, with
//     DISTINCT per-beat timestamps and a monotonic seq. The old parser routed
//     text into a string accumulator and tool_use into a separate array, so
//     452 seconds of work and 29 tool calls landed as one blob, all the chips,
//     and one identical timestamp.
// ===========================================================================
{
  const parser = makeStreamParser();
  const events = [];
  for (const l of ORDERED_FIXTURE) for (const e of parser.push(l)) events.push(e);
  const st = parser.state();
  assert.deepStrictEqual(st.beats.map((b) => b.kind),
    ["text", "tool", "text", "tool", "text", "tool", "text"],
    "beats alternate prose/tool in TRUE chronological order");
  assert.deepStrictEqual(st.beats.filter((b) => b.kind === "tool").map((b) => b.name),
    ["Skill", "Read", "Bash"], "the tools are in the order they were called");
  assert.deepStrictEqual(st.beats.filter((b) => b.kind === "text").map((b) => b.text), [
    "I'll check the roadmap first.",
    "The board has six milestones.",
    "Two of them are blocked.",
    "The tree is clean.",
  ], "each prose panel is its own beat — sealed at the tool boundary, not concatenated");
  // seq is monotonic across the whole turn.
  const seqs = st.beats.map((b) => b.seq);
  assert.deepStrictEqual(seqs, seqs.slice().sort((a, b) => a - b), "seq is monotonic");
  assert.strictEqual(new Set(seqs).size, seqs.length, "seq values are unique");
  // Every beat has an honest ts.
  for (const b of st.beats) assert.ok(typeof b.ts === "string" && /^\d{4}-/.test(b.ts), "every beat carries an ISO ts stamped at parse time");
  // Results correlated onto their own tool.
  const tools = st.beats.filter((b) => b.kind === "tool");
  assert.strictEqual(tools[0].output, "Launching skill: questlog-chief-of-staff");
  assert.strictEqual(tools[1].output, '{"milestones":[]}');
  assert.strictEqual(tools[2].output, "nothing to commit");
  // F6's input: the Skill beat carries the skill name for the banner.
  assert.strictEqual(tools[0].input.skill, "questlog-chief-of-staff", "the Skill beat carries the skill name (F6 banner)");
  // The persisted line shape (schema v2).
  const lines = st.beats.map(beatToLine);
  assert.deepStrictEqual(lines.map((l) => l.role), ["assistant", "tool", "assistant", "tool", "assistant", "tool", "assistant"],
    "beatToLine preserves the order and maps kinds onto the existing role vocabulary");
  assert.ok(lines[1].input && lines[1].toolUseId && typeof lines[1].output === "string", "a persisted tool line carries input, id and output");
  assert.ok(lines.every((l) => typeof l.seq === "number"), "every persisted line carries seq");
  ok("F1: a multi-tool stream persists as prose->chip->prose in true order, distinct ts, monotonic unique seq, results correlated");
}

// ===========================================================================
// 3c. F2 — caps. A 50KB Read result must not put 50KB on every transcript line.
// ===========================================================================
{
  const parser = makeStreamParser();
  const bigInput = { blob: "x".repeat(TOOL_INPUT_CAP + 5000) };
  const bigOutput = "y".repeat(TOOL_OUTPUT_CAP + 50000);
  parser.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "big", name: "Read", input: bigInput }] } }));
  parser.push(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "big", content: bigOutput, is_error: true }] } }));
  const b = parser.state().beats[0];
  assert.strictEqual(typeof b.input, "string", "an over-cap input is kept as a clipped string, not dropped");
  assert.ok(b.input.length <= TOOL_INPUT_CAP, "input honours the 16KB cap");
  assert.strictEqual(b.inputTruncated, true, "the input truncation is FLAGGED, not silent");
  assert.strictEqual(b.output.length, TOOL_OUTPUT_CAP, "output honours the 4KB cap");
  assert.strictEqual(b.outputTruncated, true, "the output truncation is flagged");
  assert.strictEqual(b.outputIsError, true, "a failed tool result is flagged so the chip can render vermilion");
  // Array-shaped tool_result content (the common MCP shape) flattens.
  const p2 = makeStreamParser();
  p2.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "m", name: "mcp__questlog__roadmap_get", input: {} }] } }));
  p2.push(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "m", content: [{ type: "text", text: "road" }, { type: "text", text: "map" }] }] } }));
  assert.strictEqual(p2.state().beats[0].output, "road\nmap", "an array-shaped tool_result flattens to text");
  ok("F2: 16KB input / 4KB output caps enforced and FLAGGED; array-shaped results flatten; tool errors marked");
}

// ===========================================================================
// 4. Preamble builders bounded.
// ===========================================================================
{
  const big = "x".repeat(5000);
  const mp = buildMilestonePreamble({
    projectName: big,
    milestone: { title: big, status: big, summary: big, plain: big },
    baton: { label: big, done: [big], inFlight: [big], next: [big], warnings: [big] },
    builtBy: { count: 3, labels: [big, big, big] },
  });
  assert.ok(mp.length <= 4000, `whole preamble <=4000 (got ${mp.length})`);
  for (const line of mp.split("\n")) assert.ok(line.length <= 700, "no single clamped field grossly exceeds 600 (+label)");
  const bp = buildBoardPreamble({ projectName: big, root: big });
  assert.ok(bp.length <= 4000, "board preamble <=4000");
  assert.ok(/chief-of-staff/.test(bp), "board preamble installs the chief-of-staff persona");
  // from-disk assembly: milestone-anchored picks up card + baton + built-by
  const asm = buildPreamble(CTX, "ms-alpha");
  assert.ok(/Alpha milestone/.test(asm) && /hand off alpha/.test(asm) && /BUILT BY: 1/.test(asm), "assembled milestone preamble carries card+baton+built-by");
  const board = buildPreamble(CTX, null);
  assert.ok(/Test Road/.test(board) && /chief-of-staff/.test(board), "assembled board preamble names road + persona");
  ok("preamble: milestone + board bounded (<=600/field, <=4000 whole); disk assembly carries card/baton/built-by");
}

// ===========================================================================
// 5. Create -> send -> round-trip (fake claude spawn), roster + files updated.
// ===========================================================================
let CHAT_ID = null;
{
  _resetRuntime();
  const resC = fakeRes();
  handleChatCreate(resC, { roadId: "rm-test", milestoneId: "ms-alpha", profile: "observer", model: "sonnet" }, DEPS);
  assert.strictEqual(resC.code, 200, "create 200");
  const rec = jsonOf(resC).chat;
  CHAT_ID = rec.id;
  assert.ok(/^[0-9a-f-]{36}$/.test(CHAT_ID), "chat id is a uuid");
  assert.strictEqual(rec.profile, "observer", "record stores the chosen profile");
  assert.strictEqual(rec.mode, "observer", "legacy mode kept in step for old readers");
  assert.strictEqual(rec.parentSessionId, null, "an unbranched chat has no parent");
  assert.strictEqual(rec.anchorMilestoneId, "ms-alpha");
  // roster: create put the chat in the road sessions.json immediately
  const sess0 = JSON.parse(fs.readFileSync(CTX.files.sessions, "utf8")).sessions;
  assert.ok(sess0.find((s) => s.id === CHAT_ID), "chat id present in road roster on create");

  // send with an injected fake claude
  const sendDeps = { ...DEPS, spawn: makeFakeSpawn(FIXTURE_LINES) };
  const resS = fakeRes();
  handleChatSend(resS, CHAT_ID, { text: "explain the milestone please" }, sendDeps);
  assert.strictEqual(resS.code, 202, "send accepted 202");

  // wait for the fake run to finish (status back to idle)
  for (let i = 0; i < 200 && isChatRunning(CHAT_ID); i++) await sleep(5);
  assert.ok(!isChatRunning(CHAT_ID), "chat run settled");

  // transcript: user(briefed) + assistant + tool + result
  const tr = readTranscript(ENV, CHAT_ID);
  const user = tr.find((e) => e.role === "user");
  assert.ok(user && user.briefed === true && /explain the milestone/.test(user.text), "user line stored with briefed:true (founder words, no preamble)");
  assert.ok(!/BUILT BY|chief-of-staff/.test(user.text), "preamble NOT stored in the founder line");
  assert.ok(tr.find((e) => e.role === "assistant" && e.text === "Hello world"), "assistant text persisted");
  const toolLine = tr.find((e) => e.role === "tool" && e.name === "Read");
  assert.ok(toolLine, "tool line persisted");
  assert.deepStrictEqual(toolLine.input, { file_path: "/x/y.txt" }, "the persisted tool line keeps the FULL input (F2)");
  assert.strictEqual(toolLine.output, "line one\nline two", "the persisted tool line keeps the correlated output (F2)");
  const resLine = tr.find((e) => e.role === "result");
  assert.ok(resLine && resLine.costUsd === 0.0123 && resLine.isError === false, "result line persisted");
  // schema v2: seq on every line, user line = 0, honest per-beat ts.
  assert.strictEqual(user.seq, 0, "the user line is seq 0 for this send");
  for (const e of tr) assert.strictEqual(typeof e.seq, "number", `every new line carries seq (${e.role})`);
  const seqs = tr.map((e) => e.seq);
  assert.deepStrictEqual(seqs, seqs.slice().sort((a, b) => a - b), "persisted seq is monotonic in file order");
  assert.ok(new Set(tr.filter((e) => e.role !== "user").map((e) => e.ts)).size > 1,
    "beats carry DISTINCT timestamps, not one child-close stamp for the whole turn");
  // P1 — the record now records that a Claude session exists.
  assert.strictEqual(findChat(CHAT_ID, ENV).sessionStarted, true, "sessionStarted persisted at spawn");

  // chats.json record updated (idle, lastCostUsd, title auto)
  const rec2 = findChat(CHAT_ID, ENV);
  assert.strictEqual(rec2.status, "idle", "status back to idle after success");
  assert.strictEqual(rec2.lastCostUsd, 0.0123, "lastCostUsd recorded");
  assert.ok(rec2.title && rec2.title.length <= 60 && /explain/.test(rec2.title), "title auto-set from first message (<=60 chars)");

  // roster label reflects the chat title
  const sess1 = JSON.parse(fs.readFileSync(CTX.files.sessions, "utf8")).sessions.find((s) => s.id === CHAT_ID);
  assert.ok(sess1 && /^chat: /.test(sess1.label) && sess1.eventCount >= 1, "road roster label 'chat: ...' + event accounted");
  ok("round-trip: create+send -> chats.json + <id>.jsonl + road sessions.json all updated; preamble not stored");
}

// ===========================================================================
// 6. SSE ring-buffer replay on connect.
// ===========================================================================
{
  const rres = fakeRes();
  const rreq = new EventEmitter();
  // events from the previous run are in the ring; connect now and expect replay
  handleChatStream(rreq, rres, CHAT_ID, DEPS);
  assert.strictEqual(rres.code, 200, "stream 200");
  assert.strictEqual(rres.headers["Content-Type"], "text/event-stream; charset=utf-8", "SSE content-type");
  const joined = rres.chunks.join("");
  assert.ok(/data:\{"type":"delta"/.test(joined), "replayed a delta event");
  assert.ok(/"type":"result"/.test(joined) && /"type":"done"/.test(joined), "replayed result + done");
  // a freshly emitted event reaches the live listener too
  _emitForTest(CHAT_ID, { type: "delta", text: "LIVE" });
  assert.ok(rres.chunks.join("").includes('"LIVE"'), "live event fanned out to connected listener");
  rreq.emit("close");
  ok("SSE: ring replay on connect (last events) + live fan-out; heartbeat wired");
}

// ===========================================================================
// 7. Concurrency: E_CHAT_BUSY (409) and E_CHAT_CAP (429).
// ===========================================================================
{
  _resetRuntime();
  // A fake spawn that never closes on its own => keeps the chat "running".
  const hangingSpawn = () => { const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => {}; return c; };
  // make three distinct running chats to hit the cap
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const rc = fakeRes();
    handleChatCreate(rc, { roadId: "rm-test", mode: "standard" }, DEPS);
    const id = jsonOf(rc).chat.id; ids.push(id);
    const rs = fakeRes();
    handleChatSend(rs, id, { text: "hi " + i }, { ...DEPS, spawn: hangingSpawn });
    assert.strictEqual(rs.code, 202, "send " + i + " started");
  }
  assert.strictEqual(totalInFlight(), 3, "three chats in flight");
  // same-chat second send => 409 busy
  const busy = fakeRes();
  handleChatSend(busy, ids[0], { text: "again" }, { ...DEPS, spawn: hangingSpawn });
  assert.strictEqual(busy.code, 409, "same chat busy => 409");
  assert.strictEqual(jsonOf(busy).error, "E_CHAT_BUSY");
  // a fourth, different chat => 429 cap
  const capRc = fakeRes();
  handleChatCreate(capRc, { roadId: "rm-test", mode: "standard" }, DEPS);
  const cap = fakeRes();
  handleChatSend(cap, jsonOf(capRc).chat.id, { text: "overflow" }, { ...DEPS, spawn: hangingSpawn });
  assert.strictEqual(cap.code, 429, "over cap => 429");
  assert.strictEqual(jsonOf(cap).error, "E_CHAT_CAP");
  _resetRuntime(); // release the hanging fakes (in-memory only)
  ok("concurrency: 409 E_CHAT_BUSY per-chat, 429 E_CHAT_CAP total (max 3)");
}

// ===========================================================================
// 8. Error path: nonzero exit / spawn error appends an error line, status idle.
// ===========================================================================
{
  _resetRuntime();
  const rc = fakeRes();
  handleChatCreate(rc, { roadId: "rm-test", mode: "observer" }, DEPS);
  const id = jsonOf(rc).chat.id;
  const rs = fakeRes();
  handleChatSend(rs, id, { text: "will fail" }, { ...DEPS, spawn: makeFakeSpawn([], { exitCode: 1 }) });
  assert.strictEqual(rs.code, 202);
  for (let i = 0; i < 200 && isChatRunning(id); i++) await sleep(5);
  const tr = readTranscript(ENV, id);
  const err = tr.find((e) => e.role === "error");
  assert.ok(err && /exited 1/.test(err.message), "error line appended on nonzero exit");
  assert.strictEqual(findChat(id, ENV).status, "idle", "status back to idle after error");

  // spawn-error variant
  const rc2 = fakeRes();
  handleChatCreate(rc2, { roadId: "rm-test", mode: "observer" }, DEPS);
  const id2 = jsonOf(rc2).chat.id;
  const rs2 = fakeRes();
  handleChatSend(rs2, id2, { text: "boom" }, { ...DEPS, spawn: makeFakeSpawn([], { emitError: "spawn ENOENT" }) });
  for (let i = 0; i < 200 && isChatRunning(id2); i++) await sleep(5);
  assert.ok(readTranscript(ENV, id2).find((e) => e.role === "error" && /ENOENT/.test(e.message)), "spawn error appended as error line");
  ok("error path: nonzero-exit + spawn-error each append an error line, never a fake reply, status idle");
}

// ===========================================================================
// 9. Validation: bad profile/mode 400, central missing roadId 400, 404s.
// ===========================================================================
{
  const r1 = fakeRes();
  handleChatCreate(r1, { roadId: "rm-test", profile: "god-mode" }, DEPS);
  assert.strictEqual(r1.code, 400, "unknown profile => 400");
  const r1b = fakeRes();
  handleChatCreate(r1b, { roadId: "rm-test", mode: "bypass" }, DEPS);
  assert.strictEqual(r1b.code, 400, "bad legacy mode => 400");
  const r1c = fakeRes();
  handleChatCreate(r1c, { roadId: "rm-test" }, DEPS);
  assert.strictEqual(r1c.code, 400, "neither profile nor mode => 400");
  const r1d = fakeRes();
  handleChatCreate(r1d, { roadId: "rm-test", profile: "observer", branchFromSessionId: "bad id!" }, DEPS);
  assert.strictEqual(r1d.code, 400, "malformed branchFromSessionId => 400");
  const r2 = fakeRes();
  handleChatCreate(r2, { profile: "observer" }, DEPS); // central + no roadId
  assert.strictEqual(r2.code, 400, "central missing roadId => 400");
  const r3 = fakeRes();
  handleChatGet(r3, "no-such-chat", DEPS);
  assert.strictEqual(r3.code, 404, "unknown chat => 404");
  const r4 = fakeRes();
  handleChatList(r4, DEPS);
  assert.strictEqual(r4.code, 200, "list ok");
  assert.ok(Array.isArray(jsonOf(r4).chats), "list returns chats array");
  ok("validation: unknown profile 400, bad legacy mode 400, neither 400, bad branch id 400, missing roadId 400, unknown chat 404");
}

// ===========================================================================
// 10. BRANCHING end-to-end (fake spawn): a branch chat records its parent,
//     stamps lineage into the road roster, and forks on its FIRST send only.
//     The parent's own transcript is byte-identical afterwards.
// ===========================================================================
{
  _resetRuntime();
  // Branch from the chat created in group 5 (any ledger session id works).
  const parentBytesBefore = fs.readFileSync(path.join(HOME, "chats", `${CHAT_ID}.jsonl`));
  const rc = fakeRes();
  handleChatCreate(rc, { roadId: "rm-test", profile: "board-editor", branchFromSessionId: CHAT_ID }, DEPS);
  assert.strictEqual(rc.code, 200, "branch create 200");
  const brec = jsonOf(rc).chat;
  assert.strictEqual(brec.parentSessionId, CHAT_ID, "branch record stores parentSessionId");
  assert.strictEqual(brec.profile, "board-editor", "a branch picks its own tier (never inherited, never full-autonomy by default)");
  assert.notStrictEqual(brec.id, CHAT_ID, "a branch gets a NEW chat id");

  // lineage landed in the road roster on create
  const sess = JSON.parse(fs.readFileSync(CTX.files.sessions, "utf8")).sessions.find((s) => s.id === brec.id);
  assert.ok(sess && sess.parentSessionId === CHAT_ID, "road sessions.json entry carries parentSessionId");

  // first send forks; capture the real argv from the injected spawn
  let seenArgs = null;
  const capturingSpawn = (bin, args, opts) => { seenArgs = args; return makeFakeSpawn(FIXTURE_LINES)(bin, args, opts); };
  const rs = fakeRes();
  handleChatSend(rs, brec.id, { text: "carry on from there" }, { ...DEPS, spawn: capturingSpawn });
  assert.strictEqual(rs.code, 202, "branch send accepted");
  for (let i = 0; i < 200 && isChatRunning(brec.id); i++) await sleep(5);
  assert.ok(seenArgs, "spawn happened");
  const i2 = seenArgs.indexOf("--resume");
  assert.strictEqual(seenArgs[i2 + 1], CHAT_ID, "first send resumes the PARENT id");
  assert.ok(seenArgs.includes("--fork-session"), "first send passes --fork-session");
  assert.strictEqual(seenArgs[seenArgs.indexOf("--session-id") + 1], brec.id, "first send pins the branch's own id");
  // the branch runs at ITS OWN tier
  assert.strictEqual(seenArgs[seenArgs.indexOf("--allowedTools") + 1], DEFAULT_PROFILES["board-editor"].allowedTools.join(","), "branch spawned with its own profile's allowlist");

  // second send: no fork, own id
  let seen2 = null;
  const cap2 = (bin, args, opts) => { seen2 = args; return makeFakeSpawn(FIXTURE_LINES)(bin, args, opts); };
  const rs2 = fakeRes();
  handleChatSend(rs2, brec.id, { text: "and again" }, { ...DEPS, spawn: cap2 });
  for (let i = 0; i < 200 && isChatRunning(brec.id); i++) await sleep(5);
  assert.ok(seen2 && !seen2.includes("--fork-session"), "second send does NOT fork again");
  assert.strictEqual(seen2[seen2.indexOf("--resume") + 1], brec.id, "second send resumes the branch itself");

  // the source is untouched
  const parentBytesAfter = fs.readFileSync(path.join(HOME, "chats", `${CHAT_ID}.jsonl`));
  assert.strictEqual(Buffer.compare(parentBytesBefore, parentBytesAfter), 0, "the parent chat's transcript is byte-identical after the branch ran");
  ok("branching: parent recorded + lineage stamped; first send forks the parent, later sends resume the branch; source untouched");
}

// ===========================================================================
// 11. PICKER (index.html, static): four rows with the right badge colours, the
//     red warning row naming the capabilities verbatim, and observer forced as
//     the default so full-autonomy is never preselected — including on a branch.
// ===========================================================================
{
  const html = fs.readFileSync(path.resolve(__dirname, "./index.html"), "utf8");
  // four badge colours, per contract §3
  const badgeToken = {
    observer: "var(--st-available)",
    "board-editor": "var(--tier-blue)",
    "workspace-builder": "var(--gold)",
    "full-autonomy": "var(--tier-red)",
  };
  for (const [cls, token] of Object.entries(badgeToken)) {
    const re = new RegExp(`\\.cd-badge\\.${cls.replace("-", "\\-")}\\s*\\{background:${token.replace(/[()\-]/g, "\\$&")}\\}`);
    assert.ok(re.test(html), `.cd-badge.${cls} is painted with ${token}`);
  }
  // both new tokens are declared in :root AND registered as skin tokens
  assert.ok(/--tier-blue:#[0-9a-f]{6}/.test(html) && /--tier-red:#[0-9a-f]{6}/.test(html), ":root declares --tier-blue and --tier-red");
  const skinSrc = fs.readFileSync(path.resolve(__dirname, "./skins.mjs"), "utf8");
  assert.ok(/"tier-blue":/.test(skinSrc) && /"tier-red":/.test(skinSrc), "the new badge colours are skin tokens, not hardcoded one-offs");
  // exactly four rows, in safest-first order
  assert.ok(/PROFILE_ORDER\s*=\s*\["observer","board-editor","workspace-builder","full-autonomy"\]/.test(html),
    "the picker renders exactly the four tiers, observer first and full-autonomy last");
  // the disabled placeholder row is GONE (it said higher tiers were unauthorised)
  assert.ok(!/higher-autonomy modes await explicit founder authorization/.test(html),
    "the old disabled placeholder row is removed, not left contradicting the ruling");
  // the red warning row exists, is its own row, and names the capabilities verbatim
  assert.ok(/FULL_AUTONOMY_WARNING\s*=\s*"everything without prompts — commands, files, tools"/.test(html),
    "the warning names the capabilities verbatim, as the founder was asked");
  assert.ok(/class="cd-warnrow"/.test(html), "the warning is its own row in the picker, not a tooltip");
  assert.ok(/\.cd-warnrow\{[^}]*var\(--tier-red\)/.test(html), "the warning row is painted red");
  assert.ok(/if\(key==="full-autonomy"\)\{\s*\n?\s*h\+='<div class="cd-warnrow"/.test(html),
    "the warning row is emitted directly under the full-autonomy option");
  // observer is the default, always — full-autonomy is never preselected
  assert.ok(/createCtx\.profile="observer";/.test(html), "openChatCreate forces observer as the selected tier");
  assert.ok(!/profile:\s*"full-autonomy"/.test(html) && !/mode:\s*"full-autonomy"/.test(html),
    "nothing in the UI ever preselects full-autonomy");
  // branching does not inherit the parent's tier
  assert.ok(!/profile:\s*(rec|s)\.profile/.test(html), "a branch never inherits its parent's tier");
  // profile is create-only: the send path must not carry one
  assert.ok(!/payload\.profile\s*=/.test(html.split("async function sendChat")[1] || ""), "the send path never sets a profile");
  ok("picker: four tiers with the four badge colours, red warning row naming the capabilities verbatim, observer always preselected");
}

// ===========================================================================
// 12. P1 — THE BRICK. Regression for a real incident: the FIRST turn dies
//     before producing any assistant text, and the NEXT send must RESUME,
//     not re-pin --session-id.
//     This test fails on the old code, where isFirst = !hasAssistantLine().
// ===========================================================================
{
  _resetRuntime();
  const rc = fakeRes();
  handleChatCreate(rc, { roadId: "rm-test", profile: "observer" }, DEPS);
  const id = jsonOf(rc).chat.id;
  assert.strictEqual(findChat(id, ENV).sessionStarted, false, "a fresh record starts with sessionStarted:false");

  // Attempt 1: exits non-zero having emitted NOTHING — exactly the incident.
  let argv1 = null;
  const spawn1 = (bin, args, opts) => { argv1 = args; return makeFakeSpawn([], { exitCode: 1 })(bin, args, opts); };
  const s1 = fakeRes();
  handleChatSend(s1, id, { text: "load the skill" }, { ...DEPS, spawn: spawn1 });
  for (let i = 0; i < 400 && isChatRunning(id); i++) await sleep(5);

  assert.ok(argv1.includes("--session-id"), "the first send pins --session-id (correct)");
  const tr1 = readTranscript(ENV, id);
  assert.ok(!tr1.some((e) => e.role === "assistant"), "no assistant line was ever written — the false-negative condition");
  assert.strictEqual(findChat(id, ENV).sessionStarted, true,
    "sessionStarted was persisted the instant spawn returned, even though the child immediately failed");

  // Attempt 2 — "pick up from where you left off".
  let argv2 = null;
  const spawn2 = (bin, args, opts) => { argv2 = args; return makeFakeSpawn(FIXTURE_LINES)(bin, args, opts); };
  const s2 = fakeRes();
  handleChatSend(s2, id, { text: "pick up from where you left off" }, { ...DEPS, spawn: spawn2 });
  for (let i = 0; i < 400 && isChatRunning(id); i++) await sleep(5);

  assert.ok(argv2.includes("--resume"), "THE FIX: the second send RESUMES");
  assert.strictEqual(argv2[argv2.indexOf("--resume") + 1], id, "it resumes this chat's own session id");
  assert.ok(!argv2.includes("--session-id"), "THE FIX: it does NOT re-pin --session-id (this is what bricked the chat)");
  // And the preamble is not re-injected, so the briefed chip cannot lie.
  const users = readTranscript(ENV, id).filter((e) => e.role === "user");
  assert.strictEqual(users.length, 2, "two founder messages");
  assert.strictEqual(users[0].briefed, true, "the FIRST send was briefed");
  assert.ok(!users[1].briefed, "the SECOND send is NOT re-briefed — the incident re-injected the whole board preamble here");
  ok("P1: a first turn that dies before any assistant text no longer re-pins --session-id — the next send resumes, unbriefed");
}

// ===========================================================================
// 12b. P1 back-compat + the fork path + P1b's mirror of Claude Code's guard.
// ===========================================================================
{
  // Back-compat: a record with NO sessionStarted field but an assistant line in
  // its transcript still resumes (covers the chats already on disk).
  assert.strictEqual(hasAssistantLine([{ role: "assistant", text: "x" }]), true);
  assert.strictEqual(hasAssistantLine([{ role: "user", text: "x" }]), false);
  _resetRuntime();
  const rc = fakeRes();
  handleChatCreate(rc, { roadId: "rm-test", profile: "observer" }, DEPS);
  const id = jsonOf(rc).chat.id;
  // Simulate a legacy record: strip the flag, seed an assistant line.
  const idxFile = path.join(HOME, "chats", "chats.json");
  const data = JSON.parse(fs.readFileSync(idxFile, "utf8"));
  delete data.chats.find((c) => c.id === id).sessionStarted;
  fs.writeFileSync(idxFile, JSON.stringify(data, null, 2), "utf8");
  fs.appendFileSync(path.join(HOME, "chats", `${id}.jsonl`), JSON.stringify({ ts: "2026-07-01T00:00:00.000Z", role: "assistant", text: "legacy reply" }) + "\n", "utf8");
  assert.strictEqual(findChat(id, ENV).sessionStarted, undefined, "the legacy record genuinely has no flag");
  let argv = null;
  const sp = (bin, args, opts) => { argv = args; return makeFakeSpawn(FIXTURE_LINES)(bin, args, opts); };
  const rs = fakeRes();
  handleChatSend(rs, id, { text: "carry on" }, { ...DEPS, spawn: sp });
  for (let i = 0; i < 400 && isChatRunning(id); i++) await sleep(5);
  assert.ok(argv.includes("--resume") && !argv.includes("--session-id"),
    "back-compat: a legacy record with an assistant line still resumes");

  // P1b — the helper mirrors Claude Code's statSync guard.
  assert.strictEqual(claudeProjectSlug("C:\\Work\\My Projects\\demo.app"),
    "C--Work-My-Projects-demo-app",
    "the slug derivation folds drive letter, backslash, space and dot alike");
  const cfgDir = path.join(TMP, "fakeclaude");
  const projDir = path.join(cfgDir, "projects", claudeProjectSlug(ROAD));
  fs.mkdirSync(projDir, { recursive: true });
  assert.strictEqual(claudeSessionExists(ROAD, "sess-abc", { CLAUDE_CONFIG_DIR: cfgDir }), false, "absent session file => false");
  fs.writeFileSync(path.join(projDir, "sess-abc.jsonl"), "{}\n", "utf8");
  assert.strictEqual(claudeSessionExists(ROAD, "sess-abc", { CLAUDE_CONFIG_DIR: cfgDir }), true, "present session file => true (CLAUDE_CONFIG_DIR honoured)");
  assert.strictEqual(claudeSessionExists(ROAD, "../evil", { CLAUDE_CONFIG_DIR: cfgDir }), false, "a junk id is refused, fail-open");
  assert.strictEqual(claudeSessionExists(null, null, {}), false, "fail-open on nonsense");

  // P1b in the run: a chat whose Claude session already exists degrades to
  // --resume on what it thinks is its first send.
  _resetRuntime();
  const rc2 = fakeRes();
  handleChatCreate(rc2, { roadId: "rm-test", profile: "observer" }, DEPS);
  const id2 = jsonOf(rc2).chat.id;
  fs.writeFileSync(path.join(projDir, `${id2}.jsonl`), "{}\n", "utf8");
  let argv2 = null;
  const sp2 = (bin, args, opts) => { argv2 = args; return makeFakeSpawn(FIXTURE_LINES)(bin, args, opts); };
  const rs2 = fakeRes();
  handleChatSend(rs2, id2, { text: "hello" }, { ...DEPS, env: { ...ENV, CLAUDE_CONFIG_DIR: cfgDir }, spawn: sp2 });
  for (let i = 0; i < 400 && isChatRunning(id2); i++) await sleep(5);
  assert.ok(argv2.includes("--resume") && !argv2.includes("--session-id"),
    "P1b: an already-existing session file degrades the first send to --resume instead of hard-failing");

  // The FORK path is untouched — Claude Code explicitly permits
  // --resume <parent> --fork-session --session-id <new>.
  _resetRuntime();
  const rc3 = fakeRes();
  handleChatCreate(rc3, { roadId: "rm-test", profile: "observer", branchFromSessionId: "parent-1" }, DEPS);
  const id3 = jsonOf(rc3).chat.id;
  fs.writeFileSync(path.join(projDir, `${id3}.jsonl`), "{}\n", "utf8");   // even with the file present
  let argv3 = null;
  const sp3 = (bin, args, opts) => { argv3 = args; return makeFakeSpawn(FIXTURE_LINES)(bin, args, opts); };
  const rs3 = fakeRes();
  handleChatSend(rs3, id3, { text: "branch" }, { ...DEPS, env: { ...ENV, CLAUDE_CONFIG_DIR: cfgDir }, spawn: sp3 });
  for (let i = 0; i < 400 && isChatRunning(id3); i++) await sleep(5);
  assert.strictEqual(argv3[argv3.indexOf("--resume") + 1], "parent-1", "the fork still resumes the PARENT");
  assert.ok(argv3.includes("--fork-session"), "the fork still passes --fork-session");
  assert.strictEqual(argv3[argv3.indexOf("--session-id") + 1], id3, "the fork still pins the new id — P1b must not disturb it");
  ok("P1b: slug + CLAUDE_CONFIG_DIR mirror of the statSync guard, fail-open; existing session degrades to --resume; the fork path is untouched");
}

// ===========================================================================
// 12c. P1c — "already in use" self-corrects with ONE silent re-run, and is
//      NEVER retried (§3 proved a retry would fail identically forever).
// ===========================================================================
{
  _resetRuntime();
  const rc = fakeRes();
  handleChatCreate(rc, { roadId: "rm-test", profile: "observer" }, DEPS);
  const id = jsonOf(rc).chat.id;
  const argvs = [];
  const spawnFn = (bin, args) => {
    argvs.push(args);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    child.pid = 4242;
    setImmediate(() => {
      if (argvs.length === 1) {
        child.stderr.write(`Error: Session ID ${id} is already in use.`);
        setImmediate(() => child.emit("close", 1));
      } else {
        for (const l of FIXTURE_LINES) child.stdout.write(l + "\n");
        setImmediate(() => child.emit("close", 0));
      }
    });
    return child;
  };
  const rs = fakeRes();
  handleChatSend(rs, id, { text: "go" }, { ...DEPS, spawn: spawnFn });
  for (let i = 0; i < 400 && isChatRunning(id); i++) await sleep(5);
  assert.strictEqual(argvs.length, 2, "exactly ONE silent re-run — never a backoff loop");
  assert.ok(argvs[0].includes("--session-id"), "attempt 1 pinned the session id");
  assert.ok(argvs[1].includes("--resume") && !argvs[1].includes("--session-id"),
    "the correction switches to --resume — the ONLY recovery, since the guard is a statSync on a file that never disappears");
  const tr = readTranscript(ENV, id);
  assert.ok(!tr.some((e) => e.role === "error" && /already in use/.test(e.message)),
    "the founder never sees 'Session ID … is already in use' — it is unreachable through the dock");
  assert.ok(tr.some((e) => e.role === "assistant"), "the corrected run's reply landed");
  // The classifier must NEVER retry it.
  assert.strictEqual(classifyChatFailure({ kind: "exit", stderr: "Error: Session ID abc is already in use." }).retry, false,
    "'already in use' is NEVER retried (it is corrected, not retried)");
  ok("P1c: one silent re-run with --resume; 'already in use' never surfaces and is never retried");
}

// ===========================================================================
// 13. P2 — TWO CLOCKS. Defaults, precedence, and both kill paths proved with
//     tiny injected values on hermetic fake children.
// ===========================================================================
{
  assert.strictEqual(CHAT_TIMEOUT_DEFAULT_MS, 3600000, "the absolute ceiling defaults to 60 min (was a 10-min coin flip)");
  assert.strictEqual(CHAT_IDLE_TIMEOUT_DEFAULT_MS, 300000, "the idle watchdog defaults to 5 min");
  assert.strictEqual(chatTimeoutMs({}), 3600000);
  assert.strictEqual(chatIdleTimeoutMs({}), 300000);
  // precedence: env > config > default
  assert.strictEqual(chatTimeoutMs({}, { timeoutMs: 111 }), 111, "config beats the default");
  assert.strictEqual(chatTimeoutMs({ QUESTLOG_CHAT_TIMEOUT_MS: "222" }, { timeoutMs: 111 }), 222, "env beats config");
  assert.strictEqual(chatIdleTimeoutMs({ QUESTLOG_CHAT_IDLE_TIMEOUT_MS: "9" }, { idleTimeoutMs: 5 }), 9, "env beats config (idle)");
  assert.strictEqual(chatTimeoutMs({ QUESTLOG_CHAT_TIMEOUT_MS: "0" }), 3600000, "a nonsense env value falls back to the default");
  assert.strictEqual(chatRetries({}), CHAT_RETRIES_DEFAULT, "retries default to 2");
  assert.strictEqual(chatRetries({ QUESTLOG_CHAT_RETRIES: "0" }), 0, "retries can be turned off with 0");
  // reason-aware copy
  assert.ok(/went quiet/.test(killMessage("idle", 300000)) && /Settings/.test(killMessage("idle", 300000)),
    "the idle message is plain-language and points at Settings");
  assert.ok(/ceiling/.test(killMessage("hard", 3600000)), "the ceiling message is distinguishable from the idle one");

  // ---- a DRIBBLING child (continuous output) is killed by the CEILING, not
  // the watchdog. This is the incident workload: 8m49s of real activity.
  _resetRuntime();
  const dribbleEnv = { ...ENV, QUESTLOG_CHAT_TIMEOUT_MS: "400", QUESTLOG_CHAT_IDLE_TIMEOUT_MS: "200", QUESTLOG_CHAT_RETRIES: "0" };
  const dribbleDeps = { ...DEPS, env: dribbleEnv };
  const rc = fakeRes();
  handleChatCreate(rc, { roadId: "rm-test", profile: "observer" }, dribbleDeps);
  const id = jsonOf(rc).chat.id;
  const dribbleSpawn = () => {
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.pid = 999;
    let killed = false;
    c.kill = () => { if (!killed) { killed = true; clearInterval(iv); setImmediate(() => c.emit("close", 1)); } };
    // one byte every 50ms — well inside the 200ms watchdog, past the 400ms ceiling
    const iv = setInterval(() => { try { c.stdout.write(" "); } catch { /* closed */ } }, 50);
    return c;
  };
  const rs = fakeRes();
  handleChatSend(rs, id, { text: "long job" }, { ...dribbleDeps, spawn: dribbleSpawn });
  for (let i = 0; i < 600 && isChatRunning(id); i++) await sleep(5);
  const derr = readTranscript(ENV, id).find((e) => e.role === "error");
  assert.ok(derr, "the dribbling child was stopped");
  assert.ok(/ceiling/.test(derr.message), `a continuously-working child is killed by the CEILING, not the watchdog (got: ${derr.message})`);
  assert.ok(!/went quiet/.test(derr.message), "the watchdog kept being reset by raw stdout bytes");

  // ---- a SILENT child is killed by the WATCHDOG.
  _resetRuntime();
  const silentEnv = { ...ENV, QUESTLOG_CHAT_TIMEOUT_MS: "60000", QUESTLOG_CHAT_IDLE_TIMEOUT_MS: "150", QUESTLOG_CHAT_RETRIES: "0" };
  const silentDeps = { ...DEPS, env: silentEnv };
  const rc2 = fakeRes();
  handleChatCreate(rc2, { roadId: "rm-test", profile: "observer" }, silentDeps);
  const id2 = jsonOf(rc2).chat.id;
  const silentSpawn = () => {
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.pid = 998;
    let killed = false;
    c.kill = () => { if (!killed) { killed = true; setImmediate(() => c.emit("close", 1)); } };
    return c;
  };
  const rs2 = fakeRes();
  handleChatSend(rs2, id2, { text: "hangs" }, { ...silentDeps, spawn: silentSpawn });
  for (let i = 0; i < 600 && isChatRunning(id2); i++) await sleep(5);
  const serr = readTranscript(ENV, id2).find((e) => e.role === "error");
  assert.ok(serr && /went quiet/.test(serr.message), `a silent child is killed by the WATCHDOG (got: ${serr && serr.message})`);
  ok("P2: 60min ceiling / 5min watchdog defaults, env>config>default; a working child dies by ceiling, a silent one by watchdog");
}

// ===========================================================================
// 14. P3 — Windows child-TREE kill. child.kill() maps to TerminateProcess on
//     the DIRECT child only; descendants (the MCP stdio server, PostToolUse
//     hooks, Bash grandchildren) orphan. Assert taskkill /T /F is what fires.
// ===========================================================================
{
  const src = fs.readFileSync(CHAT_MJS, "utf8");
  assert.ok(/realSpawn\("taskkill",\s*\["\/PID",\s*String\(child\.pid\),\s*"\/T",\s*"\/F"\]/.test(src),
    "the win32 kill path invokes taskkill /PID <pid> /T /F");
  assert.ok(/win32[\s\S]{0,400}taskkill/.test(src), "the taskkill branch is guarded by process.platform === win32");
  // It MUST use realSpawn, not deps.spawn — tests inject a fake spawn and must
  // not have the taskkill intercepted (and a fake must not receive it).
  const killBlock = src.slice(src.indexOf("function killChild"), src.indexOf("function killChild") + 900);
  assert.ok(killBlock.includes("realSpawn("), "killChild uses realSpawn");
  assert.ok(!/deps\.spawn|spawnFn\(/.test(killBlock), "killChild NEVER routes taskkill through the injected spawn");
  assert.ok(/windowsHide:\s*true/.test(killBlock), "no console flash on the founder's desktop");
  assert.ok(/shell:\s*false/.test(killBlock), "the taskkill spawn is shell-free");
  // The temp-dir cleanup retries and LOGS instead of swallowing — an EBUSY
  // after taskkill /T is evidence something in the tree survived.
  assert.ok(/function removeTemp\(triesLeft\)/.test(src), "temp removal is a retrying helper");
  assert.ok(/removeTemp\(3\)/.test(src), "3 attempts");
  assert.ok(/250\)/.test(src.slice(src.indexOf("function removeTemp"), src.indexOf("function removeTemp") + 500)), "250ms apart");
  assert.ok(/could not remove temp dir/.test(src), "the final failure LOGS the path instead of swallowing it");
  ok("P3: win32 tree kill via realSpawn taskkill /T /F (never the injected spawn), windowsHide, shell-free; temp cleanup retries 3x250ms then logs");
}

// ===========================================================================
// 15. P4 — the retry CLASSIFICATION TABLE. One case per pinned class.
// ===========================================================================
{
  const R = (o) => classifyChatFailure(o).retry;
  // --- RETRY (transient / infrastructural) ---
  for (const code of ["ECONNRESET", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EAI_AGAIN"]) {
    assert.strictEqual(R({ kind: "spawn-error", errCode: code }), true, `spawn error ${code} RETRIES`);
  }
  for (const s of ["socket hang up", "fetch failed", "network error", "Connection error", "read ECONNRESET",
    "HTTP 502 Bad Gateway", "503 Service Unavailable", "504 timeout", "Overloaded", "rate limit exceeded", "rate-limit"]) {
    assert.strictEqual(R({ kind: "exit", stderr: s }), true, `stderr "${s}" RETRIES`);
  }
  assert.strictEqual(R({ kind: "kill", killReason: "idle" }), true, "an idle-watchdog kill RETRIES (the mid-stream drop)");
  // --- NEVER (deterministic) ---
  assert.strictEqual(R({ kind: "exit", stderr: "Error: Session ID abc is already in use." }), false, "'already in use' NEVER retries");
  assert.strictEqual(R({ kind: "exit", stderr: "Error: Invalid session ID. Must be a valid UUID." }), false, "invalid session id NEVER retries");
  assert.strictEqual(R({ kind: "exit", stderr: "Error: --session-id can only be used with --continue" }), false, "an argv bug NEVER retries");
  assert.strictEqual(R({ kind: "kill", killReason: "hard" }), false, "the absolute ceiling NEVER retries — the founder set it deliberately");
  for (const s of ["not logged in", "authentication failed", "invalid api key", "credit balance too low", "insufficient credit", "HTTP 401", "HTTP 403"]) {
    assert.strictEqual(R({ kind: "exit", stderr: s }), false, `auth/credit "${s}" NEVER retries`);
  }
  assert.strictEqual(R({ kind: "spawn-error", errCode: "ENOENT" }), false, "ENOENT on the binary NEVER retries — configuration, not weather");
  assert.strictEqual(R({ kind: "clean-error" }), false, "a clean exit with result.isError NEVER retries — that is content, not transport");
  // A stderr that matches BOTH lists must land on NEVER.
  assert.strictEqual(R({ kind: "exit", stderr: "503 — Session ID abc is already in use." }), false,
    "the NEVER patterns are checked first and win over a coincidental retry match");
  assert.strictEqual(R({ kind: "exit", stderr: "some unremarkable failure" }), false, "an unclassified exit does NOT retry");
  ok("P4: the classification table — every pinned RETRY class retries, every pinned NEVER class does not, NEVER wins ties");
}

// ===========================================================================
// 15b. P4 in the run: resume-preserving retries, correct bookkeeping, ONE done.
// ===========================================================================
{
  _resetRuntime();
  const env = { ...ENV, QUESTLOG_CHAT_RETRIES: "2" };
  const rdeps = { ...DEPS, env };
  const rc = fakeRes();
  handleChatCreate(rc, { roadId: "rm-test", profile: "observer" }, rdeps);
  const id = jsonOf(rc).chat.id;
  const argvs = [];
  // Every attempt fails with a connection error => 3 attempts, then give up.
  const flakySpawn = (bin, args) => {
    argvs.push(args);
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => {}; c.pid = 7;
    setImmediate(() => {
      // an attempt still does SOME work before dropping — F8a must keep it
      c.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial " + argvs.length }] } }) + "\n");
      c.stderr.write("socket hang up");
      setImmediate(() => c.emit("close", 1));
    });
    return c;
  };
  const events = [];
  const rs = fakeRes();
  handleChatSend(rs, id, { text: "flaky" }, { ...rdeps, spawn: flakySpawn });
  // watch the SSE ring by attaching a listener
  const sres = fakeRes(); const sreq = new EventEmitter();
  handleChatStream(sreq, sres, id, rdeps);
  for (let i = 0; i < 1200 && isChatRunning(id); i++) await sleep(5);

  assert.strictEqual(argvs.length, 3, "2 retries => 3 total attempts");
  assert.ok(argvs[0].includes("--session-id"), "attempt 1 pins the session");
  for (const a of argvs.slice(1)) {
    assert.ok(a.includes("--resume") && !a.includes("--session-id"),
      "EVERY retry re-enters with isFirst=false => --resume, continuing the SAME Claude session with full context");
  }
  // Bookkeeping: the in-flight budget must return to zero, once.
  assert.strictEqual(totalInFlight(), 0, "inFlightCount is back to 0 after 2 retries then failure (the CHAT_TOTAL_CAP budget did not leak)");
  assert.ok(!isChatRunning(id), "the run settled");

  const tr = readTranscript(ENV, id);
  const retries = tr.filter((e) => e.role === "retry");
  assert.strictEqual(retries.length, 2, "one role:retry line per retry — the history is honest about what happened");
  assert.deepStrictEqual(retries.map((r) => r.attempt), [1, 2], "retry lines are numbered");
  assert.ok(retries.every((r) => r.reason === "connection"), "the retry lines carry the classified reason");
  const errs = tr.filter((e) => e.role === "error");
  assert.strictEqual(errs.length, 1, "ONLY the final failure writes role:error");
  // F8a — no attempt's work was dropped.
  const partials = tr.filter((e) => e.role === "assistant" && /^partial/.test(e.text));
  assert.strictEqual(partials.length, 3, "SALVAGE: every attempt's beats were persisted, including the two that were retried away");
  // The user line was NOT re-appended, and the preamble was not re-prepended.
  assert.strictEqual(tr.filter((e) => e.role === "user").length, 1, "the user line is appended once per SEND, not once per attempt");
  // SSE: exactly one done, and a retry event per retry.
  const sse = sres.chunks.join("");
  const doneCount = (sse.match(/"type":"done"/g) || []).length;
  assert.strictEqual(doneCount, 1, "`done` fires EXACTLY ONCE per send, after the final attempt (otherwise the dock hangs forever)");
  assert.strictEqual((sse.match(/"type":"retry"/g) || []).length, 2, "a retry SSE event per retry");
  assert.ok(sse.indexOf('"type":"retry"') < sse.lastIndexOf('"type":"error"'), "the retries precede the single final error");
  ok("P4: 3 attempts, every retry resumes; inFlight back to 0; retry lines + one error line; salvage kept all 3 attempts; exactly one done");
}

// ===========================================================================
// 15c. NEVER-retry classes really do not retry, and the ceiling is respected.
// ===========================================================================
{
  for (const [label, mk] of [
    ["auth failure", () => makeFakeSpawn([], { exitCode: 1, stderrText: "invalid api key" })],
    ["ENOENT", () => makeFakeSpawn([], { emitError: "spawn ENOENT", errCode: "ENOENT" })],
  ]) {
    _resetRuntime();
    const rc = fakeRes();
    handleChatCreate(rc, { roadId: "rm-test", profile: "observer" }, DEPS);
    const id = jsonOf(rc).chat.id;
    let attempts = 0;
    const spawnFn = (bin, args, opts) => { attempts++; return mk()(bin, args, opts); };
    const rs = fakeRes();
    handleChatSend(rs, id, { text: label }, { ...DEPS, spawn: spawnFn });
    for (let i = 0; i < 600 && isChatRunning(id); i++) await sleep(5);
    assert.strictEqual(attempts, 1, `${label} is attempted exactly once — no retry`);
    assert.strictEqual(readTranscript(ENV, id).filter((e) => e.role === "retry").length, 0, `${label} writes no retry line`);
    assert.strictEqual(totalInFlight(), 0, `${label}: in-flight budget released`);
  }
  ok("P4: auth failures and ENOENT are attempted exactly once — a retry would burn time and show the identical error");
}

// ===========================================================================
// 16. F8a — SALVAGE on a plain timeout/nonzero exit: the beats that happened
//     are on disk BEFORE the error line. The bricked session did 28 tool
//     calls and questlog kept four lines, two of them error strings.
// ===========================================================================
{
  _resetRuntime();
  const env = { ...ENV, QUESTLOG_CHAT_RETRIES: "0" };
  const sdeps = { ...DEPS, env };
  const rc = fakeRes();
  handleChatCreate(rc, { roadId: "rm-test", profile: "observer" }, sdeps);
  const id = jsonOf(rc).chat.id;
  // real work, then a hard nonzero exit with no result line
  const workThenDie = () => {
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => {}; c.pid = 3;
    setImmediate(() => {
      c.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Reading the board." }] } }) + "\n");
      c.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "s1", name: "Read", input: { file_path: "/a" } }] } }) + "\n");
      c.stdout.write(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "s1", content: "contents" }] } }) + "\n");
      c.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Six milestones." }] } }) + "\n");
      c.stderr.write("boom");
      setImmediate(() => c.emit("close", 1));
    });
    return c;
  };
  const rs = fakeRes();
  handleChatSend(rs, id, { text: "do work then die" }, { ...sdeps, spawn: workThenDie });
  for (let i = 0; i < 600 && isChatRunning(id); i++) await sleep(5);
  const tr = readTranscript(ENV, id);
  const roles = tr.map((e) => e.role);
  assert.ok(roles.includes("assistant") && roles.includes("tool"), "the run's beats survived a failure (they were discarded entirely before)");
  assert.deepStrictEqual(tr.filter((e) => e.role === "assistant").map((e) => e.text),
    ["Reading the board.", "Six milestones."], "both prose panels survived, in order");
  const toolLine = tr.find((e) => e.role === "tool");
  assert.strictEqual(toolLine.output, "contents", "the tool's correlated output survived too");
  assert.ok(roles.lastIndexOf("error") === roles.length - 1, "the error line is LAST — the salvaged beats are written BEFORE it");
  assert.ok(roles.indexOf("tool") < roles.lastIndexOf("error"), "the work reads as work that then failed, not as a bare error");
  ok("F8a: a failed run persists its ordered beats before the error line — no turn's work is discarded");
}

// ===========================================================================
// 17. F8b — the sidecar is wired READ-ONLY into handleChatGet, and any adapter
//     failure degrades to the dock transcript (the splint).
// ===========================================================================
{
  _resetRuntime();
  const rc = fakeRes();
  handleChatCreate(rc, { roadId: "rm-test", profile: "observer" }, DEPS);
  const id = jsonOf(rc).chat.id;
  fs.appendFileSync(path.join(HOME, "chats", `${id}.jsonl`), JSON.stringify({ ts: "2026-07-01T00:00:00.000Z", role: "user", text: "hi", seq: 0 }) + "\n", "utf8");

  // No sidecar on disk for this id => the dock transcript, unchanged.
  const g1 = fakeRes();
  handleChatGet(g1, id, DEPS);
  assert.strictEqual(g1.code, 200);
  const b1 = jsonOf(g1);
  assert.strictEqual(b1.transcript.length, 1, "with no sidecar, the dock transcript is returned as-is");
  assert.ok(b1.sidecar && b1.sidecar.ok === false, "the response reports honestly that there was no sidecar");

  // An adapter that THROWS must not break the chat open.
  const g2 = fakeRes();
  handleChatGet(g2, id, { ...DEPS, resolveRoadCtx: () => { throw new Error("boom"); } });
  assert.strictEqual(g2.code, 200, "a throwing dependency still returns 200");
  assert.strictEqual(jsonOf(g2).transcript.length, 1, "THE SPLINT: the dock transcript survives an adapter explosion");

  // sidecar.enabled=false turns the read off entirely.
  const g3 = fakeRes();
  handleChatGet(g3, id, { ...DEPS, sidecarEnabled: () => false });
  assert.strictEqual(jsonOf(g3).sidecar, null, "sidecar.enabled=false means no sidecar read at all");

  // A REAL sidecar with more beats wins, and the drift hook fires on drift.
  const cfgDir = path.join(TMP, "sidecarcfg");
  const projDir = path.join(cfgDir, "projects", claudeProjectSlug(ROAD));
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, `${id}.jsonl`), [
    JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-07-01T00:00:00.000Z", version: "2.1.220", message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-07-01T00:00:01.000Z", version: "2.1.220", message: { role: "assistant", content: [{ type: "text", text: "hello back" }] } }),
    JSON.stringify({ type: "assistant", uuid: "a2", parentUuid: "a1", timestamp: "2026-07-01T00:00:02.000Z", version: "2.1.220", message: { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "Read", input: { file_path: "/z" } }] } }),
  ].join("\n") + "\n", "utf8");
  const g4 = fakeRes();
  handleChatGet(g4, id, { ...DEPS, env: { ...ENV, CLAUDE_CONFIG_DIR: cfgDir } });
  const b4 = jsonOf(g4);
  assert.ok(b4.sidecar && b4.sidecar.ok === true, "the sidecar was read");
  assert.ok(b4.transcript.length > 1, "with MORE beats than the dock, the sidecar enriches the render");
  assert.ok(b4.transcript.some((e) => e.role === "tool" && e.name === "Read"), "a tool beat only the sidecar knew about is now rendered");
  assert.ok(b4.transcript.some((e) => e.role === "user" && e.text === "hi"), "the dock's own user line survives the merge");

  // Drift => the hook fires AND the splint engages.
  fs.appendFileSync(path.join(projDir, `${id}.jsonl`), JSON.stringify({ type: "quantum-frame", uuid: "q", parentUuid: null, timestamp: "2026-07-01T00:00:03.000Z" }) + "\n", "utf8");
  let drifted = null;
  const g5 = fakeRes();
  handleChatGet(g5, id, { ...DEPS, env: { ...ENV, CLAUDE_CONFIG_DIR: cfgDir }, onSidecarDrift: (r) => { drifted = r; } });
  const b5 = jsonOf(g5);
  assert.ok(drifted && drifted.drift.some((d) => /quantum-frame/.test(d)), "the drift sentinel fired the repair hook with a named reason");
  assert.strictEqual(b5.transcript.length, 1, "THE SPLINT: on drift the chat degrades to the dock transcript and still opens");
  // A hook that THROWS must not break the chat open either.
  const g6 = fakeRes();
  handleChatGet(g6, id, { ...DEPS, env: { ...ENV, CLAUDE_CONFIG_DIR: cfgDir }, onSidecarDrift: () => { throw new Error("launcher exploded"); } });
  assert.strictEqual(g6.code, 200, "an exploding repair launcher still returns the chat");
  ok("F8b: sidecar wired read-only into handleChatGet; enriches when richer, splints on drift/throw/disabled; the drift hook fires with named reasons");
}

// ===========================================================================
// 18. UI (index.html, static) — the wave-1 renderer changes and the P5 chip.
// ===========================================================================
{
  const html = fs.readFileSync(path.resolve(__dirname, "./index.html"), "utf8");
  // F1 — the chip-hoisting insertBefore is GONE.
  assert.ok(!/keep tool chips above any in-progress live bubble/.test(html),
    "the chip-hoisting comment is gone");
  assert.ok(!/msgsEl\.insertBefore\(d,\s*chatCtx\.liveBubble\.wrap\)/.test(html),
    "THE HOIST IS DELETED: chips are no longer inserted above the live bubble");
  assert.ok(/chatCtx\.liveBubble=null;\s*\n?\s*const node=toolNode\(evt\)/.test(html),
    "a tool event SEALS the prose panel, then appends the chip in position");
  // F2 — unfurl.
  assert.ok(/function wireUnfurl/.test(html), "chips have a tap-to-unfurl");
  assert.ok(/e\.shiftKey/.test(html), "shift-tap unfurls the whole turn");
  assert.ok(/\.cd-unfurl pre\{[^}]*overflow-x:auto/.test(html), "the unfurled payload has its OWN horizontal scroll — the body never scrolls sideways");
  assert.ok(/\.cd-tool\{[^}]*min-height:44px/.test(html), "the chip row is a >=44px tap target");
  assert.ok(/what it was asked/.test(html) && /what came back/.test(html), "the unfurl labels are plain language");
  // F4 — context marks.
  assert.ok(/function applyContextMarks/.test(html), "context marks are applied");
  assert.ok(/GROUP_COLLAPSE_OVER=4/.test(html), "groups of more than four chips collapse by default");
  assert.ok(/cd-mark/.test(html) && /\.cd-mark::before/.test(html), "the caption is set into a gold rule");
  assert.ok(/wrote to the road/.test(html), "questlog write tools caption as 'wrote to the road'");
  assert.ok(/contains\("cd-retry"\)/.test(html), "retry lines are NEVER grouped");
  // F6 — skill banner.
  assert.ok(/cd-skill/.test(html) && /took the quill/.test(html), "a Skill invocation renders as an illuminated band");
  assert.ok(/\.cd-skill\{[^}]*var\(--surf-parch-gold\)/.test(html), "the band is filled with --surf-parch-gold");
  assert.ok(/\.cd-skill\{[^}]*border-top:2px solid var\(--gold-deep\)/.test(html), "ruled with --gold-deep");
  // P5 — the retry chip.
  assert.ok(/evt\.type==="retry"/.test(html), "handleChatEvent has a retry branch");
  assert.ok(/cd-tool cd-retry/.test(html), "the retry chip reuses the chip idiom with a distinct modifier");
  assert.ok(/function clearRetryChip/.test(html), "the chip is REPLACEABLE — removed when work resumes");
  {
    const branch = html.slice(html.indexOf('evt.type==="retry"'), html.indexOf('evt.type==="retry"') + 900);
    assert.ok(/setTyping\(true\)/.test(branch), "the typing indicator STAYS ON during a retry — the turn is alive");
    assert.ok(/s\.disabled=true/.test(branch), "the send button STAYS DISABLED during a retry");
    assert.ok(!/cd-err/.test(branch), "a retry is NOT the tombstone");
  }
  {
    const doneBranch = html.slice(html.indexOf('evt.type==="done"'), html.indexOf('evt.type==="done"') + 400);
    assert.ok(/s\.disabled=false/.test(doneBranch), "only `done` re-enables the composer");
  }
  assert.ok(/ev\.role==="retry"/.test(html), "a reloaded chat renders role:retry as a muted one-liner");
  // P5(3) — chatIsFirst is fed the RECORD, so the briefed chip cannot lie.
  assert.ok(/function chatIsFirst\(chat,\s*transcript\)/.test(html), "chatIsFirst takes the record");
  assert.ok(/!\(chat && chat\.sessionStarted\)/.test(html), "it consults record.sessionStarted first");
  assert.ok(/chatIsFirst\(rec,transcript\)/.test(html), "the single call site passes the record");
  assert.ok(!/chatIsFirst\(transcript\)/.test(html), "no call site still uses the old transcript-only predicate");
  // P2 — the two clocks are in Settings, with the env-lock treatment.
  assert.ok(/set-chat-idle/.test(html) && /set-chat-timeout/.test(html), "both chat clocks are editable in Settings");
  assert.ok(/envLocked\(s\["chat\.timeoutMs"\]\)/.test(html), "the ceiling honours the env lock");
  assert.ok(/envLocked\(s\["chat\.idleTimeoutMs"\]\)/.test(html), "the watchdog honours the env lock");
  assert.ok(/no sign of life/.test(html), "the watchdog is described in plain language, not as a millisecond count");
  // F8b — the sidecar switches, with the founder's own framing.
  assert.ok(/set-sidecar-enabled/.test(html) && /set-sidecar-repair/.test(html), "the sidecar switches are in Settings");
  assert.ok(/never writes, moves or deletes/.test(html), "the consent copy states the read-only guarantee plainly");
  assert.ok(/your standing instruction/.test(html), "the auto default is labelled as the founder's own instruction");
  // No jargon leaked into founder-facing copy.
  for (const jargon of ["sidecar", "parentUuid", "jsonl", "seq", "SSE"]) {
    const consent = (html.match(/<div class="set-consent">[\s\S]*?<\/div>/g) || []).join(" ");
    assert.ok(!new RegExp("\\b" + jargon + "\\b", "i").test(consent), `founder-facing consent copy avoids "${jargon}"`);
  }
  ok("UI: hoist deleted + boundary seal, unfurl with 44px targets and own scroll, context marks, skill band, live retry chip, record-fed chatIsFirst, both clocks + sidecar in Settings");
}

// ===========================================================================
// 19. The repair launcher's PERMISSION SCOPE — the narrowest set, asserted
//     rather than trusted. It must NOT be built through profileFlags, because
//     safeToolName() would strip the path-scoping parentheses and silently
//     widen Edit(<one file>) to Edit(everything).
// ===========================================================================
{
  const srv = fs.readFileSync(path.resolve(__dirname, "./server.mjs"), "utf8");
  const fn = srv.slice(srv.indexOf("function buildSidecarRepairArgs"), srv.indexOf("function stamp()"));
  assert.ok(fn, "buildSidecarRepairArgs exists");
  assert.ok(/--model", SIDECAR_REPAIR_MODEL/.test(fn), "the repair model comes from the pinned constant");
  assert.ok(/SIDECAR_REPAIR_MODEL = "fable"/.test(srv), "the repair model is hardcoded fable per the founder's ruling — no config key");
  assert.ok(!/sidecar[\s\S]{0,200}repairModel/i.test(srv), "there is no config key for the repair model");
  assert.ok(/--strict-mcp-config/.test(fn), "--strict-mcp-config with no --mcp-config => ZERO MCP servers");
  assert.ok(!/"--mcp-config"/.test(fn), "the repair session gets no MCP config at all (--strict-mcp-config with none = zero servers)");
  assert.ok(!/--permission-mode/.test(fn), "NO --permission-mode: under headless -p every unlisted tool is denied by construction");
  assert.ok(!/dangerously-skip-permissions|bypassPermissions|acceptEdits/.test(fn), "no bypassing flag anywhere in the repair argv");
  assert.ok(/--max-turns", "50"/.test(fn), "the repair session is turn-bounded");
  // Exactly the three files, and Bash scoped to exactly one command.
  assert.ok(/Edit\(\$\{adapter\}\)|`Edit\(\$\{adapter\}\)`/.test(fn), "Edit is path-scoped to the adapter");
  assert.ok(/Bash\(node sidecar-adapter\.selftest\.mjs:\*\)/.test(fn), "Bash is prefix-scoped to running the selftest only");
  assert.ok(/SIDECAR_FILES = \["sidecar-adapter\.mjs", "sidecar-adapter\.selftest\.mjs", "sidecar-fingerprint\.json"\]/.test(srv),
    "exactly three files are in scope");
  assert.ok(!/profileFlags/.test(fn), "the repair argv is NOT built through profileFlags (safeToolName would strip the path scoping)");
  // Single concurrency, backup, acceptance gate, restore.
  assert.ok(/sidecarRepairInFlight/.test(srv) && /\.sidecar-repair-running/.test(srv) && /sidecarRepairSeen/.test(srv),
    "single concurrency: in-process flag + marker file + one launch per drift signature");
  assert.ok(/sidecar-backup/.test(srv) && /copyFileSync/.test(srv), "the three files are backed up before launch");
  assert.ok(/ACCEPTANCE GATE/.test(srv) && /spawnSync\(process\.execPath, \[path\.join\(workDir, "sidecar-adapter\.selftest\.mjs"\)\]/.test(srv),
    "the LAUNCHER runs the selftest after the child exits — the child claiming green is not evidence");
  assert.ok(/SIDECAR_SELFTEST_REQUIRE_REAL: "1"/.test(srv), "the gate requires the selftest to have run against REAL transcripts");
  assert.ok(/else restore\(\)/.test(srv), "a failing gate RESTORES the backup");

  // ---- F-C: the child never runs in the founder's repo -------------------
  // allowedTools cannot govern the founder's USER-LEVEL hooks; those run in the
  // child's session and write into its cwd. cwd is the only lever, so cwd must
  // be a throwaway.
  assert.ok(/cwd: workDir/.test(srv) && !/cwd: repoRoot/.test(srv),
    "F-C: the repair child's cwd is the isolated work dir, never the repo root");
  assert.ok(/function makeRepairWorkDir/.test(srv) && /mkdtempSync\(path\.join\(os\.tmpdir\(\), "questlog-sidecar-repair-"\)\)/.test(srv),
    "F-C: the work dir is a fresh temp dir");
  assert.ok(/const args = buildSidecarRepairArgs\(\{ \.\.\.driftReport, drift \}, workDir\)/.test(srv),
    "F-C: Edit/Write are path-scoped to the COPIES in the work dir, not to the repo files");
  assert.ok(/function copyRepairFilesBack/.test(srv) && /for \(const f of SIDECAR_FILES\)[\s\S]{0,300}copyFileSync\(src, path\.join\(repoRoot, f\)\)/.test(srv),
    "F-C: only the three permitted files are ever copied back into the repo");
  assert.ok(/if \(gate\.ok\) copied = copyRepairFilesBack\(workDir, repoRoot\)/.test(srv),
    "F-C: nothing comes home unless the acceptance gate passed");
  assert.ok(/function removeRepairWorkDir/.test(srv) && /removeRepairWorkDir\(workDir\)/.test(srv),
    "F-C: the work dir — and whatever the hooks left in it — is removed");
  assert.ok(/THE HOOK CAVEAT/.test(srv) && /allowedTools[\s\S]{0,400}hooks/i.test(srv),
    "F-C: the hook caveat is documented in the module header");
  assert.ok(/removeRepairWorkDir\(workDir\); return \{ launched: false, reason: "in-flight" \}/.test(srv),
    "F-C: every bail-out after the work dir is built removes it (no temp-dir leak)");
  assert.ok(/SIDECAR_REPAIR_TIMEOUT_MS = 1800000/.test(srv), "the child has a 30-minute hard timeout");
  assert.ok(/cleanEnvForRepair|bridgeCleanEnv/.test(srv), "the repair child runs with nesting env cleared");
  assert.ok(/windowsHide: true[\s\S]{0,80}shell: false|shell: false[\s\S]{0,80}windowsHide: true/.test(srv), "spawned hidden and shell-free");
  // Every event is logged to the road — see §23 for the behavioural proof.
  assert.ok(/action: "sidecar_repair"/.test(srv), "the history line names the action, in the canonical field");
  assert.ok(/kind: "note_to_founder"/.test(srv), "the founder-visible artifact is a note_to_founder card the dashboard already renders");
  assert.ok(/withLock\(ctx, \(\) => writeSidecarRepairNotice\(ctx, evt\)\)/.test(srv), "the notice is written under the road lock");
  assert.ok(/const logEvent = \(extra\) => logSidecarRepair/.test(srv), "every launcher outcome goes through one logging path, with the same road/chat/card anchor");
  ok("repair launcher: fable, zero MCP, no permission-mode, Edit/Write scoped to exactly 3 files, Bash to one command; backup + launcher-run acceptance gate + restore; single concurrency; every outcome logged to the road");
}

// ===========================================================================
// 20. Config plumbing for the new keys (server.mjs, static + behavioural).
// ===========================================================================
{
  const srv = fs.readFileSync(path.resolve(__dirname, "./server.mjs"), "utf8");
  for (const k of ["chat.timeoutMs", "chat.idleTimeoutMs", "sidecar.enabled", "sidecar.repair"]) {
    assert.ok(srv.includes(`"${k}"`), `${k} is stamped in the sources map`);
  }
  assert.ok(/allowedC = new Set\(\["model", "profiles", "timeoutMs", "idleTimeoutMs"\]\)/.test(srv), "validateConfigBody accepts the two clocks");
  assert.ok(/unknown sidecar key/.test(srv), "validateConfigBody rejects unknown sidecar keys");
  assert.ok(/sidecarRepair = envRepair \|\| cfgRepair \|\| "auto"/.test(srv), "sidecar.repair defaults to auto — the founder's authorized default");
  assert.ok(/QUESTLOG_SIDECAR_REPAIR/.test(srv), "the env override exists and wins");
  assert.ok(/chatTimeouts\(\)/.test(srv), "the two clocks are threaded to chat.mjs through deps.chatTimeouts");
  assert.ok(/idleTimeoutMs must not exceed/.test(srv), "a watchdog longer than the ceiling is rejected — it could never fire");
  ok("config: chat.timeoutMs/idleTimeoutMs + sidecar.enabled/repair validated, source-stamped, threaded; repair defaults to auto with an env override");
}

// ===========================================================================
// 21. F-A — DOUBLE RENDERING. The ship blocker.
//
// The bug: openChatActive() rendered the persisted transcript and THEN
// connected; handleChatStream replayed the whole ring to every new connector
// and handleChatEvent appended it all again. Nothing deduped and the ring was
// never watermarked, so an 11-line transcript rendered as 20 blocks on reopen.
//
// The fix has two independent halves and BOTH are proven here:
//   (a) the server stops replaying already-persisted beats (evId watermark +
//       ?since cursor),
//   (b) the client refuses to draw an identity it has already drawn (evId /
//       toolUseId ledgers).
// ===========================================================================
{
  // ---- (a1) the cursor parser ------------------------------------------
  assert.strictEqual(streamSinceFromUrl({ url: "/api/chat/x/stream" }), null, "no query => no cursor (legacy full replay)");
  assert.strictEqual(streamSinceFromUrl({ url: "/api/chat/x/stream?since=17" }), 17, "since parsed");
  assert.strictEqual(streamSinceFromUrl({ url: "/api/chat/x/stream?a=1&since=0" }), 0, "since=0 is a real cursor, not falsy-null");
  assert.strictEqual(streamSinceFromUrl({ url: "/api/chat/x/stream?since=nope" }), null, "junk cursor degrades to full replay");
  assert.strictEqual(streamSinceFromUrl({ url: "/api/chat/x/stream?since=-4" }), null, "negative cursor refused");
  assert.strictEqual(streamSinceFromUrl(null), null, "no request object never throws");

  // ---- (a2) a real completed turn --------------------------------------
  _resetRuntime();
  const rc = fakeRes();
  handleChatCreate(rc, { roadId: "rm-test", milestoneId: "ms-alpha", profile: "observer", model: "sonnet" }, DEPS);
  const FA_ID = jsonOf(rc).chat.id;
  const rs = fakeRes();
  handleChatSend(rs, FA_ID, { text: "render me exactly once" }, { ...DEPS, spawn: makeFakeSpawn(FIXTURE_LINES) });
  assert.strictEqual(rs.code, 202, "F-A send accepted");
  for (let i = 0; i < 200 && isChatRunning(FA_ID); i++) await sleep(5);
  assert.ok(!isChatRunning(FA_ID), "F-A turn settled");

  const ring = _ringFor(FA_ID);
  assert.ok(ring.length > 0, "the turn left events in the ring");
  for (const e of ring) assert.strictEqual(typeof e.evId, "number", "EVERY emitted event carries an evId (the stable identity)");
  const ids = ring.map((e) => e.evId);
  assert.deepStrictEqual(ids, ids.slice().sort((a, b) => a - b), "evId is monotonic");
  assert.strictEqual(new Set(ids).size, ids.length, "evId is unique");
  const cursor = _streamCursor(FA_ID);
  assert.strictEqual(cursor, ids[ids.length - 1], "the watermark moved to the last event of the completed turn");

  // The GET hands the client the watermark alongside the transcript.
  const g = fakeRes();
  handleChatGet(g, FA_ID, DEPS);
  const got = jsonOf(g);
  assert.strictEqual(got.streamCursor, cursor, "GET returns the watermark the transcript covers");
  const persisted = readTranscript(ENV, FA_ID);
  assert.ok(persisted.length > 1, "the transcript really is persisted");

  // ---- THE VERIFIER'S EXACT REPRO --------------------------------------
  // send, back, reopen -> three consecutive opens, each rendering exactly the
  // persisted block count. "Blocks" = transcript lines drawn + events the
  // stream then pushes at the client. The old code pushed the whole ring on
  // every open, so this count grew by |ring| each time.
  const blockCounts = [];
  for (let open = 0; open < 3; open++) {
    const og = fakeRes();
    handleChatGet(og, FA_ID, DEPS);                       // "reopen"
    const body = jsonOf(og);
    const drawnFromDisk = body.transcript.length;
    const ores = fakeRes();
    const oreq = new EventEmitter();
    oreq.url = `/api/chat/${FA_ID}/stream?since=${body.streamCursor}`;
    handleChatStream(oreq, ores, FA_ID, DEPS);            // "connect"
    const replayed = ores.chunks.filter((c) => c.startsWith("data:")).length;
    assert.strictEqual(replayed, 0, `open ${open + 1}: the stream replayed NOTHING already on disk`);
    blockCounts.push(drawnFromDisk + replayed);
    oreq.emit("close");
  }
  assert.deepStrictEqual(blockCounts, [persisted.length, persisted.length, persisted.length],
    "three consecutive opens each render EXACTLY the persisted block count — no doubling, no drift");

  // ---- (a3) a mid-turn open still catches up ---------------------------
  // The watermark must not cost the founder the live turn: beats emitted but
  // NOT yet persisted are exactly what a fresh connector should receive.
  const midCursor = _streamCursor(FA_ID);
  _emitForTest(FA_ID, { type: "delta", text: "in flight" });
  _emitForTest(FA_ID, { type: "tool", name: "Read", detail: "x", toolUseId: "tu-live", seq: 9 });
  const mres = fakeRes(); const mreq = new EventEmitter();
  mreq.url = `/api/chat/${FA_ID}/stream?since=${midCursor}`;
  handleChatStream(mreq, mres, FA_ID, DEPS);
  const midEvents = mres.chunks.filter((c) => c.startsWith("data:"));
  assert.strictEqual(midEvents.length, 2, "a mid-turn connector receives exactly the un-persisted beats");
  assert.ok(/in flight/.test(midEvents.join("")), "…including the live prose");
  mreq.emit("close");

  // ---- (a4) the GET/done race -------------------------------------------
  // Client reads the transcript, the turn completes, THEN the client connects.
  // Its cursor is the OLD watermark, so the just-finished turn must replay.
  const raceCursor = _streamCursor(FA_ID);   // what the client was handed
  _emitForTest(FA_ID, { type: "result", costUsd: 1 });
  _markPersisted(FA_ID);                      // the turn completes, mid-race
  const rres2 = fakeRes(); const rreq2 = new EventEmitter();
  rreq2.url = `/api/chat/${FA_ID}/stream?since=${raceCursor}`;
  handleChatStream(rreq2, rres2, FA_ID, DEPS);
  assert.ok(rres2.chunks.filter((c) => c.startsWith("data:")).length >= 1,
    "the ring is watermarked, NOT cleared — a client that raced the `done` still catches up");
  rreq2.emit("close");

  // ---- (b) the client's two dedupe guards -------------------------------
  const html = fs.readFileSync(path.resolve(__dirname, "./index.html"), "utf8");
  assert.ok(/chatCtx\.cursor=\(data&&typeof data\.streamCursor==="number"\)/.test(html),
    "the client keeps the watermark the GET handed it");
  assert.ok(/connectChatSSE\(id,\s*chatCtx\.cursor\)/.test(html) && /\?since="\+encodeURIComponent/.test(html),
    "the client asks the stream to start ABOVE what it already drew");
  assert.ok(/if\(chatCtx\.seenEv\.has\(evt\.evId\)\) return;/.test(html),
    "GUARD 1: an evId seen twice is never drawn twice (covers EventSource auto-reconnect)");
  assert.ok(/if\(evt\.evId<=\(chatCtx\.cursor\|\|0\)\) return;/.test(html),
    "GUARD 1b: anything at or below the watermark is already on the page — the client is correct even against a server that replays everything");
  assert.ok(/if\(chatCtx\.seenTools\.has\(evt\.toolUseId\)\) return;/.test(html),
    "GUARD 2: a toolUseId already on the page is never appended again");
  assert.ok(/if\(ev&&ev\.role==="tool"&&ev\.toolUseId\) chatCtx\.seenTools\.add\(ev\.toolUseId\);/.test(html),
    "chips drawn from the persisted transcript are entered in the ledger");
  // The ledgers must NOT be reset per send — the duplicate they defend against
  // is a replay of an OLDER turn.
  const sendFn = html.slice(html.indexOf("async function sendChatMessage"), html.indexOf("async function sendChatMessage") + 900);
  assert.ok(/chatCtx\.toolNodes=\{\}/.test(sendFn), "per-send state still resets");
  assert.ok(!/seenEv=new Set|seenTools=new Set/.test(sendFn), "the dedupe ledgers survive a send");
  ok("F-A: evId on every event + a `done` watermark + ?since cursor + client evId/toolUseId ledgers — three consecutive reopens each render EXACTLY the persisted block count; mid-turn and GET/done-race opens still catch up");
}

// ===========================================================================
// 22. F-B — injected text is never attributed to the founder.
// ===========================================================================
{
  const sc = await import(pathToFileURL(path.resolve(__dirname, "./sidecar-adapter.mjs")).href);

  // The exact shapes Claude Code files under the `user` role.
  assert.deepStrictEqual(sc.classifyInjected({ isMeta: true }, "Base directory for this skill: C:\\x\\skills\\questlog-chief-of-staff\n\n# Chief"),
    { origin: "skill", skill: "questlog-chief-of-staff" }, "a skill preamble is attributed to the skill, by name");
  assert.deepStrictEqual(sc.classifyInjected({}, "<command-name>takeaway</command-name>"), { origin: "command" }, "slash-command echo");
  assert.deepStrictEqual(sc.classifyInjected({}, "<local-command-stdout>ok</local-command-stdout>"), { origin: "command" }, "local command output");
  assert.deepStrictEqual(sc.classifyInjected({}, "<system-reminder>be good</system-reminder>"), { origin: "system" }, "harness reminder");
  assert.deepStrictEqual(sc.classifyInjected({ isMeta: true }, "anything else at all"), { origin: "system" }, "isMeta alone is enough");
  assert.strictEqual(sc.classifyInjected({}, "load the skill"), null, "the founder's own words are NOT reclassified");
  assert.strictEqual(sc.classifyInjected({ isMeta: false }, "fix the parser please"), null, "…and neither is a normal prompt");

  // questlog's own anchoring preamble is peeled off the founder's first message.
  const pre = buildBoardPreamble({ projectName: "Atlas", root: "C:/x" });
  const split = sc.splitPreamble(pre + "\n\n---\n\nload");
  assert.ok(split && split.brief === pre && split.text === "load", "the brief is peeled off; only the typed words stay the founder's");
  assert.strictEqual(sc.splitPreamble("just a normal message"), null, "an ordinary message is never split");

  // End to end on a REAL bricked chat: the acceptance case. A transcript is
  // somebody's whole session, so it is the one thing this repo can never
  // carry. Point QUESTLOG_SIDECAR_ACCEPTANCE at one, as "<project root>::
  // <chat id>", the same way sidecar-adapter.selftest.mjs does, and this
  // runs. Unset, it skips and says so — a clone is not a machine anyone has
  // worked in yet.
  const ACCEPT = (() => {
    const raw = process.env.QUESTLOG_SIDECAR_ACCEPTANCE || "";
    const i = raw.lastIndexOf("::");
    if (i <= 0 || i + 2 >= raw.length) return null;
    return { root: raw.slice(0, i), id: raw.slice(i + 2) };
  })();
  const real = ACCEPT ? sc.readSidecar(ACCEPT.id, ACCEPT.root, process.env) : { ok: false };
  if (!ACCEPT) skip("the real-sidecar acceptance case", "QUESTLOG_SIDECAR_ACCEPTANCE unset");
  if (real.ok) {
    const sys = real.beats.filter((b) => b.kind === "system");
    const usr = real.beats.filter((b) => b.kind === "user");
    assert.ok(sys.some((b) => b.origin === "skill" && b.skill === "questlog-chief-of-staff"),
      "the real chief-of-staff skill preamble is a SYSTEM beat naming the skill");
    assert.ok(sys.some((b) => b.origin === "brief"), "questlog's own anchoring brief is a SYSTEM beat");
    for (const u of usr) {
      assert.ok(!/^Base directory for this skill:/.test(u.text), "no skill preamble survives as the founder's voice");
      assert.ok(!/^You are the board-level chat for/.test(u.text), "no anchoring brief survives as the founder's voice");
    }
    const dock = [{ ts: "2000-01-01T00:00:00.000Z", role: "user", text: "load", briefed: true }];
    const merged = sc.enrich(dock, real);
    const you = merged.filter((e) => e.role === "user");
    assert.strictEqual(you.length, 1, "exactly ONE line renders under the founder's name");
    assert.strictEqual(you[0].text, "load", "…and it is exactly what the founder typed");
    assert.strictEqual(you[0].briefed, true, "…still carrying the briefed chip");
    assert.ok(merged.some((e) => e.role === "system" && e.origin === "skill"), "the skill preamble rides through enrich as role:system");
  }

  // Injected beats must never be the reason the splint releases.
  const thin = { ok: true, drift: [], beats: [
    { kind: "system", origin: "skill", ts: "t1", seq: 0, text: "a" },
    { kind: "system", origin: "system", ts: "t2", seq: 1, text: "b" },
    { kind: "user", ts: "t3", seq: 2, text: "hi" },
  ] };
  const dockThin = [{ ts: "t0", role: "user", text: "hi" }, { ts: "t1", role: "assistant", text: "yo" }];
  assert.strictEqual(sc.enrich(dockThin, thin), dockThin, "two system beats cannot outvote the dock — the splint holds");

  // The renderer: a distinct block, and the word "You" is nowhere near it.
  const html = fs.readFileSync(path.resolve(__dirname, "./index.html"), "utf8");
  assert.ok(/ev\.role==="system"\)\{\s*M\.appendChild\(systemNode\(ev\)\);/.test(html.replace(/\n\s*/g, "")),
    "role:system has its own renderer branch");
  const node = html.slice(html.indexOf("function systemNode"), html.indexOf("function retryReasonText"));
  assert.ok(!/cd-msg user|>You</.test(node), "the system block is NEVER the founder's bubble");
  assert.ok(/cd-sys/.test(node), "it gets its own class");
  const lab = html.slice(html.indexOf("function systemLabel"), html.indexOf("function systemNode"));
  assert.ok(/Skill instructions/.test(lab) && /added automatically/.test(lab) && /not typed/.test(lab),
    "the header says plainly that the founder did not type it");
  assert.ok(/\.cd-sys\{/.test(html) && /border:1px dashed/.test(html), "styled distinctly from both voices");
  ok("F-B: skill preambles, slash-command echoes, system reminders and questlog's own brief render as attributed SYSTEM blocks — the founder's real chat shows exactly one 'You' line, the four words they typed");
}

// ===========================================================================
// 23. G-A / G-B — A REPAIR EVENT IS A NOTIFICATION, NOT A HORIZON SUGGESTION.
//
// The bug: logSidecarRepair wrote a bespoke history object literal (no id /
// actor / source / summary, a FILENAME in targetId) plus a suggestions.json
// entry missing frontierMilestoneId / questId / plain / order / createdAt /
// updatedAt. The real road stopped validating and the renderer silently
// dropped the ghost, so the founder was told nothing — while sidecar.repair
// defaults to "auto", i.e. this fires the first time the format really moves.
//
// The fix, proven end to end against a COPY OF A WHOLE ROAD:
//   * the history line goes through appendHistory in the canonical shape,
//   * the founder-visible artifact is a note_to_founder ITEM on a real
//     milestone — asserted against index.html's OWN itemCard() render
//     predicate, executed here on the record that was actually written,
//   * suggestions.json is not touched at all,
//   * the road still validates against the real schema validator.
// ===========================================================================
{
  const { validateDir } = await import(pathToFileURL(path.resolve(__dirname, "./schema/validate.mjs")).href);

  // ---- a copy of a whole road, proven valid BEFORE we touch it ----------
  // This checkout's own road when it has one, the demo seed otherwise. Both
  // validate clean, so the CONTROL below is the same assertion either way and
  // a clone with no road of its own still exercises the writer.
  const REPO = __dirname;
  const SRC_ROAD = fs.existsSync(path.join(REPO, ".questlog", "roadmap.json"))
    ? REPO : path.join(REPO, "seeds", "sample-project");
  assert.ok(fs.existsSync(path.join(SRC_ROAD, ".questlog", "roadmap.json")), "a whole road is available to test against");
  const G_ROOT = path.join(TMP, "gRoad");
  fs.mkdirSync(G_ROOT, { recursive: true });
  fs.cpSync(path.join(SRC_ROAD, ".questlog"), path.join(G_ROOT, ".questlog"), { recursive: true });
  try { fs.rmSync(path.join(G_ROOT, ".questlog", ".lock"), { recursive: true, force: true }); } catch { /* none */ }
  assert.deepStrictEqual(validateDir(G_ROOT), [], "CONTROL: the copied road validates before the repair event");
  const sugBefore = fs.existsSync(path.join(G_ROOT, ".questlog", "suggestions.json"))
    ? fs.readFileSync(path.join(G_ROOT, ".questlog", "suggestions.json"), "utf8") : null;
  const histBefore = fs.readFileSync(path.join(G_ROOT, ".questlog", "history.jsonl"), "utf8").split("\n").filter((l) => l.trim()).length;

  // ---- the REAL server-side writer, no port opened ----------------------
  const savedReg = process.env.QUESTLOG_REGISTRY;
  process.env.QUESTLOG_NO_LISTEN = "1";
  process.env.QUESTLOG_REGISTRY = path.join(TMP, "ghome", "registry.json");   // repair logs land in temp, never the founder's home
  fs.mkdirSync(path.join(TMP, "ghome"), { recursive: true });
  const srvMod = await import(pathToFileURL(path.resolve(REPO, "server.mjs")).href);
  const gctx = srvMod.makeCtx(G_ROOT);

  const roadmap0 = JSON.parse(fs.readFileSync(gctx.files.roadmap, "utf8"));
  const anchorMs = (roadmap0.milestones || []).find((m) => m && m.status === "done") || roadmap0.milestones[0];
  assert.ok(anchorMs && anchorMs.id, "the real road has a milestone to anchor a notice to");

  const DRIFT = ["unknown line type: summary", "block type not in the fingerprint: server_tool_use"];
  const CHAT = "4c1f0b2e-3d5a-4e6f-8a9b-0c1d2e3f4a5b";

  // Event 1 — the repair is launched. Event 2 — the acceptance gate passed.
  const w1 = srvMod.logSidecarRepair(gctx, { status: "launched", drift: DRIFT, sessionId: CHAT, milestoneId: anchorMs.id });
  const w2 = srvMod.logSidecarRepair(gctx, { status: "passed", drift: DRIFT, sessionId: CHAT, milestoneId: anchorMs.id });

  // ---- (1) THE ROAD STILL VALIDATES ------------------------------------
  assert.deepStrictEqual(validateDir(G_ROOT), [],
    "after a simulated repair event the road still validates — zero errors from the real validator");

  // ---- (2) the history line is canonical, through the same helper -------
  const hist = fs.readFileSync(gctx.files.history, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  assert.strictEqual(hist.length, histBefore + 2, "exactly one history line per repair event");
  for (const e of hist.slice(-2)) {
    assert.ok(/^evt-[a-z0-9][a-z0-9-]*$/.test(e.id), "the event carries a genId('evt') id");
    assert.strictEqual(e.actor, "system", "actor is on the enum");
    assert.strictEqual(e.source, "ui", "source is on the enum");
    assert.strictEqual(e.action, "sidecar_repair", "action names the thing that happened");
    assert.ok(typeof e.summary === "string" && e.summary.length > 0, "a non-empty summary — the field the old literal omitted entirely");
    assert.ok(/^[a-z]+-[a-z0-9][a-z0-9-]*$/.test(e.targetId), "targetId is an ID, never a filename");
    assert.strictEqual(e.targetId, w1.itemId, "…and it points at the founder's card");
    assert.strictEqual(e.sessionId, CHAT, "the chat session is attributed");
    assert.ok(e.patch && typeof e.patch === "object" && Array.isArray(e.patch.drift), "the drift reasons ride in patch, where free-form data belongs");
    for (const stray of ["type", "targetType", "status", "drift"]) {
      assert.ok(!(stray in e), `no bespoke top-level "${stray}" key — the schema forbids extras`);
    }
  }
  assert.strictEqual(w1.eventId, hist[hist.length - 2].id, "the writer reports the event it wrote");

  // ---- (3) NOT a suggestion. suggestions.json is untouched. -------------
  const sugAfter = fs.existsSync(path.join(G_ROOT, ".questlog", "suggestions.json"))
    ? fs.readFileSync(path.join(G_ROOT, ".questlog", "suggestions.json"), "utf8") : null;
  assert.strictEqual(sugAfter, sugBefore, "G-B: a repair notice is NOT a horizon suggestion — suggestions.json is byte-identical");
  const srvSrc = fs.readFileSync(path.resolve(REPO, "server.mjs"), "utf8");
  const logFn = srvSrc.slice(srvSrc.indexOf("function writeSidecarRepairNotice"), srvSrc.indexOf("function launchSidecarRepair"));
  assert.ok(!/suggestions/i.test(logFn), "the repair writer never reaches for the horizon system at all");
  assert.ok(!/genId\("sg"\)/.test(srvSrc), "no repair path mints a suggestion id");

  // ---- (4) the founder-visible artifact exists, on a real milestone -----
  const rm = JSON.parse(fs.readFileSync(gctx.files.roadmap, "utf8"));
  const card = (rm.items || []).find((it) => it && it.id === w1.itemId);
  assert.ok(card, "the notice is a real item on the road");
  assert.strictEqual(w2.itemId, w1.itemId, "the second event joins the SAME card — one card per repair episode, not litter");
  assert.strictEqual(card.kind, "note_to_founder", "…of the kind the dashboard already renders as a card");
  assert.strictEqual(card.milestoneId, anchorMs.id, "…hung on the milestone the chat was opened from");
  assert.ok((rm.milestones || []).some((m) => m.id === card.milestoneId), "…which really exists (no orphan)");
  assert.strictEqual(card.notes.length, 2, "each later event of the episode appends to the thread");
  assert.strictEqual(card.notes[0].author, "agent", "the thread is honestly attributed — the founder did not write it");
  assert.strictEqual(card.status, "done", "a passed repair closes the card");
  assert.ok(card.body.includes(DRIFT[0]) && card.body.includes(DRIFT[1]), "the founder is told what actually changed");

  // ---- (5) THE REAL RENDER PREDICATE ------------------------------------
  // index.html's own item filter and itemCard(), lifted verbatim out of the
  // page and executed on the record that was actually written. Not a
  // file-exists check: the founder's card is built here.
  const idx = fs.readFileSync(path.resolve(REPO, "index.html"), "utf8");
  const grab = (from, to) => { const a = idx.indexOf(from); const b = idx.indexOf(to); assert.ok(a >= 0 && b > a, `render source ${from} lifted from index.html`); return idx.slice(a, b); };
  const consts = ["const STATUS_LABEL", "const KIND_LABEL", "const NOPLAIN"]
    .map((c) => { const m = idx.slice(idx.indexOf(c)).match(/^[^\n]*\n/)[0]; return m.trim(); }).join("\n");
  const helpers = grab("function esc(s)", "  // relative age");
  const itemCardSrc = grab("function itemCard(it)", "function decisionCard(d)");
  // itemCard() ends by appending contestedBlock(), so that comes across verbatim
  // too. Its one dependency is contestedOn(), a reader of the page's live
  // contested-writes state, which is stubbed empty the way plainMode is: this
  // road holds no contested write, so the block the founder sees is the empty one.
  const contestedSrc = grab("function contestedBlock(id)", "  // The ruling controls");
  const itemCard = new Function(`"use strict"; let plainMode=false; const contestedOn=()=>[];\n${consts}\n${helpers}\n${contestedSrc}\n${itemCardSrc}\nreturn itemCard;`)();

  // The page's own filter: items are drawn on the milestone they name.
  assert.ok(idx.includes('(rm.items||[]).filter(it=>it.milestoneId===mid)'), "the page's item filter is unchanged and is the predicate used here");
  const drawn = (rm.items || []).filter((it) => it.milestoneId === card.milestoneId);
  assert.ok(drawn.some((it) => it.id === card.id), "the page's own filter selects the notice for that milestone's card list");

  const rendered = itemCard(card);
  assert.ok(/class="kind note_to_founder"/.test(rendered), "it renders with the Note to Founder styling");
  assert.ok(rendered.includes("Note to Founder"), "…and the page's own label for that kind");
  assert.ok(rendered.includes(srvMod.SIDECAR_NOTICE_TITLE), "the title the founder reads is on the card");
  assert.ok(/Claude Code changed the shape of that record/.test(rendered), "the plain-language explanation renders");
  assert.ok(/<code>unknown line type: summary<\/code>/.test(rendered), "the raw drift reason renders as code, not as prose");
  assert.ok(rendered.includes("The full chat view is working again"), "the outcome note renders in the thread");
  assert.ok(/class="who agent"/.test(rendered), "the thread is drawn as the agent's, never the founder's");
  assert.ok(!/undefined|\[object Object\]/.test(rendered), "nothing renders as undefined — the record is complete");

  // ---- (6) no milestones anywhere = no orphan item, still a valid line ---
  const BARE = path.join(TMP, "gBare");
  fs.mkdirSync(path.join(BARE, ".questlog"), { recursive: true });
  fs.writeFileSync(path.join(BARE, ".questlog", "roadmap.json"), JSON.stringify({ schemaVersion: 1, project: { name: "bare" }, quests: [], milestones: [], items: [], assets: [] }), "utf8");
  fs.writeFileSync(path.join(BARE, ".questlog", "history.jsonl"), "", "utf8");
  const bareCtx = srvMod.makeCtx(BARE);
  const wb = srvMod.logSidecarRepair(bareCtx, { status: "dry", drift: DRIFT, sessionId: CHAT });
  assert.strictEqual(wb.itemId, null, "with no milestone to hang it on, no orphan item is invented");
  const bareEvt = JSON.parse(fs.readFileSync(bareCtx.files.history, "utf8").trim());
  assert.strictEqual(bareEvt.targetId, null, "…and targetId falls back to null, which the schema allows");
  assert.ok(/^evt-/.test(bareEvt.id) && bareEvt.summary, "…the history line is still canonical");

  process.env.QUESTLOG_NO_LISTEN = "";
  if (savedReg === undefined) delete process.env.QUESTLOG_REGISTRY; else process.env.QUESTLOG_REGISTRY = savedReg;
  ok("G-A/G-B: a repair event is a NOTIFICATION — one canonical appendHistory line (id/actor/source/action/targetId/patch/summary) plus a note_to_founder card on a real milestone, threaded per episode; suggestions.json untouched; the copied road still validates and index.html's own itemCard() draws the card");
}

// ---- done ------------------------------------------------------------------
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
console.log(`\nALL PASS — ${passed} groups.`);
// Test #7 leaves intentionally-hanging fake children whose kill-timers keep the
// event loop alive; the assertions are all done, so exit cleanly.
process.exit(0);
