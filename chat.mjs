#!/usr/bin/env node
// ---------------------------------------------------------------------------
// QUESTLOG — CHAT DOCK backend (B1).
//
// Each chat is a REAL headless Claude Code session (resume-chained): the first
// send pins a --session-id, every later send --resume's it. Chats live per
// questlog-home (the board roster is central), NOT per road — a board chat can
// span roads. Every chat shows up in the road's sessions.json roster
// automatically because it shares its Claude session UUID as the chat id.
//
// Zero npm deps. Node builtins only. Reuses bridge.mjs's spawn hygiene verbatim
// (cleanEnv / strippedEnvKeys / no-shell spawn / windowsHide / SIGTERM->SIGKILL)
// and the exact same lock + atomic-write protocol as server.mjs / the MCP
// server. chat.mjs never imports server.mjs (no cycle): the road-lock +
// upsertSession protocol is re-implemented here against a plain ctx object.
//
// ACCESS TIERS — the governing ruling is dec-chat-access-tiers (approved on the
// questlog road, 2026-07-25). It SUPERSEDES the earlier "exactly two modes /
// no approval-bypassing string anywhere in this file" ruling that this header
// used to carry. That earlier ruling required a named, by-capability founder
// authorization before any higher tier could ship; the founder was asked with
// each bypassing capability spelled out in the option text and answered "all
// the 4 tiers on choice". The superseded text is rewritten here, not deleted,
// so the change of ruling stays legible.
//
// FOUR profiles ship (see DEFAULT_PROFILES below):
//   * "observer"          : ONLY an --allowedTools whitelist of the READ-ONLY
//                           questlog MCP tools (roadmap_get, list_unclear,
//                           baton_peek — the strictly-read baton view; NOT
//                           baton_read, which can claim on pickUp). NO
//                           permission-mode flag. Under headless `-p` every
//                           tool NOT on the whitelist is denied by
//                           construction. DEFAULT everywhere, always.
//   * "board-editor"      : observer + the questlog MCP write tools. Still no
//                           file/command tools and NO permission-mode flag.
//   * "workspace-builder" : board-editor + Read/Edit/Write, with
//                           --permission-mode acceptEdits. Claude Code's own
//                           acceptEdits scoping applies: edits are auto-accepted
//                           within the session's working directory, which for a
//                           chat is the road's project root (cwd below). That is
//                           Claude Code's scoping, not an extra wall this file
//                           builds — stated plainly, not overclaimed.
//   * "full-autonomy"     : --permission-mode bypassPermissions, no allowlist —
//                           everything without prompts: commands, files, tools.
//                           Red-badged, never preselected anywhere.
//
// (Live-probe finding, still true: --permission-mode plan categorically BLOCKS
// all MCP execution regardless of --allowedTools — "Cannot call
// mcp__questlog__roadmap_get while in plan mode" — so plan is never used.)
//
// ESCALATION CEILING. AUTHORIZED_CEILING below is the frozen record of exactly
// which profile names the founder authorized which permission mode for. It is
// enforced TWICE: once when a config edit is validated (server.mjs
// validateConfigBody) and again here at spawn time in profileFlags(), so a
// hand-edited config.json can never widen a profile past what was authorized.
// A custom profile name has no ceiling entry, so it can never carry a
// permission mode at all.
// ---------------------------------------------------------------------------

