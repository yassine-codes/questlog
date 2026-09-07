#!/usr/bin/env node
// ---------------------------------------------------------------------------
// HORIZON TREES / REQUEST-MORE / PROMOTE-DEMOTE / EXPAND-IN-PLACE — selftest.
//
// Everything the four features own, proved end to end and zero-dep:
//   F1 schema + upsert  — 15-item fan accepted, 16th refused, seat collisions
//                         refused, legacy records still render as today's chain,
//                         an in-progress (non road-end) anchor is accepted, and
//                         a fan tagged to a PORTAL re-anchors at render time.
//   F2 request-more     — POST /api/request-suggestions writes a history event
//                         and a marker; a fresh upsert clears the marker.
//   F3 promote / demote — round trip leaves the parent equivalent modulo ids and
//                         timestamps, the registry gains then loses the edge,
//                         both histories are logged, and demoting a road that
//                         has a child of its own is refused.
//   F4 expand-in-place  — the overlap predicate holds through the whole
//                         expand -> collapse cycle, collapse restores the exact
//                         pre-expand layout AND the pre-expand camera.
//
// TEMP EVERYTHING: temp HOME (QUESTLOG_REGISTRY), temp copies of the demo road
// data, server on 4340+. The founder's :4177 and the real .questlog dirs are
// never touched (the real dirs are only READ, to copy).
//
// Usage: node features.selftest.mjs [--verbose]
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes("--verbose");
const PORT = Number(process.env.QL_TEST_PORT || 4341);

let pass = 0, fail = 0, skipped = 0;
const failures = [];
function ok(name, cond, detail){
  if(cond){ pass++; if(VERBOSE) console.log("  ok   " + name); }
  else { fail++; failures.push(name + (detail ? " — " + detail : "")); console.log("  FAIL " + name + (detail ? " — " + detail : "")); }
}

// ---- load QL_ENGINE + QL_FEAT straight out of index.html (no duplicate src) --
function loadBlock(marker){
  const html = fs.readFileSync(path.join(HERE, "index.html"), "utf8");
  const a = html.indexOf("// ==== " + marker + "_BEGIN ====");
  const b = html.indexOf("// ==== " + marker + "_END ====");
  if(a < 0 || b < 0) throw new Error(marker + " markers not found in index.html");
  return new Function(html.slice(a, b) + "\n; return " + marker + ";")();
}
const E = loadBlock("QL_ENGINE");
const F = loadBlock("QL_FEAT");

function jclone(x){ return JSON.parse(JSON.stringify(x)); }
function posSnapshot(L){
  const o = {};
  for(const e of L.elements) o[e.id] = [Math.round(e.x*1000)/1000, Math.round(e.y*1000)/1000];
  return o;
}
// A group whose data is not on this machine SKIPS, loudly, with the reason. It
// is never a FAIL: a fresh clone has none of the founder's roads, and a public
// repo whose selftests are red out of the box is a defect, not a finding.
function skip(name, why){ skipped++; console.log("  SKIP " + name + " — " + why); }
function assertInvariant(name, L){
  const v = E.invariant(L);
  ok(name + " [" + L.elements.length + " boxes]", v.ok,
     v.ok ? "" : (v.violations.length + " violations, first: " + JSON.stringify(v.violations[0])));
  return v.ok;
}

// ---------------------------------------------------------------------------
// temp workspace
// ---------------------------------------------------------------------------
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "ql-feat-"));
const HOME = path.join(WORK, "home");
const REGISTRY = path.join(HOME, "registry.json");
fs.mkdirSync(HOME, { recursive: true });
const ENV = Object.assign({}, process.env, {
  QUESTLOG_REGISTRY: REGISTRY,
  QUESTLOG_ALLOW_TEMP: "1",          // the temp-path guard's documented escape hatch
  QUESTLOG_PORT: String(PORT),
});
delete ENV.QUESTLOG_DIR;             // central mode

