#!/usr/bin/env node
// Batch-dispatch UNIT self-tests (planner §3) — no model spawn, no server.
// Exercises the bridge.mjs exports the dispatch feature adds:
//   - readBridgeConfig autoTrigger (§5.1)
//   - buildBatchPrompt template (§3)
//   - runBatchOnce dry-run + turn/time budget formulas (§3.2)
//   - controller reserveBatch/cancelBatchReservation/runBatch + fire() re-arm (§3.3)
//   - trigger() enabled&&autoTrigger gate (§5.1)
// Run: node batch.selftest.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readBridgeConfig, buildBatchPrompt, runBatchOnce, createBridge, DEFAULT_ALLOWED_TOOLS, bridgePaths,
} from "./bridge.mjs";

let passed = 0;
const ok = (name) => { console.log("  ok -", name); passed++; };

// ---- 1. autoTrigger config (§5.1): default false; env "1"; config true ----
{
  assert.strictEqual(readBridgeConfig({}).autoTrigger, false, "default off");
  assert.strictEqual(readBridgeConfig({ QUESTLOG_BTW_AUTOTRIGGER: "1" }).autoTrigger, true, "env 1 => on");
  assert.strictEqual(readBridgeConfig({ QUESTLOG_BTW_AUTOTRIGGER: "0" }).autoTrigger, false, "env 0 => off");
  assert.strictEqual(readBridgeConfig({}, { bridge: { autoTrigger: true } }).autoTrigger, true, "config true => on");
  assert.strictEqual(readBridgeConfig({ QUESTLOG_BTW_AUTOTRIGGER: "0" }, { bridge: { autoTrigger: true } }).autoTrigger, false, "env wins over config");
  ok("readBridgeConfig: autoTrigger default off, env>config precedence");
}

// ---- 2. buildBatchPrompt template (§3) ----
{
  const worklist = {
    dispatchId: "disp-abc12345", ts: "2026-07-21T00:00:00.000Z", projectName: "Proj",
    entries: [
      { n: 1, targetType: "item", id: "it-1", title: "Ship login",
        questId: "q-main", questTitle: "Main Quest", milestoneId: "ms-1", milestoneTitle: "Auth",
        currentText: "wire OAuth", currentPlain: "", unclear: false, unclearAt: null,
        notes: [{ noteId: "note-1", body: "make this plainer please", ts: "2026-07-20T10:00:00.000Z" }] },
      { n: 2, targetType: "milestone", id: "ms-9", title: "Payments",
        questId: "q-main", questTitle: "Main Quest",
        currentText: "integrate PSP", currentPlain: "", unclear: true, unclearAt: "2026-07-20T11:00:00.000Z", notes: [] },
      { n: 3, targetType: "decision", id: "dec-7", title: "Use Postgres",
        currentText: "rationale\nimpact", currentPlain: "", unclear: true, unclearAt: "2026-07-20T12:00:00.000Z",
        notes: [], relatedMilestoneIds: ["ms-1"], relatedMilestoneTitles: ["Auth"] },
    ],
  };
  const p = buildBatchPrompt({ worklist, sessionId: "sid-xyz" });
  assert.ok(p.includes("WORKLIST (3 entries)"), "worklist header with N");
  assert.ok(p.includes('session_hello with sessionId "sid-xyz" and label "bridge"'), "hello + label");
  assert.ok(p.includes("roadmap_get once"), "roadmap_get step");
  assert.ok(p.includes("make this plainer please"), "founder note verbatim");
  assert.ok(p.includes("--- Entry 1 of 3: item it-1 ---"), "entry 1 header");
  assert.ok(p.includes("--- Entry 2 of 3: milestone ms-9 ---"), "entry 2 header");
  assert.ok(p.includes("--- Entry 3 of 3: decision dec-7 ---"), "entry 3 header");
  assert.ok(p.includes('Card: "Ship login", on milestone "Auth" (ms-1), quest "Main Quest"'), "item card line w/ milestone+quest");
  assert.ok(p.includes('Card: "Payments", quest "Main Quest"'), "milestone card line quest-only (no milestone clause)");
  assert.ok(p.includes("Related milestones: Auth"), "decision related milestones line");
  assert.ok(p.includes("Flagged unclear: yes (flagged 2026-07-20T11:00:00.000Z)"), "unclear yes w/ ts");
  assert.ok(p.includes("Flagged unclear: no"), "unclear no");
  assert.ok(p.includes("touch ONLY the cards listed above"), "containment rules line");
  ok("buildBatchPrompt: pinned template, verbatim notes, per-type card lines");
}