import { spawn as realSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import process from "node:process";
import { questlogHome, cleanEnv, strippedEnvKeys, MCP_SERVER_PATH } from "./bridge.mjs";
// F8b sidecar — read-only enrichment of a chat's transcript from Claude Code's
// own session file. chat.mjs consumes exactly two functions and nothing else,
// so a drift-repair session can rewrite the adapter without touching this file.
import { readSidecar, enrich } from "./sidecar-adapter.mjs";

// ---------------------------------------------------------------------------
// TWO CLOCKS (P2). The old design was ONE 10-minute wall-clock cap armed at
// spawn and never rearmed — it killed turns that were actively working (the
// 2026-07-25 incident: axed 63s after the last real activity, mid-flight, after
// 8m49s of productive work). Replaced by:
//   * an IDLE watchdog, reset on every raw stdout byte (the honest liveness
//     signal — a long tool call still emits stream frames), default 5 min;
//   * an ABSOLUTE ceiling, armed once per attempt, never reset, default 60 min.
// Precedence for both: env > config (deps.chatTimeouts()) > default.
// ---------------------------------------------------------------------------
export const CHAT_TIMEOUT_DEFAULT_MS = 3600000;      // 60 min absolute ceiling
export const CHAT_IDLE_TIMEOUT_DEFAULT_MS = 300000;  // 5 min without output
export const CHAT_RETRIES_DEFAULT = 2;               // max retries (3 attempts)

function posIntOr(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Absolute ceiling. Name kept (server.mjs + tests reference it).
export function chatTimeoutMs(env = process.env, cfg = null) {
  const fromEnv = parseInt(env.QUESTLOG_CHAT_TIMEOUT_MS, 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;         // env wins
  if (cfg && Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0) return cfg.timeoutMs;
  return CHAT_TIMEOUT_DEFAULT_MS;
}
// Idle watchdog — time since the last byte on stdout.
export function chatIdleTimeoutMs(env = process.env, cfg = null) {
  const fromEnv = parseInt(env.QUESTLOG_CHAT_IDLE_TIMEOUT_MS, 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (cfg && Number.isFinite(cfg.idleTimeoutMs) && cfg.idleTimeoutMs > 0) return cfg.idleTimeoutMs;
  return CHAT_IDLE_TIMEOUT_DEFAULT_MS;
}
// Max bounded auto-retries per send (env only — no config key by contract).
// 0 is a legitimate value here (retries off), so this one is >= 0.
export function chatRetries(env = process.env) {
  const n = parseInt(env.QUESTLOG_CHAT_RETRIES, 10);
  return Number.isFinite(n) && n >= 0 ? n : CHAT_RETRIES_DEFAULT;
}
// Backoff before retry N (0-indexed attempt that just failed).
export const RETRY_BACKOFF_MS = [2000, 8000];

// Total concurrent in-flight chats across the whole server.
export const CHAT_TOTAL_CAP = 3;

// ---------------------------------------------------------------------------
// P1b — mirror Claude Code's OWN guard. Decompiled from claude.exe v2.1.220 the
// check behind "Session ID <id> is already in use" is a plain
// fs.statSync(<projectSessionsDir>/<id>.jsonl): pure existence, no process, no
// lock, no expiry. So --session-id is poisoned the instant the session file
// lands (~3s after the first spawn), long before any assistant text. We mirror
// the check so we degrade to --resume instead of hard-failing forever.
//
// Slug = the absolute cwd with \ / : . and spaces folded to -. Honours
// CLAUDE_CONFIG_DIR (that is dq() in the decompiled source). FAIL-OPEN: any
// doubt returns false, and P1's sessionStarted flag carries the fix regardless,
// so this helper is strictly additive and never load-bearing alone.
// ---------------------------------------------------------------------------
export function claudeProjectSlug(root) {
  return String(root || "").replace(/[\\/:.\s]/g, "-");
}
export function claudeSessionExists(root, sessionId, env = process.env) {
  try {
    if (typeof sessionId !== "string" || !sessionId) return false;
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return false;
    const cfgDir = (typeof env.CLAUDE_CONFIG_DIR === "string" && env.CLAUDE_CONFIG_DIR)
      ? env.CLAUDE_CONFIG_DIR
      : path.join(os.homedir(), ".claude");
    const file = path.join(cfgDir, "projects", claudeProjectSlug(root), `${sessionId}.jsonl`);
    return fs.statSync(file).isFile();
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// P4 — the retry classifier. PURE + exported so every pinned class has a unit
// test. Transient/infrastructural failures retry (the terminal absorbs those
// silently and carries on); deterministic ones never do, because a retry burns
// the founder's time and then shows the identical error.
// ---------------------------------------------------------------------------
const RETRYABLE_SPAWN_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EAI_AGAIN"]);
const RETRY_STDERR_RE = /ECONNRESET|ETIMEDOUT|socket hang up|network error|fetch failed|Connection error|502|503|504|Overloaded|rate.?limit/i;
// Checked FIRST — these beat the retry regex even if both match.
const NEVER_STDERR_RE = /Session ID \S+ is already in use|Invalid session ID|--session-id can only be used|not logged in|authentication|invalid api key|credit balance|insufficient|\b401\b|\b403\b/i;
// "Session ID … is already in use" specifically: not an error to retry, a flag
// to flip (P1c). Detected separately so the close handler can self-correct.
export const SESSION_IN_USE_RE = /Session ID \S+ is already in use/;

// kind: "spawn-error" | "exit" | "kill" | "clean-error"
export function classifyChatFailure({ kind, errCode, stderr, killReason } = {}) {
  const err = String(stderr || "");
  if (kind === "spawn-error") {
    if (errCode === "ENOENT") return { retry: false, reason: "binary-not-found" };
    if (RETRYABLE_SPAWN_CODES.has(errCode)) return { retry: true, reason: "connection" };
    return { retry: false, reason: "spawn-failed" };
  }
  if (kind === "kill") {
    if (killReason === "idle") return { retry: true, reason: "went-quiet" };
    return { retry: false, reason: "ceiling" };   // the founder set that ceiling deliberately
  }
  if (kind === "clean-error") return { retry: false, reason: "model-reported" };
  // kind === "exit"
  if (NEVER_STDERR_RE.test(err)) return { retry: false, reason: "deterministic" };
  if (RETRY_STDERR_RE.test(err)) return { retry: true, reason: "connection" };
  return { retry: false, reason: "exit" };
}

// Plain-language, reason-aware kill copy (P2/P5). Never a raw number dump.
export function killMessage(reason, ms) {
  const tail = " You can raise this in Settings → Chat.";
  if (reason === "idle") return `chat went quiet for ${ms}ms (no output) — stopped.${tail}`;
  return `chat hit the ${ms}ms ceiling — stopped.${tail}`;
}

// ---------------------------------------------------------------------------
// Storage paths — per questlog-home (same dir as registry.json / config.json).
// ---------------------------------------------------------------------------
export function chatPaths(env = process.env) {
  const home = questlogHome(env);
  const dir = path.join(home, "chats");
  return {
    home,
    dir,
    index: path.join(dir, "chats.json"),
    lockDir: path.join(home, ".chats-lock"),
    transcript: (id) => path.join(dir, `${id}.jsonl`),
  };
}

const emptyIndex = () => ({ schemaVersion: 1, chats: [] });

function readJsonTolerant(file, fallbackFn) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallbackFn(); }
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// chats.json lock — .chats-lock, 3s timeout / 5s stale, exactly the config-lock
// protocol. Never nested with a road lock (we release chats before touching a
// road's sessions.json).
// ---------------------------------------------------------------------------
function acquireChatsLock(env = process.env) {
  const cp = chatPaths(env);
  if (!fs.existsSync(cp.home)) fs.mkdirSync(cp.home, { recursive: true });
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(cp.lockDir); return; }
    catch (err) {
      if (err.code !== "EEXIST") throw Object.assign(new Error("E_IO: " + err.message), { code: "E_IO" });
      let age = Infinity;
      try { age = Date.now() - fs.statSync(cp.lockDir).mtimeMs; } catch { /* vanished */ }
      if (age > 5000) { try { fs.rmdirSync(cp.lockDir); } catch { /* raced */ } continue; }
      if (Date.now() - start > 3000) throw Object.assign(new Error("E_LOCK_TIMEOUT: could not acquire chats lock"), { code: "E_LOCK_TIMEOUT" });
      const until = Date.now() + 50; while (Date.now() < until) { /* spin */ }
    }
  }
}
function releaseChatsLock(env = process.env) {
  try { fs.rmdirSync(chatPaths(env).lockDir); } catch { /* already gone */ }
}
function withChatsLock(env, fn) {
  acquireChatsLock(env);
  try { return fn(); } finally { releaseChatsLock(env); }
}

// ---------------------------------------------------------------------------
// chats.json CRUD (all writes under the chats lock).
// ---------------------------------------------------------------------------
export function readChatsIndex(env = process.env) {
  const data = readJsonTolerant(chatPaths(env).index, emptyIndex);
  if (!data || typeof data !== "object" || !Array.isArray(data.chats)) return emptyIndex();
  if (data.schemaVersion !== 1) data.schemaVersion = 1;
  return data;
}

export function findChat(id, env = process.env) {
  return readChatsIndex(env).chats.find((c) => c && c.id === id) || null;
}

// Upsert one chat record. `patch` is shallow-merged onto the existing record
// (or a fresh one). updatedAt is always stamped. Returns the stored record.
export function upsertChatRecord(env, id, patch) {
  const cp = chatPaths(env);
  return withChatsLock(env, () => {
    fs.mkdirSync(cp.dir, { recursive: true });
    const data = readChatsIndex(env);
    const now = new Date().toISOString();
    let rec = data.chats.find((c) => c && c.id === id);
    if (rec) {
      Object.assign(rec, patch, { updatedAt: now });
    } else {
      rec = {
        id,
        title: "",
        roadId: null,
        anchorMilestoneId: null,
        mode: "observer",
        profile: "observer",
        parentSessionId: null,
        model: null,
        createdAt: now,
        updatedAt: now,
        status: "idle",
        lastCostUsd: null,
        // P1 — "has a Claude session been created for this id", stamped at the
        // moment of spawn. The OLD predicate (hasAssistantLine) answered a
        // different question and produced a false negative on any pre-assistant
        // failure, which re-pinned --session-id and bricked the chat forever.
        sessionStarted: false,
        ...patch,
      };
      data.chats.push(rec);
    }
    atomicWrite(cp.index, data);
    return { ...rec };
  });
}

// ---------------------------------------------------------------------------
// Transcript — append-only jsonl, one event per line.
// ---------------------------------------------------------------------------
export function appendTranscript(env, id, line) {
  const cp = chatPaths(env);
  fs.mkdirSync(cp.dir, { recursive: true });
  fs.appendFileSync(cp.transcript(id), JSON.stringify(line) + "\n", "utf8");
}

export function readTranscript(env, id) {
  const cp = chatPaths(env);
  let raw = "";
  try { raw = fs.readFileSync(cp.transcript(id), "utf8"); } catch { return []; }
  const out = [];
  for (const l of raw.split("\n")) {
    const t = l.trim(); if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip malformed */ }
  }
  return out;
}

// BACK-COMPAT LEG ONLY (P1). Chats created before `sessionStarted` existed have
// no flag on their record, so an assistant line remains the evidence that their
// session is live. New chats are governed by record.sessionStarted; this is the
// fallback that keeps the transcripts already on disk resuming correctly.
export function hasAssistantLine(transcript) {
  return transcript.some((e) => e && e.role === "assistant");
}

// ---------------------------------------------------------------------------
// Road-side session roster upsert (the "every chat is in the roster" promise).
// Re-implements server.mjs's withLock + upsertSession against a ctx object so
// chat.mjs stays free of a server.mjs import. Called AFTER the chats lock is
// released, so the two locks never nest.
// ---------------------------------------------------------------------------
// `extra` carries lineage: {parentSessionId} is stamped onto the sessions.json
// entry so the roster can render children under their parent.
function roadUpsertSession(ctx, sessionId, label, delta, extra) {
  if (!ctx || typeof sessionId !== "string" || !sessionId) return;
  if (!fs.existsSync(ctx.dataDir)) fs.mkdirSync(ctx.dataDir, { recursive: true });
  const start = Date.now();
  // acquire road lock (5s stale / 3s timeout — same as server.mjs)
  for (;;) {
    try { fs.mkdirSync(ctx.lockDir); break; }
    catch (err) {
      if (err.code !== "EEXIST") return; // best-effort: never break a send
      let age = Infinity;
      try { age = Date.now() - fs.statSync(ctx.lockDir).mtimeMs; } catch { /* vanished */ }
      if (age > 5000) { try { fs.rmdirSync(ctx.lockDir); } catch { /* raced */ } continue; }
      if (Date.now() - start > 3000) return; // give up quietly
      const until = Date.now() + 50; while (Date.now() < until) { /* spin */ }
    }
  }
  try {
    const sessFile = ctx.files.sessions;
    const data = readJsonTolerant(sessFile, () => ({ schemaVersion: 1, sessions: [] }));
    if (!data || typeof data !== "object") return;
    if (!Array.isArray(data.sessions)) data.sessions = [];
    data.schemaVersion = 1;
    const now = new Date().toISOString();
    let s = data.sessions.find((x) => x && x.id === sessionId);
    if (s) {
      s.lastSeenAt = now;
      s.eventCount = (Number.isInteger(s.eventCount) ? s.eventCount : 0) + delta;
      if (typeof label === "string" && label.length > 0) s.label = label;
    } else {
      s = { id: sessionId, firstSeenAt: now, lastSeenAt: now, label: (typeof label === "string" ? label : "") || "", eventCount: delta };
      data.sessions.push(s);
    }
    const parent = extra && typeof extra.parentSessionId === "string" && extra.parentSessionId ? extra.parentSessionId : null;
    if (parent && parent !== sessionId) s.parentSessionId = parent;
    atomicWrite(sessFile, data);
  } catch { /* best-effort */ }
  finally { try { fs.rmdirSync(ctx.lockDir); } catch { /* gone */ } }
}

// ---------------------------------------------------------------------------
// Profiles -> spawn flags. profileFlags() is the ENTIRE surface where a
// permission/tool flag can be constructed. The MCP server key is "questlog"
// (see mcpConfig below), so the mcp__questlog__ prefix is correct.
// ---------------------------------------------------------------------------
export const OBSERVER_READ_TOOLS = [
  "mcp__questlog__roadmap_get",
  "mcp__questlog__list_unclear",
  "mcp__questlog__baton_peek",
  "mcp__questlog__roadmap_list",
  "mcp__questlog__history_tail",
];

// AUTHORITATIVE BOARD PROFILES (HARNESS-4). The declared allowlist was not the
// effective one: the headless layer auto-allowed Read/Grep/Glob for a
// board-level chat, so a profile that says "questlog tools only" could answer
// by grepping the filesystem. These two frozen tables close that: buildFlags
// pushes --disallowedTools for any BOARD_LEVEL_PROFILES name, keyed by NAME at
// spawn time, so a hand-edited config.json cannot remove it (the same
// double-enforcement pattern as AUTHORIZED_CEILING). Deny beats allow in Claude
// Code, so a config-injected "Read" in allowedTools is dead argv.
//
// `Skill` and `ToolSearch` are deliberately NOT denied: buildBoardPreamble
// instructs the chat to invoke the questlog:chief-of-staff skill, and both are
// instruction/schema loaders with no data reach once the file/exec surface is
// denied. If the founder ever wants Skill denied, buildBoardPreamble must drop
// that sentence in the same change.
// workspace-builder and full-autonomy are untouched by definition — file access
// is what those tiers ARE.
export const BOARD_DENY_TOOLS = Object.freeze(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "BashOutput", "KillShell", "Glob", "Grep", "WebFetch", "WebSearch", "Task"]);
export const BOARD_LEVEL_PROFILES = Object.freeze(["observer", "board-editor"]);

// Every questlog MCP tool that changes the ROAD (enumerated from mcp/server.mjs).
// roadmap_register / roadmap_set_origin are deliberately NOT here: they change
// registry topology, not the road. A founder can add them to a profile by hand.
export const BOARD_WRITE_TOOLS = [
  "mcp__questlog__session_hello",
  "mcp__questlog__milestone_upsert",
  "mcp__questlog__milestone_set_status",
  "mcp__questlog__milestone_delete",
  "mcp__questlog__item_upsert",
  "mcp__questlog__item_delete",
  "mcp__questlog__item_note_add",
  "mcp__questlog__quest_create",
  "mcp__questlog__quest_delete",
  "mcp__questlog__asset_link",
  "mcp__questlog__decision_log",
  "mcp__questlog__decision_set_approval",
  "mcp__questlog__pin_compaction",
  "mcp__questlog__clear_unclear",
  "mcp__questlog__glossary_term_upsert",
  "mcp__questlog__baton_pass",
  "mcp__questlog__baton_read",
  "mcp__questlog__brief_create",
  "mcp__questlog__suggestions_upsert",
  "mcp__questlog__suggestion_promote",
  "mcp__questlog__suggestion_dismiss",
];

const BOARD_EDITOR_TOOLS = [...OBSERVER_READ_TOOLS, ...BOARD_WRITE_TOOLS];
const WORKSPACE_FILE_TOOLS = ["Read", "Edit", "Write"];

// The four built-ins. A config chat.profiles entry REPLACES one of these by
// name (and `null` restores it). label is founder-facing plain language.
export const DEFAULT_PROFILES = {
  observer: {
    label: "Observer",
    allowedTools: OBSERVER_READ_TOOLS.slice(),
    permissionMode: null,
  },
  "board-editor": {
    label: "Board editor",
    allowedTools: BOARD_EDITOR_TOOLS.slice(),
    permissionMode: null,
  },
  "workspace-builder": {
    label: "Workspace builder",
    allowedTools: [...BOARD_EDITOR_TOOLS, ...WORKSPACE_FILE_TOOLS],
    permissionMode: "acceptEdits",
  },
  "full-autonomy": {
    label: "Full autonomy",
    allowedTools: null, // no allowlist — bypassPermissions is the whole point
    permissionMode: "bypassPermissions",
  },
};

// FROZEN record of the founder's by-capability authorization
// (dec-chat-access-tiers). Maps a profile NAME to the ONE permission mode that
// name may ever carry. A name absent from this table may carry none.
export const AUTHORIZED_CEILING = Object.freeze({
  "workspace-builder": "acceptEdits",
  "full-autonomy": "bypassPermissions",
});

export function profileNames(profiles) {
  const t = (profiles && typeof profiles === "object" && !Array.isArray(profiles)) ? profiles : DEFAULT_PROFILES;
  return Object.keys(t);
}

// Clamp a requested permission mode against the ceiling for that profile name.
// Returns null (no --permission-mode flag) for anything not exactly authorized.
// Restricting DOWN to null is always allowed; widening is impossible.
export function clampPermissionMode(profileName, requested) {
  if (requested === null || requested === undefined || requested === "") return null;
  if (typeof requested !== "string") return null;
  const ceiling = Object.prototype.hasOwnProperty.call(AUTHORIZED_CEILING, profileName)
    ? AUTHORIZED_CEILING[profileName] : null;
  if (ceiling === null) return null;
  return requested === ceiling ? ceiling : null;
}

// A tool name safe to hand to --allowedTools (no separators / whitespace).
function safeToolName(t) {
  return typeof t === "string" && t.length > 0 && t.length <= 120 && /^[A-Za-z0-9_.:*()\- ]+$/.test(t) && !t.includes(",");
}

// profileFlags — the ONLY constructor of permission/tool argv. Unknown profile
// names fall through to observer (safe default preserved).
export function profileFlags(profileName, profiles) {
  const table = (profiles && typeof profiles === "object" && !Array.isArray(profiles)) ? profiles : DEFAULT_PROFILES;
  const name = (typeof profileName === "string" && profileName) ? profileName : "observer";
  let def = table[name];
  if (!def || typeof def !== "object") def = DEFAULT_PROFILES[name];
  if (!def || typeof def !== "object") {
    // Unknown/legacy profile name — observer flags, never wider.
    def = table.observer && typeof table.observer === "object" ? table.observer : DEFAULT_PROFILES.observer;
    return buildFlags("observer", def);
  }
  return buildFlags(name, def);
}

function buildFlags(name, def) {
  const flags = [];
  const pm = clampPermissionMode(name, def.permissionMode);
  if (pm) flags.push("--permission-mode", pm);
  const tools = Array.isArray(def.allowedTools) ? def.allowedTools.filter(safeToolName) : null;
  if (tools && tools.length) flags.push("--allowedTools", tools.join(","));
  // Board-level profiles are AUTHORITATIVE: the deny list is table-keyed by
  // profile NAME, not read from the (editable) profile definition, so no config
  // edit can widen a board chat back onto the filesystem.
  if (BOARD_LEVEL_PROFILES.includes(name)) flags.push("--disallowedTools", BOARD_DENY_TOOLS.join(","));
  return flags;
}

// Legacy mode -> flags. Kept verbatim for records created before profiles
// existed: mode "standard" ran flagless and keeps running flagless.
export function modeFlags(mode) {
  if (mode === "standard") return [];
  return ["--allowedTools", OBSERVER_READ_TOOLS.join(",")];
}

// The record-level decision: a stored `profile` wins; otherwise the legacy
// `mode`. Never widens: an unknown profile lands on observer.
export function spawnFlags({ profile, mode, profiles }) {
  if (typeof profile === "string" && profile) return profileFlags(profile, profiles);
  return modeFlags(mode);
}

// The spawn argv for one message. Mirrors bridge.buildArgs' shape but is chat-
// shaped: stream-json + --verbose + partial messages, session-id on the first
// message / --resume after, mode flags, and the questlog MCP WITHOUT
// --strict-mcp-config (deliberate delta: let the road's own project MCP/skills
// resolve too). No --add-dir: cwd is already the road project root.
//
// BRANCHING (plan A). When a chat records a parentSessionId, its FIRST send is
// a fork of that parent: `--resume <parentSessionId> --fork-session
// --session-id <newChatId>`. `claude --help` confirms --fork-session ("When
// resuming, create a new session ID instead of reusing the original (use with
// --resume or --continue)") and --session-id <uuid>. The parent is only READ:
// forking writes a new session, never the source.
// Plan B (documented fallback, only if --session-id turns out not to pin the
// forked id): omit --session-id, read the session_id out of the stream-json
// `system:init` line and adopt it as the chat id before any roster upsert.
export function buildChatArgs({ prompt, model, sessionId, isFirst, mode, profile, profiles, parentSessionId, mcpConfigPath }) {
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",                       // stream-json under -p requires --verbose
    "--include-partial-messages",      // text deltas
    "--model", model,
  ];
  if (isFirst) {
    if (typeof parentSessionId === "string" && parentSessionId) {
      args.push("--resume", parentSessionId, "--fork-session", "--session-id", sessionId);
    } else {
      args.push("--session-id", sessionId);
    }
  } else {
    args.push("--resume", sessionId);
  }
  for (const f of spawnFlags({ profile, mode, profiles })) args.push(f);
  args.push("--mcp-config", mcpConfigPath); // NO --strict-mcp-config (by design)
  return args;
}

