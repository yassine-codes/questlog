#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ROADMAP CURRENCY (dec-currency-architecture) — selftest for C1..C7.
//
// The point of this file: the next change to questlog cannot silently break the
// currency architecture. Every claim the architecture makes is asserted here
// against the REAL code path — the real gate helper, the real evidence writer,
// the real hooks spawned as child processes, the real skins validator, the real
// schema validator.
//
// GOVERNING PRINCIPLE under test: automate observation and absence-detection;
// instruct interpretation. So the assertions come in two flavours and no third:
//   * a MECHANISM refuses / records / detects something, or
//   * a SURFACE says something in words a person can act on.
// Nothing here asserts that questlog decided whether a claim was TRUE, because
// it never does.
//
//   C1 launch gate       — refused without a resolving milestone or a chore flag,
//                          accepted with either; all five internal spawn points
//                          carry a call of their own; external workflows are
//                          DETECTED as unlinked, never blocked.
//   C2 evidence plane    — idempotent by (source, ref, kind) across a watcher
//                          restart (byte-identical file), tombstone rules,
//                          retraction only by the author and only before a human.
//   C3 status plane      — automation refused when it tries to write status;
//                          claimsComplete derived, never stored, and correctly
//                          refuted by a later ship:false verdict / abandon.
//   C4 orphan detector   — the predicate over fixtures incl. the standing
//                          exemption; injected at SessionStart, nudged at Stop;
//                          a road with no orphans still reads as clear.
//   C5 dirty bit         — set by mutating tools only, cleared by a road write,
//                          nudged at Stop, and a read-only session never flagged.
//   C6 skill sentences   — present in both SKILL.md files.
//   C7 coverage surface  — the interface renders evidence, claimsComplete,
//                          unlinked raids and the chore rate; skins stay legible.
//   back-compat          — a road with no evidence and no ledger reads exactly
//                          as it did before any of this existed.
//
// TEMP EVERYTHING: temp HOME (QUESTLOG_REGISTRY + QUESTLOG_ALLOW_TEMP=1), temp
// copies of the bundled demo seed and of every road this machine has registered,
// server on 4350+. A live :4177 and every real .questlog dir are never written —
// they are READ, once, to copy.
//
// Usage: node currency.selftest.mjs [--verbose]
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes("--verbose");
const PORT = Number(process.env.QL_TEST_PORT || 4351);

let pass = 0, fail = 0, skipped = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; if (VERBOSE) console.log("  ok   " + name); }
  else { fail++; failures.push(name + (detail ? " — " + detail : "")); console.log("  FAIL " + name + (detail ? " — " + detail : "")); }
}
// A group whose data is not on this machine SKIPS, loudly, with the reason. It
// is never a FAIL: a fresh clone has none of the founder's roads, and a public
// repo whose selftests are red out of the box is a defect, not a finding.
function skip(name, why) { skipped++; console.log("  SKIP " + name + " — " + why); }
const J = (x) => JSON.stringify(x);

// ---------------------------------------------------------------------------
// temp workspace — nothing below this line touches a real road for WRITING
// ---------------------------------------------------------------------------
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "ql-curr-"));
const HOME = path.join(WORK, "home");
const REGISTRY = path.join(HOME, "registry.json");
fs.mkdirSync(HOME, { recursive: true });

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } }
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2), "utf8"); }
function makeRoadFrom(src, name) {
  const root = path.join(WORK, name);
  fs.mkdirSync(root, { recursive: true });
  copyDir(src, path.join(root, ".questlog"));
  return root;
}

// THE DEMO ROAD ships in the repo, so every structural case below has data on a
// fresh clone: two copies of it, because C1 and C2/C3 write different things and
// neither should read the other's leavings.
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
// registry is read HERE, before the temp one is written over the environment
// below, and every road found is COPIED — the originals are opened for reading
// and nothing else. Absent (a fresh clone, a fresh laptop) is not a failure:
// the group that uses them SKIPS and says which registry it looked in.
const REGISTRY_SRC = process.env.QUESTLOG_REGISTRY ||
                     path.join(os.homedir(), ".questlog", "registry.json");
const REAL_ROADS = (() => {
  let reg = null;
  try { reg = JSON.parse(fs.readFileSync(REGISTRY_SRC, "utf8")); } catch { return []; }
  const roots = [];
  for (const r of (reg && Array.isArray(reg.roadmaps)) ? reg.roadmaps : []) {
    if (!r || typeof r.dir !== "string") continue;
    if (!fs.existsSync(path.join(r.dir, ".questlog", "roadmap.json"))) continue;
    roots.push(makeRoadFrom(path.join(r.dir, ".questlog"), "road-real-" + (roots.length + 1)));
  }
  return roots.map((root, i) => ({ root, label: "real road " + (i + 1) + "/" + roots.length }));
})();

// A bare road built from nothing — the BACK-COMPAT fixture: no evidence array
// anywhere, no activity.jsonl, no dirty bits. It must behave exactly as a
// pre-currency road did, and it must validate exactly as strictly.
const T0 = "2026-01-01T00:00:00.000Z";
function makeBareRoad(root, name, decisions) {
  writeJson(path.join(root, ".questlog", "roadmap.json"), {
    schemaVersion: 1,
    project: { name, tagline: "a fixture road", createdAt: T0, updatedAt: T0 },
    quests: [{ id: "q-main", type: "main", title: "Main", parentMilestoneId: null, side: null, order: 0, status: "in_progress", createdAt: T0, updatedAt: T0 }],
    milestones: [{
      id: "ms-one", questId: "q-main", order: 0, title: "One", summary: "the only milestone", plain: "the only milestone",
      status: "available", statusReason: "", eta: null, startedAt: null, completedAt: null,
      createdAt: T0, updatedAt: T0, unclear: false, unclearAt: null,
    }],
    items: [], assets: [],
  });
  writeJson(path.join(root, ".questlog", "decisions.json"), { schemaVersion: 1, decisions: decisions || [] });
  writeJson(path.join(root, ".questlog", "pins.json"), { schemaVersion: 1, pins: [] });
  writeJson(path.join(root, ".questlog", "glossary.json"), { schemaVersion: 1, terms: [] });
  return root;
}
const decision = (id, title, extra) => Object.assign({
  id, ts: T0, title, rationale: "because the fixture says so", impact: "none — this is a fixture",
  plain: "a fixture decision", relatedMilestoneIds: [], proposedBy: "agent",
  approved: true, approvedAt: T0, status: "approved", supersededBy: null,
}, extra || {});
const PLAIN = makeBareRoad(path.join(WORK, "road-plain"), "Plain");

