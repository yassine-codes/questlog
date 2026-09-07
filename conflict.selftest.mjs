#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A COLLIDING WRITE IS HELD — never applied, never dropped, always ruled on.
//
// The founder's ruling of 2026-08-27 is a promise with three halves, and each
// half can fail on its own, so each is tested on its own:
//
//   NOT APPLIED   — the second write changes nothing. Proved by reading the
//                   record off disk afterwards and finding the FIRST write.
//   NOT DISCARDED — the second write survives in full. Proved by reading it
//                   back out of conflicts.json and, in C6, applying it.
//   RULED         — the founder decides, and both routes to a ruling (the board
//                   and the tools) land on the same file with the same effect.
//
// The one real design decision is the DETECTION, and it is the thing most
// likely to rot: "this writer based its change on a version that is no longer
// current" is a different claim from "two writes happened", and only the first
// one is worth holding a change over. C1 pins the version against a hash this
// file computes for itself, C3 shows two live agents colliding, and C4 proves
// the back-compat escape (a writer with NO basis is not stale, it is blind).
//
//   C1  the version      — served, and equal to an independent recomputation
//   C2  the board holds  — 200 then 409, first write standing on disk
//   C3  two agents       — one persistent MCP process each, second one held
//   C4  a blind write    — no basis, no hold (documented back-compat)
//   C5  explicit basis   — baseVersion beats what the process remembers, both ways
//   C6  the ruling       — keep:"held" via the tool, keep:"current" via the board,
//                          and (in C9b) a held glossary TERM ruled from the board
//   C7  delete           — a deleted record's holds are voided, road stays valid
//   C8  the escape hatch — a whole-file overwrite REFUSES stale, it never holds
//   C9  appends          — exempt, and stay exempt even with a stale basis
//   C9b the other guards — every remaining guarded writer, one collision each
//   C10 the validator    — clean at the end, and loud on a corrupted file
//   C11 the surface      — the board's own half, counted in the source
//
// TEMP EVERYTHING: temp HOME (QUESTLOG_REGISTRY), a fresh temp copy of
// seeds/sample-project per case, random high ports. The founder's :4177 and the
// repo's own .questlog are never touched — and C11 proves the latter by mtime.
//
// Usage: node conflict.selftest.mjs [--verbose]
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes("--verbose");
// NEVER 4177 — that port belongs to the founder's live server and this test does
// not so much as knock on it.
const randomPort = () => 45000 + Math.floor(Math.random() * 4000);

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail){
  if(cond){ pass++; if(VERBOSE) console.log("  ok   " + name); }
  else { fail++; failures.push(name + (detail ? " — " + detail : "")); console.log("  FAIL " + name + (detail ? " — " + detail : "")); }
}
const readSrc = (rel) => fs.readFileSync(path.join(HERE, rel), "utf8");

// The version, computed HERE and not imported: if conflicts.mjs ever gets
// clever about key order or field stripping, this line stops agreeing with it
// and C1 says so. That is the whole point of writing it out twice.
const versionOf = (rec) => crypto.createHash("sha1").update(JSON.stringify(rec)).digest("hex").slice(0, 12);

// ---------------------------------------------------------------------------
// temp workspace — one road per case, each a fresh copy, so no case can inherit
// another's damage.
// ---------------------------------------------------------------------------
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "ql-cf-"));
const HOME = path.join(WORK, "home");
const REGISTRY = path.join(HOME, "registry.json");
fs.mkdirSync(HOME, { recursive: true });
const ENV = Object.assign({}, process.env, {
  QUESTLOG_REGISTRY: REGISTRY,       // the founder's overworld is never written
  QUESTLOG_ALLOW_TEMP: "1",          // the temp-path guard's documented escape hatch
});
delete ENV.QUESTLOG_DIR;             // the mode comes from argv, never the env
delete ENV.QUESTLOG_BTW_BRIDGE;      // a held write must not wake the bridge here