// ---------------------------------------------------------------------------
// Stream-json parser. Fed line-buffered stdout JSON; emits the frozen SSE event
// shapes and accumulates the authoritative assistant text / tool lines / result
// for persistence at child close. Pure + stateful — hermetically testable.
// ---------------------------------------------------------------------------
function numOr(v, def) { return (typeof v === "number" && Number.isFinite(v)) ? v : def; }

function toolDetail(block) {
  const name = (block && typeof block.name === "string" && block.name) ? block.name : "tool";
  const inp = block && block.input;
  let s = "";
  if (inp && typeof inp === "object") {
    const parts = [];
    for (const k of Object.keys(inp)) {
      let v = inp[k];
      if (typeof v === "string") v = v.length > 60 ? v.slice(0, 60) + "…" : v;
      else { try { v = JSON.stringify(v); } catch { v = String(v); } }
      parts.push(`${k}: ${v}`);
      if (parts.join(", ").length > 120) break;
    }
    s = parts.join(", ");
  }
  let out = s ? `${name} — ${s}` : name;
  if (out.length > 240) out = out.slice(0, 240) + "…";
  return out;
}

// F2 caps. The FULL structured input rides the event and the transcript line;
// only these caps bound it. `detail` above stays as the legacy summary string.
export const TOOL_INPUT_CAP = 16384;   // 16KB stringified
export const TOOL_OUTPUT_CAP = 4096;   // 4KB of correlated tool_result text

