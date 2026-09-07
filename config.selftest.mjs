#!/usr/bin/env node
// W2 self-test — config + version + shutdown surface on server.mjs, and the
// bridge config-read integration in bridge.mjs. Runs a REAL server on port 4191
// with a temp registry/config dir + temp APPDATA (autostart Startup file lands
// in the temp tree, never the real one). Never touches :4177 or any running
// process. Bridge is exercised in DRY-RUN only.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readBridgeConfig, createBridge } from "./bridge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = __dirname;
const PORT = 4335;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ok - ${name}`); }
function bad(name, detail) { fail++; console.log(`  FAIL - ${name}\n        ${detail}`); }
function assert(cond, name, detail) { cond ? ok(name) : bad(name, detail || ""); }
function eq(a, b, name) { assert(JSON.stringify(a) === JSON.stringify(b), name, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }

async function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(BASE + p, {
      method,
      headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {},
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* leave null */ }
        resolve({ status: res.statusCode, json, raw: buf });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitUp(ms = 8000) {
  const start = Date.now();
  for (;;) {
    try { const r = await req("GET", "/api/version"); if (r.status === 200) return; } catch { /* not up yet */ }
    if (Date.now() - start > ms) throw new Error("server did not come up");
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "questlog-w2-"));
  const homeDir = path.join(tmp, "home");           // stands in for ~/.questlog's parent
  const qlHome = path.join(homeDir, ".questlog");
  fs.mkdirSync(qlHome, { recursive: true });
  const registry = path.join(qlHome, "registry.json");
  const configPath = path.join(qlHome, "config.json");
  const appdata = path.join(tmp, "AppData", "Roaming");
  fs.mkdirSync(appdata, { recursive: true });
  const autostartFile = path.join(appdata, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "questlog-autostart.vbs");

  // ---- Part A: bridge.mjs config-read unit checks (no server needed) --------
  console.log("bridge.mjs config-read integration:");
  {
    // one-arg back-compat unchanged
    const c0 = readBridgeConfig({});
    eq([c0.enabled, c0.dryRun, c0.model], [false, true, "sonnet"], "one-arg defaults (off, dry, sonnet)");

    // file supplies enabled/dryRun/model when env is unset
    const fc = { schemaVersion: 1, bridge: { enabled: true, dryRun: false, model: "opus" } };
    const c1 = readBridgeConfig({}, fc);
    eq([c1.enabled, c1.dryRun, c1.model], [true, false, "opus"], "file config fills enabled/dryRun/model");

    // env WINS over file per key
    const c2 = readBridgeConfig({ QUESTLOG_BTW_BRIDGE: "0", QUESTLOG_BTW_DRYRUN: "1", QUESTLOG_BTW_MODEL: "haiku" }, fc);
    eq([c2.enabled, c2.dryRun, c2.model], [false, true, "haiku"], "env overrides file per key");

    // empty-string env is NOT set -> falls through to file
    const c3 = readBridgeConfig({ QUESTLOG_BTW_BRIDGE: "", QUESTLOG_BTW_MODEL: "" }, fc);
    eq([c3.enabled, c3.model], [true, "opus"], "empty-string env counts as unset -> file wins");

    // containment defaults untouched
    eq([c1.timeoutMs, c1.maxTurns, c1.claudeBin], [120000, 8, "claude"], "env-only containment knobs intact");
  }

  // ---- Part B: bridge toggles per-trigger via getCfg (dry-run only) ---------
  console.log("bridge per-trigger config re-read (dry-run):");
  {
    let liveCfg = { schemaVersion: 1, bridge: { enabled: false, dryRun: true, model: "sonnet" } };
    const getCfg = () => readBridgeConfig({}, liveCfg);
    const runs = [];
    // Fake clock so we control the debounce deterministically.
    let timers = [];
    const setTimeoutFake = (fn) => { const h = { fn }; timers.push(h); return h; };
    const clearTimeoutFake = (h) => { timers = timers.filter((t) => t !== h); };
    const flush = async () => { const cur = timers; timers = []; for (const t of cur) await t.fn(); };
    const bridge = createBridge(getCfg, {
      setTimeout: setTimeoutFake,
      clearTimeout: clearTimeoutFake,
      runBridgeOnce: async (cfg) => { runs.push({ enabled: cfg.enabled, dryRun: cfg.dryRun, model: cfg.model }); return { status: "dryrun" }; },
    });
    const ctx = { dataDir: path.join(tmp, "proj", ".questlog"), root: path.join(tmp, "proj") };

    // disabled -> trigger inert
    const t1 = bridge.trigger(ctx, { itemId: "i-1" });
    assert(t1 === false, "disabled config -> trigger() returns false (inert)");
    assert(timers.length === 0, "disabled -> nothing scheduled");

    // flip enabled in the (in-memory) config -> next trigger honors it, no restart.
    // Per-note auto-trigger is opt-in now (planner §5.1): enable + autoTrigger.
    liveCfg = { schemaVersion: 1, bridge: { enabled: true, dryRun: true, model: "haiku", autoTrigger: true } };
    const t2 = bridge.trigger(ctx, { itemId: "i-1" });
    assert(t2 === true, "after flip -> trigger() returns true (armed)");
    await flush();
    assert(runs.length === 1, "one dry-run pass fired after flip");
    eq([runs[0].enabled, runs[0].dryRun, runs[0].model], [true, true, "haiku"], "fire() used freshly-read config (enabled/dry/haiku)");
  }

  // ---- Part C: live server on 4191, config/version/shutdown round-trip ------
  console.log("server.mjs /api/config + /api/version + /api/shutdown (port 4191):");
  const child = spawn(process.execPath, [path.join(REPO, "server.mjs"), "--port", String(PORT)], {
    cwd: REPO,
    env: {
      ...process.env,
      QUESTLOG_REGISTRY: registry,   // config.json derived from this dir
      APPDATA: appdata,              // autostart lands in temp tree
      QUESTLOG_DIR: path.join(tmp, "proj"), // dir mode (avoids central registry noise)
      // ensure no bridge env leaks influence precedence checks
      QUESTLOG_BTW_BRIDGE: "", QUESTLOG_BTW_DRYRUN: "", QUESTLOG_BTW_MODEL: "",
      QUESTLOG_PORT: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));

  try {
    await waitUp();

    // version
    const v = await req("GET", "/api/version");
    assert(v.status === 200, "GET /api/version 200");
    assert(v.json.app === "questlog" && v.json.schemaVersion === 1, "version app/schemaVersion");
    assert(v.json.port === PORT && v.json.pid === child.pid, "version reports running port + pid");
    assert(v.json.packaged === false && v.json.buildId === "dev", "node-run: packaged=false, buildId=dev");
    assert(/^[0-9a-f]{64}$/.test(v.json.sourceHash), "sourceHash is 64 lowercase hex");
    assert(v.json.node === process.version, "version.node matches runtime");

    // sourceHash matches an independent SHA-256 of the sources in order
    // (chat.mjs added to computeSourceHash per Chat Dock contract §6)
    const { createHash } = await import("node:crypto");
    const h = createHash("sha256");
    for (const f of ["server.mjs", "bridge.mjs", "index.html", "chat.mjs"]) h.update(fs.readFileSync(path.join(REPO, f)));
    eq(v.json.sourceHash, h.digest("hex"), "sourceHash == SHA-256(server+bridge+index+chat)");

    // config: fresh install defaults
    const g0 = await req("GET", "/api/config");
    assert(g0.status === 200, "GET /api/config 200");
    // chat.profiles is compared separately below (it is a whole table).
    const cfg0 = JSON.parse(JSON.stringify(g0.json.config));
    const profiles0 = cfg0.chat.profiles; delete cfg0.chat.profiles;
    eq(cfg0, { port: PORT, autostart: false, bridge: { enabled: false, dryRun: true, model: "sonnet", autoTrigger: false }, raids: { enabled: true, journalRoots: [] }, roster: { allowSpawn: false }, archaeology: { repoPaths: [] }, skins: { active: "parchment" }, distillery: { live: false }, taskboard: { enabled: false, capacityWindow: { startHour: 0, endHour: 24, maxTokens: 0 } }, chat: { model: "sonnet", timeoutMs: 3600000, idleTimeoutMs: 300000 }, sidecar: { enabled: true, repair: "auto" } }, "defaults: bridge OFF + dryRun ON, autostart off, raids ON, spawn OFF, archaeology empty, skins parchment, distillery live off, taskboard off, chat model sonnet + 60min ceiling / 5min watchdog, sidecar on with repair=auto");
    // The two chat clocks and the sidecar switches carry a source stamp like
    // every other key, so the settings panel can be honest about where each
    // value came from (P2 / dec-sidecar-selfhealing).
    for (const k of ["chat.timeoutMs", "chat.idleTimeoutMs", "sidecar.enabled", "sidecar.repair"]) {
      eq(g0.json.sources[k], "default", `sources["${k}"] is stamped default on a fresh install`);
    }
    // ---- chat access profiles (dec-chat-access-tiers) ----------------------
    eq(Object.keys(profiles0).sort(), ["board-editor", "full-autonomy", "observer", "workspace-builder"], "four built-in access tiers ship");
    eq(profiles0.observer.permissionMode, null, "observer has no permission mode");
    eq(profiles0["board-editor"].permissionMode, null, "board-editor has no permission mode");
    eq(profiles0["workspace-builder"].permissionMode, "acceptEdits", "workspace-builder = acceptEdits");
    eq(profiles0["full-autonomy"].permissionMode, "bypassPermissions", "full-autonomy = bypassPermissions");
    eq(profiles0["full-autonomy"].allowedTools, null, "full-autonomy carries no allowlist");
    assert(profiles0["board-editor"].allowedTools.includes("mcp__questlog__brief_create"), "board-editor can write briefs");
    assert(!profiles0["board-editor"].allowedTools.some((t) => ["Read", "Edit", "Write"].includes(t)), "board-editor has NO file tools");
    eq(g0.json.sources["chat.profiles"], "default", "chat.profiles source=default before any edit");

    // Edit a profile: RESTRICTING is allowed and round-trips.
    const trimmed = ["mcp__questlog__roadmap_get", "mcp__questlog__list_unclear"];
    const pe1 = await req("POST", "/api/config", { chat: { profiles: { observer: { label: "Observer", allowedTools: trimmed, permissionMode: null } } } });
    assert(pe1.status === 200, "restricting a profile's tool list saves");
    eq(pe1.json.config.chat.profiles.observer.allowedTools, trimmed, "POST returns the trimmed tool list");
    eq(pe1.json.sources["chat.profiles"], "config", "chat.profiles source=config after an edit");
    eq((await req("GET", "/api/config")).json.config.chat.profiles.observer.allowedTools, trimmed, "GET round-trips the edited profile");

    // ESCALATION IS REJECTED at validation — a founder edit that adds a bypass
    // flag to observer must be refused, and nothing may be written.
    const beforeEsc = fs.readFileSync(configPath, "utf8");
    const esc1 = await req("POST", "/api/config", { chat: { profiles: { observer: { permissionMode: "bypassPermissions" } } } });
    assert(esc1.status === 400 && esc1.json.error === "E_VALIDATION", "observer + bypassPermissions REJECTED (400)");
    assert(/dec-chat-access-tiers/.test(esc1.json.message || ""), "the rejection cites the governing decision");
    const esc2 = await req("POST", "/api/config", { chat: { profiles: { "board-editor": { permissionMode: "acceptEdits" } } } });
    assert(esc2.status === 400, "board-editor + acceptEdits REJECTED (no ceiling for that name)");
    const esc3 = await req("POST", "/api/config", { chat: { profiles: { "workspace-builder": { permissionMode: "bypassPermissions" } } } });
    assert(esc3.status === 400, "workspace-builder widened to bypassPermissions REJECTED");
    const esc4 = await req("POST", "/api/config", { chat: { profiles: { "my-tier": { permissionMode: "acceptEdits" } } } });
    assert(esc4.status === 400, "a custom profile may carry no permission mode");
    const esc5 = await req("POST", "/api/config", { chat: { profiles: { observer: { permissionMode: "plan" } } } });
    assert(esc5.status === 400, "an unlisted permission mode is rejected too");
    assert(fs.readFileSync(configPath, "utf8") === beforeEsc, "no write occurred on any escalation attempt");

    // HARNESS-4 layer (a): a board-level profile may not carry file/command
    // tools. Layer (b) re-denies them at spawn time — this is the file gate.
    const beforeDeny = fs.readFileSync(configPath, "utf8");
    for (const [name, tool] of [["observer", "Read"], ["board-editor", "Read"], ["board-editor", "Bash"], ["observer", "Grep"], ["board-editor", "Task"]]) {
      const r = await req("POST", "/api/config", { chat: { profiles: { [name]: { allowedTools: ["mcp__questlog__roadmap_get", tool] } } } });
      assert(r.status === 400 && r.json.error === "E_VALIDATION", name + ".allowedTools + " + tool + " REJECTED (400)");
      assert(/board-level profiles cannot carry file\/command tools/.test(r.json.message || ""),
        "the " + name + "/" + tool + " rejection names the board-level rule (got: " + r.json.message + ")");
    }
    assert(fs.readFileSync(configPath, "utf8") === beforeDeny, "no write occurred on any board-level file-tool attempt");
    // A board-level profile may still be trimmed to questlog tools only.
    const okBoard = await req("POST", "/api/config", { chat: { profiles: { "board-editor": { allowedTools: ["mcp__questlog__roadmap_get", "mcp__questlog__roadmap_list"] } } } });
    assert(okBoard.status === 200, "a board-level profile trimmed to questlog tools still saves");
    // Skill / ToolSearch are NOT on the deny list, so a founder may add them.
    const okSkill = await req("POST", "/api/config", { chat: { profiles: { observer: { allowedTools: ["mcp__questlog__roadmap_get", "Skill", "ToolSearch"] } } } });
    assert(okSkill.status === 200, "Skill/ToolSearch stay allowed for board-level profiles (the board preamble needs Skill)");
    // workspace-builder keeps file tools by definition — not a board-level tier.
    const okWb = await req("POST", "/api/config", { chat: { profiles: { "workspace-builder": { allowedTools: ["Read", "Edit", "Write"] } } } });
    assert(okWb.status === 200, "workspace-builder may still carry Read/Edit/Write (untouched by definition)");
    await req("POST", "/api/config", { chat: { profiles: { observer: null, "board-editor": null, "workspace-builder": null } } });
    // The authorised modes ARE accepted at their own tier.
    const okEsc = await req("POST", "/api/config", { chat: { profiles: { "workspace-builder": { permissionMode: "acceptEdits", allowedTools: ["Read"] } } } });
    assert(okEsc.status === 200, "workspace-builder + acceptEdits accepted (its authorised ceiling)");
    eq(okEsc.json.config.chat.profiles["workspace-builder"].allowedTools, ["Read"], "the edited workspace-builder list round-trips");

    // Reset: null restores the built-in default.
    const rst = await req("POST", "/api/config", { chat: { profiles: { observer: null, "workspace-builder": null } } });
    assert(rst.status === 200, "profiles reset accepted");
    eq(rst.json.config.chat.profiles.observer.allowedTools,
      ["mcp__questlog__roadmap_get", "mcp__questlog__list_unclear", "mcp__questlog__baton_peek",
        "mcp__questlog__roadmap_list", "mcp__questlog__history_tail"], "observer restored to its built-in default");
    eq(rst.json.config.chat.profiles["workspace-builder"].permissionMode, "acceptEdits", "workspace-builder restored to its built-in default");
    eq(rst.json.sources["chat.profiles"], "default", "chat.profiles source back to default after a full reset");

    eq(g0.json.sources["bridge.enabled"], "default", "source enabled=default when no env/file");
    eq(g0.json.sources.port, "cli", "port source=cli (started with --port)");
    eq(g0.json.needsRestart, ["port"], "needsRestart=[port]");
    assert(g0.json.path === configPath, "config path is <regdir>/config.json");
    assert(g0.json.autostartActual === false, "autostart file absent initially");

    // POST a partial merge: enable bridge, keep dry, model=opus, autostart on
    const p1 = await req("POST", "/api/config", { bridge: { enabled: true, model: "opus" }, autostart: true });
    assert(p1.status === 200 && p1.json.ok === true, "POST /api/config ok");
    eq(p1.json.config.bridge, { enabled: true, dryRun: true, model: "opus", autoTrigger: false }, "POST returns merged bridge (enabled+opus, dry kept)");
    eq(p1.json.config.autostart, true, "POST returns autostart true");
    eq(p1.json.sources["bridge.enabled"], "config", "source enabled=config after save");
    assert(p1.json.autostartActual === true, "autostart Startup file created");
    assert(fs.existsSync(autostartFile), "autostart .vbs exists on disk in temp tree");
    const vbs = fs.readFileSync(autostartFile, "utf8");
    assert(vbs.includes("launch.mjs") && vbs.includes("--silent"), "vbs references launch.mjs --silent");
    // The launcher is Node now, not PowerShell: autostartVbsContent() runs
    // <node> <appRoot>\\desktop\\launch.mjs --silent. desktop/launch.mjs exists and the
    // server runs from the real repo __dirname, so the target resolves and no
    // warning is emitted.
    assert(p1.json.warning == null, "no autostart warning: desktop\\launch.mjs present");

    // GET reflects the write (round-trip)
    const g1 = await req("GET", "/api/config");
    eq(g1.json.config.bridge, { enabled: true, dryRun: true, model: "opus", autoTrigger: false }, "GET round-trips saved bridge");
    eq(g1.json.config.autostart, true, "GET round-trips autostart");

    // file on disk preserved unknown keys? write a hand-edited unknown key, then POST
    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
    onDisk.someFutureKey = { keep: "me" };
    onDisk.bridge.futureBridgeKey = 42;
    fs.writeFileSync(configPath, JSON.stringify(onDisk, null, 2));
    const p2 = await req("POST", "/api/config", { bridge: { dryRun: false } });
    assert(p2.status === 200, "POST partial (dryRun=false) ok");
    const after = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert(after.someFutureKey && after.someFutureKey.keep === "me", "unknown top-level file key preserved on write");
    assert(after.bridge.futureBridgeKey === 42, "unknown bridge file key preserved on write");
    eq(p2.json.config.bridge.dryRun, false, "dryRun flipped to false (live mode) in effective config");

    // validation failures -> 400, nothing written
    const before = fs.readFileSync(configPath, "utf8");
    const bad1 = await req("POST", "/api/config", { port: 80 });
    assert(bad1.status === 400 && bad1.json.error === "E_VALIDATION", "port 80 rejected (below 1024)");
    const bad2 = await req("POST", "/api/config", { bridge: { model: "GPT 4!" } });
    assert(bad2.status === 400, "model with spaces/caps/bang rejected");
    const bad3 = await req("POST", "/api/config", { autostart: "yes" });
    assert(bad3.status === 400, "non-boolean autostart rejected");
    const bad4 = await req("POST", "/api/config", { bogusKey: 1 });
    assert(bad4.status === 400, "unknown top-level key rejected");
    const bad5 = await req("POST", "/api/config", { bridge: { bogus: 1 } });
    assert(bad5.status === 400, "unknown bridge key rejected");
    assert(fs.readFileSync(configPath, "utf8") === before, "no write occurred on any validation failure");

    // autostart toggle OFF deletes the Startup file
    const p3 = await req("POST", "/api/config", { autostart: false });
    assert(p3.status === 200 && p3.json.autostartActual === false, "autostart off -> file removed");
    assert(!fs.existsSync(autostartFile), "autostart .vbs deleted from disk");

    // env precedence: a running server with QUESTLOG_BTW_BRIDGE set would grey the field.
    // (covered structurally by Part A; here we assert the source machinery reports config)
    eq((await req("GET", "/api/config")).json.sources["bridge.dryRun"], "config", "dryRun source=config after saves");

    // ---- P2 / F8b: the new keys must SURVIVE the read-modify-write ---------
    // Regression: handleConfigPost merges key-by-key, so a new config key that
    // is validated and source-stamped but NOT added to the merge is silently
    // dropped — the panel appears to save and then reverts on the next read.
    // (That is exactly what happened on the first live boot of this batch.)
    {
      const save = await req("POST", "/api/config", {
        chat: { idleTimeoutMs: 600000, timeoutMs: 5400000 },
        sidecar: { repair: "dry", enabled: false },
      });
      assert(save.status === 200, "POST the two chat clocks + sidecar switches -> 200");
      eq(save.json.config.chat.timeoutMs, 5400000, "chat.timeoutMs survives the merge");
      eq(save.json.config.chat.idleTimeoutMs, 600000, "chat.idleTimeoutMs survives the merge");
      eq(save.json.config.sidecar, { enabled: false, repair: "dry" }, "sidecar.enabled + repair survive the merge");
      // ...and are still there on a FRESH read from disk.
      const back = await req("GET", "/api/config");
      eq(back.json.config.chat.timeoutMs, 5400000, "chat.timeoutMs is still there on a fresh read");
      eq(back.json.config.chat.idleTimeoutMs, 600000, "chat.idleTimeoutMs is still there on a fresh read");
      eq(back.json.config.sidecar.repair, "dry", "sidecar.repair is still there on a fresh read");
      for (const k of ["chat.timeoutMs", "chat.idleTimeoutMs", "sidecar.enabled", "sidecar.repair"]) {
        eq(back.json.sources[k], "config", `sources["${k}"] flips to config after the save`);
      }
      // The saved profile overrides from earlier in this run are untouched.
      assert(back.json.config.chat.profiles && typeof back.json.config.chat.profiles === "object",
        "the chat.profiles table is unharmed by the new chat keys");
      // Validation still bites on the way in.
      eq((await req("POST", "/api/config", { chat: { timeoutMs: 1 } })).status, 400, "an absurdly small ceiling is rejected");
      eq((await req("POST", "/api/config", { chat: { idleTimeoutMs: "5m" } })).status, 400, "a non-numeric watchdog is rejected");
      eq((await req("POST", "/api/config", { sidecar: { repair: "yolo" } })).status, 400, "an unknown repair mode is rejected");
      eq((await req("POST", "/api/config", { sidecar: { nope: 1 } })).status, 400, "an unknown sidecar key is rejected");
      // Put the sidecar read back on for anything downstream.
      await req("POST", "/api/config", { sidecar: { enabled: true, repair: "auto" } });
    }

    // shutdown: graceful, frees the port
    const sd = await req("POST", "/api/shutdown");
    assert(sd.status === 200 && sd.json.ok === true, "POST /api/shutdown -> {ok:true}");
    // wait for exit
    await new Promise((resolve) => { child.on("exit", resolve); setTimeout(resolve, 4000); });
    let refused = false;
    try { await req("GET", "/api/version"); } catch { refused = true; }
    assert(refused, "port freed after shutdown (connection refused)");
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    if (stderr && fail > 0) console.log("--- server stderr ---\n" + stderr);
  }

  console.log(`\n${pass} checks passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