function copyDir(src, dst){
  fs.mkdirSync(dst, { recursive: true });
  for(const e of fs.readdirSync(src, { withFileTypes: true })){
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if(e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}
const qfile = (road, name) => path.join(road, ".questlog", name);
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const exists = (f) => fs.existsSync(f);
const historyLines = (road) => {
  try { return fs.readFileSync(qfile(road, "history.jsonl"), "utf8").split("\n").filter(l => l.trim()); }
  catch { return []; }
};
const lastEvent = (road) => { const l = historyLines(road); return l.length ? JSON.parse(l[l.length - 1]) : null; };
const countAction = (road, action) => historyLines(road)
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(e => e && e.action === action).length;
const msOf = (road, id) => readJson(qfile(road, "roadmap.json")).milestones.find(m => m.id === id);
const itemOf = (road, id) => readJson(qfile(road, "roadmap.json")).items.find(i => i.id === id);
const holds = (road) => (exists(qfile(road, "conflicts.json")) ? readJson(qfile(road, "conflicts.json")).conflicts : []);
// The first hold on a road, or an empty stand-in. A case that expected a hold
// and found none must FAIL its own assertion, not crash the run before the rest
// of the file gets to speak — a mutation test is worthless if one break stops
// the tape.
const hold0 = (road) => holds(road)[0] || {};

function freshRoad(name){
  const road = path.join(WORK, name);
  copyDir(path.join(HERE, "seeds", "sample-project"), road);
  return road;
}

// ---------------------------------------------------------------------------
// MCP driver — ONE PERSISTENT PROCESS per agent, which is the whole point here.
// features.selftest's mcpCall spawns a server per call; that would wipe the
// per-process memory of what each agent last read, and this feature's back-compat
// escape hatch is exactly "a process that never read is not stale". So: one
// child, initialize once, tools/call by incrementing id, resolved by id.
// ---------------------------------------------------------------------------
const AGENTS = [];
function mcpAgent(dir){
  const p = spawn(process.execPath, [path.join(HERE, "mcp", "server.mjs"), "--dir", dir],
                  { env: ENV, stdio: ["pipe", "pipe", "pipe"] });
  AGENTS.push(p);
  const pending = new Map();
  let buf = "";
  p.stdout.on("data", (b) => {
    buf += b.toString();
    for(;;){
      const i = buf.indexOf("\n");
      if(i < 0) break;
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if(!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const resolve = pending.get(m.id);
      if(resolve){ pending.delete(m.id); resolve(m); }
    }
  });
  let seq = 0;
  const send = (method, params) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const ready = send("initialize", {});
  return {
    async call(name, args){
      await ready;
      const m = await send("tools/call", { name, arguments: args || {} });
      const r = (m && m.result) || {};
      const text = (r.content && r.content[0] && r.content[0].text) || "";
      if(r.isError) return { error: text };
      let value = null; try { value = JSON.parse(text); } catch { value = text; }
      return { value };
    },
    async list(){ await ready; const m = await send("tools/list", {}); return (m.result && m.result.tools) || []; },
    stop(){ try { p.stdin.end(); } catch { /* already closed */ } try { p.kill(); } catch { /* already gone */ } },
  };
}
function stopAgents(){
  for(const p of AGENTS){ if(p && !p.killed){ try { p.stdin.end(); } catch { /* closed */ } try { p.kill(); } catch { /* gone */ } } }
  AGENTS.length = 0;
}

// ---------------------------------------------------------------------------
// HTTP servers — spawned here, killed here, nothing else on the box is touched.
// ---------------------------------------------------------------------------
const SERVERS = [];
function spawnServer(args, port){
  return new Promise((resolve) => {
    const env = Object.assign({}, ENV, { QUESTLOG_PORT: String(port) });
    const p = spawn(process.execPath, [path.join(HERE, "server.mjs"), ...args], { env, cwd: WORK, stdio: ["ignore", "pipe", "pipe"] });
    SERVERS.push(p);
    let buf = "";
    const onData = (b) => { buf += b.toString(); if(/listening|http:\/\/127\.0\.0\.1/i.test(buf)) resolve(p); };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("error", () => resolve(p));
    setTimeout(() => resolve(p), 2500);
  });
}
async function alive(port){
  try { const r = await fetch("http://127.0.0.1:" + port + "/api/mode"); await r.text(); return r.status === 200; }
  catch { return false; }
}
async function startRoad(road){
  for(let attempt = 0; attempt < 2; attempt++){
    const port = randomPort();
    const p = await spawnServer(["--dir", road, "--port", String(port)], port);
    if(await alive(port)) return port;
    try { p.kill(); } catch { /* already gone */ }
  }
  return 0;
}
function stopServers(){
  for(const p of SERVERS){ if(p && !p.killed){ try { p.kill(); } catch { /* already gone */ } } }
  SERVERS.length = 0;
}
async function getState(port){
  const r = await fetch("http://127.0.0.1:" + port + "/api/state", { cache: "no-store" });
  return r.json();
}
// The version map, defensively. A state reply that lost its versions key must
// FAIL the assertion that asks for it, not crash the run before the rest of the
// file gets to speak — a mutation test is worthless if one break stops the tape.
const vers = (st) => (st && st.versions && typeof st.versions === "object") ? st.versions : {};
// Every POST here returns status AND body, because the 409 body is the
// interesting one in most of these cases.
async function post(port, route, body){
  const r = await fetch("http://127.0.0.1:" + port + route, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, json, text };
}

// The founder's own road: read its mtime now, check it at the end.
const LIVE_ROADMAP = path.join(HERE, ".questlog", "roadmap.json");
const liveMtimeBefore = (() => { try { return fs.statSync(LIVE_ROADMAP).mtimeMs; } catch { return null; } })();
const LIVE_CONFLICTS = path.join(HERE, ".questlog", "conflicts.json");
const liveConflictsBefore = fs.existsSync(LIVE_CONFLICTS);

// ===========================================================================
async function main(){

// ---------------------------------------------------------------------------
// C1 — the version is served, and it is the hash of the record as parsed
// ---------------------------------------------------------------------------
console.log("\n== C1: the version map ==");
const road1 = freshRoad("road-c1");
const port1 = await startRoad(road1);
ok("the server came up on road C1", port1 > 0);
if(port1 > 0){
  const st = await getState(port1);
  ok("/api/state serves a versions map", st.versions && typeof st.versions === "object");
  ok("/api/state serves a conflicts document", st.conflicts && Array.isArray(st.conflicts.conflicts));
  ok("a road with no collisions has no conflicts.json on disk", !exists(qfile(road1, "conflicts.json")));
  const rm = readJson(qfile(road1, "roadmap.json"));
  const ms = rm.milestones.find(m => m.id === "ms-mvp");
  ok("the milestone's version equals an independent sha1 of its bytes",
     vers(st)["ms-mvp"] === versionOf(ms), vers(st)["ms-mvp"] + " vs " + versionOf(ms));
  ok("items are versioned too", vers(st)["it-mvp-form"] === versionOf(rm.items.find(i => i.id === "it-mvp-form")));
  ok("quests are versioned too", vers(st)["q-main"] === versionOf(rm.quests.find(q => q.id === "q-main")));
  const dec = readJson(qfile(road1, "decisions.json")).decisions[0];
  ok("decisions are versioned too — they have no updatedAt, which is half the reason",
     !!dec && vers(st)[dec.id] === versionOf(dec));
  // The derived-layer rule: nothing was written back onto the record.
  ok("no version field was added to any stored record",
     !("version" in ms) && !("baseVersion" in ms) && !("contested" in ms));
}

// ---------------------------------------------------------------------------
// C2 — the board holds the second write, and the first one is what stands
// ---------------------------------------------------------------------------
console.log("\n== C2: a colliding write from the board ==");
const road2 = freshRoad("road-c2");
const port2 = await startRoad(road2);
ok("the server came up on road C2", port2 > 0);
let cf2 = null;
if(port2 > 0){
  const st0 = await getState(port2);
  const v0 = vers(st0)["ms-mvp"];
  const rev0 = st0.rev;
  const first = await post(port2, "/api/unclear", { targetType: "milestone", id: "ms-mvp", unclear: true, baseVersion: v0 });
  ok("the first write, on a current basis, is a 200", first.status === 200, first.status + " " + first.text.slice(0, 120));
  ok("the first write landed on disk", msOf(road2, "ms-mvp").unclear === true);

  const nHist = historyLines(road2).length;
  const second = await post(port2, "/api/unclear", { targetType: "milestone", id: "ms-mvp", unclear: false, baseVersion: v0 });
  ok("the second write, on the SAME old basis, is a 409", second.status === 409, second.status + " " + second.text.slice(0, 160));
  ok("and it names itself E_CONTESTED", second.json && second.json.error === "E_CONTESTED", JSON.stringify(second.json && second.json.error));
  ok("the 409 carries the whole conflict", !!(second.json && second.json.conflict && second.json.conflict.id));

  // NOT APPLIED: the first write is still what the record says.
  ok("the first write still stands on disk", msOf(road2, "ms-mvp").unclear === true);

  // NOT DISCARDED: the second write is on file, in full.
  const hs = holds(road2);
  ok("conflicts.json holds exactly one entry", hs.length === 1, "found " + hs.length);
  cf2 = hs[0] || null;
  ok("the hold is open", cf2 && cf2.status === "open");
  ok("the hold names the record and how it came in", cf2 && cf2.targetId === "ms-mvp"
     && cf2.targetType === "milestone" && cf2.source === "ui" && cf2.action === "ui_unclear_set");
  ok("the hold carries the basis and what was actually on disk",
     cf2 && cf2.baseVersion === v0 && cf2.currentVersion !== v0);
  ok("the hold carries BOTH whole versions", cf2 && cf2.current && cf2.current.id === "ms-mvp"
     && cf2.proposed && cf2.proposed.id === "ms-mvp");
  if(cf2){
    const diff = Object.keys(Object.assign({}, cf2.current, cf2.proposed))
      .filter(k => JSON.stringify(cf2.current[k]) !== JSON.stringify(cf2.proposed[k])).sort();
    ok("the two versions differ on the flag that was toggled", diff.includes("unclear"), diff.join(","));
    ok("and on nothing beyond the flag, its stamp and the clock",
       diff.every(k => ["unclear", "unclearAt", "updatedAt"].includes(k)), diff.join(","));
    ok("the standing version is the one that says unclear", cf2.current.unclear === true && cf2.proposed.unclear === false);
  }

  // One history event, and it is the hold — not a write to the road.
  ok("exactly one history event was appended", historyLines(road2).length === nHist + 1,
     nHist + " -> " + historyLines(road2).length);
  const ev = lastEvent(road2);
  ok("the event is a conflict_held", ev && ev.action === "conflict_held", ev && ev.action);
  ok("the event says why, in words", ev && /no longer current/.test(ev.summary || ""), ev && ev.summary);
  ok("the event's patch points at the conflict", ev && ev.patch && ev.patch.conflictId === (cf2 && cf2.id));

  // The board finds out within one poll.
  const st1 = await getState(port2);
  ok("the rev moved, so the board re-renders", st1.rev !== rev0, rev0 + " -> " + st1.rev);
  ok("/api/state now serves the open hold", st1.conflicts.conflicts.length === 1 && st1.conflicts.conflicts[0].status === "open");
}

// ---------------------------------------------------------------------------
// C3 — two live agents, one persistent MCP process each
// ---------------------------------------------------------------------------
console.log("\n== C3: two agents write to the same milestone ==");
const road3 = freshRoad("road-c3");
const agentA = mcpAgent(road3);
const agentB = mcpAgent(road3);
let cf3 = null;
{
  // Both read. Neither has been told a baseVersion; each process now remembers
  // what IT was served, which is exactly the basis its next write is standing on.
  const ra = await agentA.call("roadmap_get", {});
  const rb = await agentB.call("roadmap_get", {});
  ok("agent A read the road", !!(ra.value && ra.value.roadmap));
  ok("agent B read the same road", !!(rb.value && rb.value.roadmap));
  ok("reading appends no history event", countAction(road3, "roadmap_get") === 0);

  const wa = await agentA.call("milestone_set_status", { id: "ms-launch", status: "in_progress" });
  ok("agent A's write goes through", !wa.error && wa.value && wa.value.status === "in_progress", wa.error);
  ok("and it landed on disk", msOf(road3, "ms-launch").status === "in_progress");

  const wb = await agentB.call("milestone_set_status", { id: "ms-launch", status: "done" });
  ok("agent B's write is held", !!wb.error, JSON.stringify(wb.value));
  ok("the refusal is E_CONTESTED, not E_CONFLICT", wb.error && wb.error.startsWith("E_CONTESTED:"), (wb.error || "").slice(0, 80));
  ok("the refusal names the conflict id", wb.error && /cf-[0-9a-f]{8}/.test(wb.error));
  ok("the refusal carries both versions inline", wb.error && /"current"/.test(wb.error) && /"proposed"/.test(wb.error));
  ok("the refusal ends with the promise, in words",
     wb.error && /Held, not applied and not discarded\./.test(wb.error));
  ok("the refusal says what to do next", wb.error && /conflict_resolve/.test(wb.error));

  // NOT APPLIED — A's status is what the road says.
  ok("agent A's status is still what the road says", msOf(road3, "ms-launch").status === "in_progress",
     msOf(road3, "ms-launch").status);
  const hs = holds(road3);
  cf3 = hs[0] || null;
  ok("one hold was recorded", hs.length === 1, "found " + hs.length);
  ok("it came in through the tools", cf3 && cf3.source === "mcp" && cf3.actor === "agent"
     && cf3.action === "milestone_set_status");
  ok("the held version is the one agent B wanted", cf3 && cf3.proposed && cf3.proposed.status === "done");
  ok("the standing version is the one agent A wrote", cf3 && cf3.current && cf3.current.status === "in_progress");
  ok("the raw call was kept, so the ruling can carry it out", cf3 && cf3.input && cf3.input.id === "ms-launch"
     && cf3.input.status === "done");
  ok("a conflict_held event was written", countAction(road3, "conflict_held") === 1);

  // The board is never frozen: a write on a CURRENT basis still goes through
  // while the hold sits open. Agent A read it last, so A still has a live basis.
  const wa2 = await agentA.call("milestone_set_status", { id: "ms-launch", status: "blocked", reason: "waiting on the founder" });
  ok("a later write on a current basis still goes through — the board is not frozen",
     !wa2.error && msOf(road3, "ms-launch").status === "blocked", wa2.error);
  ok("and the open hold is untouched by it", holds(road3).length === 1 && hold0(road3).status === "open");
}

// ---------------------------------------------------------------------------
// C4 — a writer with no basis at all is BLIND, not stale (documented back-compat)
// ---------------------------------------------------------------------------
console.log("\n== C4: a blind write goes through ==");
const road4 = freshRoad("road-c4");
{
  const agentX = mcpAgent(road4);
  await agentX.call("roadmap_get", {});
  const wx = await agentX.call("milestone_set_status", { id: "ms-launch", status: "in_progress" });
  ok("agent X moved the milestone", !wx.error, wx.error);

  // Agent C has never read anything on this road. It has no basis, so there is
  // nothing for it to have been stale against.
  const agentC = mcpAgent(road4);
  const wc = await agentC.call("milestone_set_status", { id: "ms-launch", status: "done" });
  ok("a process that never read is not stale — its write goes through", !wc.error, wc.error);
  ok("and it landed", msOf(road4, "ms-launch").status === "done");
  ok("nothing was held", !exists(qfile(road4, "conflicts.json")));
}

// ---------------------------------------------------------------------------
// C5 — an explicit baseVersion beats what the process remembers, both ways
// ---------------------------------------------------------------------------
console.log("\n== C5: an explicit basis wins in both directions ==");
const road5 = freshRoad("road-c5");
{
  const agentP = mcpAgent(road5);
  await agentP.call("roadmap_get", {});   // P now remembers the CURRENT version

  // (a) a stated basis that is stale beats a remembered one that is current.
  const bad = await agentP.call("milestone_set_status", { id: "ms-launch", status: "done", baseVersion: "000000000000" });
  ok("a stated stale basis is held even though the process just read", !!bad.error, JSON.stringify(bad.value));
  ok("and it is E_CONTESTED", bad.error && bad.error.startsWith("E_CONTESTED:"));
  ok("the road did not move", msOf(road5, "ms-launch").status === "available", msOf(road5, "ms-launch").status);
  ok("the hold recorded the stated basis, not the remembered one",
     hold0(road5).baseVersion === "000000000000");

  // (b) a stated basis that is CURRENT beats a remembered one that is stale.
  const agentQ = mcpAgent(road5);
  await agentQ.call("roadmap_get", {});   // Q remembers version v0
  const agentR = mcpAgent(road5);
  const wr = await agentR.call("milestone_set_status", { id: "ms-feedback", status: "available" });
  ok("a third writer moved the record out from under Q", !wr.error, wr.error);
  const vNow = versionOf(msOf(road5, "ms-feedback"));
  const wq = await agentQ.call("milestone_set_status", { id: "ms-feedback", status: "in_progress", baseVersion: vNow });
  ok("Q's stale memory is overruled by the current basis it states", !wq.error, wq.error);
  ok("and Q's write landed", msOf(road5, "ms-feedback").status === "in_progress");
  ok("still only the one hold from (a)", holds(road5).length === 1, "found " + holds(road5).length);
  // The version the tool serves back is the one a follow-up write is judged on:
  // an agent must be able to write twice in a row without contesting itself.
  const wq2 = await agentQ.call("milestone_set_status", { id: "ms-feedback", status: "done" });
  ok("the same agent can write twice in a row without contesting itself", !wq2.error, wq2.error);
}

// ---------------------------------------------------------------------------
// C6 — the ruling, from both surfaces
// ---------------------------------------------------------------------------
console.log("\n== C6: the founder rules ==");
{
  // keep:"held" through the tools, on the conflict C3 opened. Guarded on cf3
  // so a break in C3 fails ITS OWN assertions and lets the tape run on, rather
  // than stopping the file before the board half gets to speak.
  const ruler = mcpAgent(road3);
  const listed = await ruler.call("conflict_list", {});
  ok("conflict_list reads the open holds", listed.value && listed.value.count === 1, JSON.stringify(listed.error || listed.value && listed.value.count));
  ok("conflict_list appends no history event", countAction(road3, "conflict_list") === 0);
  const nBefore3 = historyLines(road3).length;
  if(cf3){
  const ruled = await ruler.call("conflict_resolve", { id: cf3.id, keep: "held" });
  ok("the ruling is recorded", !ruled.error, ruled.error);
  ok("the conflict is now ruled", ruled.value && ruled.value.conflict && ruled.value.conflict.status === "ruled");
  ok("the ruling says which way it went", ruled.value && ruled.value.conflict.ruling
     && ruled.value.conflict.ruling.keep === "held" && ruled.value.conflict.ruling.by === "founder");
  // The held version is applied WHOLE — status and reason both come from it,
  // over the top of the "blocked" that landed in between.
  const after = msOf(road3, "ms-launch");
  ok("the held version replaced the record", after.status === "done", after.status);
  ok("field by field, the record equals the held version bar the clock",
     JSON.stringify(Object.assign({}, cf3.proposed, { updatedAt: 0 })) === JSON.stringify(Object.assign({}, after, { updatedAt: 0 })),
     JSON.stringify(after));
  ok("one conflict_ruled event was written", countAction(road3, "conflict_ruled") === 1);
  ok("exactly one history event came with the ruling", historyLines(road3).length === nBefore3 + 1);
  const again = await ruler.call("conflict_resolve", { id: cf3.id, keep: "current" });
  ok("a settled conflict cannot be re-ruled", !!again.error && /already ruled/.test(again.error), again.error);
  ok("both versions survive the ruling", hold0(road3).current && hold0(road3).proposed);
  } else { ok("C3 left a conflict for the tool ruling to act on", false, "no conflict was held"); }

  // keep:"current" through the board, on the conflict C2 opened.
  if(port2 > 0 && cf2){
    const before = JSON.stringify(msOf(road2, "ms-mvp"));
    const r = await post(port2, "/api/conflict/resolve", { id: cf2.id, keep: "current" });
    ok("the board records a ruling", r.status === 200, r.status + " " + r.text.slice(0, 140));
    ok("and it is ruled", r.json && r.json.conflict && r.json.conflict.status === "ruled");
    ok("keeping the standing version changes nothing on the road",
       JSON.stringify(msOf(road2, "ms-mvp")) === before);
    ok("one conflict_ruled event on this road too", countAction(road2, "conflict_ruled") === 1);
    ok("the held version is still on file, not thrown away",
       hold0(road2).proposed && hold0(road2).proposed.unclear === false);
    const r404 = await post(port2, "/api/conflict/resolve", { id: "cf-deadbeef", keep: "current" });
    ok("an unknown conflict is a 404", r404.status === 404, String(r404.status));
    const rbad = await post(port2, "/api/conflict/resolve", { id: cf2.id, keep: "whatever" });
    ok("a ruling has to be one of the two", rbad.status === 400, String(rbad.status));
  }
}

// ---------------------------------------------------------------------------
// C7 — a deleted record's holds are voided, and the road stays valid
// ---------------------------------------------------------------------------
console.log("\n== C7: deleting a contested record ==");
const road7 = freshRoad("road-c7");
const port7 = await startRoad(road7);
ok("the server came up on road C7", port7 > 0);
if(port7 > 0){
  const st = await getState(port7);
  const v0 = vers(st)["it-mvp-form"];
  await post(port7, "/api/unclear", { targetType: "item", id: "it-mvp-form", unclear: true, baseVersion: v0 });
  const held = await post(port7, "/api/unclear", { targetType: "item", id: "it-mvp-form", unclear: false, baseVersion: v0 });
  ok("an item can be contested too", held.status === 409 && held.json.error === "E_CONTESTED");
  ok("the hold is open before the delete", holds(road7).length === 1 && hold0(road7).status === "open");

  const st2 = await getState(port7);
  const del = await post(port7, "/api/delete", { targetType: "item", id: "it-mvp-form", baseVersion: vers(st2)["it-mvp-form"] });
  ok("deleting the contested item is a 200", del.status === 200, del.status + " " + del.text.slice(0, 140));
  ok("the item is off the road", !itemOf(road7, "it-mvp-form"));
  const h = holds(road7)[0];
  ok("its hold was voided, not deleted", h && h.status === "void", h && h.status);
  ok("and it says why", h && h.voidReason === "target deleted");
  ok("a void carries no ruling — nobody ruled on it", h && !("ruling" in h));
  ok("one conflict_void event was written", countAction(road7, "conflict_void") === 1);
  const { validateDir } = await import("./schema/validate.mjs");
  const errs = validateDir(road7);
  ok("the road validates with a voided conflict on it", errs.length === 0, errs.slice(0, 3).join(" | "));
}

// ---------------------------------------------------------------------------
// C8 — the escape hatch refuses stale instead of holding it
// ---------------------------------------------------------------------------
console.log("\n== C8: a whole-file overwrite ==");
const road8 = freshRoad("road-c8");
const port8 = await startRoad(road8);
ok("the server came up on road C8", port8 > 0);
if(port8 > 0){
  const pins = readJson(qfile(road8, "pins.json"));
  const before = fs.readFileSync(qfile(road8, "pins.json"), "utf8");
  const stale = await post(port8, "/api/file/pins?baseRev=not-the-rev", pins);
  ok("a stale whole-file overwrite is refused", stale.status === 409, stale.status + " " + stale.text.slice(0, 140));
  ok("and it says E_STALE, not E_CONTESTED — there is no card to hold it on",
     stale.json && stale.json.error === "E_STALE", JSON.stringify(stale.json && stale.json.error));
  ok("the refusal hands back the rev to re-read from", stale.json && typeof stale.json.rev === "string" && stale.json.rev.length > 0);
  ok("pins.json is byte-identical after the refusal",
     fs.readFileSync(qfile(road8, "pins.json"), "utf8") === before);

  const st = await getState(port8);
  const fresh = await post(port8, "/api/file/pins?baseRev=" + encodeURIComponent(st.rev), pins);
  ok("a current baseRev is accepted", fresh.status === 200, fresh.status + " " + fresh.text.slice(0, 140));
  const plain = await post(port8, "/api/file/pins", pins);
  ok("and no baseRev at all is today's behaviour, unchanged", plain.status === 200, String(plain.status));
}

// ---------------------------------------------------------------------------
// C9 — appends are exempt, and stay exempt
// ---------------------------------------------------------------------------
console.log("\n== C9: an append never collides ==");
const road9 = freshRoad("road-c9");
const port9 = await startRoad(road9);
ok("the server came up on road C9", port9 > 0);
if(port9 > 0){
  const st = await getState(port9);
  const v0 = vers(st)["it-mvp-form"];
  await post(port9, "/api/unclear", { targetType: "item", id: "it-mvp-form", unclear: true, baseVersion: v0 });
  // v0 is now thoroughly stale. A note is still a note.
  const n = await post(port9, "/api/note", { itemId: "it-mvp-form", body: "two notes are two notes", baseVersion: v0 });
  ok("a note on a moved-on card is still a 200", n.status === 200, n.status + " " + n.text.slice(0, 140));
  const it = itemOf(road9, "it-mvp-form");
  ok("and the note is on the card", it.notes.some(x => x.body === "two notes are two notes"));
  ok("nothing was held for an append", !exists(qfile(road9, "conflicts.json")));
}

// ---------------------------------------------------------------------------
// C9b — the guarded writers the cases above never reach. C3 and C5 exercise
// milestone_set_status and C2/C7 exercise the board's unclear toggle; the rest
// are guarded in exactly the same shape and would rot in exactly the same way,
// so each gets its own collision here. A decision is the interesting one: it
// carries no updatedAt at all, which is half the reason the version is a hash.
// ---------------------------------------------------------------------------
console.log("\n== C9b: every other guarded writer ==");
const road9b = freshRoad("road-c9b");
const port9b = await startRoad(road9b);
ok("the server came up on road C9b", port9b > 0);
if(port9b > 0){
  const decId = readJson(qfile(road9b, "decisions.json")).decisions[0].id;
  const st = await getState(port9b);
  const dv = vers(st)[decId];
  const a = await post(port9b, "/api/decision/approve", { id: decId, set: "rejected", baseVersion: dv });
  ok("the board can rule on a decision on a current basis", a.status === 200, a.status + " " + a.text.slice(0, 120));
  const b = await post(port9b, "/api/decision/approve", { id: decId, set: "approved", baseVersion: dv });
  ok("a second approval on the SAME old basis is held", b.status === 409 && b.json.error === "E_CONTESTED",
     b.status + " " + b.text.slice(0, 120));
  const dec = readJson(qfile(road9b, "decisions.json")).decisions.find(d => d.id === decId);
  ok("the first ruling is still what the decision says", dec.status === "rejected", dec.status);
  ok("the held version wanted the other answer", hold0(road9b).proposed?.status === "approved");
  ok("a decision hold names its type", hold0(road9b).targetType === "decision");
}

// The three remaining tools, each on its own road so a hold in one cannot
// colour another. The pattern is identical every time, which is the point:
// find the record, clone it when the basis is stale, hold instead of writing.
{
  // item_upsert
  const r = freshRoad("road-c9b-item");
  const one = mcpAgent(r), two = mcpAgent(r);
  await one.call("roadmap_get", {}); await two.call("roadmap_get", {});
  const w1 = await one.call("item_upsert", { id: "it-mvp-form", milestoneId: "ms-mvp", kind: "task", title: "One's title" });
  ok("item_upsert goes through on a current basis", !w1.error, w1.error);
  const w2 = await two.call("item_upsert", { id: "it-mvp-form", milestoneId: "ms-mvp", kind: "task", title: "Two's title" });
  ok("item_upsert is held on a stale one", w2.error && w2.error.startsWith("E_CONTESTED:"), (w2.error || "").slice(0, 60));
  ok("and the first title is what the card says", itemOf(r, "it-mvp-form").title === "One's title",
     itemOf(r, "it-mvp-form").title);
  ok("the held title is on file, not lost", hold0(r).proposed?.title === "Two's title");
  // Creating is NOT guarded — there is no prior version to be stale against.
  const made = await two.call("item_upsert", { milestoneId: "ms-mvp", kind: "task", title: "brand new" });
  ok("creating an item is exempt even from a stale process", !made.error, made.error);
}
{
  // clear_unclear
  const r = freshRoad("road-c9b-unclear");
  const flag = mcpAgent(r);
  await flag.call("item_upsert", { id: "it-mvp-form", milestoneId: "ms-mvp", kind: "task", title: "Sign-up form" });
  // Raise the flag by hand: the tools have no raise, only a clear.
  const rm = readJson(qfile(r, "roadmap.json"));
  const it = rm.items.find(x => x.id === "it-mvp-form");
  it.unclear = true; it.unclearAt = "2026-09-07T00:00:00.000Z";
  fs.writeFileSync(qfile(r, "roadmap.json"), JSON.stringify(rm, null, 2), "utf8");
  const one = mcpAgent(r), two = mcpAgent(r);
  await one.call("list_unclear", {}); await two.call("list_unclear", {});
  ok("the drain queue is where a clear_unclear learns its basis",
     (await one.call("list_unclear", {})).value.count === 1);
  const w1 = await one.call("clear_unclear", { id: "it-mvp-form", rewritten_plain: "the box people type their email into" });
  ok("clear_unclear goes through on a current basis", !w1.error, w1.error);
  const w2 = await two.call("clear_unclear", { id: "it-mvp-form", rewritten_plain: "a different rewrite entirely" });
  // The second agent's basis is stale AND the flag is already down; the hold
  // must win, because refusing on the flag would lose the rewrite.
  ok("clear_unclear is held on a stale basis", w2.error && w2.error.startsWith("E_CONTESTED:"), (w2.error || "").slice(0, 60));
  ok("the first rewrite is what the card says",
     itemOf(r, "it-mvp-form").plain === "the box people type their email into", itemOf(r, "it-mvp-form").plain);
  ok("the second rewrite is on file", hold0(r).proposed?.plain === "a different rewrite entirely");
}
{
  // glossary_term_upsert
  const r = freshRoad("road-c9b-term");
  const one = mcpAgent(r), two = mcpAgent(r);
  const g1 = await one.call("roadmap_get", { section: "glossary" });
  await two.call("roadmap_get", { section: "glossary" });
  const termId = Array.isArray(g1.value) && g1.value.length ? g1.value[0].id : null;
  ok("the seed glossary has a term to argue over", !!termId, JSON.stringify(g1.error || g1.value));
  if(termId){
    const t0 = g1.value[0];
    const w1 = await one.call("glossary_term_upsert", { id: termId, term: t0.term, plain: "one's plain meaning" });
    ok("glossary_term_upsert goes through on a current basis", !w1.error, w1.error);
    const w2 = await two.call("glossary_term_upsert", { id: termId, term: t0.term, plain: "two's plain meaning" });
    ok("glossary_term_upsert is held on a stale one", w2.error && w2.error.startsWith("E_CONTESTED:"), (w2.error || "").slice(0, 60));
    const gl = readJson(qfile(r, "glossary.json")).terms.find(t => t.id === termId);
    ok("the first meaning is what the glossary says", gl.plain === "one's plain meaning", gl.plain);
    ok("the held meaning is on file", hold0(r).proposed?.plain === "two's plain meaning");
    // A term is not a road record, so the validator must not demand it be one.
    const { validateDir } = await import("./schema/validate.mjs");
    ok("an open hold on a glossary term still validates", validateDir(r).length === 0, validateDir(r).slice(0, 3).join(" | "));
    // And the ruling reaches the glossary too.
    const ruled = await one.call("conflict_resolve", { id: hold0(r).id || "cf-none", keep: "held" });
    ok("a term ruling applies to glossary.json", !ruled.error, ruled.error);
    ok("the held meaning replaced the term",
       readJson(qfile(r, "glossary.json")).terms.find(t => t.id === termId).plain === "two's plain meaning");
  }
}
{
  // The same term collision, ruled from the BOARD. The two routes are supposed
  // to land on the same file with the same effect, and for a term the board's
  // half was missing entirely: applyHeldChange had a branch for a decision and
  // a fallthrough for the road, so a term fell through, got looked for among the
  // quests, and answered 404 while the conflict stayed open.
  const r = freshRoad("road-c9b-term-board");
  const one = mcpAgent(r), two = mcpAgent(r);
  const g1 = await one.call("roadmap_get", { section: "glossary" });
  await two.call("roadmap_get", { section: "glossary" });
  const termId = Array.isArray(g1.value) && g1.value.length ? g1.value[0].id : null;
  ok("the seed glossary has a term for the board to rule on", !!termId, JSON.stringify(g1.error || g1.value));
  if(termId){
    const t0 = g1.value[0];
    await one.call("glossary_term_upsert", { id: termId, term: t0.term, plain: "one's plain meaning" });
    const w2 = await two.call("glossary_term_upsert", { id: termId, term: t0.term, plain: "two's plain meaning" });
    ok("the second meaning is held, as before", w2.error && w2.error.startsWith("E_CONTESTED:"), (w2.error || "").slice(0, 60));
    const port = await startRoad(r);
    ok("the server came up on the term-board road", port > 0);
    if(port > 0){
      const rb = await post(port, "/api/conflict/resolve", { id: hold0(r).id || "cf-none", keep: "held" });
      ok("the board can rule on a held glossary term", rb.status === 200, rb.status + " " + rb.text.slice(0, 140));
      ok("and the conflict is ruled", rb.json && rb.json.conflict && rb.json.conflict.status === "ruled");
      const term = readJson(qfile(r, "glossary.json")).terms.find(t => t.id === termId);
      ok("the held meaning is what the glossary says", term.plain === "two's plain meaning", term.plain);
      ok("the board stamped no updatedAt on a term", !("updatedAt" in term), JSON.stringify(term));
      ok("one conflict_ruled event was written", countAction(r, "conflict_ruled") === 1);
      // The README's promise: both routes agree. The record on disk is the held
      // version whole, exactly as the tool route leaves it.
      ok("the board's swap is the tool's swap, field for field",
         JSON.stringify(term) === JSON.stringify(hold0(r).proposed), JSON.stringify(term));
      const { validateDir } = await import("./schema/validate.mjs");
      ok("a term ruled from the board still validates", validateDir(r).length === 0, validateDir(r).slice(0, 3).join(" | "));
    }
  }
}

// ---------------------------------------------------------------------------
// C10 — the validator: silent on absence, strict on presence, loud on nonsense
// ---------------------------------------------------------------------------
console.log("\n== C10: the validator ==");
{
  const { validateDir } = await import("./schema/validate.mjs");
  ok("road C2 validates with a ruled conflict on it", validateDir(road2).length === 0, validateDir(road2).slice(0, 3).join(" | "));
  ok("road C3 validates with a ruled conflict on it", validateDir(road3).length === 0, validateDir(road3).slice(0, 3).join(" | "));
  ok("road C5 validates with an OPEN conflict on it", validateDir(road5).length === 0, validateDir(road5).slice(0, 3).join(" | "));
  ok("a road that never collided validates with no conflicts.json at all",
     validateDir(road4).length === 0 && !exists(qfile(road4, "conflicts.json")));

  // Hand-corrupt it: a status nobody defined, and an open hold on a record that
  // is not on the road. Both must be named.
  const road10 = freshRoad("road-c10");
  fs.writeFileSync(qfile(road10, "conflicts.json"), JSON.stringify({
    schemaVersion: 1,
    conflicts: [
      { id: "cf-11111111", ts: "2026-09-07T00:00:00.000Z", status: "bogus", targetType: "milestone",
        targetId: "ms-mvp", source: "ui", actor: "founder", action: "ui_unclear_set",
        baseVersion: "aaaaaaaaaaaa", currentVersion: "bbbbbbbbbbbb", current: {}, proposed: {}, input: {} },
      { id: "cf-22222222", ts: "2026-09-07T00:00:00.000Z", status: "open", targetType: "milestone",
        targetId: "ms-nowhere", source: "ui", actor: "founder", action: "ui_unclear_set",
        baseVersion: "aaaaaaaaaaaa", currentVersion: "bbbbbbbbbbbb", current: {}, proposed: null, input: {} },
    ],
  }, null, 2), "utf8");
  const errs = validateDir(road10);
  ok("a corrupted conflicts.json is invalid", errs.length > 0);
  ok("and every error names the file it came from", errs.every(e => /^conflicts/.test(e)), errs.join(" | "));
  ok("the unknown status is named", errs.some(e => /cf-11111111/.test(e) && /status/.test(e)), errs.join(" | "));
  ok("the open hold on a missing record is named",
     errs.some(e => /cf-22222222/.test(e) && /not on the road/.test(e)), errs.join(" | "));
  // A ruling on an argument nobody settled is a lie in the other direction.
  fs.writeFileSync(qfile(road10, "conflicts.json"), JSON.stringify({
    schemaVersion: 1,
    conflicts: [
      { id: "cf-33333333", ts: "2026-09-07T00:00:00.000Z", status: "open", targetType: "milestone",
        targetId: "ms-mvp", source: "ui", actor: "founder", action: "ui_unclear_set",
        baseVersion: "aaaaaaaaaaaa", currentVersion: "bbbbbbbbbbbb", current: {}, proposed: {}, input: {},
        ruling: { keep: "held", ts: "2026-09-07T00:00:00.000Z", by: "founder" } },
    ],
  }, null, 2), "utf8");
  const errs2 = validateDir(road10);
  ok("an open conflict carrying a ruling is invalid", errs2.some(e => /only a ruled conflict has one/.test(e)),
     errs2.join(" | "));
  fs.rmSync(qfile(road10, "conflicts.json"));
  ok("and with the file gone the same road is clean again", validateDir(road10).length === 0);
}

// ---------------------------------------------------------------------------
// C11 — the surfaces, counted in the source, and the live road left alone
// ---------------------------------------------------------------------------
console.log("\n== C11: the surface ==");
{
  const html = readSrc("index.html");
  ok("the header carries a contested badge", /id="contestedBadge"/.test(html));
  ok("the drawer has a conflict view", /function renderConflictsBody\(/.test(html));
  ok("the view offers both rulings", /data-cf-keep="current"/.test(html) && /data-cf-keep="held"/.test(html));
  ok("and it posts them to the ruling endpoint", /\/conflict\/resolve/.test(html));
  ok("the two columns are named for what they are",
     /Standing \(first write\)/.test(html) && /Held \(second write\)/.test(html));
  ok("the card carries a contested block", /function contestedBlock\(/.test(html));
  ok("all three cards render it", (html.match(/h\+=contestedBlock\(/g) || []).length === 3,
     "found " + (html.match(/h\+=contestedBlock\(/g) || []).length);
  // Every UI write that can collide must state the version it was based on.
  const unclearCalls = html.match(/api\(API_PREFIX\+"\/unclear"[^\n]*/g) || [];
  ok("every /unclear call sends its basis", unclearCalls.length > 0 && unclearCalls.every(c => /baseVersion:baseVersionOf\(/.test(c)),
     unclearCalls.join(" | ").slice(0, 200));
  const deleteCalls = html.match(/api\(API_PREFIX\+"\/delete"[^\n]*/g) || [];
  ok("every /delete call sends its basis", deleteCalls.length > 0 && deleteCalls.every(c => /baseVersion:baseVersionOf\(/.test(c)),
     deleteCalls.join(" | ").slice(0, 200));
  ok("a held write raises no browser dialog", !/E_CONTESTED[^\n]*alert\(/.test(html));

  const srv = readSrc("server.mjs"), mcp = readSrc("mcp/server.mjs");
  ok("both servers speak E_CONTESTED", /E_CONTESTED/.test(srv) && /E_CONTESTED/.test(mcp));
  ok("both servers judge staleness through the one shared module",
     /from "\.\/conflicts\.mjs"/.test(srv) && /from "\.\.\/conflicts\.mjs"/.test(mcp));
  // E_CONFLICT already means "this record has dependents". Overloading it would
  // make a delete refusal and a held write indistinguishable to an agent.
  ok("E_CONFLICT still only means dependents in the tools",
     !/E_CONFLICT[^\n]*contest/i.test(mcp) && /has dependents/.test(readSrc("deletion.mjs")));
  ok("no version field was added to the stored roadmap schema",
     !/recordVersion|baseVersion|versions/.test(readSrc("schema/roadmap.schema.json")));
  ok("conflicts.json has a schema of its own", exists(path.join(HERE, "schema", "conflicts.schema.json")));
}

// ---------------------------------------------------------------------------
// C11b — the tool surface, over a real stdio handshake
// ---------------------------------------------------------------------------
console.log("\n== C11b: the tool list ==");
{
  const lister = mcpAgent(road4);
  const tools = await lister.list();
  ok("the server lists 30 tools", tools.length === 30, "found " + tools.length);
  const byName = new Map(tools.map(t => [t.name, t]));
  ok("conflict_list is there", byName.has("conflict_list"));
  ok("conflict_resolve is there", byName.has("conflict_resolve"));
  const guarded = ["milestone_upsert", "milestone_set_status", "item_upsert",
                   "decision_set_approval", "clear_unclear", "glossary_term_upsert"];
  for(const g of guarded){
    const t = byName.get(g);
    const bv = t && t.inputSchema && t.inputSchema.properties && t.inputSchema.properties.baseVersion;
    ok(g + " takes an optional baseVersion string", !!bv && bv.type === "string");
    const req = (t && t.inputSchema && t.inputSchema.required) || [];
    ok(g + " does not require it (a blind write is still allowed)", !req.includes("baseVersion"));
  }
  // The appends and the create-only tools are deliberately NOT guarded.
  ok("item_note_add is exempt — an append never collides",
     !(byName.get("item_note_add").inputSchema.properties.baseVersion));
  ok("quest_create is exempt — nothing to be stale against",
     !(byName.get("quest_create").inputSchema.properties.baseVersion));
}

// ---------------------------------------------------------------------------
// C12 — the founder's own road was never opened for writing
// ---------------------------------------------------------------------------
console.log("\n== C12: the live road is untouched ==");
{
  const now = (() => { try { return fs.statSync(LIVE_ROADMAP).mtimeMs; } catch { return null; } })();
  ok("the repo's own .questlog/roadmap.json has not moved", now === liveMtimeBefore,
     liveMtimeBefore + " -> " + now);
  ok("no conflicts.json was created in the repo's own .questlog",
     fs.existsSync(LIVE_CONFLICTS) === liveConflictsBefore);
}

stopServers();
stopAgents();
console.log("\n---------------------------------------------");
console.log(fail === 0 ? ("ALL GREEN — " + pass + " assertions passed")
                       : (fail + " FAILED of " + (pass + fail) + "\n" + failures.map(f => "  - " + f).join("\n")));
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* windows may still hold a handle */ }
process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { stopServers(); stopAgents(); console.error("SELFTEST CRASHED:", err); process.exit(1); });
