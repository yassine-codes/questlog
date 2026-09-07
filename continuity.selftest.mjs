#!/usr/bin/env node
// Hermetic self-test for questlog continuity + stability + raids + roster (B1).
// Part A drives the MCP server over stdio against a TEMP data dir: baton_pass /
// baton_read, milestone/item/quest delete, decision_set_approval `set`.
// Part B runs a REAL central-mode UI server on port 4230 with a temp registry /
// config / raids fixture and checks GET /api/raids, GET /api/sessions, and the
// spawn-gated POST /api/sessions/resume. Never touches :4177, the real registry,
// or the founder's home; spawn is never actually fired (allowSpawn stays false).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = __dirname;
const PORT = 4336;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ok - ${name}`); }
function bad(name, detail) { fail++; console.log(`  FAIL - ${name}\n        ${detail}`); }
function assert(cond, name, detail) { cond ? ok(name) : bad(name, detail || ""); }

const nowIso = () => new Date().toISOString();
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };

// ---- MCP stdio client -----------------------------------------------------
function mcpClient(dir, registry) {
  const child = spawn(process.execPath, [path.join(REPO, "mcp", "server.mjs"), "--dir", dir], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, QUESTLOG_REGISTRY: registry },
  });
  let buf = "";
  const pending = new Map();
  let idc = 0;
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++idc;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout " + method)); } }, 8000);
  });
  const tool = async (name, args) => {
    const r = await call("tools/call", { name, arguments: args || {} });
    const text = r.result && r.result.content && r.result.content[0] && r.result.content[0].text;
    if (r.result && r.result.isError) return { error: text };
    try { return { value: JSON.parse(text) }; } catch { return { value: text }; }
  };
  return { child, call, tool };
}

async function partA() {
  console.log("Part A — MCP continuity + stability tools (stdio):");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "questlog-cont-"));
  const registry = path.join(tmp, "registry.json");
  const dataDir = path.join(tmp, ".questlog");
  const c = mcpClient(tmp, registry);
  try {
    await c.call("initialize", {});
    await c.tool("session_hello", { sessionId: "sess-mcp-1" });

    const m = await c.tool("milestone_upsert", { questId: "q-main", title: "M1" });
    const msid = m.value.id;
    const it = await c.tool("item_upsert", { milestoneId: msid, kind: "task", title: "I1" });
    const itid = it.value.id;
    const as = await c.tool("asset_link", { milestoneId: msid, kind: "file", label: "L", ref: "r" });
    const asid = as.value.id;
    const q = await c.tool("quest_create", { title: "SideQ", parentMilestoneId: msid, milestones: [{ title: "SM1" }] });
    const qid = q.value.quest.id;
    const smid = q.value.milestones[0].id;
    const d = await c.tool("decision_log", { title: "D", rationale: "because" });
    const decid = d.value.id;

    // ---- batons ----
    const bp = await c.tool("baton_pass", { label: "B1", done: ["did a"], next: ["do b"], warnings: ["watch c"], sessionId: "sess-mcp-1" });
    assert(bp.value && /^baton-[0-9a-f]{8}$/.test(bp.value.id), "baton_pass returns baton-<8hex> id", bp.value && bp.value.id);
    assert(bp.value.status === "open" && bp.value.fromSessionId === "sess-mcp-1", "baton is open, fromSessionId stamped");
    assert(bp.value.toSessionId === null, "new baton toSessionId null");
    const br = await c.tool("baton_read", {});
    assert(br.value && br.value.id === bp.value.id, "baton_read returns freshest baton");
    const brPick = await c.tool("baton_read", { pickUp: true, sessionId: "sess-mcp-2" });
    assert(brPick.value && brPick.value.status === "picked_up" && brPick.value.toSessionId === "sess-mcp-2", "baton_read pickUp claims it");
    const batonsFile = readJson(path.join(dataDir, "batons.json"), { batons: [] });
    assert(batonsFile.batons.length === 1 && batonsFile.batons[0].status === "picked_up", "batons.json persisted picked_up");

    // ---- decision_set_approval `set` ----
    const a1 = await c.tool("decision_set_approval", { id: decid, set: "approved" });
    assert(a1.value && a1.value.approved === true && a1.value.status === "approved", "set:approved -> approved");
    const a2 = await c.tool("decision_set_approval", { id: decid, set: "proposed" });
    assert(a2.value && a2.value.approved === false && a2.value.status === "proposed" && a2.value.approvedAt === null, "set:proposed REVOKES to proposed");
    const a3 = await c.tool("decision_set_approval", { id: decid, approved: true });
    assert(a3.value && a3.value.status === "approved", "legacy approved:true still works");
    const a4 = await c.tool("decision_set_approval", { id: decid, approved: true, set: "rejected" });
    assert(a4.error && /exactly one/.test(a4.error), "both approved+set -> E_VALIDATION", a4.error);
    const a5 = await c.tool("decision_set_approval", { id: decid });
    assert(a5.error && /exactly one/.test(a5.error), "neither approved nor set -> E_VALIDATION", a5.error);

    // ---- delete tools ----
    const del1 = await c.tool("milestone_delete", { id: msid });
    assert(del1.error && /E_CONFLICT/.test(del1.error) && del1.error.includes(itid) && del1.error.includes(qid), "milestone_delete lists dependents (E_CONFLICT)", del1.error);
    const dq0 = await c.tool("quest_delete", { id: "q-main" });
    assert(dq0.error && /E_VALIDATION/.test(dq0.error), "quest_delete main quest -> E_VALIDATION", dq0.error);
    const dq1 = await c.tool("quest_delete", { id: qid });
    assert(dq1.error && /E_CONFLICT/.test(dq1.error) && dq1.error.includes(smid), "quest_delete with milestones -> E_CONFLICT", dq1.error);
    const dq2 = await c.tool("quest_delete", { id: qid, force: true });
    assert(dq2.value && dq2.value.deleted.id === qid && dq2.value.cascaded.some((r) => r.id === smid), "quest_delete force cascades its milestone");
    const di = await c.tool("item_delete", { id: itid });
    assert(di.value && di.value.deleted.id === itid, "item_delete removes the item");
    // now msid still has the asset as a dependent
    const del2 = await c.tool("milestone_delete", { id: msid });
    assert(del2.error && /E_CONFLICT/.test(del2.error) && del2.error.includes(asid), "milestone_delete still conflicts on remaining asset", del2.error);
    const del3 = await c.tool("milestone_delete", { id: msid, force: true });
    assert(del3.value && del3.value.deleted.id === msid && del3.value.cascaded.some((r) => r.id === asid), "milestone_delete force cascades asset");

    // roadmap now empty of those records + validates
    const rm = readJson(path.join(dataDir, "roadmap.json"), {});
    assert(!(rm.milestones || []).some((x) => x.id === msid || x.id === smid), "deleted milestones gone from roadmap");
    assert(!(rm.quests || []).some((x) => x.id === qid), "deleted quest gone from roadmap");
    assert(!(rm.items || []).some((x) => x.id === itid), "deleted item gone");
    assert(!(rm.assets || []).some((x) => x.id === asid), "deleted asset gone");
    const hist = fs.readFileSync(path.join(dataDir, "history.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    assert(hist.some((e) => e.action === "milestone_delete" && e.patch && e.patch.deleted), "history logs milestone_delete with deleted snapshot");
    assert(hist.some((e) => e.action === "baton_pass") && hist.some((e) => e.action === "baton_read"), "history logs baton_pass + baton_read");

    // baton_pass with no resolvable session id -> E_VALIDATION
    const c2 = mcpClient(tmp, registry);
    await c2.call("initialize", {});
    const noSess = await c2.tool("baton_pass", { label: "x", done: [], next: [] });
    assert(noSess.error && /session id/.test(noSess.error), "baton_pass without a session id -> E_VALIDATION", noSess.error);
    c2.child.kill();

    // final validation of the temp .questlog. pin_compaction was never called in
    // this flow, so seed an empty pins.json (validate.mjs requires the file to
    // exist); everything else was written by the tools under test.
    const pinsFile = path.join(dataDir, "pins.json");
    if (!fs.existsSync(pinsFile)) fs.writeFileSync(pinsFile, JSON.stringify({ schemaVersion: 1, pins: [] }, null, 2));
    const { validateDir } = await import(pathToFileURL(path.join(REPO, "schema", "validate.mjs")).href);
    const errs = validateDir(tmp);
    assert(errs.length === 0, "temp .questlog validates clean after all tool writes", errs.join("; "));
  } finally {
    c.child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- HTTP helpers ---------------------------------------------------------
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(BASE + p, { method, headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch { /* */ } resolve({ status: res.statusCode, json: j, raw: b }); });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
async function waitUp(ms = 8000) {
  const start = Date.now();
  for (;;) {
    try { const r = await req("GET", "/api/mode"); if (r.status === 200) return; } catch { /* */ }
    if (Date.now() - start > ms) throw new Error("server did not come up");
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function partB() {
  console.log("Part B — raids + roster HTTP surface (central mode, port 4230):");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "questlog-rr-"));
  const qlHome = path.join(tmp, ".questlog");
  fs.mkdirSync(qlHome, { recursive: true });
  const registry = path.join(qlHome, "registry.json");
  const configPath = path.join(qlHome, "config.json");

  // A registered road with a session ledger + batons.
  const road1 = path.join(tmp, "road1");
  const r1data = path.join(road1, ".questlog");
  fs.mkdirSync(r1data, { recursive: true });
  const ts = nowIso();
  const old = "2020-01-01T00:00:00.000Z";
  fs.writeFileSync(path.join(r1data, "roadmap.json"), JSON.stringify({
    schemaVersion: 1, project: { name: "Road One", tagline: "", createdAt: ts, updatedAt: ts },
    quests: [{ id: "q-main", type: "main", title: "Main", parentMilestoneId: null, side: null, order: 0, status: "in_progress", createdAt: ts, updatedAt: ts }],
    milestones: [], items: [], assets: [],
  }, null, 2));
  fs.writeFileSync(path.join(r1data, "sessions.json"), JSON.stringify({ schemaVersion: 1, sessions: [
    { id: "sess-active", firstSeenAt: old, lastSeenAt: ts, label: "live one", eventCount: 3, lastPulse: ts, focus: "Edit: server.mjs" },
    { id: "sess-completed", firstSeenAt: old, lastSeenAt: old, label: "banked one", eventCount: 5 },
    { id: "sess-superseded", firstSeenAt: old, lastSeenAt: old, label: "handed off", eventCount: 2 },
    { id: "sess-idle", firstSeenAt: old, lastSeenAt: old, label: "quiet one", eventCount: 1 },
  ] }, null, 2));
  fs.writeFileSync(path.join(r1data, "batons.json"), JSON.stringify({ schemaVersion: 1, batons: [
    { id: "baton-0000000c", ts: old, fromSessionId: "sess-completed", toSessionId: null, label: "open baton", done: [], inFlight: [], next: [], warnings: [], docPath: null, status: "open" },
    { id: "baton-0000000d", ts: old, fromSessionId: "sess-superseded", toSessionId: "sess-active", label: "claimed baton", done: [], inFlight: [], next: [], warnings: [], docPath: null, status: "picked_up" },
  ] }, null, 2));
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, roadmaps: [
    { id: "rm-road1", name: "Road One", dir: road1, addedAt: ts, lastSeenAt: ts },
  ] }, null, 2));

  // A raids fixture tree: <raidRoot>/proj/sess/subagents/workflows/wf_test/journal.jsonl
  const raidRoot = path.join(tmp, "raidsrc");
  const wfDir = path.join(raidRoot, "proj", "sess", "subagents", "workflows", "wf_test");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, "journal.jsonl"),
    JSON.stringify({ type: "started", key: "k1", agentId: "a1" }) + "\n" +
    JSON.stringify({ type: "started", key: "k2", agentId: "a2" }) + "\n" +
    JSON.stringify({ type: "result", key: "k1", agentId: "a1", result: "done" }) + "\n");
  const metaDir = path.join(raidRoot, "proj", "sess", "workflows");
  fs.mkdirSync(metaDir, { recursive: true });
  const script = "export const meta = {\n  name: 'test-raid',\n  description: 'a fixture raid',\n  phases: [\n    { title: 'Plan', model: 'opus' },\n    { title: 'Build', model: 'sonnet' },\n  ],\n}\n";
  fs.writeFileSync(path.join(metaDir, "wf_test.json"), JSON.stringify({ runId: "wf_test", timestamp: ts, taskId: "task-xyz", script }, null, 2));
  const raidGlob = path.join(raidRoot, "*", "*", "subagents", "workflows", "wf_*");
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, raids: { journalRoots: [raidGlob] } }, null, 2));

  const child = spawn(process.execPath, [path.join(REPO, "server.mjs"), "--port", String(PORT)], {
    cwd: REPO,
    env: { ...process.env, QUESTLOG_REGISTRY: registry, QUESTLOG_PORT: "", QUESTLOG_DIR: "", APPDATA: path.join(tmp, "AppData") },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = ""; child.stderr.on("data", (d) => (stderr += d.toString()));
  try {
    await waitUp();

    // config reports raids + roster with sources
    const cfg = await req("GET", "/api/config");
    assert(cfg.status === 200 && cfg.json.config.raids && cfg.json.config.roster, "config exposes raids + roster");
    assert(cfg.json.config.roster.allowSpawn === false, "roster.allowSpawn defaults false");
    assert(cfg.json.sources["raids.journalRoots"] === "config", "raids.journalRoots source=config");
    assert(cfg.json.sources["roster.allowSpawn"] === "default", "roster.allowSpawn source=default");

    // raids
    const raids = await req("GET", "/api/raids");
    assert(raids.status === 200 && Array.isArray(raids.json.raids), "GET /api/raids 200 + array");
    const wf = raids.json.raids.find((x) => x.id === "wf_test");
    assert(wf, "raids includes the fixture wf_test");
    assert(wf && wf.name === "test-raid", "raid name parsed from meta script", wf && wf.name);
    assert(wf && wf.description === "a fixture raid", "raid description parsed");
    assert(wf && wf.taskId === "task-xyz", "raid taskId from meta");
    assert(wf && wf.phasesTotal === 2 && wf.phases[0].title === "Plan" && wf.phases[0].model === "opus", "raid phases parsed (title+model)");
    assert(wf && wf.agentsStarted === 2 && wf.agentsDone === 1, "raid agent counts from journal", wf && `${wf.agentsStarted}/${wf.agentsDone}`);
    assert(wf && wf.status === "running", "fresh raid status=running", wf && wf.status);

    // roster
    const sess = await req("GET", "/api/sessions");
    assert(sess.status === 200 && Array.isArray(sess.json.projects), "GET /api/sessions 200 + projects");
    const proj = sess.json.projects.find((p) => p.roadmapId === "rm-road1");
    assert(proj && proj.name === "Road One", "roster project name resolved");
    const byId = Object.fromEntries((proj ? proj.sessions : []).map((s) => [s.id, s]));
    assert(byId["sess-active"] && byId["sess-active"].status === "active", "active session derived (recent lastSeen)", byId["sess-active"] && byId["sess-active"].status);
    assert(byId["sess-completed"] && byId["sess-completed"].status === "completed", "completed session derived (open baton)", byId["sess-completed"] && byId["sess-completed"].status);
    assert(byId["sess-superseded"] && byId["sess-superseded"].status === "superseded", "superseded session derived (picked_up baton)", byId["sess-superseded"] && byId["sess-superseded"].status);
    assert(byId["sess-idle"] && byId["sess-idle"].status === "idle", "idle session derived", byId["sess-idle"] && byId["sess-idle"].status);
    assert(byId["sess-active"] && byId["sess-active"].resumeCommand.includes("claude --resume sess-active"), "resumeCommand present");
    assert(byId["sess-completed"] && byId["sess-completed"].batonId === "baton-0000000c", "batonId links the session's baton");
    assert(byId["sess-active"] && byId["sess-active"].focus === "Edit: server.mjs", "roster surfaces focus/lastPulse");

    // resume is spawn-gated
    const r409 = await req("POST", "/api/sessions/resume", { roadmapId: "rm-road1", sessionId: "sess-active" });
    assert(r409.status === 409 && r409.json.error === "E_SPAWN_DISABLED", "resume 409 E_SPAWN_DISABLED when allowSpawn false", `${r409.status} ${r409.raw}`);
    const rBad = await req("POST", "/api/sessions/resume", { roadmapId: "rm-road1" });
    assert(rBad.status === 400, "resume rejects missing sessionId (400)");

    await req("POST", "/api/shutdown");
    await new Promise((r) => { child.on("exit", r); setTimeout(r, 4000); });
  } finally {
    try { child.kill(); } catch { /* */ }
    if (stderr && fail > 0) console.log("--- server stderr ---\n" + stderr);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  await partA();
  await partB();
  console.log(`\n${pass} checks passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