// ---- 3. runBatchOnce dry-run: writes worklist + ctx package + log, no spawn ----
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "batch-dry-"));
  const ctx = { dataDir: path.join(tmp, ".questlog"), root: tmp };
  const worklist = { dispatchId: "disp-dry00001", ts: "2026-07-21T00:00:00.000Z", projectName: "P",
    entries: [{ n: 1, targetType: "item", id: "it-1", title: "T", currentText: "x", currentPlain: "", unclear: false, unclearAt: null, notes: [] }] };
  const cfg = { ...readBridgeConfig({ QUESTLOG_BTW_BRIDGE: "1" }), model: "sonnet", claudeBin: "claude", allowedTools: DEFAULT_ALLOWED_TOOLS };
  let spawned = false;
  const res = await runBatchOnce(cfg, ctx, { worklist, dispatchId: "disp-dry00001", dryRun: true, chore: true }, {
    env: {}, spawn: () => { spawned = true; throw new Error("must not spawn in dry-run"); },
  });
  assert.strictEqual(spawned, false, "no spawn");
  assert.strictEqual(res.status, "dryrun");
  const bp = bridgePaths(ctx, {});
  const wlPath = path.join(bp.dir, "worklist-disp-dry00001.json");
  assert.ok(fs.existsSync(wlPath), "worklist-<id>.json written");
  const wl = JSON.parse(fs.readFileSync(wlPath, "utf8"));
  assert.strictEqual(wl.dispatchId, "disp-dry00001", "worklist file round-trips id");
  assert.ok(fs.existsSync(res.contextPackagePath), "ctx-batch package written");
  const log = fs.readFileSync(bp.log, "utf8");
  assert.ok(log.includes("bridge-dryrun-batch"), "dry-run log kind");
  ok("runBatchOnce: dry-run writes worklist+ctx+log, spawns nothing");
}

// ---- 4. turn/time budget formulas (§3.2) ----
{
  const mk = (N) => ({ dispatchId: "disp-fmt00001", ts: "2026-07-21T00:00:00.000Z", projectName: "P",
    entries: Array.from({ length: N }, (_, i) => ({ n: i + 1, targetType: "item", id: "it-" + i, title: "T", currentText: "", currentPlain: "", unclear: false, unclearAt: null, notes: [] })) });
  const readBudget = async (N, env) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "batch-fmt-"));
    const ctx = { dataDir: path.join(tmp, ".questlog"), root: tmp };
    const cfg = { ...readBridgeConfig({ QUESTLOG_BTW_BRIDGE: "1" }), model: "sonnet", claudeBin: "claude", allowedTools: DEFAULT_ALLOWED_TOOLS };
    const res = await runBatchOnce(cfg, ctx, { worklist: mk(N), dispatchId: "disp-fmt00001", dryRun: true, chore: true }, { env: env || {}, spawn: () => { throw new Error("no spawn"); } });
    return JSON.parse(fs.readFileSync(res.contextPackagePath, "utf8"));
  };
  let c = await readBudget(1);
  assert.strictEqual(c.maxTurns, 8, "N=1 maxTurns floor 8");
  assert.strictEqual(c.timeoutMs, 120000, "N=1 timeout base");
  c = await readBudget(3);
  assert.strictEqual(c.maxTurns, 16, "N=3 maxTurns = 4+4*3");
  assert.strictEqual(c.timeoutMs, 240000, "N=3 timeout = 120000+60000*2");
  c = await readBudget(20);
  assert.strictEqual(c.maxTurns, 60, "N=20 maxTurns capped 60");
  assert.strictEqual(c.timeoutMs, 900000, "N=20 timeout capped 900000");
  c = await readBudget(3, { QUESTLOG_BTW_MAX_TURNS: "99", QUESTLOG_BTW_TIMEOUT_MS: "5000" });
  assert.strictEqual(c.maxTurns, 99, "env max-turns absolute");
  assert.strictEqual(c.timeoutMs, 5000, "env timeout absolute");
  ok("runBatchOnce: turn/time budget formulas + env overrides");
}

