#!/usr/bin/env node
// QUESTLOG hook — SessionStart. Checks the session in (a session_hello-equivalent
// history event + sessions.json row) and injects a compact "state of the road"
// briefing into the new session's context so the agent resumes with situational
// awareness: what is blocked, what the founder flagged unclear, which decisions
// await approval, which save-points still need synthesis, the freshest baton,
// and — every time — the one line that points at the map (/questlog:open).
//
// In a project with NO .questlog it says one line and does nothing at all: the
// founder should never wonder whether the plugin is installed, and should never
// find a directory it created behind their back.
//
// stdin: {session_id, cwd, source}
// stdout: {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}
// Never blocks; failure-open (see lib.runHook).

import {
  runHook, makeCtx, dataDirExists, readJson, emptyRoadmap, emptyDecisions,
  emptyPins, emptyBatons, withLock, appendHistory, upsertSession, historyEvent,
} from "./lib.mjs";
import { isOrphanDecision } from "../currency.mjs";

const MAX_CONTEXT = 2000;

// The empty-project line (user-journey §2, approved wording). Silence would let
// the founder forget the plugin is installed; creating .questlog in every repo
// they open would be hostile. So: say it once, touch nothing.
const NO_ROAD = 'Questlog is here. No road in this project yet — say "start a road" when you want one.';

