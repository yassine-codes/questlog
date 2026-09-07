#!/usr/bin/env node
// ---------------------------------------------------------------------------
// DELETING FROM THE BOARD — the dashboard's half, and the promise that the two
// surfaces delete the SAME WAY.
//
// The MCP tools could always delete; the board could not, so taking a milestone,
// a side quest or a card off the road meant opening roadmap.json in an editor.
// Now both delete, through one shared module, and the risk moves: two code paths
// claiming to be one is exactly the kind of thing that drifts quietly. So this
// file does not test "the endpoint returns 200". It tests the four promises:
//
//   S  the surface   — the control exists on all three cards, and it is the
//                      two-step inline strip, not a browser dialog. Counted in
//                      the source, so a refactor that drops one fails here.
//   A  a leaf        — an item deletes, and history holds the WHOLE record back,
//                      because history is the only recovery path there is.
//   B  the refusal   — a milestone with dependents answers 409 and CHANGES
//                      NOTHING. Proved by comparing roadmap.json byte for byte
//                      across the call, not by trusting the status code.
//   C  the cascade   — force:true takes the whole subtree, recursively, AND
//                      scrubs every reference to the dead ids out of
//                      decisions.json and pins.json. Proved by running the real
//                      validator afterwards: a delete that skips the scrub
//                      leaves a road its own validator rejects.
//   D  side quest    — the same, entered from the quest end.
//   E  the refusals  — the main quest, an unknown id, a bad targetType.
//   F  equivalence   — the MCP tool and the endpoint, run against two identical
//                      copies of the same road, leave roadmaps that DEEP-EQUAL
//                      (bar project.updatedAt) and the same scrub. This is the
//                      one that catches drift.
//
// TEMP EVERYTHING: temp HOME (QUESTLOG_REGISTRY), four temp copies of
// seeds/sample-project, random high ports. The founder's :4177 and the repo's
// own .questlog are never touched — and G proves the latter by mtime.
//
// Usage: node delete.selftest.mjs [--verbose]
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const sameIds = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// ---------------------------------------------------------------------------
// temp workspace — one road per case, each a fresh copy, so no case can inherit
// another's damage and the MCP/UI comparison starts from identical bytes.
// ---------------------------------------------------------------------------
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "ql-del-"));
const HOME = path.join(WORK, "home");
const REGISTRY = path.join(HOME, "registry.json");
fs.mkdirSync(HOME, { recursive: true });
const ENV = Object.assign({}, process.env, {
  QUESTLOG_REGISTRY: REGISTRY,       // the founder's overworld is never written
  QUESTLOG_ALLOW_TEMP: "1",          // the temp-path guard's documented escape hatch
});
delete ENV.QUESTLOG_DIR;             // the mode comes from argv, never the env
delete ENV.QUESTLOG_BTW_BRIDGE;      // a delete must not wake the bridge here

