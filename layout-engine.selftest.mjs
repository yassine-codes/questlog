#!/usr/bin/env node
// ---------------------------------------------------------------------------
// LAYOUT COLLISION ENGINE — selftest (zero deps).
//
// Extracts the QL_ENGINE block verbatim from index.html (between the
// QL_ENGINE_BEGIN / QL_ENGINE_END markers) and asserts the overlap predicate
// across:
//   (a) the bundled demo road, plus whatever real roads this machine has
//       registered in the overworld — all read-only
//   (b) synthetic stress cases  — 5-wide fan with 3-deep tails on three
//       adjacent anchors, a nested branch three levels deep, an injected child
//       road of 24 milestones mid-map
//   (c) 50 seeded-random fuzz road states
//   (d) determinism  — layout(sameData) twice => deep-equal positions
//   (e) stability    — adding one milestone moves nothing earlier in canonical
//       order
//
// Usage: node layout-engine.selftest.mjs [--verbose]
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes("--verbose");

// ---- load the engine straight out of index.html (no duplicated source) ----
function loadEngine(){
  const html = fs.readFileSync(path.join(HERE, "index.html"), "utf8");
  const a = html.indexOf("// ==== QL_ENGINE_BEGIN ====");
  const b = html.indexOf("// ==== QL_ENGINE_END ====");
  if(a < 0 || b < 0) throw new Error("QL_ENGINE markers not found in index.html");
  const src = html.slice(a, b);
  const fn = new Function(src + "\n; return QL_ENGINE;");
  return fn();
}
const E = loadEngine();

let pass = 0, fail = 0, skipped = 0;
const failures = [];
function ok(name, cond, detail){
  if(cond){ pass++; if(VERBOSE) console.log("  ok   " + name); }
  else { fail++; failures.push(name + (detail ? " — " + detail : "")); console.log("  FAIL " + name + (detail ? " — " + detail : "")); }
}
// A group whose data is not on this machine SKIPS, loudly, with the reason. It
// never records a FAIL: a fresh clone owns none of the founder's roads, and a
// public repo whose selftests are red out of the box is a defect, not a finding.
function skip(name, why){ skipped++; console.log("  SKIP " + name + " — " + why); }
function assertInvariant(name, L){
  const v = E.invariant(L);
  const d = v.ok ? "" : (v.violations.length + " violations, first: " + JSON.stringify(v.violations[0]));
  ok(name + " [" + L.elements.length + " boxes / " + L.connectors.length + " connectors]", v.ok, d);
  return v;
}