// The test process itself runs the server's helpers in-process, so it must look
// like a dir-mode boot on a temp road with the temp home.
process.env.QUESTLOG_REGISTRY = REGISTRY;
process.env.QUESTLOG_ALLOW_TEMP = "1";
process.env.QUESTLOG_NO_LISTEN = "1";
process.env.QUESTLOG_DIR = ROADS.demo;
process.env.QUESTLOG_PORT = String(PORT);

const ENV = Object.assign({}, process.env, { QUESTLOG_PORT: String(PORT) });
delete ENV.QUESTLOG_NO_LISTEN;

const C = await import("./currency.mjs");
const SRV = await import("./server.mjs");
const BR = await import("./bridge.mjs");
const SK = await import("./skins.mjs");

const SRC = {
  server: fs.readFileSync(path.join(HERE, "server.mjs"), "utf8"),
  bridge: fs.readFileSync(path.join(HERE, "bridge.mjs"), "utf8"),
  html: fs.readFileSync(path.join(HERE, "index.html"), "utf8"),
};

// Spawn a hook with a stdin payload; resolve its stdout.
function runHookScript(name, payload) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, "hooks", name)], { env: ENV, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (b) => { out += b.toString(); });
    p.stderr.on("data", (b) => { err += b.toString(); });
    p.on("close", (code) => resolve({ out, err, code }));
    p.stdin.write(JSON.stringify(payload));
    p.stdin.end();
  });
}
const sessionsOf = (root) => readJson(path.join(root, ".questlog", "sessions.json"), { sessions: [] }).sessions || [];
const rowOf = (root, id) => sessionsOf(root).find((s) => s && s.id === id) || null;

