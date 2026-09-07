#!/usr/bin/env node
// QUESTLOG hook — PreCompact. Drops an automatic save-point pin on the road just
// before Claude Code compacts the transcript, so the compaction boundary is
// visible later and a synthesis doc can be attached to it.
//
// stdin: {session_id, cwd, hook_event_name:"PreCompact", trigger}
// stdout: none. Never blocks; failure-open (see lib.runHook).

import {
  runHook, makeCtx, dataDirExists, readJson, emptyPins, emptyRoadmap,
  withLock, atomicWrite, appendHistory, upsertSession, historyEvent, genId, nowIso,
} from "./lib.mjs";

runHook(async (input) => {
  const cwd = input && input.cwd;
  const sessionId = input && input.session_id;
  if (!cwd) return;
  const ctx = makeCtx(cwd);
  if (!dataDirExists(ctx)) return; // no .questlog here → silent exit 0
  const trigger = (input && typeof input.trigger === "string" && input.trigger) ? input.trigger : "auto";

  withLock(ctx, () => {
    const pins = readJson(ctx.files.pins, emptyPins);
    if (!pins || typeof pins !== "object") return;
    if (!Array.isArray(pins.pins)) pins.pins = [];
    pins.schemaVersion = 1;

    // afterMilestoneId default (same rule as pin_compaction): last non-locked
    // main-quest milestone, else null.
    const rm = readJson(ctx.files.roadmap, emptyRoadmap);
    const mainQuestId = (Array.isArray(rm.quests) ? rm.quests : []).find((q) => q && q.type === "main")?.id;
    const mainMs = (Array.isArray(rm.milestones) ? rm.milestones : [])
      .filter((m) => m && m.questId === mainQuestId)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    const nonLocked = mainMs.filter((m) => m.status !== "locked");
    const afterMilestoneId = nonLocked.length ? nonLocked[nonLocked.length - 1].id : null;

    const ts = nowIso();
    const pin = {
      id: genId("pin"),
      ts,
      kind: "save_point",
      label: "Save point (" + trigger + ")",
      afterMilestoneId,
      summary: "Auto save-point before compaction; synthesis pending.",
      synthesisDocPath: null,
      sessionId: (typeof sessionId === "string" && sessionId) ? sessionId : null,
      synthesisPending: true,
    };
    pins.pins.push(pin);
    atomicWrite(ctx.files.pins, pins);

    const evt = historyEvent({
      action: "hook_precompact", targetId: pin.id,
      summary: `Save point pinned before compaction (${trigger})`,
      sessionId,
    });
    appendHistory(ctx, evt);
    if (sessionId) upsertSession(ctx, sessionId, undefined, 1);
  });
});
