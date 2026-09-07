#!/usr/bin/env node
// QUESTLOG hook — PostToolUse. Two jobs on one row of sessions.json:
//
//   THE PULSE. Records that this session is alive and what it is touching (a
//   heartbeat + focus line), throttled to at most once per 60s. A pulse is NOT
//   an event: it never appends history and never bumps eventCount — it only
//   refreshes lastPulse/focus so the roster can show "active" and what the agent
//   is doing right now.
//
//   THE DIRTY BIT (C5). A MUTATING tool use sets dirty/dirtyAt on the row. Any
//   questlog write clears it (hooks/lib.mjs upsertSession, mcp stampHistory,
//   server upsertSession); the Stop hook nudges if it is still set. It NEVER
//   blocks. Unlike the pulse, the bit is NOT throttled: a mutating tool that
//   fires 5s after a pulse must still be recorded, or the nudge would silently
//   depend on timing. It is written once and then costs nothing (an already-
//   dirty row is a no-op, so a long editing run does not rewrite the file).
//
//   Read-only work — Read, Grep, Glob, WebFetch, WebSearch, ToolSearch, and
//   questlog's own tools — never sets the bit, so a pure-research session is
//   never flagged. HONESTY LIMIT: Bash/PowerShell count as mutating even when
//   the command only reads; the Stop nudge's copy owns that.
//
// stdin: {session_id, cwd, tool_name, tool_input}
// stdout: none. Never blocks; failure-open.

import path from "node:path";
import { runHook, makeCtx, dataDirExists, readJson, emptySessions, withLock, atomicWrite, nowIso } from "./lib.mjs";
import { isMutatingTool, markDirty } from "../currency.mjs";

const THROTTLE_MS = 60 * 1000;

const pulsedRecently = (row) => {
  if (!row || typeof row.lastPulse !== "string") return false;
  const age = Date.now() - Date.parse(row.lastPulse);
  return Number.isFinite(age) && age >= 0 && age < THROTTLE_MS;
};

runHook(async (input) => {
  const cwd = input && input.cwd;
  const sessionId = input && input.session_id;
  if (!cwd || !sessionId) return;
  const ctx = makeCtx(cwd);
  if (!dataDirExists(ctx)) return;

  const toolName = (input && typeof input.tool_name === "string") ? input.tool_name : "";
  const mutating = isMutatingTool(toolName);

  // Lock-free pre-check: skip entirely when there is neither a pulse due nor a
  // bit to set. This is the common case on a busy read-only session.
  const before = readJson(ctx.files.sessions, emptySessions);
  const rowsBefore = Array.isArray(before.sessions) ? before.sessions : [];
  const rowBefore = rowsBefore.find((s) => s && s.id === sessionId);
  const dirtyDue = mutating && !(rowBefore && rowBefore.dirty === true);
  if (!dirtyDue && pulsedRecently(rowBefore)) return;

  // focus = tool_name (+ ": <basename>" when tool_input carries a file_path), ≤120 chars.
  let focus = toolName;
  const fp = input && input.tool_input && input.tool_input.file_path;
  if (typeof fp === "string" && fp.length) focus += ": " + path.basename(fp);
  if (focus.length > 120) focus = focus.slice(0, 120);

  withLock(ctx, () => {
    const data = readJson(ctx.files.sessions, emptySessions);
    if (!data || typeof data !== "object") return;
    if (!Array.isArray(data.sessions)) data.sessions = [];
    data.schemaVersion = 1;
    const ts = nowIso();
    let s = data.sessions.find((x) => x && x.id === sessionId);
    if (s) {
      let changed = false;
      // Re-check the PULSE throttle under lock (another pulse may have landed).
      // The dirty bit deliberately does not consult it.
      if (!pulsedRecently(s)) { s.lastPulse = ts; s.focus = focus; changed = true; }
      if (mutating && markDirty(s, ts)) changed = true;
      if (!changed) return; // nothing to say — leave the file byte-identical
    } else {
      // First contact via a pulse: create a bare row (eventCount 0 — a pulse is
      // not an event). session_hello / mutations fill in the rest later.
      s = { id: sessionId, firstSeenAt: ts, lastSeenAt: ts, label: "", eventCount: 0, lastPulse: ts, focus };
      if (mutating) markDirty(s, ts);
      data.sessions.push(s);
    }
    atomicWrite(ctx.files.sessions, data);
  });
});