function capInput(input) {
  if (input === undefined || input === null) return { input: null, inputTruncated: false };
  let s; try { s = JSON.stringify(input); } catch { return { input: null, inputTruncated: false }; }
  if (typeof s !== "string") return { input: null, inputTruncated: false };
  if (s.length <= TOOL_INPUT_CAP) return { input, inputTruncated: false };
  // Too big to keep structurally — keep a clipped string form and flag it.
  return { input: s.slice(0, TOOL_INPUT_CAP), inputTruncated: true };
}

// tool_result.content is either a string or an array of {type:"text",text}.
function flattenResultContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (content === undefined || content === null) return "";
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  const parts = [];
  for (const c of content) {
    if (typeof c === "string") { parts.push(c); continue; }
    if (!c || typeof c !== "object") continue;
    if (typeof c.text === "string") parts.push(c.text);
    else if (c.type === "image") parts.push("[image]");
    else { try { parts.push(JSON.stringify(c)); } catch { /* skip */ } }
  }
  return parts.join("\n");
}
function capOutput(content) {
  const s = flattenResultContent(content);
  if (s.length <= TOOL_OUTPUT_CAP) return { output: s, outputTruncated: false };
  return { output: s.slice(0, TOOL_OUTPUT_CAP), outputTruncated: true };
}

// ---------------------------------------------------------------------------
// F1 — ORDERED BEATS. `obj.message.content` is an ORDERED array; the old parser
// read it in order and then destroyed that order by routing text into a string
// accumulator and tool_use into a separate array, so persistence wrote one
// prose blob then all the tool chips, all stamped with the child-close time.
// 452 seconds of work and 29 tool calls came out as one timestamp.
//
// Now: one `beats[]` in true chronological order. Consecutive text merges into
// the OPEN prose beat; a tool_use SEALS it, so the next text opens a fresh
// panel and the founder sees prose → chip → prose. Every beat carries an honest
// per-beat `ts` (stamped at parse time, never at close) and a `seq` issued by
// the run controller, so seq spans P4's retry attempts.
//
// `nextSeq` is injected by the run controller. Default: a private counter, so
// the parser stays hermetically testable on its own.
// ---------------------------------------------------------------------------
export function makeStreamParser(opts = {}) {
  const nextSeq = (opts && typeof opts.nextSeq === "function")
    ? opts.nextSeq
    : (() => { let n = 0; return () => ++n; })();

  const beats = [];
  const byToolUseId = new Map();
  let openProse = null;     // the prose beat currently accepting text
  let result = null;

  function handle(obj) {
    const out = [];
    if (!obj || typeof obj !== "object") return out;

    if (obj.type === "stream_event") {
      const ev = obj.event;
      if (ev && ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta" && typeof ev.delta.text === "string") {
        out.push({ type: "delta", text: ev.delta.text });
      }
    } else if (obj.type === "assistant" && obj.message && Array.isArray(obj.message.content)) {
      for (const b of obj.message.content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && typeof b.text === "string") {
          if (!b.text) continue;
          if (openProse) openProse.text += b.text;
          else { openProse = { kind: "text", ts: new Date().toISOString(), seq: nextSeq(), text: b.text }; beats.push(openProse); }
        } else if (b.type === "tool_use") {
          openProse = null;                                   // seal at the boundary
          const name = (typeof b.name === "string" && b.name) ? b.name : "tool";
          const toolUseId = (typeof b.id === "string" && b.id) ? b.id : null;
          const detail = toolDetail(b);                        // legacy summary string
          const { input, inputTruncated } = capInput(b.input);
          const beat = {
            kind: "tool", ts: new Date().toISOString(), seq: nextSeq(),
            name, detail, toolUseId, input, inputTruncated,
          };
          beats.push(beat);
          if (toolUseId) byToolUseId.set(toolUseId, beat);
          out.push({ type: "tool", name, detail, toolUseId, input, inputTruncated, seq: beat.seq });
        }
      }
    } else if (obj.type === "user" && obj.message && Array.isArray(obj.message.content)) {
      // F2 — tool_result blocks ride `user` lines. Correlate back to the chip.
      for (const b of obj.message.content) {
        if (!b || typeof b !== "object" || b.type !== "tool_result") continue;
        const toolUseId = (typeof b.tool_use_id === "string" && b.tool_use_id) ? b.tool_use_id : null;
        const { output, outputTruncated } = capOutput(b.content);
        const isErr = !!b.is_error;
        const beat = toolUseId ? byToolUseId.get(toolUseId) : null;
        if (beat) { beat.output = output; beat.outputTruncated = outputTruncated; beat.outputIsError = isErr; }
        out.push({
          type: "tool_result", toolUseId, output, outputIsError: isErr,
          truncated: outputTruncated, seq: beat ? beat.seq : null,
        });
      }
    } else if (obj.type === "result") {
      result = {
        costUsd: numOr(obj.total_cost_usd !== undefined ? obj.total_cost_usd : obj.cost_usd, null),
        durationMs: numOr(obj.duration_ms, null),
        numTurns: numOr(obj.num_turns, null),
        isError: !!obj.is_error,
      };
      out.push({ type: "result", ...result });
      // `done` is emitted by the RUN CONTROLLER, not here: with P4's bounded
      // retry a failed attempt must not close the turn in the UI. Exactly one
      // `done` per send, after the final attempt.
    }
    return out;
  }

  return {
    // Feed one raw line; returns the SSE events it produced (possibly []).
    push(line) {
      const t = String(line || "").trim();
      if (!t) return [];
      let obj; try { obj = JSON.parse(t); } catch { return []; }
      return handle(obj);
    },
    state() { return { beats: beats.slice(), result }; },
  };
}

