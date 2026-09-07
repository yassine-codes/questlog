#!/usr/bin/env node
// QUESTLOG hook — Stop. Up to three gentle, non-blocking nudges, in this order:
//
//   1. HANDOFF. If this session did real work on the road (its sessions.json row
//      has eventCount>0) but has NOT banked a baton since its last activity,
//      remind it to hand off before stopping.
//   2. ORPHANED DECISIONS (C4). If any approved decision names no milestone and
//      claims no standing, say how many. Detection is mechanical; the fix is the
//      agent's judgement call, so this is a line of text, never a gate.
//   3. DIRTY BIT (C5). If this session touched a mutating tool and then wrote
//      nothing to the road, say so. HONESTY LIMIT: we cannot read a command's
//      intent — Bash counts as mutating even when it only read — so the copy
//      offers the ignore path outright.
//
// Writes nothing; exits 0 always (never blocks the Stop). A pure-research
// session (Read/Grep/Glob/WebFetch/…) is never flagged by #3, because none of
// those tools sets the bit in the first place.
//
// stdin: {session_id, cwd, stop_hook_active}
// stdout: at most three plain-text reminder lines.

import { runHook, makeCtx, dataDirExists, readJson, emptySessions, emptyBatons, emptyDecisions } from "./lib.mjs";
import { isOrphanDecision, isDirty, DIRTY_NUDGE, orphanNudge } from "../currency.mjs";

runHook(async (input) => {
  const cwd = input && input.cwd;
  const sessionId = input && input.session_id;
  if (!cwd || !sessionId) return;
  const ctx = makeCtx(cwd);
  if (!dataDirExists(ctx)) return;

  const sessions = readJson(ctx.files.sessions, emptySessions);
  const rows = Array.isArray(sessions.sessions) ? sessions.sessions : [];
  const row = rows.find((s) => s && s.id === sessionId);

  const out = [];

  // 1 — the baton check. Unchanged: it only speaks for a session that actually
  // wrote events here.
  if (row) {
    const eventCount = Number.isInteger(row.eventCount) ? row.eventCount : 0;
    if (eventCount > 0) {
      const batons = readJson(ctx.files.batons, emptyBatons);
      const batonList = Array.isArray(batons.batons) ? batons.batons : [];
      const lastSeen = String(row.lastSeenAt || "");
      const banked = batonList.some((b) => b && b.fromSessionId === sessionId && String(b.ts || "") >= lastSeen);
      if (!banked) out.push("questlog: unbanked work on this road — consider /questlog:handoff (baton_pass)");
    }
  }

  // 2 — C4, orphaned decisions. Road-wide, not session-scoped: an orphan is a
  // hole in the record whoever left it there.
  try {
    const dec = readJson(ctx.files.decisions, emptyDecisions);
    const orphans = (Array.isArray(dec.decisions) ? dec.decisions : []).filter(isOrphanDecision);
    if (orphans.length) out.push(orphanNudge(orphans.length));
  } catch { /* failure-open: a nudge is never worth breaking a Stop over */ }

  // 3 — C5, the dirty bit. Session-scoped, and cleared by any questlog write, so
  // reaching here means: this session changed something and told the road nothing.
  if (isDirty(row)) out.push(DIRTY_NUDGE);

  if (out.length) process.stdout.write(out.join("\n") + "\n");
});