// ---- deterministic PRNG (mulberry32) -------------------------------------
function rng(seed){
  let t = seed >>> 0;
  return function(){
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function posSnapshot(L){
  const o = {};
  for(const e of L.elements) o[e.id] = [Math.round(e.x*1000)/1000, Math.round(e.y*1000)/1000];
  return o;
}

// ---------------------------------------------------------------------------
// (a) road datasets — read-only
//
// The DEMO road ships in the repo, so every case below has data on a fresh
// clone. REAL roads are whatever this machine has registered in the overworld:
// they are the only data shaped by somebody actually walking a road, so when
// they are present they get the same read-only sweep, and when they are absent
// the group SKIPS and says which registry it looked in. Nothing here writes.
// ---------------------------------------------------------------------------
const DEMO_DIR = path.join(HERE, "seeds", "sample-project", ".questlog");
const REGISTRY_PATH = process.env.QUESTLOG_REGISTRY ||
                      path.join(os.homedir(), ".questlog", "registry.json");
function registeredRoads(){
  let reg = null;
  try { reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")); } catch { return []; }
  const out = [];
  for(const r of (reg && Array.isArray(reg.roadmaps)) ? reg.roadmaps : []){
    if(!r || typeof r.dir !== "string") continue;
    const dir = path.join(r.dir, ".questlog");
    if(fs.existsSync(path.join(dir, "roadmap.json"))) out.push(dir);
  }
  return out;
}
const ROAD_DIRS = [["demo", DEMO_DIR]];
registeredRoads().forEach((dir, i) => ROAD_DIRS.push(["real-" + (i + 1), dir]));
function readRoad(dir){
  const rm = JSON.parse(fs.readFileSync(path.join(dir, "roadmap.json"), "utf8"));
  let sg = { suggestions: [] };
  try { sg = JSON.parse(fs.readFileSync(path.join(dir, "suggestions.json"), "utf8")); } catch {}
  let pn = { pins: [] };
  try { pn = JSON.parse(fs.readFileSync(path.join(dir, "pins.json"), "utf8")); } catch {}
  return { quests: rm.quests||[], milestones: rm.milestones||[],
           suggestions: sg.suggestions||[], pins: pn.pins||[] };
}

console.log("\n== (a) road datasets (read-only) ==");
const roadData = {};
for(const [name, dir] of ROAD_DIRS){
  const d = readRoad(dir);
  roadData[name] = d;
  const L = E.compute(d);
  assertInvariant("road:" + name, L);
  // determinism on the same bytes read twice
  const L2 = E.compute(readRoad(dir));
  ok("road:" + name + " deterministic",
     JSON.stringify(posSnapshot(L)) === JSON.stringify(posSnapshot(L2)));
  if(VERBOSE){
    console.log("     main=" + L.mainMs.length + " branches=" + L.branches.length +
                " ghosts=" + L.ghosts.length + " bbox=" + JSON.stringify(L.bbox));
  }
}
if(ROAD_DIRS.length === 1)
  skip("real roads", "no readable road registered in " + REGISTRY_PATH);

// ---------------------------------------------------------------------------
// synthetic road builders
// ---------------------------------------------------------------------------
function road(nMain){
  const quests = [{ id:"q-main", type:"main", order:0 }];
  const milestones = [];
  for(let i=0;i<nMain;i++) milestones.push({ id:"m"+i, questId:"q-main", order:i, title:"Main "+i, status:"available" });
  return { quests, milestones, suggestions:[], pins:[] };
}
function addBranch(d, id, parentMsId, n, side, order){
  d.quests.push({ id, type:"side", parentMilestoneId:parentMsId, side:side||null, order:order||0, title:id });
  for(let i=0;i<n;i++) d.milestones.push({ id:id+"-"+i, questId:id, order:i, title:id+" "+i, status:"available" });
  return d;
}
// a 5-wide fan with 3-deep tails at one anchor => 5 roots + 5*3 children = 20
function addFan(d, anchorId, widths){
  widths = widths || [3,3,3,3,3];
  for(let b=0;b<widths.length;b++){
    for(let s=0;s<=widths[b];s++){
      d.suggestions.push({
        id:"sug-"+anchorId+"-"+b+"-"+s, frontierMilestoneId:anchorId,
        branchIndex:b, seqIndex:s, order:b*10+s,
        title:"horizon "+b+"."+s, plain:"a possibility",
      });
    }
  }
  return d;
}

// ---------------------------------------------------------------------------
// (b) synthetic stress cases
// ---------------------------------------------------------------------------
console.log("\n== (b) synthetic stress cases ==");

// S1 — 5-wide fan with 3-deep tails on THREE ADJACENT anchors
{
  const d = road(8);
  addFan(d, "m2"); addFan(d, "m3"); addFan(d, "m4");
  const L = E.compute(d);
  assertInvariant("S1 5x3 fans on three adjacent anchors", L);
  ok("S1 ghost count = 60", L.ghosts.length === 60, "got " + L.ghosts.length);
  const roots = L.ghosts.filter(g => g.role === "parallel").length;
  ok("S1 parallel roots = 15 (5 per anchor)", roots === 15, "got " + roots);
}

// S2 — nested branch three levels deep
{
  const d = road(6);
  addBranch(d, "q-l1", "m2", 4, "right", 0);
  addBranch(d, "q-l2", "q-l1-1", 4, null, 0);
  addBranch(d, "q-l3", "q-l2-1", 4, null, 0);
  const L = E.compute(d);
  assertInvariant("S2 nested branch, three levels deep", L);
  ok("S2 branch count = 3", L.branches.length === 3, "got " + L.branches.length);
  const depths = L.branches.map(b => b.nodes.length).join(",");
  ok("S2 all branch nodes placed", depths === "4,4,4", depths);
}

// S2b — nested three levels deep PLUS multiple branches on the same parent
{
  const d = road(6);
  addBranch(d, "q-a", "m2", 3, "right", 0);
  addBranch(d, "q-b", "m2", 3, "right", 1);   // same parent, same side -> lane 1
  addBranch(d, "q-c", "m2", 3, "left", 2);
  addBranch(d, "q-a2", "q-a-1", 3, null, 0);
  addBranch(d, "q-a3", "q-a2-1", 3, null, 0);
  const L = E.compute(d);
  assertInvariant("S2b nested + multi-lane on one parent", L);
}

// S3 — simulated injected child road of 24 milestones mid-map
{
  const parent = road(9);
  addBranch(parent, "q-side", "m6", 3, "left", 0);
  addFan(parent, "m8", [2,2,2]);
  const child = road(24);
  addBranch(child, "q-child-side", "m5", 3, "right", 0);
  const L = E.compute(parent, { expanded: { m4: child } });
  assertInvariant("S3 injected 24-milestone child road mid-map", L);
  ok("S3 one block injected", L.blocks.length === 1, "got " + L.blocks.length);
  ok("S3 block carries 27 child boxes",
     L.blocks[0] && L.blocks[0].nodes.length === 27,
     "got " + (L.blocks[0] ? L.blocks[0].nodes.length : "none"));
  // reflow, never overdraw: everything downstream of the portal moved DOWN
  const flat = E.compute(parent);
  const gap = L.pos.m5.y - flat.pos.m5.y;
  ok("S3 downstream main road reflowed by the block height", gap > L.blocks[0].h, "gap=" + gap);
  ok("S3 upstream main road untouched", L.pos.m0.y === flat.pos.m0.y && L.pos.m4.y === flat.pos.m4.y);
}

// S4 — the everything case: the demo road + fans + a nested branch + a block.
// ms-polish-icons already sits on the side quest q-polish, so hanging q-stress
// off it is a third-level nest.
{
  const d = JSON.parse(JSON.stringify(roadData.demo));
  addBranch(d, "q-stress", "ms-polish-icons", 4, null, 0);   // 3rd level nest
  addFan(d, "ms-launch");
  addFan(d, "ms-feedback", [1,1,1]);
  const L = E.compute(d, { expanded: { "ms-mvp": road(24) } });
  assertInvariant("S4 demo road + fans + nesting + injected block", L);
}

// ---------------------------------------------------------------------------
// (c) fuzz — 50 seeded-random road states
// ---------------------------------------------------------------------------
console.log("\n== (c) fuzz: 50 seeded-random road states ==");
let fuzzFail = 0, worst = null;
for(let seed = 1; seed <= 50; seed++){
  const R = rng(seed * 7919);
  const nMain = 3 + Math.floor(R() * 14);
  const d = road(nMain);
  const nBranch = Math.floor(R() * 6);
  const placed = ["__main__"];
  for(let b = 0; b < nBranch; b++){
    const anchorPool = d.milestones.map(m => m.id);
    const anchor = anchorPool[Math.floor(R() * anchorPool.length)];
    const n = 1 + Math.floor(R() * 5);
    const side = R() < 0.5 ? "left" : "right";
    addBranch(d, "qf" + seed + "-" + b, anchor, n, side, b);
  }
  // fans: 0-3 anchors, up to 5 wide x 3 deep
  const nFans = Math.floor(R() * 4);
  for(let f = 0; f < nFans; f++){
    const anchor = d.milestones[Math.floor(R() * d.milestones.length)].id;
    const w = 1 + Math.floor(R() * 5);
    const widths = [];
    for(let k = 0; k < w; k++) widths.push(Math.floor(R() * 4) - 1);
    addFan(d, anchor, widths.map(x => Math.max(0, x)));
  }
  // one expanded block in ~half the cases
  const opts = {};
  if(R() < 0.5){
    const anchor = d.milestones[Math.floor(R() * d.milestones.length)].id;
    opts.expanded = {}; opts.expanded[anchor] = road(2 + Math.floor(R() * 24));
  }
  const L = E.compute(d, opts);
  const v = E.invariant(L);
  if(!v.ok){
    fuzzFail++;
    if(!worst) worst = { seed, v, L };
  }
  // determinism inside the fuzz loop too
  const L2 = E.compute(d, opts);
  if(JSON.stringify(posSnapshot(L)) !== JSON.stringify(posSnapshot(L2))){
    ok("fuzz seed " + seed + " deterministic", false);
  }
}
ok("fuzz: 50/50 road states satisfy the predicate", fuzzFail === 0,
   fuzzFail ? (fuzzFail + " failed; first seed " + worst.seed + " -> " +
               JSON.stringify(worst.v.violations[0])) : "");

// ---------------------------------------------------------------------------
// (d) determinism — layout(sameData) twice => deep-equal positions
// ---------------------------------------------------------------------------
console.log("\n== (d) determinism ==");
{
  const d = road(10);
  addBranch(d, "q-x", "m3", 4, "left", 0);
  addBranch(d, "q-y", "m3", 4, "left", 1);
  addBranch(d, "q-z", "q-x-2", 3, null, 0);
  addFan(d, "m5"); addFan(d, "m9", [2,2]);
  const opts = { expanded: { m7: road(12) } };
  const A = E.compute(d, opts), B = E.compute(d, opts);
  ok("determinism: two layouts deep-equal",
     JSON.stringify(posSnapshot(A)) === JSON.stringify(posSnapshot(B)));
  // key-order independence: shuffling the input arrays must not change output
  const shuffled = JSON.parse(JSON.stringify(d));
  shuffled.milestones.reverse(); shuffled.quests.reverse(); shuffled.suggestions.reverse();
  const C = E.compute(shuffled, { expanded: { m7: road(12) } });
  ok("determinism: input array order does not change output",
     JSON.stringify(posSnapshot(A)) === JSON.stringify(posSnapshot(C)));
}

// ---------------------------------------------------------------------------
// (e) stability — adding one milestone moves nothing earlier in canonical order
// ---------------------------------------------------------------------------
console.log("\n== (e) stability ==");
// The contract's guarantee, stated precisely: "placing element N may move only
// elements later in canonical order". L.elements IS the canonical placement
// order, so: everything placed BEFORE the newly inserted element must be
// byte-identical, and nothing may move that is not downstream of the insert.
// `strict` additionally demands that NOTHING moved at all.
function stability(name, base, mutate, newIds, strict){
  const before = E.compute(base);
  const after = E.compute(mutate(JSON.parse(JSON.stringify(base))));
  const sb = posSnapshot(before), sa = posSnapshot(after);
  const order = after.elements.map(e => e.id);
  let k = Infinity;
  for(const nid of (newIds||[])){ const i = order.indexOf(nid); if(i >= 0 && i < k) k = i; }
  const prefix = new Set(order.slice(0, k === Infinity ? order.length : k));
  const moved = Object.keys(sb).filter(id => sa[id] && (sa[id][0] !== sb[id][0] || sa[id][1] !== sb[id][1]));
  const movedInPrefix = moved.filter(id => prefix.has(id));
  if(strict){
    ok("stability(strict): " + name, moved.length === 0,
       moved.length ? ("moved: " + moved.slice(0,6).join(",")) : "");
  }
  ok("stability(prefix): " + name + " — " + prefix.size + " earlier elements pinned",
     movedInPrefix.length === 0, movedInPrefix.slice(0,6).join(","));
  return { before, after, moved };
}
{
  const base = road(8);
  addBranch(base, "q-s", "m3", 3, "right", 0);
  addBranch(base, "q-s2", "q-s-1", 2, null, 0);
  addFan(base, "m7", [2,2,2]);
  stability("append a main milestone", base, d => {
    d.milestones.push({ id: "m8", questId: "q-main", order: 8, title: "Main 8", status: "available" });
    return d;
  }, ["m8"]);
  stability("append a branch milestone", base, d => {
    d.milestones.push({ id: "q-s-3", questId: "q-s", order: 3, title: "Side 3", status: "available" });
    return d;
  }, ["q-s-3"]);
  stability("append a nested-branch milestone", base, d => {
    d.milestones.push({ id: "q-s2-2", questId: "q-s2", order: 2, title: "Nested 2", status: "available" });
    return d;
  }, ["q-s2-2"]);
  stability("add a whole new branch on the LAST main node", base, d =>
    addBranch(d, "q-new", "m7", 3, "left", 9), ["q-new-0"]);
  // deepening a fan tail must not move the other rays' roots
  stability("deepen one fan ray", base, d => {
    d.suggestions.push({ id: "sug-m7-0-3", frontierMilestoneId: "m7", branchIndex: 0, seqIndex: 3,
                         order: 3, title: "deeper" });
    return d;
  }, ["ghost:sug-m7-0-3"]);
  // STRICT: a mutation that touches nothing already placed must move NOTHING.
  // (branch appended to the deepest nested quest of a road with no ghosts)
  const clean = road(8);
  addBranch(clean, "q-c", "m3", 3, "right", 0);
  addBranch(clean, "q-c2", "q-c-1", 2, null, 0);
  stability("append to the last-placed nested branch (no ghosts)", clean, d => {
    d.milestones.push({ id: "q-c2-2", questId: "q-c2", order: 2, title: "N2", status: "available" });
    return d;
  }, ["q-c2-2"], true);
}
// stability on the REAL roads: append one milestone to the end of the main quest.
// NOTE the legacy ghosts at the OLD road-end correctly disappear — a legacy
// (ungrouped) suggestion is only honoured while its frontier is still a
// road-end. That is today's rule, preserved verbatim; the prefix assertion is
// what the engine owes.
for(const name of Object.keys(roadData)){
  const base = roadData[name];
  const mainQ = base.quests.find(q => q.type === "main");
  const maxOrder = Math.max(...base.milestones.filter(m => m.questId === mainQ.id).map(m => m.order || 0));
  const { before, after } = stability("road:" + name + " + one main milestone", base, d => {
    d.milestones.push({ id: "zz-new", questId: mainQ.id, order: maxOrder + 1, title: "New", status: "locked" });
    return d;
  }, ["zz-new"]);
  // every REAL milestone (main + branch + nested) must be exactly where it was
  const sb = posSnapshot(before), sa = posSnapshot(after);
  const realIds = base.milestones.map(m => m.id).filter(id => sb[id]);
  const moved = realIds.filter(id => !sa[id] || sa[id][0] !== sb[id][0] || sa[id][1] !== sb[id][1]);
  ok("stability: road:" + name + " — all " + realIds.length + " existing milestones unmoved",
     moved.length === 0, moved.slice(0,6).join(","));
}

// ---------------------------------------------------------------------------
// (e2) B1 — NO EXILED FAN RAYS. The predicate can be perfectly satisfied by a
// layout that still reads wrong: a ray whose fixed heading pointed through an
// existing branch used to march radially (RAD_STEP x R_GUARD = up to 12,800px)
// until it cleared everything, landing one "alternative" 40x further from the
// anchor than its siblings — thousands of pixels off-screen. A ray is now
// re-seated into a free ANGULAR slot before its radius grows, and a root is
// capped at FAN_CAP x the fan's base radius. Commission an IDENTICAL fan at
// every anchorable milestone of both real roads and measure the spread.
// ---------------------------------------------------------------------------
console.log("\n== (e2) fan spread: identical fans at every anchorable milestone ==");
const FAN_CAP = 1.5;   // must match the engine constant
function fanSpread(base, label){
  let worst = 0, worstAt = "", anchors = 0, badPredicate = 0;
  for(const m of base.milestones){
    const d = JSON.parse(JSON.stringify(base));
    d.suggestions = [];                                  // isolate: only this fan
    for(let b = 0; b < 3; b++) d.suggestions.push({
      id: "probe-" + m.id + "-" + b, frontierMilestoneId: m.id,
      branchIndex: b, seqIndex: 0, order: b, title: "probe " + b, plain: "p" });
    const L = E.compute(d);
    if(!E.invariant(L).ok) badPredicate++;
    const a = L.pos[m.id];
    const roots = L.ghosts.filter(g => g.role === "parallel");
    if(roots.length !== 3 || !a) continue;
    anchors++;
    const radii = roots.map(g => Math.hypot(g.x - a.x, g.y - a.y));
    const ratio = Math.max(...radii) / Math.min(...radii);
    if(ratio > worst){
      worst = ratio;
      worstAt = m.id + " r=" + radii.map(r => Math.round(r)).join("/");
    }
  }
  ok("B1 " + label + ": " + anchors + " anchors, every fan satisfies the predicate", badPredicate === 0,
     badPredicate + " failed");
  ok("B1 " + label + ": worst sibling spread " + worst.toFixed(2) + "x <= " + FAN_CAP + "x",
     worst <= FAN_CAP + 1e-9, "worst at " + worstAt);
  if(VERBOSE) console.log("     " + label + " worst=" + worst.toFixed(2) + " at " + worstAt);
  return worst;
}
let worstSpread = 0;
for(const name of Object.keys(roadData)) worstSpread = Math.max(worstSpread, fanSpread(roadData[name], "road:" + name));
{
  // synthetic worst case: a fan on EVERY milestone of a road that is already
  // crowded with branches, so most ideal headings are blocked from the start.
  const d = road(10);
  addBranch(d, "q-l", "m2", 4, "left", 0);
  addBranch(d, "q-r", "m2", 4, "right", 1);
  addBranch(d, "q-l2", "q-l-1", 3, null, 0);
  worstSpread = Math.max(worstSpread, fanSpread(d, "crowded synthetic road"));
  // and a full 5x3 fan at the same anchors, all at once
  const e = road(8);
  addBranch(e, "q-x", "m3", 4, "left", 0);
  addFan(e, "m3"); addFan(e, "m4");
  const L = E.compute(e);
  assertInvariant("B1 two 5x3 fans beside a branch", L);
  for(const aid of ["m3", "m4"]){
    const a = L.pos[aid];
    const radii = L.ghosts.filter(g => g.anchorId === aid && g.role === "parallel")
      .map(g => Math.hypot(g.x - a.x, g.y - a.y));
    const ratio = Math.max(...radii) / Math.min(...radii);
    ok("B1 5-wide fan at " + aid + ": spread " + ratio.toFixed(2) + "x <= " + FAN_CAP + "x",
       ratio <= FAN_CAP + 1e-9, radii.map(r => Math.round(r)).join("/"));
  }
}
console.log("   worst spread ratio across every sweep: " + worstSpread.toFixed(2) + "x");

// ---------------------------------------------------------------------------
// (e3) B2 — AN EXPANDED PORTAL LANDS IN THE GAP IT OPENED. The reflow inserts
// room at the portal's main index; the block must sit INSIDE that room, not
// past the end of the road, and the main-road segment spanning the gap is
// re-routed around it (drawn from the engine's own connector, so what is
// checked is what is drawn).
// ---------------------------------------------------------------------------
console.log("\n== (e3) expand-in-place lands in the gap it opened ==");
function gapCheck(label, parent, portalId, child){
  const flat = E.compute(parent);
  const L = E.compute(parent, { expanded: { [portalId]: child } });
  assertInvariant("B2 " + label, L);
  const blk = (L.blocks || [])[0];
  if(!blk){ ok("B2 " + label + " block injected", false); return; }
  // the gap = between the main node the portal reflows at and the next one
  const mainQ = parent.quests.find(q => q.type === "main");
  const mm = parent.milestones.filter(m => m.questId === mainQ.id)
    .sort((a,b) => ((a.order||0)-(b.order||0)) || (a.id < b.id ? -1 : 1));
  let gi = mm.findIndex(m => m.id === portalId);
  if(gi < 0){
    const pm = parent.milestones.find(m => m.id === portalId);
    const pq = parent.quests.find(q => q.id === (pm && pm.questId));
    gi = mm.findIndex(m => m.id === (pq && pq.parentMilestoneId));
  }
  ok("B2 " + label + " gap index resolved", gi >= 0 && gi + 1 < mm.length);
  if(gi < 0 || gi + 1 >= mm.length) return;
  const top = L.pos[mm[gi].id], bot = L.pos[mm[gi+1].id];
  const gap = bot.y - top.y, flatGap = flat.pos[mm[gi+1].id].y - flat.pos[mm[gi].id].y;
  ok("B2 " + label + " the child block sits INSIDE the gap "
     + "[" + Math.round(blk.box.y0) + ".." + Math.round(blk.box.y1) + "] in ["
     + Math.round(top.y) + ".." + Math.round(bot.y) + "]",
     blk.box.y0 > top.y && blk.box.y1 < bot.y);
  ok("B2 " + label + " the gap is opened for the block, not left blank",
     gap - flatGap >= blk.h, "gap grew " + Math.round(gap - flatGap) + " for a block of " + Math.round(blk.h));
  // proportionate: the map grows by about the block, not by block + a blank gap
  const grew = L.bbox.h - flat.bbox.h;
  ok("B2 " + label + " map height is proportionate (grew " + Math.round(grew)
     + " for a " + Math.round(blk.h) + "px child, < 1.6x)",
     grew < blk.h * 1.6, "flat " + Math.round(flat.bbox.h) + " -> " + Math.round(L.bbox.h));
  // the spanning main-road segment is re-routed, never drawn through the block
  const seg = (L.connectors || []).find(c => c.id === "road:" + mm[gi].id + ">" + mm[gi+1].id);
  ok("B2 " + label + " the spanning main-road segment exists", !!seg);
  if(seg) ok("B2 " + label + " that segment never enters the block",
     !seg.pts.some(p => p.x > blk.box.x0 + 4 && p.x < blk.box.x1 - 4 &&
                        p.y > blk.box.y0 + 4 && p.y < blk.box.y1 - 4));
}
{
  // THE ROAD-SHAPED CASE: a portal opened partway along the demo main road,
  // which carries a side quest and a horizon fan of its own.
  const child = addBranch(road(20), "q-child-side", "m8", 3, "right", 0);
  gapCheck("demo road / ms-mvp", roadData.demo, "ms-mvp", child);
}
{
  const p = road(9);
  addBranch(p, "q-side", "m6", 3, "left", 0);
  gapCheck("synthetic main-road portal", p, "m4", road(24));
  const p2 = road(7);
  addBranch(p2, "q-door", "m3", 1, "right", 0);
  gapCheck("synthetic branch portal", p2, "q-door-0", road(14));
}

// ---------------------------------------------------------------------------
// (f) predicate self-check — the predicate must actually FIRE on a bad layout
// ---------------------------------------------------------------------------
console.log("\n== (f) predicate sanity (negative control) ==");
{
  const L = E.compute(road(4));
  const bad = JSON.parse(JSON.stringify(L.elements.slice(0, 2)));
  bad[1].x = bad[0].x; bad[1].y = bad[0].y; bad[1].box = E.boxAt(bad[0].x, bad[0].y, bad[1].r);
  const v = E.invariant({ elements: bad, connectors: [] });
  ok("predicate detects a planted node overlap", !v.ok && v.violations[0].type === "node-overlap");
  const el = JSON.parse(JSON.stringify(L.elements.slice(0, 1)));
  const cross = { id: "x", from: "nobody", to: "nobody2",
                  pts: [{ x: el[0].x, y: el[0].y }, { x: el[0].x + 1, y: el[0].y }] };
  const v2 = E.invariant({ elements: el, connectors: [cross] });
  ok("predicate detects a planted connector crossing", !v2.ok && v2.violations[0].type === "connector-crosses-node");
}

// ---------------------------------------------------------------------------
// (g) the FEATURE inputs still route through this engine — every position the
//     four features draw comes from here, so the predicate has to survive them:
//     a re-anchored fan, an expand -> collapse cycle, and the real roads'
//     regenerated (grouped) horizon trees.
// ---------------------------------------------------------------------------
console.log("\n== (g) feature inputs (horizon trees, expand/collapse) ==");
{
  const FEAT = (function(){
    const html = fs.readFileSync(path.join(HERE, "index.html"), "utf8");
    const a = html.indexOf("// ==== QL_FEAT_BEGIN ====");
    const b = html.indexOf("// ==== QL_FEAT_END ====");
    if(a < 0 || b < 0) return null;
    return new Function(html.slice(a, b) + "\n; return QL_FEAT;")();
  })();
  ok("QL_FEAT is present in index.html", !!FEAT);

  // a fan tagged to a portal, re-anchored at render time, still lays out clean
  if(FEAT){
    const d = road(6);
    addBranch(d, "q-p", "m3", 2, "right", 0);
    addFan(d, "q-p-1", [2,2,2]);                       // anchored on the "portal"
    const moved = FEAT.reanchor(d.suggestions, d.milestones, { "q-p-1": true }, d.quests);
    const L = E.compute(Object.assign({}, d, { suggestions: moved }));
    assertInvariant("g1 re-anchored fan (portal -> last real milestone)", L);
    ok("g1 the fan moved off the doorway", L.ghosts.every(g => g.anchorId === "q-p-0"));
  }

  // expand -> collapse, predicate true at every step, layout restored exactly
  for(const name of Object.keys(roadData)){
    const base = roadData[name];
    const mainQ = base.quests.find(q => q.type === "main");
    const mm = base.milestones.filter(m => m.questId === mainQ.id).sort((a,b) => (a.order||0)-(b.order||0));
    const portal = mm[Math.floor(mm.length/2)];
    const before = posSnapshot(E.compute(base));
    const opened = E.compute(base, { expanded: { [portal.id]: road(18) } });
    assertInvariant("g2 road:" + name + " with an expanded child road", opened);
    const after = posSnapshot(E.compute(base));
    ok("g2 road:" + name + " collapse restores the exact pre-expand layout",
       JSON.stringify(before) === JSON.stringify(after));
  }

  // whatever shape the real horizon data is in, every ghost knows its role
  for(const name of Object.keys(roadData)){
    const L = E.compute(roadData[name]);
    ok("g3 road:" + name + " — every ghost is labelled parallel or sequential",
       L.ghosts.every(g => g.role === "parallel" || g.role === "sequential"));
    const grouped = roadData[name].suggestions.filter(s => s && s.branchIndex != null).length;
    if(VERBOSE) console.log("     " + name + ": " + grouped + " of " +
      roadData[name].suggestions.length + " suggestions carry branchIndex");
  }
}

console.log("\n---------------------------------------------");
console.log(fail === 0 ? ("ALL GREEN — " + pass + " assertions passed" + (skipped ? ", " + skipped + " skipped" : ""))
                       : (fail + " FAILED of " + (pass + fail) + "\n" + failures.map(f => "  - " + f).join("\n")));
process.exit(fail === 0 ? 0 : 1);