// ===========================================================================
// C1 — THE LAUNCH GATE
// ===========================================================================
console.log("\n== C1: the launch gate (refuse what questlog itself launches) ==");
{
  const roadmap = { milestones: [{ id: "ms-real" }] };
  ok("C1 a run naming nothing is refused",
     C.assertLinkedOrChore({ roadmap }).ok === false);
  ok("C1 the refusal is E_UNLINKED and says what to do",
     C.assertLinkedOrChore({ roadmap }).reason === "E_UNLINKED" &&
     /name a milestone|declare it a chore/.test(C.assertLinkedOrChore({ roadmap }).message));
  ok("C1 a milestoneId that does NOT resolve is refused (naming is not enough)",
     C.assertLinkedOrChore({ roadmap, milestoneId: "ms-invented" }).ok === false);
  ok("C1 a milestoneId that resolves is accepted",
     C.assertLinkedOrChore({ roadmap, milestoneId: "ms-real" }).ok === true);
  ok("C1 a chore flag is accepted without any milestone",
     C.assertLinkedOrChore({ roadmap, chore: true }).ok === true &&
     C.assertLinkedOrChore({ roadmap, chore: true }).chore === true);
  ok("C1 only chore===true opens the hatch (truthiness is not enough)",
     C.assertLinkedOrChore({ roadmap, chore: 1 }).ok === false &&
     C.assertLinkedOrChore({ roadmap, chore: "yes" }).ok === false);
  ok("C1 an empty road resolves nothing",
     C.assertLinkedOrChore({ roadmap: {}, milestoneId: "ms-real" }).ok === false);

  // the server-side helper, against a real temp road
  const ctx = SRV.makeCtx(ROADS.demo);
  const rm = readJson(ctx.files.roadmap, { milestones: [] });
  const realMs = rm.milestones[0].id;
  ok("C1 the server helper resolves a real milestone off disk",
     SRV.assertLinkedOrChore({ ctx, milestoneId: realMs }).ok === true);
  ok("C1 the server helper refuses an invented one",
     SRV.assertLinkedOrChore({ ctx, milestoneId: "ms-nope-nope" }).ok === false);

  // GATE POINT 1 — the bridge, both spawners, with a spawn that must never fire.
  let spawned = 0;
  const spawnGuard = () => { spawned++; throw new Error("the gate let a spawn through"); };
  const cfg = { enabled: true, dryRun: true, model: "x", maxTurns: 1, allowedTools: ["Read"], claudeBin: "claude" };
  const r1 = await BR.runBridgeOnce(cfg, ctx, { trigger: "t", itemId: "it-x", targetType: "item" }, { spawn: spawnGuard, env: ENV });
  ok("C1 gate point 1a — runBridgeOnce refuses an unlinked pass", r1.status === "refused" && r1.reason === "E_UNLINKED", J(r1));
  const r2 = await BR.runBatchOnce(cfg, ctx, { worklist: [], dispatchId: "disp-x" }, { spawn: spawnGuard, env: ENV });
  ok("C1 gate point 1b — runBatchOnce refuses an unlinked batch", r2.status === "refused" && r2.reason === "E_UNLINKED", J(r2));
  ok("C1 a refused run spawned NOTHING", spawned === 0);
  const log = (() => { try { return fs.readFileSync(path.join(ROADS.demo, ".questlog", "bridge", "bridge.log"), "utf8"); } catch { return ""; } })();
  ok("C1 the refusal is logged, so a refusal is as auditable as a run", /bridge-refused/.test(log) && /E_UNLINKED/.test(log));

  const r3 = await BR.runBridgeOnce(cfg, ctx, { trigger: "t", itemId: "it-y", chore: true }, { spawn: spawnGuard, env: ENV });
  ok("C1 a run that declares itself a chore is ACCEPTED", r3.status === "dryrun", J(r3).slice(0, 120));
  const ledger = C.readActivity(ctx.files.activity);
  ok("C1 the accepted chore landed in the ledger (countable, never hidden)",
     ledger.some((e) => e.source === "bridge" && e.ref === "it-y" && e.kind === "launch"));
  const r3b = await BR.runBridgeOnce(cfg, ctx, { trigger: "t", itemId: "it-y", chore: true }, { spawn: spawnGuard, env: ENV });
  ok("C1 a repeated chore does not double-count (ledger is idempotent by key)",
     r3b.status === "dryrun" &&
     C.readActivity(ctx.files.activity).filter((e) => e.ref === "it-y" && e.kind === "launch").length === 1);

  // GATE POINT 3 — the sidecar repair launcher, before any workdir exists.
  let madeWorkDir = 0;
  const deps = { mode: "dry", makeWorkDir: () => { madeWorkDir++; return path.join(WORK, "never"); } };
  const s1 = SRV.launchSidecarRepair({ ctx, drift: [{ kind: "x" }] }, deps);
  ok("C1 gate point 3 — an unlinked sidecar repair does not run", s1.launched === false && s1.reason === "unlinked", J(s1));
  ok("C1 the sidecar gate runs BEFORE the working directory is created", madeWorkDir === 0);

  // all five internal spawn points name the gate themselves
  for (const n of ["1", "2", "3", "4", "5a", "5b"]) {
    ok("C1 gate point " + n + " of 5 is present in source",
       new RegExp("GATE POINT " + n + "\\b", "i").test(SRC.server + SRC.bridge));
  }
  const gateCalls = (SRC.server.match(/assertLinkedOrChore\(\{/g) || []).length;
  ok("C1 the server carries a gate call per point it owns (>=5)", gateCalls >= 5, "found " + gateCalls);
  ok("C1 handleDispatch has a gate call of its own",
     /async function handleDispatch[\s\S]{0,4000}?assertLinkedOrChore\(\{ ctx, chore: true \}\)/.test(SRC.server));
  ok("C1 handleDispatch ledgers its chore so the coverage line can see it",
     /async function handleDispatch[\s\S]{0,4200}?ledgerChore\(ctx, \{/.test(SRC.server));
}

// ===========================================================================
// C1 (detection half) — external workflows are LABELLED, never blocked
// ===========================================================================
console.log("\n== C1: detection for workflows questlog did not launch ==");
{
  ok("detection — a meta naming a milestone is read tolerantly",
     C.parseRaidLinkage('{"questlogMilestoneId":"ms-abc","other":1}').milestoneId === "ms-abc");
  ok("detection — a chore flag is read tolerantly (quoted or bare)",
     C.parseRaidLinkage('{"questlogChore":true}').chore === true &&
     C.parseRaidLinkage("{'questlogChore':'true'}").chore === true);
  ok("detection — a meta naming nothing yields nothing",
     C.parseRaidLinkage("just some text").milestoneId === null &&
     C.parseRaidLinkage("just some text").chore === false);
  ok("detection — garbage input never throws",
     C.parseRaidLinkage(null).milestoneId === null && C.parseRaidLinkage(undefined).chore === false);
  ok("detection — a resolving milestone labels the run linked",
     C.raidLinkage({ milestoneId: "ms-a", resolves: true }) === "milestone");
  ok("detection — a milestone that does NOT resolve is still unlinked",
     C.raidLinkage({ milestoneId: "ms-a", resolves: false }) === "unlinked");
  ok("detection — a chore flag labels the run chore",
     C.raidLinkage({ chore: true }) === "chore");
  ok("detection — naming neither is unlinked", C.raidLinkage({}) === "unlinked");
  // HONESTY: the word the founder reads is "unlinked". No RENDERED copy in the
  // raids surface may say blocked — only the comments may, and only to say that
  // nothing was blocked. So the assertion strips the comments and reads the copy.
  const raidUI = (() => {
    const a = SRC.html.indexOf("function raidCardHTML(");
    const b = SRC.html.indexOf("function wireRaidsActions(");
    return SRC.html.slice(a, b).replace(/^\s*\/\/.*$/gm, "");
  })();
  ok("HONESTY — the raids copy never says an external workflow was blocked",
     raidUI.length > 500 && !/blocked/i.test(raidUI.replace(/pill '\+esc\(st\)|RAID_STATUS_LABEL/g, "")));
  ok("HONESTY — it says 'unlinked' instead", /unlinked/.test(raidUI));
  ok("HONESTY — the honesty limit is written down where the gate lives",
     /CANNOT gate Claude Code|cannot gate Claude Code/i.test(SRC.server) &&
     /detection, never prevention|DETECTED and labelled/i.test(SRC.server));
}

// ===========================================================================
// C2 — THE EVIDENCE PLANE
// ===========================================================================
console.log("\n== C2: the evidence plane (append-only, idempotent, tombstoned) ==");
{
  const e = (o) => C.normalizeEvidenceEntry(o).entry;
  const base = { source: "raid-watcher", ref: "wf_1", kind: "launch", claim: "set out", ts: "2026-01-01T00:00:00.000Z" };
  ok("C2 an entry normalizes to a fixed key order (byte-stable rewrites)",
     J(e(base)) === J({ ts: base.ts, source: base.source, kind: base.kind, ref: base.ref, claim: base.claim }));
  ok("C2 the idempotency key is (source, ref, kind)", C.evidenceKey(e(base)) === "raid-watcher|wf_1|launch");
  ok("C2 an unknown source is refused", !!C.normalizeEvidenceEntry({ ...base, source: "hacker" }).error);
  ok("C2 an unknown kind is refused", !!C.normalizeEvidenceEntry({ ...base, kind: "vibes" }).error);
  ok("C2 an empty ref is refused (a run identity is required)", !!C.normalizeEvidenceEntry({ ...base, ref: "" }).error);
  ok("C2 a claim over 500 chars is refused", !!C.normalizeEvidenceEntry({ ...base, claim: "x".repeat(501) }).error);
  ok("C2 a verdict WITHOUT ship is refused", !!C.normalizeEvidenceEntry({ ...base, kind: "verdict" }).error);
  ok("C2 a verdict WITH ship is accepted and carries it",
     e({ ...base, kind: "verdict", ship: false }).ship === false);
  ok("C2 ship on a non-verdict is refused", !!C.normalizeEvidenceEntry({ ...base, ship: true }).error);
  ok("C2 a retract WITHOUT tombstonesRef is refused", !!C.normalizeEvidenceEntry({ ...base, kind: "retract" }).error);

  const list0 = [];
  const u1 = C.upsertEvidence(list0, e(base));
  ok("C2 the first write of a key is a change", u1.changed === true && u1.list.length === 1);
  const u2 = C.upsertEvidence(u1.list, e({ ...base, ts: "2026-02-02T00:00:00.000Z", claim: "set out AGAIN" }));
  ok("C2 a WATCHER RESTART re-observing the same run is a NO-OP", u2.changed === false && u2.list === u1.list);
  ok("C2 the no-op left the array byte-identical", J(u2.list) === J(u1.list));
  const u3 = C.upsertEvidence(u2.list, e({ ...base, kind: "finish", claim: "all agents returned" }));
  ok("C2 a different KIND on the same ref is a new entry", u3.changed === true && u3.list.length === 2);

  // tombstones
  const withRetract = u3.list.concat([e({ source: "raid-watcher", ref: "r1", kind: "retract", tombstonesRef: "raid-watcher|wf_1|finish", ts: "2026-03-03T00:00:00.000Z" })]);
  ok("C2 a retract tombstones its target, and does not delete it",
     withRetract.length === 3 &&
     withRetract.some((x) => x.kind === "finish") &&
     !C.liveEvidence(withRetract).some((x) => x.kind === "finish"));
  ok("C2 the untargeted entries stay live", C.liveEvidence(withRetract).some((x) => x.kind === "launch"));
  ok("C2 retract entries are bookkeeping, not observations", !C.liveEvidence(withRetract).some((x) => x.kind === "retract"));

  // retraction rules
  const hist = [{ ts: "2026-04-04T00:00:00.000Z", targetId: "ms-x", actor: "founder", source: "ui" }];
  ok("C2 a writer may retract its OWN entry",
     C.canRetract({ evidence: u3.list, targetKey: "raid-watcher|wf_1|finish", source: "raid-watcher", historyEvents: [], milestoneId: "ms-x" }).ok === true);
  ok("C2 a writer may NOT retract another source's entry",
     C.canRetract({ evidence: u3.list, targetKey: "raid-watcher|wf_1|finish", source: "bridge", historyEvents: [], milestoneId: "ms-x" }).reason === "E_NOT_AUTHOR");
  ok("C2 retraction is refused once a PERSON has edited that milestone since",
     C.canRetract({ evidence: u3.list, targetKey: "raid-watcher|wf_1|finish", source: "raid-watcher", historyEvents: hist, milestoneId: "ms-x" }).reason === "E_HUMAN_EDIT");
  ok("C2 a human edit on ANOTHER milestone does not block the retraction",
     C.canRetract({ evidence: u3.list, targetKey: "raid-watcher|wf_1|finish", source: "raid-watcher", historyEvents: [{ ...hist[0], targetId: "ms-other" }], milestoneId: "ms-x" }).ok === true);
  ok("C2 retracting a key that never existed is refused",
     C.canRetract({ evidence: u3.list, targetKey: "bridge|nope|finish", source: "bridge", historyEvents: [], milestoneId: "ms-x" }).reason === "E_NO_TARGET");

  // the REAL writer, on a real temp road: idempotency must be byte-level
  const ctx = SRV.makeCtx(ROADS.demo2);
  const rm = readJson(ctx.files.roadmap, { milestones: [] });
  const mid = rm.milestones[0].id;
  const w1 = SRV.writeEvidence(ctx, mid, { source: "raid-watcher", ref: "wf_selftest", kind: "launch", claim: "a workflow set out" });
  ok("C2 writeEvidence writes the first observation", w1.written === true, J(w1));
  const bytesAfterFirst = fs.readFileSync(ctx.files.roadmap);
  const w2 = SRV.writeEvidence(ctx, mid, { source: "raid-watcher", ref: "wf_selftest", kind: "launch", claim: "a workflow set out" });
  ok("C2 the same observation a second time is a duplicate no-op", w2.written === false && w2.reason === "duplicate", J(w2));
  ok("C2 a watcher restart leaves roadmap.json BYTE-IDENTICAL",
     Buffer.compare(bytesAfterFirst, fs.readFileSync(ctx.files.roadmap)) === 0);
  const msAfter = readJson(ctx.files.roadmap, { milestones: [] }).milestones.find((m) => m.id === mid);
  ok("C2 an observation did NOT touch the milestone's status", msAfter.status === rm.milestones[0].status);
  ok("C2 an observation did NOT bump updatedAt (it is not an edit of the card)",
     String(msAfter.updatedAt || "") === String(rm.milestones[0].updatedAt || ""));
  const wBad = SRV.writeEvidence(ctx, "ms-does-not-exist", { source: "hook", ref: "r", kind: "launch", claim: "x" });
  ok("C2 evidence for a milestone that does not resolve is refused", wBad.written === false && wBad.reason === "E_UNLINKED");
}

// ===========================================================================
// C3 — THE STATUS PLANE
// ===========================================================================
console.log("\n== C3: automation may never write status ==");
{
  for (const f of ["status", "statusReason", "title", "plain", "order"]) {
    const r = C.refuseStatusWrite({ [f]: "anything" });
    ok("C3 automation is refused when it carries " + f, !!r && r.code === "E_AUTOMATION_STATUS");
  }
  ok("C3 a clean payload passes", C.refuseStatusWrite({ claim: "x", ref: "y" }) === null);
  ok("C3 the refusal is a REFUSAL, not a silent strip (an attempt must be visible)",
     !!C.normalizeEvidenceEntry({ source: "hook", ref: "r", kind: "launch", claim: "c", status: "done" }).error);
  const ctx = SRV.makeCtx(ROADS.demo2);
  const mid = readJson(ctx.files.roadmap, { milestones: [] }).milestones[0].id;
  const w = SRV.writeEvidence(ctx, mid, { source: "hook", ref: "sneaky", kind: "finish", claim: "done!", status: "done" });
  ok("C3 the real writer refuses an evidence entry smuggling a status",
     w.written === false && w.code === "E_AUTOMATION_STATUS", J(w));
  ok("C3 the chore ledger refuses it too",
     !!C.normalizeActivityEntry({ source: "hook", ref: "r", kind: "launch", label: "x", status: "done" }).error);

  // claimsComplete — derived, never stored
  const ev = (kind, ts, extra) => ({ ts, source: "bridge", kind, ref: "wf", claim: "c", ...(extra || {}) });
  ok("C3 no evidence at all does not claim complete", C.claimsComplete({}) === false);
  ok("C3 a launch alone does not claim complete",
     C.claimsComplete({ evidence: [ev("launch", "2026-01-01T00:00:00.000Z")] }) === false);
  ok("C3 a finish claims complete",
     C.claimsComplete({ evidence: [ev("launch", "2026-01-01T00:00:00.000Z"), ev("finish", "2026-01-02T00:00:00.000Z")] }) === true);
  ok("C3 a LATER ship:false verdict refutes the finish",
     C.claimsComplete({ evidence: [ev("finish", "2026-01-02T00:00:00.000Z"), { ...ev("verdict", "2026-01-03T00:00:00.000Z"), ref: "v", ship: false }] }) === false);
  ok("C3 an EARLIER ship:false verdict does not refute a later finish",
     C.claimsComplete({ evidence: [{ ...ev("verdict", "2026-01-01T00:00:00.000Z"), ref: "v", ship: false }, ev("finish", "2026-01-02T00:00:00.000Z")] }) === true);
  ok("C3 a later ship:true verdict leaves the claim standing",
     C.claimsComplete({ evidence: [ev("finish", "2026-01-02T00:00:00.000Z"), { ...ev("verdict", "2026-01-03T00:00:00.000Z"), ref: "v", ship: true }] }) === true);
  ok("C3 a later abandon refutes the finish",
     C.claimsComplete({ evidence: [ev("finish", "2026-01-02T00:00:00.000Z"), { ...ev("abandon", "2026-01-03T00:00:00.000Z"), ref: "a" }] }) === false);
  ok("C3 a RETRACTED finish stops claiming complete",
     C.claimsComplete({ evidence: [ev("finish", "2026-01-02T00:00:00.000Z"),
       { ts: "2026-01-03T00:00:00.000Z", source: "bridge", kind: "retract", ref: "r", claim: "", tombstonesRef: "bridge|wf|finish" }] }) === false);
  ok("C3 a RETRACTED refutation lets the finish stand again",
     C.claimsComplete({ evidence: [ev("finish", "2026-01-02T00:00:00.000Z"),
       { ...ev("verdict", "2026-01-03T00:00:00.000Z"), ref: "v", ship: false },
       { ts: "2026-01-04T00:00:00.000Z", source: "bridge", kind: "retract", ref: "r", claim: "", tombstonesRef: "bridge|v|verdict" }] }) === true);
  ok("C3 ORDER COMES FROM TIMESTAMPS, not file position (shuffled input, same answer)",
     C.claimsComplete({ evidence: [{ ...ev("verdict", "2026-01-03T00:00:00.000Z"), ref: "v", ship: false }, ev("finish", "2026-01-02T00:00:00.000Z")] }) === false);

  // never stored, anywhere
  const derived = SRV.deriveCurrency(readJson(ctx.files.roadmap, {}), readJson(ctx.files.decisions, {}));
  ok("C3 claimsComplete is served as a DERIVED list of ids", Array.isArray(derived.claimsComplete));
  ok("C3 evidenced is served alongside it", Array.isArray(derived.evidenced));
  const roadRaw = fs.readFileSync(ctx.files.roadmap, "utf8");
  ok("C3 claimsComplete is NEVER written to disk", !/claimsComplete/.test(roadRaw));
  ok("C3 the roadmap schema does not allow storing it",
     !/claimsComplete/.test(fs.readFileSync(path.join(HERE, "schema", "roadmap.schema.json"), "utf8").replace(/"description":[^\n]*\n/g, "")));
}

// ===========================================================================
// C4 — THE ORPHAN DETECTOR
// ===========================================================================
console.log("\n== C4: orphaned decisions (detect mechanically, fix by instruction) ==");
{
  const fixtures = [
    { id: "dec-a", status: "approved", relatedMilestoneIds: [] },                  // orphan
    { id: "dec-b", status: "approved", relatedMilestoneIds: ["ms-x"] },            // linked
    { id: "dec-c", status: "approved", relatedMilestoneIds: [], standing: true },  // policy
    { id: "dec-d", status: "proposed", relatedMilestoneIds: [] },                  // not approved yet
    { id: "dec-e", status: "rejected", relatedMilestoneIds: [] },
    { id: "dec-f", status: "superseded", relatedMilestoneIds: [] },
    { id: "dec-g", status: "approved" },                                           // missing array
    { id: "dec-h", status: "approved", relatedMilestoneIds: [], standing: false },  // explicit false
  ];
  const got = C.orphanDecisions(fixtures).map((d) => d.id);
  ok("C4 the predicate finds exactly the orphans", J(got) === J(["dec-a", "dec-g", "dec-h"]), J(got));
  ok("C4 STANDING is the exemption for policy that never becomes work", !C.isOrphanDecision(fixtures[2]));
  ok("C4 a proposed decision is outside the predicate (approval comes first)", !C.isOrphanDecision(fixtures[3]));
  ok("C4 standing:false is not an exemption", C.isOrphanDecision(fixtures[7]));
  ok("C4 garbage is never an orphan", !C.isOrphanDecision(null) && !C.isOrphanDecision("x"));
  ok("C4 the predicate reads three fields and NOTHING semantic",
     /d\.status !== "approved"[\s\S]{0,320}d\.standing !== true/.test(fs.readFileSync(path.join(HERE, "currency.mjs"), "utf8")));

  // capture is sacred — no write-time gate on decisions
  const mcpSrc = fs.readFileSync(path.join(HERE, "mcp", "server.mjs"), "utf8");
  const decTool = mcpSrc.slice(mcpSrc.indexOf('name: "decision_log"'), mcpSrc.indexOf('name: "decision_log"') + 6000);
  ok("C4 decision_log is NOT gated (capture is the one reliably-performed behavior)",
     !/assertLinkedOrChore|isOrphanDecision/.test(decTool));

  // SURFACING — the real SessionStart hook, on a road that HAS orphans
  const ORPH = makeBareRoad(path.join(WORK, "road-orphan"), "Orphanage", [
    decision("dec-orphan-one", "An unrecorded plan"),
    decision("dec-orphan-two", "Another one"),
    decision("dec-policy", "Approvals happen in chat", { standing: true }),
    decision("dec-linked", "A decision that named its work", { relatedMilestoneIds: ["ms-one"] }),
  ]);
  const inj = await runHookScript("sessionstart.mjs", { session_id: "sess-orphan", cwd: ORPH, source: "startup" });
  let ctxText = "";
  try { ctxText = JSON.parse(inj.out).hookSpecificOutput.additionalContext; } catch { ctxText = inj.out; }
  ok("C4 SessionStart injects the orphan section with a COUNT", /ORPHANED DECISIONS \(2/.test(ctxText), ctxText.slice(0, 200));
  ok("C4 it names each orphan so the agent can act", /An unrecorded plan/.test(ctxText) && /Another one/.test(ctxText));
  ok("C4 it tells the agent the two legitimate fixes", /link each to a milestone or mark it standing/i.test(ctxText));
  ok("C4 a STANDING decision is not listed", !/Approvals happen in chat/.test(ctxText));
  ok("C4 the injection NEVER says the road is clear when it is not", !/clear road ahead/.test(ctxText));

  const injClean = await runHookScript("sessionstart.mjs", { session_id: "sess-clean", cwd: PLAIN, source: "startup" });
  let cleanText = ""; try { cleanText = JSON.parse(injClean.out).hookSpecificOutput.additionalContext; } catch { cleanText = injClean.out; }
  ok("C4 a road with NO orphans still reads as clear", /clear road ahead/.test(cleanText));
  ok("C4 a clean road prints no orphan section", !/ORPHANED DECISIONS/.test(cleanText));

  // THE MAP LINE — the founder's ruling is "every session", so it is asserted on
  // both roads, and asserted LAST: appended after truncation, it can never be
  // the part a long briefing cuts.
  for (const [label, txt] of [["orphaned", ctxText], ["clean", cleanText]]) {
    ok("C4 the " + label + " briefing names the open command", /\/questlog:open/.test(txt), txt.slice(-160));
    ok("C4 the map line is the LAST line of the " + label + " briefing",
       /^MAP:/.test(txt.trim().split("\n").pop()), txt.trim().split("\n").pop());
  }

  // THE EMPTY PROJECT — no .questlog anywhere. One line, and nothing created.
  const NOWHERE = path.join(WORK, "nowhere-yet");
  fs.mkdirSync(NOWHERE, { recursive: true });
  const noRoad = await runHookScript("sessionstart.mjs", { session_id: "sess-none", cwd: NOWHERE, source: "startup" });
  ok("C4 an empty project still exits 0", noRoad.code === 0, noRoad.err.slice(0, 200));
  ok("C4 it speaks exactly one line", noRoad.out.trim().split("\n").length === 1, J(noRoad.out));
  let noRoadText = ""; try { noRoadText = JSON.parse(noRoad.out).hookSpecificOutput.additionalContext; } catch { noRoadText = noRoad.out; }
  ok("C4 the empty-project line is the founder's wording, verbatim",
     noRoadText === 'Questlog is here. No road in this project yet — say "start a road" when you want one.', J(noRoadText));
  ok("C4 speaking to an empty project CREATES NOTHING (no lock, no .questlog)",
     !fs.existsSync(path.join(NOWHERE, ".questlog")));

  // NUDGED at Stop
  const stopOut = (await runHookScript("stop.mjs", { session_id: "sess-orphan", cwd: ORPH })).out;
  ok("C4 Stop nudges with the count", /2 approved decision\(s\) name no milestone and no standing flag/.test(stopOut), stopOut);
  ok("C4 the nudge names both fixes", /link or mark standing/.test(stopOut));
  const stopClean = (await runHookScript("stop.mjs", { session_id: "sess-clean", cwd: PLAIN })).out;
  ok("C4 a clean road is not nudged", !/standing flag/.test(stopClean));
  ok("C4 the Stop hook never blocks (always exit 0)",
     (await runHookScript("stop.mjs", { session_id: "sess-orphan", cwd: ORPH })).code === 0);

  // THE BACKFILL, on real roads, is asserted where the real roads are read —
  // see the real-roads group below, which skips when this machine has none.
}

// ===========================================================================
// C5 — THE DIRTY BIT
// ===========================================================================
console.log("\n== C5: the dirty bit (mutating tools only, cleared by a road write) ==");
{
  for (const t of ["Edit", "Write", "NotebookEdit", "MultiEdit", "Bash", "PowerShell"]) {
    ok("C5 " + t + " counts as mutating", C.isMutatingTool(t) === true);
  }
  for (const t of ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "ToolSearch", "TodoWrite", ""]) {
    ok("C5 " + (t || "(empty)") + " never sets the bit", C.isMutatingTool(t) === false);
  }
  ok("C5 another MCP server's tool is assumed mutating (we cannot see what it does)",
     C.isMutatingTool("mcp__github__create_pr") === true);
  ok("C5 questlog's OWN tools never set it (its writes CLEAR it)",
     C.isMutatingTool("mcp__questlog__milestone_upsert") === false &&
     C.isMutatingTool("mcp__questlog__roadmap_get") === false);
  ok("C5 garbage never sets it", C.isMutatingTool(null) === false && C.isMutatingTool(7) === false);

  const row = {};
  ok("C5 marking sets both the bit and the stamp",
     C.markDirty(row, "2026-01-01T00:00:00.000Z") === true && row.dirty === true && row.dirtyAt === "2026-01-01T00:00:00.000Z");
  ok("C5 re-marking keeps the ORIGINAL stamp (the nudge is about 'since when')",
     C.markDirty(row, "2026-09-09T00:00:00.000Z") === false && row.dirtyAt === "2026-01-01T00:00:00.000Z");
  ok("C5 clearing drops the stamp", C.clearDirty(row) === true && row.dirty === false && row.dirtyAt === undefined);
  ok("C5 clearing a clean row changes nothing at all",
     C.clearDirty({}) === false && J(Object.keys({})) === J([]));

  // the REAL hook, spawned, against a real temp road
  const D = path.join(WORK, "road-dirty");
  copyDir(path.join(PLAIN, ".questlog"), path.join(D, ".questlog"));

  await runHookScript("posttooluse-pulse.mjs", { session_id: "sess-read", cwd: D, tool_name: "Read", tool_input: { file_path: "/x/y.txt" } });
  ok("C5 a READ-ONLY session is never flagged", rowOf(D, "sess-read") && rowOf(D, "sess-read").dirty !== true);
  ok("C5 …but it still pulses (liveness is separate from the bit)",
     !!(rowOf(D, "sess-read") && rowOf(D, "sess-read").lastPulse));

  await runHookScript("posttooluse-pulse.mjs", { session_id: "sess-edit", cwd: D, tool_name: "Edit", tool_input: { file_path: "/x/y.txt" } });
  const edited = rowOf(D, "sess-edit");
  ok("C5 an EDIT sets the bit", !!edited && edited.dirty === true, J(edited));
  ok("C5 …with a stamp", !!edited && typeof edited.dirtyAt === "string");
  ok("C5 the bit does NOT count as an event", edited.eventCount === 0);

  // the bit is not throttled behind the pulse
  await runHookScript("posttooluse-pulse.mjs", { session_id: "sess-read", cwd: D, tool_name: "Bash", tool_input: {} });
  ok("C5 a mutating tool right after a pulse still sets the bit (never throttled away)",
     rowOf(D, "sess-read").dirty === true);

  // cleared by a road write, through the REAL hook helper
  const lib = await import("./hooks/lib.mjs");
  const dctx = lib.makeCtx(D);
  lib.withLock(dctx, () => {
    lib.appendHistory(dctx, lib.historyEvent({ action: "milestone_upsert", targetId: "ms-one", summary: "wrote something real", sessionId: "sess-edit" }));
    lib.upsertSession(dctx, "sess-edit", "", 1);
  });
  const cleared = rowOf(D, "sess-edit");
  ok("C5 ANY questlog write clears the bit", cleared.dirty === false, J(cleared));
  ok("C5 …and drops the stamp with it", cleared.dirtyAt === undefined);
  ok("C5 the write DID count as an event", cleared.eventCount === 1);

  // the Stop nudge
  const nudged = (await runHookScript("stop.mjs", { session_id: "sess-read", cwd: D })).out;
  ok("C5 Stop nudges a still-dirty session", /changed things but wrote nothing to the road/.test(nudged), nudged);
  ok("C5 the nudge offers the ignore path (we cannot read intent)", /or ignore if this was housekeeping/.test(nudged));
  const quiet = (await runHookScript("stop.mjs", { session_id: "sess-edit", cwd: D })).out;
  ok("C5 a session that wrote to the road is NOT nudged about dirt", !/changed things but wrote nothing/.test(quiet));
  const stranger = (await runHookScript("stop.mjs", { session_id: "sess-never-seen", cwd: D })).out;
  ok("C5 a session with no row at all is never nudged about dirt", !/changed things but wrote nothing/.test(stranger));

  ok("C5 sessions.schema.json declares both fields",
     /"dirty"/.test(fs.readFileSync(path.join(HERE, "schema", "sessions.schema.json"), "utf8")) &&
     /"dirtyAt"/.test(fs.readFileSync(path.join(HERE, "schema", "sessions.schema.json"), "utf8")));
  ok("C5 the honesty limit about Bash is written down",
     /cannot read.{0,40}intent|Bash counts as mutating/i.test(fs.readFileSync(path.join(HERE, "currency.mjs"), "utf8")));
}

// ===========================================================================
// C6 — THE SKILL SENTENCES
// ===========================================================================
console.log("\n== C6: both skills carry the three rules ==");
{
  // Whitespace-tolerant: the sentences are wrapped for the markdown column, so
  // every run of whitespace is treated as one break.
  const phrase = (s) => new RegExp(s.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "i");
  const SENTENCES = [
    phrase("Queued and in-flight work lives on the road, never only in conversation: before you start a piece of work, the milestone (or item) for it must already exist — create it first, then work."),
    phrase("an approved decision with neither is an orphan and will be surfaced until you fix it."),
    phrase("Order comes from timestamps, never file position: when you read history or evidence, sort by"),
  ];
  const SKILLS = [
    ["questlog", path.join(HERE, "skills", "questlog", "SKILL.md")],
    ["chief-of-staff", path.join(HERE, "skills", "chief-of-staff", "SKILL.md")],
  ];
  for (const [name, file] of SKILLS) {
    let txt = ""; try { txt = fs.readFileSync(file, "utf8"); } catch { /* reported below */ }
    ok("C6 " + name + "/SKILL.md is readable", txt.length > 0, file);
    ok("C6 " + name + " — work lives on the road, not only in conversation", SENTENCES[0].test(txt));
    ok("C6 " + name + " — a decision links or declares itself standing", SENTENCES[1].test(txt));
    ok("C6 " + name + " — order comes from timestamps", SENTENCES[2].test(txt));
  }
}

// ===========================================================================
// C7 — THE COVERAGE DECLARATION (interface)
// ===========================================================================
console.log("\n== C7: the interface declares coverage ==");
{
  const acts = [
    { id: "act-1", ts: new Date().toISOString(), source: "bridge", ref: "a", kind: "launch", label: "" },
    { id: "act-2", ts: new Date().toISOString(), source: "bridge", ref: "b", kind: "launch", label: "" },
    { id: "act-3", ts: "2020-01-01T00:00:00.000Z", source: "bridge", ref: "c", kind: "launch", label: "" },
    { id: "act-4", ts: new Date().toISOString(), source: "bridge", ref: "a", kind: "finish", label: "" },
  ];
  const ms = [{ evidence: [{ ts: new Date().toISOString(), source: "raid-watcher", kind: "launch", ref: "wf1", claim: "" }] }];
  const raids = [{ linked: "unlinked", startedAt: new Date().toISOString() }, { linked: "milestone", startedAt: new Date().toISOString() }];
  const cov = C.coverage({ activityEntries: acts, milestones: ms, raids });
  ok("C7 today's chores are counted (launches only)", cov.chores === 2, J(cov));
  ok("C7 yesterday's chores are not today's", cov.chores === 2);
  ok("C7 linked launches are counted from evidence", cov.linked === 1, J(cov));
  ok("C7 unlinked runs are counted from the scan", cov.unlinked === 1, J(cov));
  ok("C7 the line reads in plain words", C.coverageLine(cov) === "today: 2 chores, 1 linked, 1 unlinked");
  ok("C7 one chore is singular", C.coverageLine({ chores: 1, linked: 0, unlinked: 0 }) === "today: 1 chore, 0 linked, 0 unlinked");

  // the interface actually renders all of it
  ok("C7 index.html derives claimsComplete at read time", /function claimsComplete\(m\)/.test(SRC.html));
  ok("C7 index.html renders an evidence chip", /◈ evidenced/.test(SRC.html));
  ok("C7 index.html renders claims-complete DISTINCTLY from status", /class="evchip"[\s\S]{0,400}claims complete/.test(SRC.html));
  ok("C7 the claims-complete chip uses its OWN token, never a status colour",
     /--evid:/.test(SRC.html) && /\.evchip\{[^}]*background:var\(--evid\)/.test(SRC.html));
  ok("C7 the evidence chip is never the done-green",
     !/\.evchip\{[^}]*var\(--st-done\)/.test(SRC.html));
  ok("C7 index.html lists evidence entries in the drawer", /Evidence \('\+all\.length\+'\)/.test(SRC.html));
  ok("C7 tombstoned entries are struck through, not removed",
     /\.evrow\.dead \.evclaim\{text-decoration:line-through\}/.test(SRC.html));
  ok("C7 the raids panel flags unlinked workflows", /⚠ unlinked/.test(SRC.html));
  ok("C7 …with the one-line explanation", /This workflow named no milestone and no chore flag\./.test(SRC.html));
  ok("C7 the chore rate is visible", /function coverageLineHTML/.test(SRC.html) && /Today: <b>/.test(SRC.html));
  ok("C7 the coverage line appears in BOTH the raids drawer and the roster",
     (SRC.html.match(/coverageLineHTML\(/g) || []).length >= 3);
  ok("C7 the server serves coverage alongside the scan it came from", /coverage: collectCoverageInputs/.test(SRC.server));
  // HONESTY: the copy must say claims, never verified.
  const evidCopy = (SRC.html.match(/[^\n]*claims complete[^\n]*/gi) || []).join("\n");
  ok("C7 HONESTY — the copy says 'claims complete', never 'verified'",
     evidCopy.length > 0 && !/verified/i.test(evidCopy.replace(/not a verification|never verified|a claim, not a verification/gi, "")));

  // skins stay legible with the new tokens
  const skins = [["parchment", {}]];
  for (const f of fs.readdirSync(path.join(HERE, "skins"))) {
    if (!f.endsWith(".json")) continue;
    const s = readJson(path.join(HERE, "skins", f), null);
    if (s) skins.push([s.name || f, s.tokens || {}]);
  }
  for (const [name, tokens] of skins) {
    const eff = SK.effectiveTokens(tokens);
    const v = SK.validateContrast(eff);
    ok("C7 skin '" + name + "' respects every readability floor incl. the new evidence chip",
       v.valid, J(v.failures));
    ok("C7 skin '" + name + "' defines the evidence tokens (own or inherited)", !!eff.evid && !!eff["evid-ink"]);
  }
}

// ===========================================================================
// BACK-COMPAT — a road written before any of this still reads
// ===========================================================================
console.log("\n== back-compat: a road with no evidence and no ledger ==");
{
  const ctx = SRV.makeCtx(PLAIN);
  const rm = readJson(ctx.files.roadmap, {});
  ok("back-compat a milestone with no evidence key is not evidenced", C.hasEvidence(rm.milestones[0]) === false);
  ok("back-compat …and does not claim complete", C.claimsComplete(rm.milestones[0]) === false);
  ok("back-compat an absent activity.jsonl reads as an empty ledger", C.readActivity(ctx.files.activity).length === 0);
  ok("back-compat coverage over an empty world is all zeroes",
     J(C.coverage({})) === J({ today: C.localDateKey(undefined, new Date()), chores: 0, linked: 0, unlinked: 0 }));
  ok("back-compat the derived layer over a plain road is three empty lists",
     J(SRV.deriveCurrency(rm, readJson(ctx.files.decisions, {}))) === J({ claimsComplete: [], evidenced: [], orphanDecisions: [] }));
  const before = fs.readFileSync(ctx.files.roadmap);
  SRV.deriveCurrency(rm, {});
  ok("back-compat reading the derived layer WROTE NOTHING", Buffer.compare(before, fs.readFileSync(ctx.files.roadmap)) === 0);
  ok("back-compat a hook on a road with no .questlog exits 0 in silence",
     (await runHookScript("stop.mjs", { session_id: "s", cwd: path.join(WORK, "nowhere") })).code === 0);
}

// ===========================================================================
// REAL ROADS — the evidence writer against shapes this repo does not own
//
// The demo road is a road this repo wrote, so it agrees with the repo by
// construction. A road somebody actually walks does not, and that is the point
// of copying whatever this machine has registered and putting the real writer
// through it. Two honest limits: only the COPIES are ever written; and the
// validator assertion is that this test introduced NO NEW error, not that the
// road is clean — a road this repo does not own is allowed to carry its own.
// ===========================================================================
console.log("\n== real roads: the evidence writer on data this repo does not own ==");
{
  const { validateDir } = await import("./schema/validate.mjs");
  let standingSeen = false;
  if (!REAL_ROADS.length) {
    skip("real roads", "no readable road registered in " + REGISTRY_SRC);
  } else {
    for (const r of REAL_ROADS) {
      const baseline = new Set(validateDir(r.root));      // BEFORE any write
      const ctx = SRV.makeCtx(r.root);
      const mid = readJson(ctx.files.roadmap, { milestones: [] }).milestones[0].id;
      const obs = { source: "raid-watcher", ref: "wf_selftest", kind: "launch", claim: "a workflow set out" };
      const w1 = SRV.writeEvidence(ctx, mid, obs);
      ok(r.label + ": writeEvidence records the first observation", w1.written === true, J(w1));
      const bytes = fs.readFileSync(ctx.files.roadmap);
      const w2 = SRV.writeEvidence(ctx, mid, obs);
      ok(r.label + ": the same observation again is a duplicate no-op",
         w2.written === false && w2.reason === "duplicate", J(w2));
      ok(r.label + ": a watcher restart leaves roadmap.json BYTE-IDENTICAL",
         Buffer.compare(bytes, fs.readFileSync(ctx.files.roadmap)) === 0);
      const introduced = validateDir(r.root).filter((e) => !baseline.has(e));
      ok(r.label + ": this test introduced NO NEW validation error",
         introduced.length === 0, introduced.slice(0, 3).join(" | "));

      // C4's BACKFILL, held open: an approved decision that names no work and
      // claims no standing is the thing the detector exists to find, and a road
      // being walked is where it would actually appear.
      const dec = readJson(path.join(r.root, ".questlog", "decisions.json"), { decisions: [] });
      const orph = C.orphanDecisions(dec.decisions);
      ok("C4 " + r.label + " carries zero orphans after the backfill",
         orph.length === 0, orph.map((d) => d.id).join(", "));
      standingSeen = standingSeen || (dec.decisions || []).some((d) => d.standing === true);
    }
    // The STANDING exemption is asserted across the set, not per road: a young
    // road legitimately has no policy ruling yet, but somewhere out there the
    // exemption is carrying real weight, not only fixture weight.
    ok("C4 the standing exemption is in use on at least one real road", standingSeen);
  }
}

// ===========================================================================
// the schema validator agrees with every road this test wrote
// ===========================================================================
console.log("\n== schema validator on every road this test wrote ==");
{
  const { validateDir } = await import("./schema/validate.mjs");
  for (const [name, root] of [["demo copy", ROADS.demo], ["second demo copy", ROADS.demo2],
                              ["plain", PLAIN], ["orphanage", path.join(WORK, "road-orphan")],
                              ["dirty", path.join(WORK, "road-dirty")]]) {
    const errs = validateDir(root);
    ok("validate.mjs is clean on the " + name + " road", errs.length === 0, errs.slice(0, 3).join(" | "));
  }
}

console.log("\n---------------------------------------------");
console.log(fail === 0 ? ("ALL GREEN — " + pass + " assertions passed" + (skipped ? ", " + skipped + " skipped" : ""))
                       : (fail + " FAILED of " + (pass + fail) + "\n" + failures.map((f) => "  - " + f).join("\n")));
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* windows handle lag */ }
process.exit(fail === 0 ? 0 : 1);