// One ordered beat -> its persisted transcript line (schema v2). Shared by the
// success path and by F8a salvage so both write the identical shape.
export function beatToLine(beat) {
  if (!beat || typeof beat !== "object") return null;
  if (beat.kind === "text") {
    if (!beat.text) return null;
    return { ts: beat.ts, role: "assistant", text: beat.text, seq: beat.seq };
  }
  if (beat.kind !== "tool") return null;
  const line = { ts: beat.ts, role: "tool", seq: beat.seq, name: beat.name, detail: beat.detail };
  if (beat.toolUseId) line.toolUseId = beat.toolUseId;
  if (beat.input !== undefined && beat.input !== null) line.input = beat.input;
  if (beat.inputTruncated) line.inputTruncated = true;
  if (beat.output !== undefined) line.output = beat.output;
  if (beat.outputTruncated) line.outputTruncated = true;
  if (beat.outputIsError) line.outputIsError = true;
  return line;
}

// ---------------------------------------------------------------------------
// Anchoring preamble. Prepended server-side to the FIRST send only. Each field
// is clamped to <=600 chars; the whole preamble to <=4000.
// ---------------------------------------------------------------------------
const FIELD_MAX = 600;
const PREAMBLE_MAX = 4000;
function clamp(s, n) {
  s = (s === undefined || s === null) ? "" : String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function joinList(a) {
  return Array.isArray(a) ? a.filter((x) => typeof x === "string" && x).join("; ") : "";
}

// PROMPT-1 — the window/board honesty rule. "Absent from the board" and "absent
// from my window" were the same sentence, which produced the run's only
// hallucination. Paired with history_tail's `truncated` flag (HARNESS-3) the
// agent can now actually tell the difference. Verbatim in BOTH preambles and in
// the questlog skill's etiquette list.
export const WINDOW_HONESTY_RULE = "Saying something is NOT on the board requires a whole-record read. If your view is windowed or scoped — history_tail returned truncated:true, or a road you cannot reach — say 'not in my window', never 'not on the board'.";

// Append the rule so it can never be the thing the length clamp eats: the body
// is clamped to leave exactly room for it.
function withHonestyRule(body) {
  const tail = "\n\n" + WINDOW_HONESTY_RULE;
  return clamp(body, PREAMBLE_MAX - tail.length) + tail;
}

// Milestone-anchored preamble (pure — all inputs pre-gathered). Every field is
// individually clamped, then the assembled whole is clamped as a final guard.
export function buildMilestonePreamble({ projectName, milestone, baton, builtBy }) {
  const m = milestone || {};
  const lines = [];
  lines.push(`You are in a chat anchored to a milestone card on the "${clamp(projectName || "this", FIELD_MAX)}" road.`);
  lines.push("");
  lines.push(`CARD: ${clamp(m.title || "(untitled milestone)", FIELD_MAX)}`);
  lines.push(`STATUS: ${clamp(m.status || "unknown", FIELD_MAX)}`);
  const summarySlot = m.summary || m.body || "";
  lines.push(`SUMMARY: ${clamp(summarySlot, FIELD_MAX)}`);
  if (m.plain) lines.push(`PLAIN: ${clamp(m.plain, FIELD_MAX)}`);
  if (baton) {
    lines.push("");
    lines.push(`FRESHEST OPEN BATON: ${clamp(baton.label || "(unlabeled)", FIELD_MAX)}`);
    lines.push(`  done: ${clamp(joinList(baton.done), FIELD_MAX)}`);
    lines.push(`  in flight: ${clamp(joinList(baton.inFlight), FIELD_MAX)}`);
    lines.push(`  next: ${clamp(joinList(baton.next), FIELD_MAX)}`);
    lines.push(`  warnings: ${clamp(joinList(baton.warnings), FIELD_MAX)}`);
  }
  if (builtBy && builtBy.count > 0) {
    lines.push("");
    lines.push(clamp(`BUILT BY: ${builtBy.count} session(s): ${(builtBy.labels || []).join("; ")}`, FIELD_MAX));
  }
  lines.push("");
  lines.push("The founder is asking about this card. Read the road with your questlog tools before acting.");
  return withHonestyRule(lines.join("\n"));
}

// Board-level preamble (no milestone). Names the road and installs the persona.
export function buildBoardPreamble({ projectName, root }) {
  const lines = [
    `You are the board-level chat for the "${clamp(projectName || "this", FIELD_MAX)}" road (${clamp(root || "", FIELD_MAX)}).`,
    "Invoke the questlog:chief-of-staff skill (the Questlog plugin's chief of staff; questlog-chief-of-staff if only a personal copy is installed) and operate as it for this conversation.",
  ];
  return withHonestyRule(lines.join("\n"));
}

// Compact re-implementation of server.mjs's scanArchaeologySessions: which
// sessions touched this milestone (its card, its items, related decisions),
// returning { count, labels } newest-first. Tolerant; never throws.
function scanBuiltBy(ctx, mid) {
  try {
    const roadmap = readJsonTolerant(ctx.files.roadmap, () => ({}));
    const decisionsData = readJsonTolerant(ctx.files.decisions, () => ({ decisions: [] }));
    const items = Array.isArray(roadmap.items) ? roadmap.items : [];
    const decs = Array.isArray(decisionsData.decisions) ? decisionsData.decisions : [];
    const targetSet = new Set([mid]);
    for (const it of items) if (it && it.milestoneId === mid && typeof it.id === "string") targetSet.add(it.id);
    for (const d of decs) if (d && Array.isArray(d.relatedMilestoneIds) && d.relatedMilestoneIds.includes(mid) && typeof d.id === "string") targetSet.add(d.id);

    const sessData = readJsonTolerant(ctx.files.sessions, () => ({ sessions: [] }));
    const labelById = new Map();
    for (const s of (Array.isArray(sessData.sessions) ? sessData.sessions : [])) {
      if (s && typeof s.id === "string") labelById.set(s.id, typeof s.label === "string" ? s.label : "");
    }
    const groups = new Map();
    let raw = "";
    try { raw = fs.readFileSync(ctx.files.history, "utf8"); } catch { raw = ""; }
    for (const line of raw.split("\n")) {
      const t = line.trim(); if (!t) continue;
      let e; try { e = JSON.parse(t); } catch { continue; }
      if (!e || typeof e !== "object" || !targetSet.has(e.targetId)) continue;
      const sid = (typeof e.sessionId === "string" && e.sessionId) ? e.sessionId : null;
      if (!sid) continue;
      const ts = (typeof e.ts === "string") ? e.ts : null;
      let g = groups.get(sid);
      if (!g) { g = { sessionId: sid, label: labelById.has(sid) ? labelById.get(sid) : "", lastSeen: ts }; groups.set(sid, g); }
      if (ts && (!g.lastSeen || ts > g.lastSeen)) g.lastSeen = ts;
    }
    const arr = Array.from(groups.values()).sort((a, b) => String(b.lastSeen || "").localeCompare(String(a.lastSeen || "")));
    return { count: arr.length, labels: arr.map((g) => g.label || g.sessionId) };
  } catch { return { count: 0, labels: [] }; }
}

// Assemble the preamble for a chat from disk. milestoneId null => board-level.
export function buildPreamble(ctx, milestoneId) {
  const roadmap = readJsonTolerant(ctx.files.roadmap, () => ({}));
  const projectName = (roadmap && roadmap.project && typeof roadmap.project.name === "string" && roadmap.project.name)
    ? roadmap.project.name : path.basename(ctx.root || "");
  if (!milestoneId) {
    return buildBoardPreamble({ projectName, root: ctx.root });
  }
  const milestones = Array.isArray(roadmap.milestones) ? roadmap.milestones : [];
  const milestone = milestones.find((m) => m && m.id === milestoneId) || { id: milestoneId };
  // Freshest OPEN baton.
  const batonsData = readJsonTolerant(ctx.files.batons, () => ({ batons: [] }));
  const open = (Array.isArray(batonsData.batons) ? batonsData.batons : []).filter((b) => b && b.status === "open");
  open.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  const baton = open[0] || null;
  const builtBy = scanBuiltBy(ctx, milestoneId);
  return buildMilestonePreamble({ projectName, milestone, baton, builtBy });
}

// ---------------------------------------------------------------------------
// SSE runtime — per-chat ring buffer (last 200 events) + live listeners +
// in-flight tracking. Module-level; survives across requests for the process.
// ---------------------------------------------------------------------------
const RING_MAX = 200;
// chatId -> { ring:[], listeners:Set<res>, running:bool, child, evId, persistedThrough }
const CHAT_RT = new Map();
let inFlightCount = 0;

function rtFor(id) {
  let rt = CHAT_RT.get(id);
  if (!rt) {
    rt = {
      ring: [], listeners: new Set(), running: false, child: null,
      // evId — a monotonic per-chat id stamped on EVERY emitted event. It is
      // the stable identity a client dedupes on (F-A). Never reset while the
      // process lives, so a reconnect can never collide with an earlier event.
      evId: 0,
      // persistedThrough — the evId of the last `done`. Everything at or below
      // this watermark is ALREADY on disk in the transcript, so a fresh
      // connector must never be replayed it. See handleChatStream.
      persistedThrough: 0,
    };
    CHAT_RT.set(id, rt);
  }
  return rt;
}

// Read-only peek: must NOT create a runtime entry (handleChatGet is called for
// every chat open, including chats that have never run in this process).
function rtPeek(id) { return CHAT_RT.get(id) || null; }

function sseWrite(res, evt) {
  try { res.write("data:" + JSON.stringify(evt) + "\n\n"); } catch { /* client gone */ }
}

// Emit one event: stamp it, append to the ring (capped), fan out to listeners.
function emit(id, evt) {
  const rt = rtFor(id);
  evt.evId = ++rt.evId;
  rt.ring.push(evt);
  if (rt.ring.length > RING_MAX) rt.ring.splice(0, rt.ring.length - RING_MAX);
  for (const res of rt.listeners) sseWrite(res, evt);
}

// A turn completed: everything emitted so far is now persisted. Move the
// watermark. The ring is deliberately NOT cleared — a client that read the
// transcript just BEFORE this `done` landed still needs these events replayed,
// and its `since` cursor (taken from the old watermark) asks for exactly them.
function markPersisted(id) {
  const rt = rtFor(id);
  rt.persistedThrough = rt.evId;
}

export function isChatRunning(id) { return !!(CHAT_RT.get(id) && CHAT_RT.get(id).running); }
export function totalInFlight() { return inFlightCount; }

// ---------------------------------------------------------------------------
// One message run. Spawns the child, streams parsed events, persists at close.
// deps.spawn is injectable (tests / fake-claude bin). Never throws to caller.
// ---------------------------------------------------------------------------
function startChatRun({ record, ctx, fullPrompt, isFirst, roadLabel }, deps = {}) {
  const env = deps.env || process.env;
  const spawnFn = deps.spawn || realSpawn;
  const claudeBin = env.QUESTLOG_CHAT_CLAUDE_BIN || "claude";
  const id = record.id;
  const rt = rtFor(id);

  // --- RUN-SCOPE state (P4). Everything here is created ONCE PER SEND and
  // survives every retry attempt: the in-flight budget, the temp dir, and the
  // seq counter. Getting the budget wrong leaks CHAT_TOTAL_CAP and the founder
  // starts seeing spurious E_CHAT_CAP.
  rt.running = true;
  inFlightCount++;

  const cfgTimeouts = (typeof deps.chatTimeouts === "function") ? (deps.chatTimeouts() || null) : null;
  const hardMs = chatTimeoutMs(env, cfgTimeouts);
  const idleMs = chatIdleTimeoutMs(env, cfgTimeouts);
  const maxRetries = chatRetries(env);

  // Per-run temp dir just for the MCP config file (cwd stays the project root).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "questlog-chat-"));
  const mcpConfigPath = path.join(tmpDir, "questlog-mcp.json");
  const mcpConfig = { mcpServers: { questlog: { command: "node", args: [MCP_SERVER_PATH, "--dir", ctx.root] } } };
  try { fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf8"); } catch { /* tolerate */ }

  // seq is owned HERE, not by the parser, so it spans retry attempts. The user
  // line for this send is seq 0 (written by handleChatSend before we start).
  let seqCounter = 0;
  const nextSeq = () => ++seqCounter;

  let idleRetryUsed = false;     // the idle-stall retry is allowed exactly once
  let resumeCorrected = false;   // P1c fires at most once
  let settled = false;           // exactly one done per send

  attemptRun(0, !!isFirst);

  // -------------------------------------------------------------------------
  // ONE ATTEMPT. Re-enterable: every retry re-enters with attemptIsFirst=false,
  // so argv becomes `--resume <chatId>` and attempt N+1 continues the SAME
  // Claude session with full context — exactly like the terminal reconnecting.
  // That resume-chain is the entire reason retrying is safe here.
  // -------------------------------------------------------------------------
  function attemptRun(attempt, attemptIsFirst) {
    // P1b — never emit --session-id for a session that already exists on disk.
    // The fork path legitimately passes --resume <parent> --fork-session
    // --session-id <new>, which Claude Code explicitly permits, so exclude it.
    let first = attemptIsFirst;
    if (first && !record.parentSessionId && claudeSessionExists(ctx.root, id, env)) first = false;

    const args = buildChatArgs({
      prompt: fullPrompt, model: record.model || "sonnet", sessionId: id, isFirst: first,
      mode: record.mode, profile: record.profile,
      profiles: (typeof deps.chatProfiles === "function" ? deps.chatProfiles() : null),
      parentSessionId: first ? record.parentSessionId : null,
      mcpConfigPath,
    });

    const parser = makeStreamParser({ nextSeq });
    let buf = "";
    let stderr = "";
    let killReason = null;      // "idle" | "hard"
    let finished = false;       // this attempt only

    let child;
    try {
      child = spawnFn(claudeBin, args, {
        cwd: ctx.root,                 // chats live in the project root
        env: cleanEnv(env),            // strip nesting/session vars (bridge hygiene)
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      return failed(parser, { kind: "spawn-error", errCode: err && err.code, stderr: "" },
        String(err && err.message || err));
    }
    rt.child = child;

    // P1 — mark the session STARTED the instant spawn returns, before any
    // stdout handling. Claude Code creates <id>.jsonl within ~3s of exec and
    // questlog cannot observe that moment; the spawn is the last point at which
    // we are certainly earlier than the file. Over-marking is safe (P1b catches
    // it); under-marking is exactly what bricked the founder's chat.
    if (attemptIsFirst) { try { upsertChatRecord(env, id, { sessionStarted: true }); } catch { /* best-effort */ } }

    // --- P2: two clocks ---------------------------------------------------
    let idleTimer = null;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => killChild("idle"), idleMs);
    };
    const hardTimer = setTimeout(() => killChild("hard"), hardMs);
    const clearClocks = () => { clearTimeout(idleTimer); clearTimeout(hardTimer); idleTimer = null; };
    armIdle();

    // --- P3: kill the whole child TREE on Windows -------------------------
    // child.kill() maps to TerminateProcess on the DIRECT child only; libuv
    // does not walk the tree, so the MCP stdio server, PostToolUse hooks and
    // Bash grandchildren orphan. taskkill /T walks it; /F is required because
    // console apps ignore WM_CLOSE here. realSpawn, never deps.spawn — tests
    // inject a fake spawn and must not have the taskkill intercepted.
    function killChild(reason) {
      if (killReason) return;
      killReason = reason;
      clearClocks();
      if (process.platform === "win32") {
        try {
          realSpawn("taskkill", ["/PID", String(child.pid), "/T", "/F"],
            { stdio: "ignore", windowsHide: true, shell: false });
        } catch { /* taskkill absent — the fallback below still runs */ }
        setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 2000);
      } else {
        try { child.kill("SIGTERM"); } catch { /* gone */ }
        setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 2000);
      }
    }

    if (child.stdout) child.stdout.on("data", (d) => {
      armIdle();                     // FIRST LINE — raw bytes are the honest
      buf += d.toString();           // liveness signal, not parsed events.
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        for (const evt of parser.push(line)) emit(id, evt);
      }
    });
    if (child.stderr) child.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 8192) stderr = stderr.slice(-8192); });

    child.on("error", (err) => {
      if (finished) return; finished = true;
      clearClocks();
      failed(parser, { kind: "spawn-error", errCode: err && err.code, stderr },
        String(err && err.message || err));
    });

    child.on("close", (code) => {
      if (finished) return; finished = true;
      clearClocks();
      if (buf.trim()) for (const evt of parser.push(buf)) emit(id, evt);   // flush
      buf = "";
      const st = parser.state();

      if (killReason) {
        return failed(parser, { kind: "kill", killReason, stderr }, killMessage(killReason, killReason === "idle" ? idleMs : hardMs) + tail(stderr));
      }
      if (code !== 0) {
        // P1c — LAST-RESORT correction, not a retry. §3 of the bugfix spec
        // proves the guard is a statSync on a file that will never disappear,
        // so backoff would burn time and show the identical error. The only
        // recovery is to stop passing --session-id. Exactly one silent re-run;
        // if that also fails it is a genuine error and must surface.
        if (SESSION_IN_USE_RE.test(stderr) && attemptIsFirst && !resumeCorrected) {
          resumeCorrected = true;
          try { upsertChatRecord(env, id, { sessionStarted: true }); } catch { /* best-effort */ }
          salvage(parser);
          return attemptRun(attempt, false);
        }
        return failed(parser, { kind: "exit", stderr }, `claude exited ${code}` + tail(stderr));
      }
      if (st.result && st.result.isError) {
        // Clean exit, model-reported error: that is CONTENT, not transport.
        return finishOk(st);
      }
      finishOk(st);
    });

    // ---- per-attempt outcome helpers ------------------------------------
    function failed(p, classInput, message) {
      const verdict = classifyChatFailure(classInput);
      let retry = verdict.retry && attempt < maxRetries;
      if (retry && verdict.reason === "went-quiet") {
        if (idleRetryUsed) retry = false;      // idle stalls retry at most once
        else idleRetryUsed = true;
      }
      // F8a — the beats of THIS attempt happened. Persist them before anything
      // else, whether we retry or give up. No attempt's work is ever dropped.
      salvage(p);
      if (!retry) return finishError(message);

      const attemptNo = attempt + 1;
      const line = { ts: new Date().toISOString(), role: "retry", seq: nextSeq(), attempt: attemptNo, max: maxRetries + 1, reason: verdict.reason };
      try { appendTranscript(env, id, line); } catch { /* best-effort */ }
      emit(id, { type: "retry", attempt: attemptNo, max: maxRetries + 1, reason: verdict.reason });
      const wait = RETRY_BACKOFF_MS[attempt] !== undefined ? RETRY_BACKOFF_MS[attempt] : RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
      setTimeout(() => attemptRun(attempt + 1, false), wait);   // isFirst=false => --resume
    }
  }

  function tail(s) {
    const t = String(s || "").trim();
    if (!t) return "";
    return " — " + (t.length > 500 ? t.slice(-500) : t);
  }

  // F8a — persist an attempt's ordered beats. Idempotent per parser: a parser
  // is only ever salvaged once, and finishOk writes from the same helper.
  function salvage(parser) {
    try {
      const st = parser.state();
      for (const beat of st.beats) {
        const line = beatToLine(beat);
        if (line) appendTranscript(env, id, line);
      }
    } catch { /* best-effort */ }
  }

  // Temp-dir removal retries instead of swallowing. An EBUSY after taskkill /T
  // is direct evidence that something in the tree survived, and is worth seeing
  // — the same swallow-and-continue pattern hid the session-flag defect.
  function removeTemp(triesLeft) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    catch (err) {
      if (triesLeft > 1) { setTimeout(() => removeTemp(triesLeft - 1), 250); return; }
      try { console.error(`[questlog:chat] could not remove temp dir ${tmpDir}: ${err && err.message}`); } catch { /* no console */ }
    }
  }

  function cleanup() {
    rt.running = false;
    rt.child = null;
    inFlightCount = Math.max(0, inFlightCount - 1);
    removeTemp(3);
  }

  function finishOk(st) {
    if (settled) return; settled = true;
    try {
      // F1 — ONE loop over the ordered beats (the three-loop flatten is gone).
      for (const beat of st.beats) {
        const line = beatToLine(beat);
        if (line) appendTranscript(env, id, line);
      }
      if (st.result) {
        appendTranscript(env, id, {
          ts: new Date().toISOString(), role: "result", seq: nextSeq(),
          costUsd: st.result.costUsd, durationMs: st.result.durationMs,
          numTurns: st.result.numTurns, isError: st.result.isError,
        });
      }
      const isErr = st.result && st.result.isError;
      upsertChatRecord(env, id, { status: isErr ? "error" : "idle", lastCostUsd: st.result ? st.result.costUsd : record.lastCostUsd });
      // roster: another event this session accounted for
      roadUpsertSession(ctx, id, roadLabel, 1, { parentSessionId: record.parentSessionId });
    } catch { /* persistence best-effort */ }
    finally { emit(id, { type: "done" }); markPersisted(id); cleanup(); }
  }

  function finishError(message) {
    if (settled) return; settled = true;
    try {
      appendTranscript(env, id, { ts: new Date().toISOString(), role: "error", seq: nextSeq(), message });
      upsertChatRecord(env, id, { status: "idle" }); // status back to idle (contract)
      emit(id, { type: "error", message });
    } catch { /* best-effort */ }
    finally { emit(id, { type: "done" }); markPersisted(id); cleanup(); }
  }
}