function buildRoadState(ctx) {
  const rm = readJson(ctx.files.roadmap, emptyRoadmap);
  const dec = readJson(ctx.files.decisions, emptyDecisions);
  const pins = readJson(ctx.files.pins, emptyPins);
  const batons = readJson(ctx.files.batons, emptyBatons);

  const milestones = Array.isArray(rm.milestones) ? rm.milestones : [];
  const items = Array.isArray(rm.items) ? rm.items : [];
  const decisions = Array.isArray(dec.decisions) ? dec.decisions : [];
  const pinList = Array.isArray(pins.pins) ? pins.pins : [];
  const batonList = Array.isArray(batons.batons) ? batons.batons : [];

  const lines = [];
  const projName = (rm.project && typeof rm.project.name === "string" && rm.project.name) ? rm.project.name : "this road";
  lines.push(`Questlog state for "${projName}":`);

  // Blocked milestones + items.
  const blockedMs = milestones.filter((m) => m && m.status === "blocked");
  const blockedIt = items.filter((it) => it && it.status === "blocked");
  if (blockedMs.length || blockedIt.length) {
    lines.push("BLOCKED:");
    for (const m of blockedMs) lines.push(`  - milestone "${m.title || m.id}": ${m.statusReason || "(no reason)"}`);
    for (const it of blockedIt) lines.push(`  - item "${it.title || it.id}": ${it.blockedReason || "(no reason)"}`);
  }

  // Unclear queue in drain order (oldest unclearAt first).
  const unclear = [];
  for (const m of milestones) if (m && m.unclear === true) unclear.push({ t: "milestone", id: m.id, title: m.title || m.id, at: m.unclearAt || "" });
  for (const it of items) if (it && it.unclear === true) unclear.push({ t: "item", id: it.id, title: it.title || it.id, at: it.unclearAt || "" });
  for (const d of decisions) if (d && d.unclear === true) unclear.push({ t: "decision", id: d.id, title: d.title || d.id, at: d.unclearAt || "" });
  unclear.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (unclear.length) {
    lines.push(`UNCLEAR QUEUE (${unclear.length}, oldest first — rewrite in plain language):`);
    for (const u of unclear) lines.push(`  - ${u.t} "${u.title}"`);
  }

  // Proposed decisions awaiting approval.
  const proposed = decisions.filter((d) => d && d.status === "proposed");
  if (proposed.length) {
    lines.push(`DECISIONS AWAITING APPROVAL (${proposed.length}):`);
    for (const d of proposed) lines.push(`  - "${d.title || d.id}"`);
  }

  // C4 — ORPHANED DECISIONS. An approved decision that names no milestone and
  // claims no standing is planned work that was never written down. Detection is
  // mechanical (three fields, no semantics); the FIX is instructed, never forced —
  // the agent decides whether this decision deserves a milestone or is policy.
  //
  // This section is why "clear road ahead" can be trusted: a road with orphans
  // now says so instead of reassuring the agent that nothing is missing.
  const orphans = decisions.filter(isOrphanDecision);
  if (orphans.length) {
    lines.push(`ORPHANED DECISIONS (${orphans.length} — link each to a milestone or mark it standing):`);
    for (const d of orphans) lines.push(`  - "${d.title || d.id}" (${d.id})`);
  }

  // Save-points / pins still needing synthesis.
  const pending = pinList.filter((p) => p && p.synthesisPending === true);
  if (pending.length) {
    lines.push(`SAVE POINTS NEEDING SYNTHESIS (${pending.length}):`);
    for (const p of pending) lines.push(`  - "${p.label || p.id}"`);
  }

  // Freshest baton (max ts).
  let freshest = null;
  for (const b of batonList) {
    if (!b || typeof b !== "object") continue;
    if (!freshest || String(b.ts || "") > String(freshest.ts || "")) freshest = b;
  }
  if (freshest) {
    lines.push(`LATEST BATON ("${freshest.label || freshest.id}", ${freshest.status || "open"}):`);
    const list = (arr, tag) => { if (Array.isArray(arr) && arr.length) lines.push(`  ${tag}: ${arr.join("; ")}`); };
    list(freshest.done, "done");
    list(freshest.next, "next");
    list(freshest.warnings, "warnings");
  }

  if (lines.length === 1) lines.push("(nothing blocked, unclear, orphaned, or pending — clear road ahead.)");
  let text = lines.join("\n");
  if (text.length > MAX_CONTEXT) text = text.slice(0, MAX_CONTEXT - 1) + "…";

  // Coverage line — appended AFTER truncation so it can never be the part that
  // gets cut. The briefing is a slice of the board; without this line a session
  // can mistake the slice for the whole road.
  const sug = readJson(ctx.dataDir + "/suggestions.json", () => ({ suggestions: [] }));
  const sugCount = Array.isArray(sug.suggestions) ? sug.suggestions.length : 0;
  text += `\nCOVERAGE: this briefing is a slice — the road holds ${milestones.length} milestones, ${decisions.length} decisions, and ${sugCount} horizon suggestions, and only the blocked/unclear/proposed/orphaned/save-point/baton subsets appear above. Before asserting anything is absent, check in with session_hello and read the full board (roadmap_get here; roadmap_list for the other roads).`;

  // The map, every session (founder ruling, user-journey §5) — not only when
  // something is wrong. Appended after truncation for the same reason the
  // coverage line is: the founder must never lose it to a long briefing.
  text += "\nMAP: offer the founder /questlog:open — it starts the local dashboard if it is not running and opens the Overworld in the browser. Suggest it every session.";
  return text;
}

runHook(async (input) => {
  const cwd = input && input.cwd;
  const sessionId = input && input.session_id;
  if (!cwd) return; // malformed input is not an empty project — stay silent

  // One envelope for every branch that speaks.
  const emit = (additionalContext) => process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
  }) + "\n");

  const ctx = makeCtx(cwd);
  // No road here: say the line and return BEFORE any lock. acquireLock() mkdirs
  // the data dir, and creating .questlog in a project that never asked for one
  // is precisely what this branch exists to avoid.
  if (!dataDirExists(ctx)) { emit(NO_ROAD); return; }

  // Check the session in (session_hello-equivalent), then read the state.
  const additionalContext = withLock(ctx, () => {
    if (sessionId) {
      const evt = historyEvent({ action: "session_hello", targetId: null, summary: "AI session checked in (hook)", patch: { label: "" }, sessionId });
      appendHistory(ctx, evt);
      upsertSession(ctx, sessionId, "", 1);
    }
    return buildRoadState(ctx);
  });

  emit(additionalContext);
});