// ---- 5. controller reserveBatch / runBatch / cancel (§3.3) ----
{
  const cfg = readBridgeConfig({ QUESTLOG_BTW_BRIDGE: "1" });
  let ranWith = null;
  const b = createBridge(() => cfg, { runBatchOnce: async (c, ctx, batch) => { ranWith = batch; return { status: "done", dispatchId: batch.dispatchId }; } });
  assert.strictEqual(b.reserveBatch(), true, "first reserve ok");
  assert.strictEqual(b.reserveBatch(), false, "second reserve busy");
  assert.strictEqual(b._state().batchReserved, true, "reserved flag set");
  let doneResult = null;
  const r = await b.runBatch({ dataDir: "/d", root: "/r" }, { worklist: { entries: [] }, dispatchId: "disp-run00001", onDone: (res) => { doneResult = res; } });
  assert.strictEqual(r.status, "done");
  assert.strictEqual(doneResult.status, "done", "onDone got the result");
  assert.strictEqual(ranWith.dispatchId, "disp-run00001", "runBatchOnce got the dispatch");
  assert.strictEqual(b._state().batchReserved, false, "reservation cleared after run");
  assert.strictEqual(b._state().running, false, "running cleared after run");
  assert.strictEqual(b.reserveBatch(), true, "can reserve again after settle");
  b.cancelBatchReservation();
  assert.strictEqual(b._state().batchReserved, false, "cancelBatchReservation clears");
  ok("controller: reserveBatch single-flight, runBatch calls onDone + clears, cancel works");
}

// ---- 6. trigger() gate: inert unless enabled && autoTrigger (§5.1) ----
{
  const mk = (env) => createBridge(() => readBridgeConfig(env), { runBridgeOnce: async () => ({}) });
  assert.strictEqual(mk({}).trigger({ dataDir: "/d", root: "/r" }, { itemId: "it-1" }), false, "disabled => inert");
  assert.strictEqual(mk({ QUESTLOG_BTW_BRIDGE: "1" }).trigger({ dataDir: "/d", root: "/r" }, { itemId: "it-1" }), false, "enabled but no autoTrigger => inert");
  assert.strictEqual(mk({ QUESTLOG_BTW_BRIDGE: "1", QUESTLOG_BTW_AUTOTRIGGER: "1" }).trigger({ dataDir: "/d", root: "/r" }, { itemId: "it-1" }), true, "enabled + autoTrigger => armed");
  ok("trigger(): inert unless enabled && autoTrigger");
}

// ---- 7. reserved batch makes an auto-trigger fire re-arm, not parallelize ----
{
  const cfg = { ...readBridgeConfig({ QUESTLOG_BTW_BRIDGE: "1", QUESTLOG_BTW_AUTOTRIGGER: "1" }), debounceMs: 1000 };
  let timers = [];
  const setTimeoutFake = (fn) => { const h = { fn }; timers.push(h); return h; };
  const clearTimeoutFake = (h) => { timers = timers.filter((t) => t !== h); };
  let perItemRuns = 0;
  const b = createBridge(() => cfg, {
    setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake,
    runBridgeOnce: async () => { perItemRuns++; return {}; },
  });
  assert.strictEqual(b.reserveBatch(), true, "batch reserved");
  b.trigger({ dataDir: "/d", root: "/r" }, { itemId: "it-1" }); // arms a timer
  const fire = timers[0].fn; timers = [];
  await fire(); // fires while batchReserved -> must re-arm, not run
  assert.strictEqual(perItemRuns, 0, "per-item run suppressed while batch reserved");
  assert.strictEqual(timers.length, 1, "re-armed a new timer");
  ok("fire(): re-arms while a batch is reserved (single concurrency)");
}

console.log(`\n${passed} checks passed.`);