// ---------------------------------------------------------------------------
// HTTP handlers. server.mjs wires these; `deps` carries resolveRoadCtx + mode.
//   deps.resolveRoadCtx(roadId) -> { ctx, roadId, root } | null
//   deps.mode  = "dir" | "central"
//   deps.env / deps.spawn optional (tests)
// ---------------------------------------------------------------------------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}

// POST /api/chats {roadId?, milestoneId?, profile, model?, branchFromSessionId?}
// `mode` (observer|standard) is still accepted for back-compat when no profile
// is given. branchFromSessionId may be ANY ledger session id — a chat's id or a
// plain terminal session's — because forking only needs --resume <id> in the
// road's cwd.
export function handleChatCreate(res, payload, deps) {
  const env = deps.env || process.env;
  const p = payload && typeof payload === "object" ? payload : {};
  const profiles = (typeof deps.chatProfiles === "function" && deps.chatProfiles()) || DEFAULT_PROFILES;

  let profile = null;
  let mode;
  if (p.profile !== undefined && p.profile !== null) {
    if (typeof p.profile !== "string" || !Object.prototype.hasOwnProperty.call(profiles, p.profile)) {
      return send(res, 400, { error: "E_VALIDATION", message: `profile must be one of: ${profileNames(profiles).join(", ")}` });
    }
    profile = p.profile;
    // mode is kept in step for back-compat readers only; profile is authoritative.
    mode = (profile === "observer") ? "observer" : "standard";
  } else {
    mode = p.mode;
    if (mode !== "observer" && mode !== "standard") {
      return send(res, 400, { error: "E_VALIDATION", message: 'profile is required (or a legacy mode of exactly "observer" or "standard")' });
    }
    profile = (mode === "observer") ? "observer" : null;
  }

  let parentSessionId = null;
  if (p.branchFromSessionId !== undefined && p.branchFromSessionId !== null) {
    const b = p.branchFromSessionId;
    if (typeof b !== "string" || !b || b.length > 200 || !/^[A-Za-z0-9._-]+$/.test(b)) {
      return send(res, 400, { error: "E_VALIDATION", message: "branchFromSessionId must be a session id ([A-Za-z0-9._-], <=200 chars)" });
    }
    parentSessionId = b;
  }

  let roadId = (typeof p.roadId === "string" && p.roadId) ? p.roadId : null;
  if (deps.mode === "central" && !roadId) {
    return send(res, 400, { error: "E_VALIDATION", message: "roadId is required in central mode" });
  }
  const resolved = deps.resolveRoadCtx(roadId);
  if (!resolved || !resolved.ctx) {
    return send(res, 404, { error: "not_found", message: `no roadmap ${roadId}` });
  }
  const milestoneId = (typeof p.milestoneId === "string" && p.milestoneId) ? p.milestoneId : null;
  // Model: an explicit per-chat pick (validated — it feeds spawn argv --model)
  // wins; else the config default (deps.defaultChatModel); else "sonnet".
  let model;
  if (typeof p.model === "string" && p.model) {
    if (p.model.length > 40 || !/^[a-z0-9.-]+$/.test(p.model)) {
      return send(res, 400, { error: "E_VALIDATION", message: "model must be a nonempty string, <=40 chars, [a-z0-9.-] only" });
    }
    model = p.model;
  } else {
    model = (typeof deps.defaultChatModel === "function" && deps.defaultChatModel()) || "sonnet";
  }
  const id = crypto.randomUUID(); // == the Claude session UUID (pinned on first send)

  const rec = upsertChatRecord(env, id, {
    title: "",
    roadId: resolved.roadId || roadId || null,
    anchorMilestoneId: milestoneId,
    mode, profile, parentSessionId, model,
    status: "idle",
    lastCostUsd: null,
  });
  // Put the chat in the road roster immediately (shared id) — with lineage.
  roadUpsertSession(resolved.ctx, id, "chat: " + (rec.title || "new chat"), 0, { parentSessionId });
  return send(res, 200, { ok: true, chat: rec });
}