function copyDir(src, dst){
  fs.mkdirSync(dst, { recursive: true });
  for(const e of fs.readdirSync(src, { withFileTypes: true })){
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if(e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}
const qfile = (road, name) => path.join(road, ".questlog", name);
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const historyLines = (road) => {
  try { return fs.readFileSync(qfile(road, "history.jsonl"), "utf8").split("\n").filter(l => l.trim()); }
  catch { return []; }
};
const lastEvent = (road) => { const l = historyLines(road); return l.length ? JSON.parse(l[l.length - 1]) : null; };

// A fresh road, with ONE edit to the fixture: the seed's only pin is anchored at
// ms-setup, and every case here deletes ms-mvp. Re-anchoring it is what makes the
// pin scrub testable at all — an untouched pin proves nothing about afterMilestoneId.
function freshRoad(name){
  const road = path.join(WORK, name);
  copyDir(path.join(HERE, "seeds", "sample-project"), road);
  const pins = readJson(qfile(road, "pins.json"));
  pins.pins[0].afterMilestoneId = "ms-mvp";
  fs.writeFileSync(qfile(road, "pins.json"), JSON.stringify(pins, null, 2), "utf8");
  return road;
}

// ---------------------------------------------------------------------------
// MCP driver — one short-lived stdio server per call (the real tool path).
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
// HTTP servers — spawned here, killed here, nothing else on the box is touched.
// The boot banner is not a contract, so a port is proved live by a real GET; a
// collision on a random high port is retried once, on a fresh port.
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
// The delete call, as the dashboard makes it. Returns the parsed body whatever
// the status, because the 409 body is the interesting one.
async function del(port, body){
  const r = await fetch("http://127.0.0.1:" + port + "/api/delete", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, json, text };
}

// The founder's own road: read its mtime now, check it at the end. This test
// never opens it for writing, and G is what proves that rather than asserting it.
const LIVE_ROADMAP = path.join(HERE, ".questlog", "roadmap.json");
const liveMtimeBefore = (() => { try { return fs.statSync(LIVE_ROADMAP).mtimeMs; } catch { return null; } })();

// ===========================================================================
async function main(){

// ---------------------------------------------------------------------------
// S — the control is on the board, and it is the two-step kind
// ---------------------------------------------------------------------------
console.log("\n== S: the delete control exists on all three cards ==");
{
  const html = readSrc("index.html");
  ok("index.html defines the deleteBtn helper", /function deleteBtn\(/.test(html));
  // One helper, three call sites: the item card, the milestone card, and the
  // side-quest row. Counted so that quietly dropping one fails this test.
  const calls = (html.match(/deleteBtn\(/g) || []).length - 1;
  ok("deleteBtn is called from three cards", calls === 3, "found " + calls);
  ok("the card emits the delete affordance", /data-del="/.test(html) && /data-delconfirm="/.test(html));
  ok("the strip carries both a Delete and a Keep", /data-del-yes="/.test(html) && /data-del-no="/.test(html));
  ok("a 409 can offer the cascade button", /data-del-force/.test(html));
  // The house rule: NO browser confirm() for a founder-facing destructive
  // control. Comments are allowed to say the word; code is not allowed to call
  // it, and the two calls that predate the rule must not become three.
  const calls2 = html.split("\n").filter(l => /confirm\(/.test(l) && !/^\s*(\/\/|\*)/.test(l)).length;
  ok("no new browser confirm() call came with the delete control", calls2 === 2, "found " + calls2);
  // The shared module IS the promise that the two surfaces agree.
  ok("server.mjs deletes through deletion.mjs", /planDeletion/.test(readSrc("server.mjs")));
  ok("mcp/server.mjs deletes through deletion.mjs", /planDeletion/.test(readSrc("mcp/server.mjs")));
  ok("the E_CONFLICT wording lives in deletion.mjs", /has dependents: /.test(readSrc("deletion.mjs")));
}

// ---------------------------------------------------------------------------
// A — a leaf: an item deletes, and history keeps the whole card
// ---------------------------------------------------------------------------
console.log("\n== A: deleting an item ==");
const roadA = freshRoad("road-a");
const portA = await startRoad(roadA);
ok("the server came up on road A", portA > 0);
if(portA > 0){
  const before = readJson(qfile(roadA, "roadmap.json"));
  const item = before.items.find(i => i.id === "it-scaffold");
  const nBefore = historyLines(roadA).length;
  const r = await del(portA, { targetType: "item", id: "it-scaffold" });
  ok("deleting an item is a 200", r.status === 200, r.status + " " + r.text.slice(0, 120));
  ok("the reply names what it deleted", r.json && r.json.deleted && r.json.deleted.id === "it-scaffold");
  ok("an item is a leaf — nothing cascades", r.json && Array.isArray(r.json.cascaded) && r.json.cascaded.length === 0);
  const after = readJson(qfile(roadA, "roadmap.json"));
  ok("the item is off the road", !after.items.some(i => i.id === "it-scaffold"));
  ok("nothing else left with it", after.items.length === before.items.length - 1
    && after.milestones.length === before.milestones.length);
  ok("exactly one history event was written", historyLines(roadA).length === nBefore + 1,
     "was " + nBefore + ", now " + historyLines(roadA).length);
  const evt = lastEvent(roadA);
  ok("the event is a ui_item_delete", evt && evt.action === "ui_item_delete", evt && evt.action);
  ok("the event is stamped as the founder, from the ui", evt && evt.actor === "founder" && evt.source === "ui");
  // History is the ONLY way back. If the patch is a summary rather than the
  // record, the delete is not recoverable and the promise is empty.
  ok("history carries the whole deleted record back",
     evt && JSON.stringify(evt.patch && evt.patch.deleted) === JSON.stringify(item));
}

// ---------------------------------------------------------------------------
// E — the three refusals, on the same road (none of them writes anything)
// ---------------------------------------------------------------------------
console.log("\n== E: what the endpoint refuses ==");
if(portA > 0){
  const q = await del(portA, { targetType: "quest", id: "q-main" });
  ok("the main quest cannot be deleted", q.status === 400 && q.json && q.json.error === "E_VALIDATION",
     q.status + " " + q.text.slice(0, 120));
  ok("and it says why in the tools' own words", q.json && q.json.message === "the main quest cannot be deleted", q.json && q.json.message);
  const nf = await del(portA, { targetType: "milestone", id: "ms-nope" });
  ok("an unknown id is a 404", nf.status === 404 && nf.json && nf.json.error === "E_NOT_FOUND", nf.status + " " + nf.text.slice(0, 120));
  const bt = await del(portA, { targetType: "decision", id: "dec-use-sqlite" });
  ok("a decision is not deletable — it is superseded, never erased", bt.status === 400, bt.status + " " + bt.text.slice(0, 120));
  const bad = await del(portA, { targetType: "milestone", id: "not-an-id" });
  ok("an id of the wrong shape is a 400", bad.status === 400 && bad.json && bad.json.error === "E_VALIDATION", bad.status);
  const none = await del(portA, { targetType: "milestone" });
  ok("a missing id is a 400", none.status === 400, none.status);
}
stopServers();
{
  const { validateDir } = await import("./schema/validate.mjs");
  ok("road A validates after the item delete", validateDir(roadA).length === 0, validateDir(roadA).slice(0, 2).join(" | "));
}

// ---------------------------------------------------------------------------
// B + C — the refusal, then the cascade, on one road
// ---------------------------------------------------------------------------
console.log("\n== B: a milestone with dependents refuses, and changes nothing ==");
const roadB = freshRoad("road-b");
const portB = await startRoad(roadB);
ok("the server came up on road B", portB > 0);
// ms-mvp is the interesting one in the fixture: two items AND a side quest
// branching off it, whose own milestones carry a further item and an asset.
const EXPECT_DEPS = ["it-mvp-form", "it-mvp-note", "q-polish"];
const EXPECT_CASCADE = ["it-polish-copy-explain", "ms-polish-copy", "as-icon-sheet",
                        "ms-polish-icons", "q-polish", "it-mvp-form", "it-mvp-note"];
// What must SURVIVE the cascade: every main-quest milestone except the deleted
// one. Counted off the seed rather than pinned to a number, so a richer demo
// road never reads as a delete that took too much.
const EXPECT_SURVIVORS = readJson(path.join(HERE, "seeds", "sample-project", ".questlog", "roadmap.json"))
  .milestones.filter(m => m.questId === "q-main" && m.id !== "ms-mvp").length;
let conflictMessage = null;
if(portB > 0){
  const bytesBefore = fs.readFileSync(qfile(roadB, "roadmap.json"));
  const nBefore = historyLines(roadB).length;
  const r = await del(portB, { targetType: "milestone", id: "ms-mvp" });
  ok("a milestone with dependents is a 409", r.status === 409, r.status + " " + r.text.slice(0, 160));
  ok("the 409 is an E_CONFLICT", r.json && r.json.error === "E_CONFLICT", r.json && r.json.error);
  // Read the list defensively: a wrong answer here should FAIL, and take the
  // rest of the file with it — not crash the run before D and F ever execute.
  const deps = (r.json && Array.isArray(r.json.dependents)) ? r.json.dependents : [];
  ok("the 409 names every dependent, structurally", sameIds(deps.map(d => d.id), EXPECT_DEPS),
     JSON.stringify(r.json && r.json.dependents));
  ok("each dependent carries what the card needs to render it",
     deps.length > 0 && deps.every(d => d.id && d.type && d.title));
  ok("the dependents are typed, not guessed",
     deps.some(d => d.type === "quest") && deps.some(d => d.type === "item"));
  // A refusal that half-wrote would be worse than no refusal at all.
  ok("the roadmap is byte-identical across the refusal",
     fs.readFileSync(qfile(roadB, "roadmap.json")).equals(bytesBefore));
  ok("the refusal wrote no history event", historyLines(roadB).length === nBefore);
  conflictMessage = r.json && r.json.message;
  ok("the refusal explains itself in the tools' exact wording",
     conflictMessage === "milestone ms-mvp has dependents: " + EXPECT_DEPS.join(", ") + " — pass force:true to cascade",
     conflictMessage);
}

console.log("\n== C: force:true takes the whole subtree, and scrubs after itself ==");
if(portB > 0){
  const nBefore = historyLines(roadB).length;
  const r = await del(portB, { targetType: "milestone", id: "ms-mvp", force: true });
  ok("with force it is a 200", r.status === 200, r.status + " " + r.text.slice(0, 160));
  const casc = (r.json && Array.isArray(r.json.cascaded)) ? r.json.cascaded : [];
  // NOT the same count as `dependents`: dependents is what hangs off this
  // milestone directly, the cascade is the whole recursive subtree under it.
  ok("the cascade is the whole subtree, recursively",
     sameIds(casc.map(x => x.id), EXPECT_CASCADE), JSON.stringify(casc.map(x => x.id)));
  ok("every direct dependent is in the cascade",
     EXPECT_DEPS.every(id => casc.some(x => x.id === id)));
  const after = readJson(qfile(roadB, "roadmap.json"));
  ok("the milestone is gone", !after.milestones.some(m => m.id === "ms-mvp"));
  ok("the side quest branching off it is gone", !after.quests.some(q => q.id === "q-polish"));
  ok("that quest's milestones are gone", !after.milestones.some(m => m.questId === "q-polish"));
  ok("their items and assets went with them",
     !after.items.some(i => ["it-mvp-form", "it-mvp-note", "it-polish-copy-explain"].includes(i.id))
     && !after.assets.some(a => a.id === "as-icon-sheet"));
  ok("the main quest and the rest of the road are untouched",
     after.quests.some(q => q.id === "q-main") && after.milestones.length === EXPECT_SURVIVORS
     && after.milestones.every(m => m.questId === "q-main"),
     after.milestones.map(m => m.id).join(","));
  // The scrub — the half the tools never had. Without it the road is invalid.
  const decs = readJson(qfile(roadB, "decisions.json"));
  ok("no decision still points at the dead milestone",
     decs.decisions.every(d => !(d.relatedMilestoneIds || []).includes("ms-mvp")));
  ok("the decision itself survives — a judgement was still made",
     decs.decisions.some(d => d.id === "dec-use-sqlite"));
  const pins = readJson(qfile(roadB, "pins.json"));
  ok("a pin anchored to the dead milestone floats back to the road start",
     pins.pins[0].afterMilestoneId === null, JSON.stringify(pins.pins[0].afterMilestoneId));
  ok("exactly one history event was written for the whole cascade",
     historyLines(roadB).length === nBefore + 1, "was " + nBefore + ", now " + historyLines(roadB).length);
  const evt = lastEvent(roadB);
  ok("the event is a ui_milestone_delete", evt && evt.action === "ui_milestone_delete", evt && evt.action);
  ok("history carries the deleted record AND everything that cascaded",
     evt && evt.patch && evt.patch.deleted && evt.patch.deleted.id === "ms-mvp"
     && Array.isArray(evt.patch.cascaded) && evt.patch.cascaded.length === EXPECT_CASCADE.length);
  ok("history carries the scrub receipt too",
     evt && evt.patch && evt.patch.scrubbed
     && evt.patch.scrubbed.decisions.includes("dec-use-sqlite")
     && evt.patch.scrubbed.pins.includes("pin-compaction-1"),
     JSON.stringify(evt && evt.patch && evt.patch.scrubbed));
  ok("the summary counts the cascade for the founder",
     evt && /\(\+7 cascaded\)/.test(evt.summary || ""), evt && evt.summary);
}
stopServers();
{
  const { validateDir } = await import("./schema/validate.mjs");
  const errs = validateDir(roadB);
  ok("road B validates after the cascade — nothing dangles", errs.length === 0, errs.slice(0, 3).join(" | "));
}

// ---------------------------------------------------------------------------
// D — the same thing entered from the quest end
// ---------------------------------------------------------------------------
console.log("\n== D: deleting a side quest ==");
const roadC = freshRoad("road-c");
const portC = await startRoad(roadC);
ok("the server came up on road C", portC > 0);
if(portC > 0){
  const soft = await del(portC, { targetType: "quest", id: "q-polish" });
  ok("a quest holding milestones refuses first",
     soft.status === 409 && soft.json && soft.json.error === "E_CONFLICT", soft.status);
  ok("and says so in the tools' own words",
     soft.json && soft.json.message === "quest q-polish has milestones: ms-polish-copy, ms-polish-icons — pass force:true to cascade",
     soft.json && soft.json.message);
  const r = await del(portC, { targetType: "quest", id: "q-polish", force: true });
  ok("with force the side quest goes", r.status === 200, r.status + " " + r.text.slice(0, 160));
  const after = readJson(qfile(roadC, "roadmap.json"));
  ok("the quest is off the road", !after.quests.some(q => q.id === "q-polish"));
  ok("its milestones, items and assets went with it",
     !after.milestones.some(m => m.questId === "q-polish")
     && !after.items.some(i => i.id === "it-polish-copy-explain")
     && !after.assets.some(a => a.id === "as-icon-sheet"));
  ok("ms-mvp, the milestone it branched off, is still there",
     after.milestones.some(m => m.id === "ms-mvp"));
  const evt = lastEvent(roadC);
  ok("the event is a ui_quest_delete", evt && evt.action === "ui_quest_delete", evt && evt.action);
  ok("it calls the thing a side quest in the summary", evt && /side quest/.test(evt.summary || ""), evt && evt.summary);
}
stopServers();
{
  const { validateDir } = await import("./schema/validate.mjs");
  const errs = validateDir(roadC);
  ok("road C validates after the quest delete", errs.length === 0, errs.slice(0, 3).join(" | "));
}

// ---------------------------------------------------------------------------
// F — the equivalence. Two surfaces, one set of rules, or the module is a lie.
// ---------------------------------------------------------------------------
console.log("\n== F: the MCP tool and the endpoint leave the same road ==");
const roadM = freshRoad("road-m");
{
  const soft = await mcpCall(roadM, "milestone_delete", { id: "ms-mvp" });
  ok("the tool refuses the same delete the endpoint refused", !!soft.error, JSON.stringify(soft).slice(0, 160));
  // The 409's message and the tool's error are the SAME SENTENCE. That is the
  // shared module showing through, and it is what agents have read for months.
  ok("word for word, the tool's refusal is the endpoint's message",
     soft.error === "E_CONFLICT: " + conflictMessage, soft.error);
  const hard = await mcpCall(roadM, "milestone_delete", { id: "ms-mvp", force: true });
  ok("the tool cascades on force", !hard.error && hard.value && hard.value.deleted, hard.error || "");
  ok("the tool reports the same cascade",
     hard.value && sameIds(hard.value.cascaded.map(x => x.id), EXPECT_CASCADE),
     JSON.stringify(hard.value && hard.value.cascaded.map(x => x.id)));
  ok("the tool scrubs too, and says what it scrubbed",
     hard.value && hard.value.scrubbed && hard.value.scrubbed.decisions.includes("dec-use-sqlite")
     && hard.value.scrubbed.pins.includes("pin-compaction-1"),
     JSON.stringify(hard.value && hard.value.scrubbed));

  // The comparison. Two fresh copies of one road, one deleted through HTTP and
  // one through stdio; strip the only field that is allowed to differ (the
  // clock) and the two roads must be the same object.
  const ui = readJson(qfile(roadB, "roadmap.json"));
  const mcp = readJson(qfile(roadM, "roadmap.json"));
  delete ui.project.updatedAt; delete mcp.project.updatedAt;
  ok("the two roadmaps deep-equal after the same delete",
     JSON.stringify(ui) === JSON.stringify(mcp),
     "ui " + JSON.stringify(ui).length + "b vs mcp " + JSON.stringify(mcp).length + "b");
  ok("the two scrubbed decisions files match",
     JSON.stringify(readJson(qfile(roadB, "decisions.json"))) === JSON.stringify(readJson(qfile(roadM, "decisions.json"))));
  ok("the two scrubbed pins files match",
     JSON.stringify(readJson(qfile(roadB, "pins.json"))) === JSON.stringify(readJson(qfile(roadM, "pins.json"))));
  const { validateDir } = await import("./schema/validate.mjs");
  const errs = validateDir(roadM);
  ok("road M validates after the tool's cascade", errs.length === 0, errs.slice(0, 3).join(" | "));
}

// ---------------------------------------------------------------------------
// G — the founder's own road was never opened for writing
// ---------------------------------------------------------------------------
console.log("\n== G: the live road is untouched ==");
{
  const now = (() => { try { return fs.statSync(LIVE_ROADMAP).mtimeMs; } catch { return null; } })();
  ok("the repo's own .questlog/roadmap.json has not moved", now === liveMtimeBefore,
     liveMtimeBefore + " -> " + now);
}

stopServers();
console.log("\n---------------------------------------------");
console.log(fail === 0 ? ("ALL GREEN — " + pass + " assertions passed")
                       : (fail + " FAILED of " + (pass + fail) + "\n" + failures.map(f => "  - " + f).join("\n")));
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { stopServers(); console.error("SELFTEST CRASHED:", err); process.exit(1); });
