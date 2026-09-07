#!/usr/bin/env node
// Bridge self-tests — no model spawn. Exercises the containment logic:
// debounce coalescing, single-concurrency re-arm, kill-switch abort, env
// hygiene, and argv shape. Run: node bridge.selftest.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readBridgeConfig, cleanEnv, strippedEnvKeys, buildArgs, buildPrompt,
  createBridge, runBridgeOnce, DEFAULT_ALLOWED_TOOLS, bridgePaths,
} from "./bridge.mjs";

let passed = 0;
const ok = (name) => { console.log("  ok -", name); passed++; };

// ---- fake clock for deterministic debounce tests ----
function makeClock() {
  let seq = 1;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { const id = seq++; timers.set(id, { fn, at: ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    // fire all timers whose delay <= advance-so-far; here we just fire everything pending once.
    tick: () => { const fns = [...timers.values()].map((t) => t.fn); timers.clear(); fns.forEach((f) => f()); },
    pending: () => timers.size,
  };
}

// 1. cleanEnv strips nesting/session vars, keeps the rest.
{
  const env = { PATH: "/x", HOME: "/h", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_SESSION_ID: "s", AI_AGENT: "y", CODEX_COMPANION_TRANSCRIPT_PATH: "z", MY_VAR: "keep" };
  const out = cleanEnv(env);
  assert.deepStrictEqual(Object.keys(out).sort(), ["HOME", "MY_VAR", "PATH"]);
  assert.deepStrictEqual(strippedEnvKeys(env).sort(), ["AI_AGENT", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_SESSION_ID", "CODEX_COMPANION_TRANSCRIPT_PATH"]);
  ok("cleanEnv strips CLAUDE*/AI_AGENT/CODEX* and keeps PATH/HOME/others");
}

// 2. config defaults are OFF and DRY.
{
  const c = readBridgeConfig({});
  assert.strictEqual(c.enabled, false, "disabled by default");
  assert.strictEqual(c.dryRun, true, "dry-run by default");
  const on = readBridgeConfig({ QUESTLOG_BTW_BRIDGE: "1" });
  assert.strictEqual(on.enabled, true);
  assert.strictEqual(on.dryRun, true, "still dry even when enabled");
  const live = readBridgeConfig({ QUESTLOG_BTW_BRIDGE: "1", QUESTLOG_BTW_DRYRUN: "0" });
  assert.strictEqual(live.dryRun, false, "explicit 0 => live");
  ok("config: OFF by default, DRY by default, live needs both flags");
}

// 3. buildArgs shape — every containment flag present, allowedTools trailing.
{
  const args = buildArgs({ prompt: "P", model: "sonnet", maxTurns: 8, allowedTools: DEFAULT_ALLOWED_TOOLS, mcpConfigPath: "/tmp/m.json", targetRoot: "/proj", sessionId: "sid" });
  for (const flag of ["-p", "--model", "--output-format", "--max-turns", "--permission-mode", "--session-id", "--mcp-config", "--strict-mcp-config", "--add-dir", "--allowedTools"]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  assert.strictEqual(args[args.indexOf("--model") + 1], "sonnet");
  assert.strictEqual(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.ok(!args.includes("--dangerously-skip-permissions"), "no blanket bypass");
  // allowedTools must be the trailing variadic
  assert.strictEqual(args[args.length - DEFAULT_ALLOWED_TOOLS.length - 1], "--allowedTools");
  ok("buildArgs: all containment flags present, no bypass, allowedTools trailing");
}

// 4. prompt names the session label and pins the one card.
{
  const p = buildPrompt({ trigger: "note", itemId: "it-abc", noteText: "help", sessionId: "sid-1", title: "Card" });
  assert.ok(p.includes("sid-1") && p.includes('label "bridge"'), "session_hello label present");
  assert.ok(p.includes("it-abc") && p.includes("ONLY it-abc"), "scopes to the one card");
  ok("buildPrompt: bridge label + single-card scope");
}

// 5. debounce coalescing — 3 rapid triggers => ONE run.
{
  const clock = makeClock();
  let runs = 0;
  // Per-note auto-trigger is opt-in now (planner §5.1): enable + autoTrigger.
  const cfg = { ...readBridgeConfig({ QUESTLOG_BTW_BRIDGE: "1", QUESTLOG_BTW_AUTOTRIGGER: "1" }), debounceMs: 1000 };
  const b = createBridge(cfg, {
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    runBridgeOnce: async () => { runs++; return { status: "dryrun" }; },
  });
  const ctx = { dataDir: "/d", root: "/r" };
  b.trigger(ctx, { itemId: "it-1" });
  b.trigger(ctx, { itemId: "it-1" });
  b.trigger(ctx, { itemId: "it-1" });
  assert.strictEqual(clock.pending(), 1, "rapid triggers collapse to a single armed timer");
  clock.tick();
  await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(runs, 1, "coalesced into exactly one run");
  ok("debounce: 3 rapid triggers on one card -> 1 run");
}

// 6. disabled controller never schedules.
{
  const clock = makeClock();
  const cfg = readBridgeConfig({}); // disabled
  const b = createBridge(cfg, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, runBridgeOnce: async () => ({}) });
  const scheduled = b.trigger({ dataDir: "/d", root: "/r" }, { itemId: "it-1" });
  assert.strictEqual(scheduled, false);
  assert.strictEqual(clock.pending(), 0);
  ok("disabled: trigger() is inert (nothing scheduled)");
}

// 7. single concurrency — while one run is in flight, a second re-arms not parallelizes.
{
  const clock = makeClock();
  let active = 0, maxActive = 0, runs = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const cfg = { ...readBridgeConfig({ QUESTLOG_BTW_BRIDGE: "1", QUESTLOG_BTW_AUTOTRIGGER: "1" }), debounceMs: 1000 };
  const b = createBridge(cfg, {
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    runBridgeOnce: async () => { runs++; active++; maxActive = Math.max(maxActive, active); await gate; active--; return {}; },
  });
  const ctx = { dataDir: "/d", root: "/r" };
  b.trigger(ctx, { itemId: "it-A" });
  clock.tick(); await Promise.resolve(); // A starts, is awaiting gate (running=true)
  b.trigger(ctx, { itemId: "it-B" });
  clock.tick(); await Promise.resolve(); // B fires but sees running -> re-arms
  assert.strictEqual(maxActive, 1, "never two runs at once");
  release(); await Promise.resolve(); await Promise.resolve(); // A finishes
  clock.tick(); await Promise.resolve(); await Promise.resolve(); // B's re-armed timer runs
  assert.strictEqual(runs, 2, "B ran after A, not alongside");
  assert.strictEqual(maxActive, 1);
  ok("concurrency: max one in-flight run; second re-arms and runs after");
}

// 8. kill-switch aborts runBridgeOnce before any spawn (real fs, dry cfg, fake spawn that must NOT be called).
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-killtest-"));
  const ctx = { dataDir: path.join(tmp, ".questlog"), root: tmp };
  const bp = bridgePaths(ctx, {});
  fs.mkdirSync(bp.dir, { recursive: true });
  fs.writeFileSync(bp.kill, "stop", "utf8");
  let spawned = false;
  const cfg = { ...readBridgeConfig({ QUESTLOG_BTW_BRIDGE: "1", QUESTLOG_BTW_DRYRUN: "0" }), model: "sonnet", maxTurns: 8, allowedTools: DEFAULT_ALLOWED_TOOLS, claudeBin: "claude" };
  const res = await runBridgeOnce(cfg, ctx, { itemId: "it-k", trigger: "note", noteText: "x", chore: true }, {
    env: {}, spawn: () => { spawned = true; throw new Error("spawn must not run"); },
  });
  assert.strictEqual(res.status, "killed");
  assert.strictEqual(spawned, false, "kill-switch prevented the spawn");
  const log = fs.readFileSync(bp.log, "utf8");
  assert.ok(log.includes("bridge-aborted"), "abort logged for the founder");
  fs.rmSync(tmp, { recursive: true, force: true });
  ok("kill-switch: present KILL file aborts before spawn and logs it");
}

// 9. dry-run writes a bridge-dryrun log line + context package, spawns nothing.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-drytest-"));
  const ctx = { dataDir: path.join(tmp, ".questlog"), root: tmp };
  let spawned = false;
  const cfg = { ...readBridgeConfig({ QUESTLOG_BTW_BRIDGE: "1" }), model: "sonnet", maxTurns: 8, allowedTools: DEFAULT_ALLOWED_TOOLS, claudeBin: "claude" };
  const res = await runBridgeOnce(cfg, ctx, { itemId: "it-d", trigger: "note", noteText: "explain plainly", chore: true }, {
    env: {}, spawn: () => { spawned = true; throw new Error("dry-run must not spawn"); },
  });
  assert.strictEqual(res.status, "dryrun");
  assert.strictEqual(spawned, false);
  assert.ok(fs.existsSync(res.contextPackagePath), "context package written");
  const pkg = JSON.parse(fs.readFileSync(res.contextPackagePath, "utf8"));
  assert.ok(pkg.command.includes("--strict-mcp-config"), "command captured");
  const bp = bridgePaths(ctx, {});
  assert.ok(fs.readFileSync(bp.log, "utf8").includes("bridge-dryrun"));
  fs.rmSync(tmp, { recursive: true, force: true });
  ok("dry-run: logs bridge-dryrun + context package, spawns nothing");
}

console.log(`\n${passed} checks passed.`);