// GET /api/chats
export function handleChatList(res, deps) {
  const env = deps.env || process.env;
  const data = readChatsIndex(env);
  const chats = data.chats.slice().sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return send(res, 200, { ok: true, chats });
}

// GET /api/chat/<id>
// F8b — the sidecar enrichment is wired HERE and nowhere else, read-only, and
// wrapped so that ANY adapter throw degrades to the dock's own transcript (the
// splint). A chat must never fail to open because the sidecar was odd.
export function handleChatGet(res, id, deps) {
  const env = deps.env || process.env;
  const rec = findChat(id, env);
  if (!rec) return send(res, 404, { error: "not_found", message: `no chat ${id}` });
  const dockTranscript = readTranscript(env, id);
  // F-A — the watermark that goes out WITH the transcript. Read it here, in the
  // same handler, so the pair is coherent: "this transcript covers everything
  // through event N; stream me N+1 onwards".
  const rtNow = rtPeek(id);
  const streamCursor = rtNow ? rtNow.persistedThrough : 0;
  let transcript = dockTranscript;
  let sidecar = null;
  try {
    const enabled = (typeof deps.sidecarEnabled === "function") ? !!deps.sidecarEnabled() : true;
    if (enabled) {
      const resolved = (typeof deps.resolveRoadCtx === "function") ? deps.resolveRoadCtx(rec.roadId) : null;
      const root = (resolved && resolved.root) ? resolved.root : null;
      if (root) {
        const sc = readSidecar(id, root, env);
        const merged = enrich(dockTranscript, sc);
        if (Array.isArray(merged)) transcript = merged;
        sidecar = {
          ok: sc.ok === true,
          reason: sc.reason || null,
          beats: (sc.ok && Array.isArray(sc.beats)) ? sc.beats.length : 0,
          drift: Array.isArray(sc.drift) ? sc.drift : [],
          enriched: transcript !== dockTranscript,
        };
        if (sidecar.drift.length && typeof deps.onSidecarDrift === "function") {
          // milestoneId rides along so the repair notice can be hung on the very
          // card this chat was opened from — where the founder will see it.
          try { deps.onSidecarDrift({ chatId: id, roadId: rec.roadId, milestoneId: rec.anchorMilestoneId || null, drift: sidecar.drift, ctx: resolved.ctx, version: sc.meta && sc.meta.version }); }
          catch { /* a repair launcher must never break a chat open */ }
        }
      }
    }
  } catch {
    transcript = dockTranscript;   // the splint
    sidecar = null;
  }
  return send(res, 200, { ok: true, chat: rec, transcript, sidecar, streamCursor });
}

