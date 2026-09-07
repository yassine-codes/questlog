// QUESTLOG — hooks shared library. Zero dependencies. Node >= 18.
//
// Shared helpers for the four questlog Claude Code hook scripts (precompact,
// sessionstart, stop, posttooluse-pulse). Semantics are copied from
// mcp/server.mjs (the same lock + atomic-write + history protocol, data-contract
// §4) so a hook writing to <cwd>\.questlog is indistinguishable from an MCP or
// UI write, EXCEPT every history event a hook writes carries source:"hook".
//
// UNIVERSAL FAILURE-OPEN RULE (data-contract, hooks §1): a hook must never break
// a session. Callers wrap main() so ANY thrown error exits 0. Here that means:
//   * readStdin() tolerates empty/garbage input (returns {}).
//   * dataDirExists() lets a hook exit 0 silently when cwd has no .questlog.
//   * acquireLock() throws E_LOCK_TIMEOUT on contention; the caller catches it,
//     skips the write, and exits 0 (never blocks, never exits 2).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { clearDirty } from "../currency.mjs";

export const nowIso = () => new Date().toISOString();
export const genId = (prefix) => `${prefix}-${crypto.randomBytes(4).toString("hex")}`;

// Read all of stdin and JSON-parse it. Never throws: an unreadable / non-JSON /
// empty payload yields {} so the caller's guards (missing cwd etc.) take over.
export function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => { raw += c; });
      process.stdin.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch { resolve({}); }
      });
      process.stdin.on("error", () => resolve({}));
      // If stdin is a TTY / already closed, `end` may never fire — guard it.
      if (process.stdin.isTTY) resolve({});
    } catch { resolve({}); }
  });
}

// Build the per-cwd context. Mirrors makeCtx in server.mjs plus the batons file.
export function makeCtx(cwd) {
  const dataDir = path.join(cwd, ".questlog");
  return {
    cwd,
    dataDir,
    lockDir: path.join(dataDir, ".lock"),
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

// A hook only acts when a real .questlog dir exists in the session's cwd.
export function dataDirExists(ctx) {
  try { return fs.existsSync(ctx.dataDir) && fs.statSync(ctx.dataDir).isDirectory(); }
  catch { return false; }
}

export function readJson(file, fallbackFn) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallbackFn(); }
}

export const emptyRoadmap = () => ({ schemaVersion: 1, project: {}, quests: [], milestones: [], items: [], assets: [] });
export const emptyDecisions = () => ({ schemaVersion: 1, decisions: [] });
export const emptyPins = () => ({ schemaVersion: 1, pins: [] });
export const emptySessions = () => ({ schemaVersion: 1, sessions: [] });
export const emptyBatons = () => ({ schemaVersion: 1, batons: [] });

// Lock: mkdir-based, 3s timeout / 5s stale-break (identical to server.mjs). On
// timeout it throws — the hook caller turns that into a silent exit 0.
export function acquireLock(ctx) {
  if (!fs.existsSync(ctx.dataDir)) fs.mkdirSync(ctx.dataDir, { recursive: true });
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(ctx.lockDir); return; }
    catch (err) {
      if (err.code !== "EEXIST") throw Object.assign(new Error("E_IO: " + err.message), { code: "E_IO" });
      let age = Infinity;
      try { age = Date.now() - fs.statSync(ctx.lockDir).mtimeMs; } catch { /* vanished */ }
      if (age > 5000) { try { fs.rmdirSync(ctx.lockDir); } catch { /* raced */ } continue; }
      if (Date.now() - start > 3000) throw Object.assign(new Error("E_LOCK_TIMEOUT"), { code: "E_LOCK_TIMEOUT" });
      const until = Date.now() + 50;
      while (Date.now() < until) { /* spin ~50ms */ }
    }
  }
}
export function releaseLock(ctx) { try { fs.rmdirSync(ctx.lockDir); } catch { /* already gone */ } }
export function withLock(ctx, fn) {
  acquireLock(ctx);
  try { return fn(); } finally { releaseLock(ctx); }
}

export function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export function appendHistory(ctx, evt) {
  fs.appendFileSync(ctx.files.history, JSON.stringify(evt) + "\n", "utf8");
}

// Every hook-written history event is source:"hook".
export function historyEvent({ actor = "agent", action, targetId = null, summary, patch, sessionId }) {
  const evt = { id: genId("evt"), ts: nowIso(), actor, source: "hook", action, targetId, summary };
  if (patch !== undefined) evt.patch = patch;
  if (sessionId) evt.sessionId = sessionId;
  return evt;
}

// upsertSession — same semantics as server.mjs/mcp: called INSIDE the lock,
// after appendHistory, adds delta to eventCount, never lowers a set label.
// Preserves any lastPulse/focus already on the row (continuity §2).
//
// C5 — this is one of the three CLEAR-ON-WRITE points for the dirty bit. A
// delta >= 1 means this session just wrote something to the road, which is
// exactly what the bit was asking for, so it is cleared. A clean row is left
// untouched (no key is added), so files that were never dirty stay as they were.
export function upsertSession(ctx, sessionId, label, delta) {
  if (typeof sessionId !== "string" || !sessionId) return null;
  const data = readJson(ctx.files.sessions, emptySessions);
  if (!data || typeof data !== "object") return null;
  if (!Array.isArray(data.sessions)) data.sessions = [];
  data.schemaVersion = 1;
  const ts = nowIso();
  let s = data.sessions.find((x) => x && x.id === sessionId);
  if (s) {
    s.lastSeenAt = ts;
    s.eventCount = (Number.isInteger(s.eventCount) ? s.eventCount : 0) + delta;
    if (typeof label === "string" && label.length > 0) s.label = label;
    if (delta >= 1) clearDirty(s);
  } else {
    s = { id: sessionId, firstSeenAt: ts, lastSeenAt: ts, label: (typeof label === "string" ? label : ""), eventCount: delta };
    data.sessions.push(s);
  }
  atomicWrite(ctx.files.sessions, data);
  return s;
}

// Run a hook body with the universal failure-open guard. Resolves the stdin
// payload, hands it to fn, and ALWAYS exits 0 — a thrown error, a lock timeout,
// a missing .questlog: every path is silent success from Claude Code's view.
export async function runHook(fn) {
  let input = {};
  try { input = await readStdin(); } catch { input = {}; }
  try { await fn(input || {}); }
  catch { /* failure-open: swallow everything */ }
  process.exit(0);
}