function copyDir(src, dst){
  fs.mkdirSync(dst, { recursive: true });
  for(const e of fs.readdirSync(src, { withFileTypes: true })){
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if(e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}
function makeRoadFrom(src, name){
  const root = path.join(WORK, name);
  fs.mkdirSync(root, { recursive: true });
  copyDir(src, path.join(root, ".questlog"));
  return root;
}
function readJson(f, fb){ try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } }
function writeJson(f, v){ fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); }
function roadData(root){
  const rm = readJson(path.join(root, ".questlog", "roadmap.json"), { quests: [], milestones: [] });
  const sg = readJson(path.join(root, ".questlog", "suggestions.json"), { suggestions: [] });
  return { quests: rm.quests||[], milestones: rm.milestones||[], suggestions: sg.suggestions||[], pins: [] };
}
function historyActions(root){
  try {
    return fs.readFileSync(path.join(root, ".questlog", "history.jsonl"), "utf8")
      .split("\n").map(l => l.trim()).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// THE DEMO ROAD ships in the repo, so every case below has data on a fresh
// clone: two copies of it, because F1 and F2 write different things and neither
// should be reading the other's leavings.
const DEMO_SEED = path.join(HERE, "seeds", "sample-project", ".questlog");
const ROADS = {
  demo: makeRoadFrom(DEMO_SEED, "road-demo"),
  demo2: makeRoadFrom(DEMO_SEED, "road-demo-2"),
};
writeJson(REGISTRY, {
  schemaVersion: 1,
  roadmaps: [
    { id: "rm-demo", name: "Sample Project (copy)", dir: ROADS.demo, addedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" },
    { id: "rm-demo-2", name: "Sample Project (second copy)", dir: ROADS.demo2, addedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" },
  ],
});

// REAL ROADS are whatever this machine has registered in the overworld. The
// registry is read HERE, from the environment as it was BEFORE the temp one
// above replaced it, and every road found is COPIED — the originals are opened
// for reading and nothing else. Absent (a fresh clone, a fresh laptop) is not a
// failure: the groups that use them SKIP and say which registry they looked in.
const REGISTRY_SRC = process.env.QUESTLOG_REGISTRY ||
                     path.join(os.homedir(), ".questlog", "registry.json");
const REAL_ROADS = (() => {
  let reg = null;
  try { reg = JSON.parse(fs.readFileSync(REGISTRY_SRC, "utf8")); } catch { return []; }
  const roots = [];
  for(const r of (reg && Array.isArray(reg.roadmaps)) ? reg.roadmaps : []){
    if(!r || typeof r.dir !== "string") continue;
    if(!fs.existsSync(path.join(r.dir, ".questlog", "roadmap.json"))) continue;
    roots.push(makeRoadFrom(path.join(r.dir, ".questlog"), "road-real-" + (roots.length + 1)));
  }
  return roots.map((root, i) => ({ root, label: "real road " + (i + 1) + "/" + roots.length }));
})();
// Snapshotted BEFORE anything runs: a road this repo does not own is allowed to
// carry its own validation errors, so what is asserted at the end is that this
// test introduced no NEW one.
const REAL_BASELINE = new Map(REAL_ROADS.map((r) => [r.root, null]));

// ---------------------------------------------------------------------------
// MCP driver — one short-lived stdio server per call batch (real tool path).
// ---------------------------------------------------------------------------
function mcpCall(dir, name, args){
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, "mcp", "server.mjs"), "--dir", dir],
                    { env: ENV, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (b) => { out += b.toString(); });
    p.on("close", () => {
      let result = null;
      for(const line of out.split("\n")){
        const t = line.trim(); if(!t) continue;
        let m; try { m = JSON.parse(t); } catch { continue; }
        if(m.id === 2) result = m;
      }
      if(!result) return resolve({ error: "no response", raw: out });
      const r = result.result || {};
      const text = (r.content && r.content[0] && r.content[0].text) || "";
      if(r.isError) return resolve({ error: text });
      let value = null; try { value = JSON.parse(text); } catch { value = text; }
      resolve({ value });
    });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) + "\n");
    p.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// HTTP server (central mode, temp home)
// ---------------------------------------------------------------------------
let SERVER = null;
function startServer(){
  return new Promise((resolve, reject) => {
    SERVER = spawn(process.execPath, [path.join(HERE, "server.mjs"), "--port", String(PORT)],
                   { env: ENV, cwd: WORK, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const onData = (b) => {
      buf += b.toString();
      if(/listening|http:\/\/127\.0\.0\.1/i.test(buf)) resolve();
    };
    SERVER.stdout.on("data", onData);
    SERVER.stderr.on("data", onData);
    SERVER.on("error", reject);
    setTimeout(() => resolve(), 2500);   // boot banner shape is not a contract
  });
}
async function req(method, p, body){
  const r = await fetch("http://127.0.0.1:" + PORT + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, body: j };
}
function stopServer(){
  if(SERVER && !SERVER.killed){ try { SERVER.kill(); } catch {} }
  SERVER = null;
}

// ===========================================================================
async function main(){
  {
    const { validateDir } = await import("./schema/validate.mjs");
    for(const r of REAL_ROADS) REAL_BASELINE.set(r.root, new Set(validateDir(r.root)));
  }

// ---------------------------------------------------------------------------
// F1 — schema delta, upsert, rendering
// ---------------------------------------------------------------------------
console.log("\n== F1: horizon trees (schema + upsert + rendering) ==");

// pick a done milestone that is NOT a road-end, on the copied demo road
const qData = roadData(ROADS.demo);
const mainQ = qData.quests.find(q => q.type === "main");
const mainMs = qData.milestones.filter(m => m.questId === mainQ.id).sort((a,b) => (a.order||0)-(b.order||0));
const roadEnd = mainMs[mainMs.length-1];
const midAnchor = mainMs.find(m => m.status === "done" && m.id !== roadEnd.id) ||
                  mainMs.find(m => m.status === "in_progress");
ok("F1 a mid-road done/in-progress anchor exists in the copied data", !!midAnchor, midAnchor ? midAnchor.id : "none");

function fan(n){
  const out = [];
  for(let b = 0; b < 5 && out.length < n; b++){
    for(let s = 0; s < 3 && out.length < n; s++){
      out.push({ title: `dir ${b} step ${s}`, plain: `a possible direction ${b}, step ${s}`, branchIndex: b, seqIndex: s });
    }
  }
  return out;
}
{
  const r15 = await mcpCall(ROADS.demo, "suggestions_upsert",
                            { frontierMilestoneId: midAnchor.id, suggestions: fan(15) });
  ok("F1 upsert accepts a 15-item fan at an in-progress/done anchor",
     !r15.error && r15.value && r15.value.suggestions && r15.value.suggestions.length === 15,
     r15.error || JSON.stringify(r15.value && r15.value.suggestions && r15.value.suggestions.length));
  ok("F1 every written record carries branchIndex + seqIndex",
     !r15.error && r15.value.suggestions.every(s => Number.isInteger(s.branchIndex) && Number.isInteger(s.seqIndex)));

  const s16 = fan(15).concat([{ title: "one too many", plain: "over the ceiling", branchIndex: 4, seqIndex: 2 }]);
  const r16 = await mcpCall(ROADS.demo, "suggestions_upsert",
                            { frontierMilestoneId: midAnchor.id, suggestions: s16 });
  ok("F1 upsert REFUSES a 16th item", !!r16.error, r16.error || "accepted 16");

  const dup = [{ title: "a", plain: "a", branchIndex: 0, seqIndex: 0 },
               { title: "b", plain: "b", branchIndex: 0, seqIndex: 0 }];
  const rdup = await mcpCall(ROADS.demo, "suggestions_upsert",
                             { frontierMilestoneId: midAnchor.id, suggestions: dup });
  ok("F1 upsert REFUSES two records in the same (branchIndex, seqIndex) seat", !!rdup.error, rdup.error || "accepted a duplicate seat");

  const rbad = await mcpCall(ROADS.demo, "suggestions_upsert",
                             { frontierMilestoneId: midAnchor.id, suggestions: [{ title: "x", plain: "x", branchIndex: 5, seqIndex: 0 }] });
  ok("F1 upsert REFUSES branchIndex 5 (max 5 directions, 0-4)", !!rbad.error, rbad.error || "accepted branchIndex 5");

  // A LOCKED, non-road-end milestone is still refused as an anchor. ROAD-END IS
  // PER QUEST (mcp/server.mjs isRoadEnd), so the filter has to be per quest too:
  // the last milestone of a SIDE quest is a road-end and anchors legitimately.
  const endOfQuest = {};
  for(const m of qData.milestones)
    endOfQuest[m.questId] = Math.max(endOfQuest[m.questId] ?? -Infinity, m.order || 0);
  const locked = qData.milestones.find(m => m.status === "locked" && (m.order || 0) < endOfQuest[m.questId]);
  if(locked){
    const rl = await mcpCall(ROADS.demo, "suggestions_upsert",
                             { frontierMilestoneId: locked.id, suggestions: [{ title: "x", plain: "x" }] });
    ok("F1 a locked non-road-end milestone is still refused as an anchor", !!rl.error, rl.error || "accepted a locked anchor");
  }
}

// the 15-fan renders, collision-free, as 5 rays of 3
{
  const d = roadData(ROADS.demo);
  const L = E.compute(d);
  assertInvariant("F1 15-item fan renders collision-free on real copied data", L);
  const mine = L.ghosts.filter(g => g.anchorId === midAnchor.id);
  ok("F1 all 15 possibilities are drawn", mine.length === 15, "got " + mine.length);
  const roots = mine.filter(g => g.role === "parallel");
  ok("F1 5 parallel roots (alternatives) + 10 sequential (consequences)",
     roots.length === 5 && mine.length - roots.length === 10,
     "roots=" + roots.length);
  // alternatives fan out BESIDE the anchor; consequences trail AFTER their root
  const anchor = L.pos[midAnchor.id];
  const byRay = new Map();
  for(const g of mine){ if(!byRay.has(g.branchIndex)) byRay.set(g.branchIndex, []); byRay.get(g.branchIndex).push(g); }
  let radialOk = true;
  for(const [, ray] of byRay){
    ray.sort((a,b) => a.seqIndex - b.seqIndex);
    for(let i = 1; i < ray.length; i++){
      const d0 = Math.hypot(ray[i-1].x-anchor.x, ray[i-1].y-anchor.y);
      const d1 = Math.hypot(ray[i].x-anchor.x, ray[i].y-anchor.y);
      if(!(d1 > d0)) radialOk = false;
    }
  }
  ok("F1 each ray's consequences sit further out than their root", radialOk);
}

// LEGACY records still render exactly as today's chain
{
  const legacy = {
    quests: [{ id: "q-main", type: "main", order: 0 }],
    milestones: [0,1,2].map(i => ({ id: "m"+i, questId: "q-main", order: i, title: "M"+i, status: "done" })),
    suggestions: [0,1,2].map(i => ({ id: "sg-legacy"+i, frontierMilestoneId: "m2", questId: "q-main", order: i, title: "legacy "+i, plain: "p" })),
    pins: [],
  };
  const L = E.compute(legacy);
  assertInvariant("F1 legacy (no branchIndex) records render", L);
  ok("F1 legacy set renders as ONE chain of 3", L.ghosts.length === 3, "got " + L.ghosts.length);
  ok("F1 legacy chain is 1 root + 2 consequences (today's shape)",
     L.ghosts.filter(g => g.role === "parallel").length === 1);
  // and a legacy record anchored at a NON road-end still does not render
  const stale = jclone(legacy);
  stale.suggestions.forEach(s => { s.frontierMilestoneId = "m1"; });
  ok("F1 legacy staleness rule is unchanged (non road-end anchor renders nothing)",
     E.compute(stale).ghosts.length === 0);
  // a GROUPED record at the same non-road-end anchor DOES render (new rule)
  const grouped = jclone(stale);
  grouped.suggestions.forEach((s, i) => { s.branchIndex = i; s.seqIndex = 0; });
  ok("F1 grouped records go stale only when the anchor is deleted",
     E.compute(grouped).ghosts.length === 3);
  const deleted = jclone(grouped);
  deleted.milestones = deleted.milestones.filter(m => m.id !== "m1");
  ok("F1 grouped records vanish when the anchor milestone is deleted",
     E.compute(deleted).ghosts.length === 0);
}

// PORTAL re-anchor (§3) — data untouched, render-time only
{
  const data = {
    quests: [{ id: "q-main", type: "main", order: 0 },
             { id: "q-side", type: "side", parentMilestoneId: "m1", side: "right", order: 0, title: "Side" }],
    milestones: [
      { id: "m0", questId: "q-main", order: 0, title: "M0", status: "done" },
      { id: "m1", questId: "q-main", order: 1, title: "M1", status: "done" },
      { id: "s0", questId: "q-side", order: 0, title: "real work", status: "done" },
      { id: "s1", questId: "q-side", order: 1, title: "the doorway", status: "in_progress" },
    ],
    suggestions: [0,1,2].map(i => ({ id: "sg-p"+i, frontierMilestoneId: "s1", questId: "q-side",
                                     order: 0, branchIndex: i, seqIndex: 0, title: "horizon "+i, plain: "p" })),
    pins: [],
  };
  const before = jclone(data.suggestions);
  const moved = F.reanchor(data.suggestions, data.milestones, { s1: true }, data.quests);
  ok("§3 a fan tagged to a portal re-anchors at the last REAL milestone",
     moved.length === 3 && moved.every(s => s.frontierMilestoneId === "s0"),
     JSON.stringify(moved.map(s => s.frontierMilestoneId)));
  ok("§3 re-anchoring records where it came from", moved.every(s => s.reanchoredFrom === "s1"));
  ok("§3 the suggestion DATA is untouched (render-time only)",
     JSON.stringify(before) === JSON.stringify(data.suggestions));
  ok("§3 a non-portal anchor is passed through unchanged",
     F.reanchor(data.suggestions, data.milestones, {}, data.quests)[0] === data.suggestions[0]);
  const L = E.compute(Object.assign({}, data, { suggestions: moved }));
  assertInvariant("§3 the re-anchored fan lays out collision-free", L);
  ok("§3 the fan now hangs off the real milestone on the map",
     L.ghosts.length === 3 && L.ghosts.every(g => g.anchorId === "s0"));
  // B3 — a quest that is NOTHING BUT the doorway (exactly what a promoted side
  // quest collapses to) used to drop its whole fan: grounded founder content
  // became invisible while the drawer still claimed it hung there. It now falls
  // back to the milestone the doorway's quest hangs off.
  const onlyPortal = jclone(data);
  onlyPortal.milestones = onlyPortal.milestones.filter(m => m.id !== "s0");
  const fellBack = F.reanchor(onlyPortal.suggestions, onlyPortal.milestones,
                              { s1: true }, onlyPortal.quests);
  ok("§3/B3 a quest that is only a doorway falls back to the doorway's PARENT milestone",
     fellBack.length === 3 && fellBack.every(s => s.frontierMilestoneId === "m1"),
     JSON.stringify(fellBack.map(s => s.frontierMilestoneId)));
  ok("§3/B3 the fallback is marked as coming from behind the door",
     fellBack.every(s => s.reanchoredFrom === "s1" && s.reanchoredViaParent === true));
  ok("§3/B3 nothing is dropped — on-disk count equals rendered count",
     fellBack.length === onlyPortal.suggestions.length);
  {
    const LB = E.compute(Object.assign({}, onlyPortal, { suggestions: fellBack }));
    assertInvariant("§3/B3 the fallen-back fan lays out collision-free", LB);
    ok("§3/B3 every record on disk is drawn as a ghost",
       LB.ghosts.length === onlyPortal.suggestions.length,
       LB.ghosts.length + " drawn of " + onlyPortal.suggestions.length);
  }
  // ...and it only vanishes when there is nothing real ANYWHERE up the chain
  const nothingReal = jclone(onlyPortal);
  nothingReal.quests[1].parentMilestoneId = null;
  ok("§3/B3 a doorway with no real milestone up the chain still renders nothing (no crash)",
     F.reanchor(nothingReal.suggestions, nothingReal.milestones, { s1: true },
                nothingReal.quests).length === 0);
  ok("§3/B3 the suggestion DATA is still untouched by the fallback",
     JSON.stringify(before) === JSON.stringify(data.suggestions));
}

// B3 on every road dataset this machine can offer: on-disk count MUST equal
// drawn ghost count. A DOORWAY is the whole shape a portal has in the data — the
// only milestone of a side quest — so it is derived here rather than named, and
// a fan tagged to one must still be drawn, re-anchored, exactly once.
{
  const B3_ROADS = [["demo", ROADS.demo], ["demo-2", ROADS.demo2]]
    .concat(REAL_ROADS.map((r, i) => ["real-" + (i + 1), r.root]));
  if(!REAL_ROADS.length) skip("B3 real roads", "no readable road registered in " + REGISTRY_SRC);
  for(const [name, dir] of B3_ROADS){
    const d = roadData(dir);
    const portals = {};
    const perQuest = {};
    for(const m of d.milestones) perQuest[m.questId] = (perQuest[m.questId] || 0) + 1;
    for(const m of d.milestones){
      const q = d.quests.find(x => x.id === m.questId);
      if(q && q.type === "side" && perQuest[m.questId] === 1) portals[m.id] = true;
    }
    const shown = F.reanchor(d.suggestions, d.milestones, portals, d.quests);
    const L = E.compute(Object.assign({}, d, { suggestions: shown }));
    ok("B3 road:" + name + " — every record on disk is drawn (" + d.suggestions.length + ")",
       d.suggestions.length === L.ghosts.length,
       d.suggestions.length + " on disk vs " + L.ghosts.length + " drawn");
    assertInvariant("B3 road:" + name + " with portal fans re-anchored", L);
    // the drawer's count is computed from THIS list, so per-anchor totals agree
    const perAnchor = {};
    for(const s of shown) perAnchor[s.frontierMilestoneId] = (perAnchor[s.frontierMilestoneId]||0)+1;
    const drawn = {};
    for(const g of L.ghosts) drawn[g.anchorId] = (drawn[g.anchorId]||0)+1;
    const norm = o => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
    ok("B3 road:" + name + " — the drawer's per-milestone count equals what is drawn",
       norm(perAnchor) === norm(drawn), norm(perAnchor) + " vs " + norm(drawn));
  }
}

// ---------------------------------------------------------------------------
// F2 — request more
// ---------------------------------------------------------------------------
console.log("\n== F2: request more ==");
await startServer();
{
  const st0 = await req("GET", "/api/r/rm-demo-2/state");
  ok("F2 the temp central server serves the copied road", st0.status === 200 && !!st0.body.roadmap);

  const sfData = roadData(ROADS.demo2);
  const target = sfData.milestones.find(m => m.status === "in_progress") || sfData.milestones[0];
  const before = historyActions(ROADS.demo2).length;
  const r = await req("POST", "/api/r/rm-demo-2/request-suggestions", { milestoneId: target.id });
  ok("F2 POST /api/request-suggestions accepts a real milestone", r.status === 200 && r.body.request && r.body.request.milestoneId === target.id,
     JSON.stringify(r.body));
  const sgFile = readJson(path.join(ROADS.demo2, ".questlog", "suggestions.json"), {});
  ok("F2 a pending marker is written into suggestions.json requests[]",
     Array.isArray(sgFile.requests) && sgFile.requests.some(x => x.milestoneId === target.id));
  ok("F2 the marker id matches the schema pattern rq-<8 hex>",
     /^rq-[0-9a-f]{8}$/.test((sgFile.requests.find(x => x.milestoneId === target.id)||{}).id || ""));
  const evts = historyActions(ROADS.demo2);
  ok("F2 a suggestion_request history event is appended",
     evts.length === before + 1 && evts[evts.length-1].action === "suggestion_request" &&
     evts[evts.length-1].targetId === target.id, JSON.stringify(evts[evts.length-1]));

  const again = await req("POST", "/api/r/rm-demo-2/request-suggestions", { milestoneId: target.id });
  const sgFile2 = readJson(path.join(ROADS.demo2, ".questlog", "suggestions.json"), {});
  ok("F2 asking twice re-stamps, never duplicates the marker",
     again.status === 200 && sgFile2.requests.filter(x => x.milestoneId === target.id).length === 1);

  const bad = await req("POST", "/api/r/rm-demo-2/request-suggestions", { milestoneId: "ms-not-here" });
  ok("F2 an unknown milestone is a 404", bad.status === 404);

  // the chip clears the moment a fresh upsert lands at that anchor
  const up = await mcpCall(ROADS.demo2, "suggestions_upsert", {
    frontierMilestoneId: target.id,
    suggestions: [{ title: "answered", plain: "the agent answered the request", branchIndex: 0, seqIndex: 0 }],
  });
  ok("F2 an agent answers through the existing suggestions_upsert path", !up.error, up.error);
  const sgFile3 = readJson(path.join(ROADS.demo2, ".questlog", "suggestions.json"), {});
  ok("F2 the pending marker is CLEARED by the fresh upsert",
     !Array.isArray(sgFile3.requests) || !sgFile3.requests.some(x => x.milestoneId === target.id));
}

// ---------------------------------------------------------------------------
// F3 — promote / demote
// ---------------------------------------------------------------------------
console.log("\n== F3: promote / demote ==");
// A dedicated road so the round-trip comparison is exact.
const P_ROOT = path.join(WORK, "road-parent");
const CHILD_DIR = path.join(WORK, "child-road");
function seedParent(){
  const ts = "2026-01-01T00:00:00.000Z";
  const q = (id, type, parent, order, title) => ({ id, type, title, parentMilestoneId: parent, side: type === "side" ? "right" : null, order, status: "in_progress", createdAt: ts, updatedAt: ts });
  const m = (id, questId, order, title) => ({ id, questId, order, title, summary: "", status: "available", statusReason: "", eta: null, startedAt: null, completedAt: null, createdAt: ts, updatedAt: ts });
  const rm = {
    schemaVersion: 1,
    project: { name: "Parent Road", tagline: "", createdAt: ts, updatedAt: ts },
    quests: [q("q-main", "main", null, 0, "Main Quest"),
             q("q-branch", "side", "ms-two", 0, "The Branch"),
             q("q-nested", "side", "ms-b1", 0, "Nested Under Branch")],
    milestones: [m("ms-one","q-main",0,"One"), m("ms-two","q-main",1,"Two"), m("ms-three","q-main",2,"Three"),
                 m("ms-b0","q-branch",0,"Branch zero"), m("ms-b1","q-branch",1,"Branch one"),
                 m("ms-n0","q-nested",0,"Nested zero")],
    items: [{ id: "it-1", milestoneId: "ms-b0", order: 0, kind: "task", title: "a task on the branch", body: "", status: "open", blockedReason: "", notes: [{ id: "note-1", author: "founder", body: "keep me", ts }], createdAt: ts, updatedAt: ts }],
    assets: [{ id: "as-1", milestoneId: "ms-b1", kind: "doc", label: "a doc", ref: "x.md", addedAt: ts }],
  };
  writeJson(path.join(P_ROOT, ".questlog", "roadmap.json"), rm);
  writeJson(path.join(P_ROOT, ".questlog", "decisions.json"), { schemaVersion: 1, decisions: [] });
  writeJson(path.join(P_ROOT, ".questlog", "pins.json"), { schemaVersion: 1, pins: [] });
  writeJson(path.join(P_ROOT, ".questlog", "suggestions.json"), {
    schemaVersion: 1,
    suggestions: [{ id: "sg-aaaaaaaa", frontierMilestoneId: "ms-b1", questId: "q-branch", title: "a branch horizon",
                    plain: "a possibility on the branch", order: 0, branchIndex: 0, seqIndex: 0,
                    createdAt: ts, updatedAt: ts }],
  });
  fs.writeFileSync(path.join(P_ROOT, ".questlog", "history.jsonl"), "");
}
// Comparison that ignores what a round trip is ALLOWED to change: generated
// ids, timestamps, and array order.
function normalizeRoad(rm){
  const strip = (o, drop) => {
    const c = {};
    for(const k of Object.keys(o).sort()) if(!drop.includes(k)) c[k] = o[k];
    return c;
  };
  const TS = ["createdAt", "updatedAt", "ts", "addedAt", "approvedAt"];
  return {
    quests: (rm.quests||[]).map(q => strip(q, TS)).sort((a,b) => String(a.id).localeCompare(String(b.id))),
    milestones: (rm.milestones||[]).map(m => strip(m, TS)).sort((a,b) => String(a.id).localeCompare(String(b.id))),
    items: (rm.items||[]).map(i => strip(Object.assign({}, i, { notes: (i.notes||[]).map(n => strip(n, TS)) }), TS))
      .sort((a,b) => String(a.id).localeCompare(String(b.id))),
    assets: (rm.assets||[]).map(a => strip(a, TS)).sort((a,b) => String(a.id).localeCompare(String(b.id))),
  };
}
{
  seedParent();
  // register the parent so a child can record its origin
  const reg0 = readJson(REGISTRY, {});
  reg0.roadmaps.push({ id: "rm-parent", name: "Parent Road", dir: P_ROOT, addedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" });
  writeJson(REGISTRY, reg0);

  const beforeRm = readJson(path.join(P_ROOT, ".questlog", "roadmap.json"), {});
  const beforeNorm = normalizeRoad(beforeRm);
  const beforeParentHist = historyActions(P_ROOT).length;

  // ---- PROMOTE ----
  const pr = await req("POST", "/api/r/rm-parent/promote", { questId: "q-branch", targetDir: CHILD_DIR });
  ok("F3 promote succeeds", pr.status === 200 && pr.body.ok, JSON.stringify(pr.body));
  const portalId = pr.body && pr.body.portalMilestoneId;
  const childId = pr.body && pr.body.childId;

  const afterPromote = readJson(path.join(P_ROOT, ".questlog", "roadmap.json"), {});
  ok("F3 the side quest collapsed to exactly ONE portal milestone",
     afterPromote.milestones.filter(m => m.questId === "q-branch").length === 1 &&
     afterPromote.milestones.some(m => m.id === portalId));
  ok("F3 the nested sub-branch travelled with it (no orphan quest left behind)",
     !afterPromote.quests.some(q => q.id === "q-nested"));
  ok("F3 the branch's milestones, items and assets left the parent",
     !afterPromote.milestones.some(m => ["ms-b0","ms-b1","ms-n0"].includes(m.id)) &&
     !(afterPromote.items||[]).some(i => i.id === "it-1") &&
     !(afterPromote.assets||[]).some(a => a.id === "as-1"));
  ok("F3 the main road is untouched by the promotion",
     ["ms-one","ms-two","ms-three"].every(id => afterPromote.milestones.some(m => m.id === id)));

  const childRm = readJson(path.join(CHILD_DIR, ".questlog", "roadmap.json"), {});
  ok("F3 the child road has the branch as its MAIN quest, ids preserved",
     childRm.quests.some(q => q.id === "q-branch" && q.type === "main") &&
     childRm.milestones.length === 3 &&
     ["ms-b0","ms-b1","ms-n0"].every(id => childRm.milestones.some(m => m.id === id)));
  ok("F3 the child carries the items (with their notes) and assets",
     (childRm.items||[]).some(i => i.id === "it-1" && (i.notes||[]).length === 1) &&
     (childRm.assets||[]).some(a => a.id === "as-1"));
  const childSug = readJson(path.join(CHILD_DIR, ".questlog", "suggestions.json"), {});
  ok("F3 the branch's horizons moved with it",
     (childSug.suggestions||[]).some(s => s.id === "sg-aaaaaaaa"));
  const parentSug = readJson(path.join(P_ROOT, ".questlog", "suggestions.json"), {});
  ok("F3 and left the parent", !(parentSug.suggestions||[]).some(s => s.id === "sg-aaaaaaaa"));

  const regAfter = readJson(REGISTRY, {});
  const childEntry = (regAfter.roadmaps||[]).find(e => e.id === childId);
  ok("F3 the registry GAINED the origin edge",
     !!childEntry && childEntry.origin && childEntry.origin.roadmapId === "rm-parent" &&
     childEntry.origin.milestoneId === portalId, JSON.stringify(childEntry && childEntry.origin));

  const dec = readJson(path.join(P_ROOT, ".questlog", "decisions.json"), {});
  ok("F3 a decision_log entry records the promotion",
     (dec.decisions||[]).some(d => d.status === "approved" && /Promoted/.test(d.title||"")));
  const pHist = historyActions(P_ROOT);
  ok("F3 the parent history logs the promotion",
     pHist.length > beforeParentHist && pHist.some(e => e.action === "promote"));
  ok("F3 the child history logs it too",
     historyActions(CHILD_DIR).some(e => e.action === "promote"));

  // ---- orphan refusal: a road with a child of its own cannot be dissolved ----
  const GRAND = path.join(WORK, "grandchild-road");
  const gp = await req("POST", "/api/r/" + childId + "/promote", { questId: "q-nested", targetDir: GRAND });
  ok("F3 the child can itself promote a branch (grandchild created)", gp.status === 200 && gp.body.ok, JSON.stringify(gp.body));
  const refuse = await req("POST", "/api/demote", { childId });
  ok("F3 demoting a road that HAS children is REFUSED",
     refuse.status === 409 && refuse.body.error === "E_HAS_CHILDREN", JSON.stringify(refuse.body));
  const dg = await req("POST", "/api/demote", { childId: gp.body.childId });
  ok("F3 the grandchild dissolves back into the child", dg.status === 200 && dg.body.ok, JSON.stringify(dg.body));

  // ---- DEMOTE (round trip) ----
  const beforeChildHist = historyActions(CHILD_DIR).length;
  const dm = await req("POST", "/api/demote", { childId });
  ok("F3 demote succeeds", dm.status === 200 && dm.body.ok, JSON.stringify(dm.body));

  const afterRm = readJson(path.join(P_ROOT, ".questlog", "roadmap.json"), {});
  const afterNorm = normalizeRoad(afterRm);
  ok("F3 ROUND TRIP: the parent road is equivalent to before, modulo ids + timestamps",
     JSON.stringify(beforeNorm) === JSON.stringify(afterNorm),
     JSON.stringify(beforeNorm) === JSON.stringify(afterNorm) ? "" :
       ("before=" + JSON.stringify(beforeNorm).slice(0, 400) + "\n        after =" + JSON.stringify(afterNorm).slice(0, 400)));
  ok("F3 the portal milestone is gone (no orphan doorway)",
     !afterRm.milestones.some(m => m.id === portalId));
  const parentSug2 = readJson(path.join(P_ROOT, ".questlog", "suggestions.json"), {});
  ok("F3 the horizons came back with the milestones",
     (parentSug2.suggestions||[]).some(s => s.id === "sg-aaaaaaaa"));

  const decEnd = readJson(path.join(P_ROOT, ".questlog", "decisions.json"), {});
  ok("F3 NO DANGLING REFS: nothing still points at the vanished portal milestone",
     !(decEnd.decisions||[]).some(d => (d.relatedMilestoneIds||[]).includes(portalId)));
  ok("F3 the promotion ruling is marked superseded by the reversal ruling",
     (decEnd.decisions||[]).some(d => /Promoted/.test(d.title||"") && typeof d.supersededBy === "string" &&
       (decEnd.decisions||[]).some(n => n.id === d.supersededBy && /Dissolved/.test(n.title||""))));

  const regEnd = readJson(REGISTRY, {});
  ok("F3 the registry LOST the edge (and the entry)",
     !(regEnd.roadmaps||[]).some(e => e.id === childId));
  ok("F3 both histories log the demotion",
     historyActions(P_ROOT).some(e => e.action === "demote") &&
     historyActions(CHILD_DIR).length > beforeChildHist &&
     historyActions(CHILD_DIR).some(e => e.action === "demote"));
  // no data was orphaned in either direction
  const inline = new Set(afterRm.milestones.map(m => m.id));
  ok("F3 NO ORPHANS: every milestone that left is back on the parent",
     ["ms-b0","ms-b1","ms-n0"].every(id => inline.has(id)));
  ok("F3 NO ORPHANS: items and assets came home too",
     (afterRm.items||[]).some(i => i.id === "it-1" && (i.notes||[]).length === 1) &&
     (afterRm.assets||[]).some(a => a.id === "as-1"));

  // refusals
  const r404 = await req("POST", "/api/demote", { childId: "rm-nope" });
  ok("F3 demoting an unknown road is a 404", r404.status === 404);
  const rMain = await req("POST", "/api/r/rm-parent/promote", { questId: "q-main", targetDir: path.join(WORK, "nope") });
  ok("F3 the MAIN quest can never be promoted", rMain.status === 400, JSON.stringify(rMain.body));
  const rSelf = await req("POST", "/api/r/rm-parent/promote", { questId: "q-branch", targetDir: P_ROOT });
  ok("F3 promoting into a road's own folder is refused", rSelf.status === 400, JSON.stringify(rSelf.body));
}

// ---------------------------------------------------------------------------
// F4 — expand in place
// ---------------------------------------------------------------------------
console.log("\n== F4: expand in place ==");
{
  const parent = roadData(ROADS.demo2);
  const child = roadData(ROADS.demo);
  const mq = parent.quests.find(q => q.type === "main");
  const pMain = parent.milestones.filter(m => m.questId === mq.id).sort((a,b) => (a.order||0)-(b.order||0));
  const portalMs = pMain[Math.floor(pMain.length/2)];

  const collapsed = E.compute(parent);
  assertInvariant("F4 collapsed layout satisfies the predicate", collapsed);
  const before = posSnapshot(collapsed);

  const expanded = E.compute(parent, { expanded: { [portalMs.id]: child } });
  assertInvariant("F4 EXPANDED layout satisfies the predicate (the founder's condition)", expanded);
  ok("F4 exactly one block was injected", (expanded.blocks||[]).length === 1);
  const blk = expanded.blocks[0];
  ok("F4 the block carries every child drawable",
     blk.nodes.length === child.milestones.length + 0 || blk.nodes.length >= child.milestones.length,
     "block nodes=" + blk.nodes.length + " child milestones=" + child.milestones.length);
  ok("F4 the portal itself did NOT move (only downstream reflows)",
     expanded.pos[portalMs.id].y === collapsed.pos[portalMs.id].y &&
     expanded.pos[portalMs.id].x === collapsed.pos[portalMs.id].x);
  const idx = pMain.findIndex(m => m.id === portalMs.id);
  const down = pMain[idx+1];
  if(down){
    ok("F4 the road BELOW the portal reflowed down by at least the block height",
       expanded.pos[down.id].y - collapsed.pos[down.id].y >= blk.h,
       "shift=" + (expanded.pos[down.id].y - collapsed.pos[down.id].y) + " block h=" + blk.h);
  }
  ok("F4 the block does not overlap ANY parent element",
     !expanded.elements.some(e => !String(e.id).startsWith("blk:") && E.overlaps(e.box, blk.box)));

  // collapse -> byte-identical layout again
  const recollapsed = E.compute(parent);
  ok("F4 COLLAPSE restores the exact pre-expand layout",
     JSON.stringify(before) === JSON.stringify(posSnapshot(recollapsed)));
  assertInvariant("F4 layout after collapse still satisfies the predicate", recollapsed);

  // the whole cycle, twice, keeping the predicate true at every step
  let cycleOk = true;
  for(let i = 0; i < 2; i++){
    if(!E.invariant(E.compute(parent)).ok) cycleOk = false;
    if(!E.invariant(E.compute(parent, { expanded: { [portalMs.id]: child } })).ok) cycleOk = false;
    if(!E.invariant(E.compute(parent)).ok) cycleOk = false;
  }
  ok("F4 the predicate holds at EVERY step of two expand/collapse cycles", cycleOk);

  // two portals expanded at once
  const other = pMain[Math.max(0, idx-2)];
  if(other && other.id !== portalMs.id){
    const both = E.compute(parent, { expanded: { [portalMs.id]: child, [other.id]: roadData(ROADS.demo) } });
    assertInvariant("F4 TWO portals expanded at once", both);
    ok("F4 two blocks injected", (both.blocks||[]).length === 2);
  }

  // ---- camera bookkeeping (pure) ----
  const stack = new F.CamStack();
  const cam0 = { tx: 120, ty: -40, s: 0.8 };
  const scr = F.screenOf(cam0, expanded.pos[portalMs.id].x, expanded.pos[portalMs.id].y);
  stack.push("p", cam0);
  const pin = F.pinTo({ tx: 999, ty: 999, s: cam0.s }, expanded.pos[portalMs.id].x, expanded.pos[portalMs.id].y, scr.x, scr.y);
  const scr2 = F.screenOf(pin, expanded.pos[portalMs.id].x, expanded.pos[portalMs.id].y);
  ok("F4 the portal keeps its exact screen position across the expansion",
     Math.abs(scr2.x - scr.x) < 1e-9 && Math.abs(scr2.y - scr.y) < 1e-9);
  const restored = stack.pop("p");
  ok("F4 COLLAPSE restores the pre-expand camera exactly",
     restored.tx === cam0.tx && restored.ty === cam0.ty && restored.s === cam0.s);
  ok("F4 the restore point is consumed once", stack.pop("p") === null && !stack.has("p"));
  const u = F.unionBox(expanded.pos[portalMs.id].box, blk.box);
  const bb = F.boxToBBox(u, 24);
  ok("F4 the fit target covers portal ∪ block",
     bb.x <= Math.min(expanded.pos[portalMs.id].box.x0, blk.box.x0) &&
     bb.x + bb.w >= Math.max(expanded.pos[portalMs.id].box.x1, blk.box.x1) &&
     bb.y + bb.h >= blk.box.y1);

  // ---- the expanded SET lives in localStorage only ----
  const mem = {};
  const store = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
  ok("F4 the expanded set starts empty", F.loadExpanded(store, "rm-x").length === 0);
  F.toggleExpanded(store, "rm-x", "ms-a");
  F.toggleExpanded(store, "rm-x", "ms-b");
  ok("F4 the expanded set persists per road, deterministically ordered",
     JSON.stringify(F.loadExpanded(store, "rm-x")) === JSON.stringify(["ms-a", "ms-b"]));
  ok("F4 it is keyed per roadmap id", F.loadExpanded(store, "rm-y").length === 0);
  F.toggleExpanded(store, "rm-x", "ms-a");
  ok("F4 toggling again collapses", JSON.stringify(F.loadExpanded(store, "rm-x")) === JSON.stringify(["ms-b"]));
  ok("F4 the storage key is namespaced per road", F.expandKey("rm-x") === "questlog.expand.rm-x");
  ok("F4 corrupt storage degrades to empty (never throws)",
     (() => { mem["questlog.expand.rm-x"] = "{not json"; return F.loadExpanded(store, "rm-x").length === 0; })());
  ok("F4 NOTHING about expansion was written to a data file",
     !fs.readdirSync(path.join(ROADS.demo2, ".questlog"), { withFileTypes: true })
       .filter(e => e.isFile())
       .some(e => fs.readFileSync(path.join(ROADS.demo2, ".questlog", e.name), "utf8").includes("questlog.expand")));
}

// ---------------------------------------------------------------------------
// schema validator agrees with everything written above
// ---------------------------------------------------------------------------
console.log("\n== schema validator on every road this test wrote ==");
{
  const { validateDir } = await import("./schema/validate.mjs");
  for(const [name, root] of [["demo copy", ROADS.demo], ["second demo copy", ROADS.demo2], ["parent", P_ROOT]]){
    const errs = validateDir(root);
    ok("validate.mjs is clean on the " + name + " road", errs.length === 0, errs.slice(0, 3).join(" | "));
  }
  // A road this repo does not own is allowed to carry its own errors; what this
  // test owes is that it did not ADD one.
  for(const r of REAL_ROADS){
    const introduced = validateDir(r.root).filter(e => !REAL_BASELINE.get(r.root).has(e));
    ok(r.label + ": this test introduced NO NEW validation error",
       introduced.length === 0, introduced.slice(0, 3).join(" | "));
  }
}

stopServer();
console.log("\n---------------------------------------------");
console.log(fail === 0 ? ("ALL GREEN — " + pass + " assertions passed" + (skipped ? ", " + skipped + " skipped" : ""))
                       : (fail + " FAILED of " + (pass + fail) + "\n" + failures.map(f => "  - " + f).join("\n")));
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { stopServer(); console.error("SELFTEST CRASHED:", err); process.exit(1); });