// POST /api/chat/<id>/send {text}
export function handleChatSend(res, id, payload, deps) {
  const env = deps.env || process.env;
  const rec = findChat(id, env);
  if (!rec) return send(res, 404, { error: "not_found", message: `no chat ${id}` });

  const text = (payload && typeof payload.text === "string") ? payload.text : "";
  if (!text.trim()) return send(res, 400, { error: "E_VALIDATION", message: "text is required" });

  // Concurrency: one in-flight per chat, total cap CHAT_TOTAL_CAP.
  if (isChatRunning(id)) return send(res, 409, { error: "E_CHAT_BUSY", message: "this chat is already generating a reply" });
  if (totalInFlight() >= CHAT_TOTAL_CAP) return send(res, 429, { error: "E_CHAT_CAP", message: `too many chats in flight (max ${CHAT_TOTAL_CAP})` });

  const resolved = deps.resolveRoadCtx(rec.roadId);
  if (!resolved || !resolved.ctx) return send(res, 404, { error: "E_MISSING_DIR", message: `roadmap ${rec.roadId} not found` });
  const ctx = resolved.ctx;

  const transcript = readTranscript(env, id);
  // P1 — the session-created FLAG is authoritative; hasAssistantLine is only
  // the back-compat leg for records written before the flag existed. The old
  // derivation asked "have we seen assistant text", which is a different
  // question from "does Claude Code already have a session file", and answered
  // false on any pre-assistant failure — re-pinning --session-id forever.
  const isFirst = !rec.sessionStarted && !hasAssistantLine(transcript);

  // First send: prepend the anchoring preamble to the PROMPT only; store the
  // founder's own words with briefed:true (UI shows a chip, not the preamble).
  // The preamble is prepended IFF isFirst, and briefed tracks that same boolean
  // — so a re-send can never show a "briefed" chip that lies.
  let fullPrompt = text;
  let userLine = { ts: new Date().toISOString(), role: "user", text, seq: 0 };
  if (isFirst) {
    let preamble = "";
    try { preamble = buildPreamble(ctx, rec.anchorMilestoneId); } catch { preamble = ""; }
    if (preamble) fullPrompt = preamble + "\n\n---\n\n" + text;
    userLine.briefed = true;
  }
  appendTranscript(env, id, userLine);

  // Title auto = first 60 chars of the first founder message.
  let title = rec.title;
  if (!title && isFirst) title = text.slice(0, 60);
  const updated = upsertChatRecord(env, id, { status: "running", title });
  const roadLabel = "chat: " + (updated.title || "untitled");
  // Roster: this send is one accounted event for the shared session id.
  roadUpsertSession(ctx, id, roadLabel, 1, { parentSessionId: updated.parentSessionId });

  startChatRun({ record: updated, ctx, fullPrompt, isFirst, roadLabel }, deps);
  return send(res, 202, { ok: true, id, running: true });
}

// GET /api/chat/<id>/stream  -> SSE
// Parse ?since=<int> off the stream URL. Anything malformed reads as "no
// cursor" (full replay + client dedupe), never as an exception.
export function streamSinceFromUrl(req) {
  try {
    const u = String((req && req.url) || "");
    const q = u.indexOf("?");
    if (q < 0) return null;
    const m = /(?:^|&)since=([^&]*)/.exec(u.slice(q + 1));
    if (!m) return null;
    const n = Number.parseInt(decodeURIComponent(m[1]), 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch { return null; }
}

export function handleChatStream(req, res, id, deps) {
  const env = deps.env || process.env;
  const rec = findChat(id, env);
  if (!rec) return send(res, 404, { error: "not_found", message: `no chat ${id}` });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "keep-alive",
  });

  const rt = rtFor(id);
  // F-A — DO NOT replay beats the client already has on disk.
  //
  // The old code replayed the whole ring to every connector. The client had
  // just rendered the persisted transcript, so reopening a finished chat drew
  // every beat twice (an 11-line transcript rendered as 20 blocks).
  //
  // The client sends ?since=<streamCursor>, the watermark it was handed with
  // the transcript. Only events ABOVE it are replayed: those are exactly the
  // in-flight turn's beats (not yet on disk), plus any turn that completed in
  // the race between the GET and this connect. Below the watermark is on disk.
  //
  // No `since` (an old client, or a raw curl) keeps the legacy full replay —
  // the client-side evId dedupe is the second, independent guard.
  const since = streamSinceFromUrl(req);
  for (const evt of rt.ring) {
    if (since !== null && typeof evt.evId === "number" && evt.evId <= since) continue;
    sseWrite(res, evt);
  }
  rt.listeners.add(res);

  const hb = setInterval(() => { try { res.write(":hb\n\n"); } catch { /* gone */ } }, 15000);
  const close = () => { clearInterval(hb); rt.listeners.delete(res); };
  req.on("close", close);
  req.on("error", close);
}

// Test hook: reset in-memory runtime (never touches disk).
export function _resetRuntime() { CHAT_RT.clear(); inFlightCount = 0; }
// Test hook: the persisted-through watermark a GET would hand out.
export function _streamCursor(id) { const rt = CHAT_RT.get(id); return rt ? rt.persistedThrough : 0; }
// Test hook: the raw ring (F-A assertions about what a connector would see).
export function _ringFor(id) { const rt = CHAT_RT.get(id); return rt ? rt.ring.slice() : []; }
// Test hook: mark a turn persisted without running one.
export function _markPersisted(id) { markPersisted(id); }
// Test hook: push a synthetic event into a chat's ring/listeners.
export function _emitForTest(id, evt) { emit(id, evt); }
// Test hook: run one message (exposes startChatRun for fake-spawn e2e).
export function _startChatRun(opts, deps) { return startChatRun(opts, deps); }
