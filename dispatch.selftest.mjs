#!/usr/bin/env node
// Batch-dispatch END-TO-END self-test (planner §2) against a REAL server.mjs on
// port 4201, dir mode, temp project + temp registry/config/APPDATA. NO live model
// spawn: for the live-marking path we point the bridge's claude bin at a
// NON-EXISTENT executable, so the spawn fails with ENOENT (no process runs) and
// the failure close-out (un-mark + dispatch_failed) is exercised deterministically.
// A restored count of 3 proves the synchronous live marking happened.
//
// Covers: 409 E_BRIDGE_DISABLED, 409 E_NOTHING_PENDING, dry-run (marks nothing,
// writes worklist + ctx package, ui_dispatch practice event, back-compat: historic
// + already-dispatched notes never swept), live marking + un-mark + dispatch_failed,
// and a clean validate.mjs on the resulting .questlog.
//
// Run: node dispatch.selftest.mjs
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateDir } from "./schema/validate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = __dirname;
const PORT = 4201;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log("  ok -", n); };
const bad = (n, d) => { fail++; console.log("  FAIL -", n, "\n        ", d || ""); };
const assert = (c, n, d) => (c ? ok(n) : bad(n, d));
const eq = (a, b, n) => assert(JSON.stringify(a) === JSON.stringify(b), n, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(BASE + p, { method, headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, json: j, raw: buf }); });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, step = 100) {
  const end = Date.now() + ms;
  for (;;) { if (await fn()) return true; if (Date.now() > end) return false; await sleep(step); }
}

const TS = "2026-07-20T09:00:00.000Z";
function seedRoadmap() {
  return {
    schemaVersion: 1,
    project: { name: "Batch Proof", tagline: "dispatch e2e", createdAt: TS, updatedAt: TS },
    quests: [{ id: "q-main", type: "main", title: "Main Quest", parentMilestoneId: null, side: null, order: 0, status: "in_progress", createdAt: TS, updatedAt: TS }],
    milestones: [
      { id: "ms-auth", questId: "q-main", order: 0, title: "Sign-in", summary: "let people sign in", status: "available", statusReason: "", eta: null, startedAt: null, completedAt: null, createdAt: TS, updatedAt: TS },
      { id: "ms-pay", questId: "q-main", order: 1, title: "Payments", summary: "take payments", status: "available", statusReason: "", eta: null, startedAt: null, completedAt: null, createdAt: TS, updatedAt: TS },
    ],
    items: [
      { id: "it-login", milestoneId: "ms-auth", order: 0, kind: "task", title: "Build sign-in", body: "the sign-in screen", status: "open", blockedReason: "", createdAt: TS, updatedAt: TS,
        notes: [
          // historic founder note (no pending field) — must NEVER be swept.
          { id: "note-old", author: "founder", body: "old thought from before dispatch existed", ts: TS },
          // already-dispatched founder note (both-or-neither pair) — must NEVER be re-included.
          { id: "note-done", author: "founder", body: "already handled last time", ts: TS, pending: false, dispatchId: "disp-old00001", dispatchedAt: TS },
        ] },
    ],
    assets: [],
  };
}
function seedDecisions() {
  return { schemaVersion: 1, decisions: [
    { id: "dec-db", ts: TS, title: "Store data in a database", rationale: "we need it to persist", impact: "shapes everything", relatedMilestoneIds: ["ms-auth"], proposedBy: "agent", approved: false, approvedAt: null, status: "proposed", supersededBy: null },
  ] };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "questlog-batch-e2e-"));
  const proj = path.join(tmp, "proj");
  const qdir = path.join(proj, ".questlog");
  const regdir = path.join(tmp, "reg");
  const appdata = path.join(tmp, "appdata");
  fs.mkdirSync(qdir, { recursive: true });
  fs.mkdirSync(regdir, { recursive: true });
  fs.mkdirSync(appdata, { recursive: true });
  fs.writeFileSync(path.join(qdir, "roadmap.json"), JSON.stringify(seedRoadmap(), null, 2));
  fs.writeFileSync(path.join(qdir, "decisions.json"), JSON.stringify(seedDecisions(), null, 2));
  fs.writeFileSync(path.join(qdir, "pins.json"), JSON.stringify({ schemaVersion: 1, pins: [] }, null, 2));
  fs.writeFileSync(path.join(qdir, "history.jsonl"), "");

  const child = spawn(process.execPath, [path.join(REPO, "server.mjs"), "--port", String(PORT)], {
    cwd: REPO,
    env: {
      ...process.env,
      QUESTLOG_DIR: proj,
      QUESTLOG_REGISTRY: path.join(regdir, "registry.json"),
      APPDATA: appdata,
      // A guaranteed-absent bin: the live spawn fails ENOENT — no process runs.
      QUESTLOG_BTW_CLAUDE_BIN: path.join(tmp, "no-such-claude-bin-xyz"),
      // Let config.json drive enabled/dryRun/autoTrigger (clear env overrides).
      QUESTLOG_BTW_BRIDGE: "", QUESTLOG_BTW_DRYRUN: "", QUESTLOG_BTW_AUTOTRIGGER: "", QUESTLOG_BTW_MODEL: "",
      QUESTLOG_PORT: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = ""; child.stderr.on("data", (d) => (stderr += d.toString()));

  try {
    const up = await waitFor(async () => { try { const r = await req("GET", "/api/mode"); return r.status === 200; } catch { return false; } }, 8000);
    if (!up) { bad("server boot", stderr); throw new Error("server did not boot"); }
    ok("server booted (dir mode, port 4201)");

    // ---- Phase A: bridge disabled -> 409 E_BRIDGE_DISABLED ----
    let r = await req("POST", "/api/dispatch", {});
    assert(r.status === 409 && r.json && r.json.error === "E_BRIDGE_DISABLED", "disabled -> 409 E_BRIDGE_DISABLED", r.raw);

    // Enable bridge, dry-run.
    r = await req("POST", "/api/config", { bridge: { enabled: true, dryRun: true } });
    assert(r.status === 200 && r.json.config.bridge.enabled === true && r.json.config.bridge.dryRun === true, "config: bridge enabled + dry-run", r.raw);

    // ---- Phase B: enabled but nothing pending -> 409 E_NOTHING_PENDING ----
    r = await req("POST", "/api/dispatch", {});
    assert(r.status === 409 && r.json && r.json.error === "E_NOTHING_PENDING", "nothing pending -> 409 E_NOTHING_PENDING", r.raw);

    // ---- Seed pending work via the REAL writers ----
    await req("POST", "/api/note", { itemId: "it-login", body: "make this plainer please" });
    await req("POST", "/api/note", { itemId: "it-login", body: "also add a way to sign out" });
    await req("POST", "/api/unclear", { targetType: "milestone", id: "ms-pay", unclear: true });
    await req("POST", "/api/unclear", { targetType: "decision", id: "dec-db", unclear: true });
    // Confirm POST /api/note set pending:true (planner §1.1).
    let st = (await req("GET", "/api/state")).json;
    let login = st.roadmap.items.find((x) => x.id === "it-login");
    const newPending = login.notes.filter((n) => n.author === "founder" && n.pending === true);
    assert(newPending.length === 2, "POST /api/note marks founder notes pending:true", JSON.stringify(login.notes.map((n) => n.pending)));

    // ---- Phase C: DRY-RUN dispatch — marks NOTHING, writes worklist + ctx ----
    r = await req("POST", "/api/dispatch", {});
    assert(r.status === 200 && r.json.ok === true && r.json.dryRun === true, "dry-run dispatch 200 dryRun:true", r.raw);
    assert(r.json.count === 3, "dry-run count = 3 cards", String(r.json.count));
    assert(typeof r.json.contextPackagePath === "string" && fs.existsSync(r.json.contextPackagePath), "dry-run returns a written contextPackagePath", r.json.contextPackagePath);
    const entriesById = Object.fromEntries(r.json.entries.map((e) => [e.id, e]));
    eq([entriesById["it-login"].noteCount, entriesById["it-login"].unclear], [2, false], "entry it-login: 2 notes, not unclear");
    eq([entriesById["ms-pay"].noteCount, entriesById["ms-pay"].unclear], [0, true], "entry ms-pay: unclear only");
    eq([entriesById["dec-db"].noteCount, entriesById["dec-db"].unclear], [0, true], "entry dec-db: unclear only");
    eq(r.json.entries.map((e) => e.id), ["it-login", "ms-pay", "dec-db"], "drain order: oldest signal first");

    // Worklist file on disk (the shared shape) — verify contents + back-compat.
    const wlPath = path.join(qdir, "bridge", `worklist-${r.json.dispatchId}.json`);
    assert(fs.existsSync(wlPath), "worklist-<dispatchId>.json written under .questlog/bridge", wlPath);
    const wl = JSON.parse(fs.readFileSync(wlPath, "utf8"));
    const wlItem = wl.entries.find((e) => e.id === "it-login");
    eq(wlItem.notes.map((n) => n.body), ["make this plainer please", "also add a way to sign out"], "worklist item carries ONLY pending notes, verbatim, ascending");
    assert(wlItem.questId === "q-main" && wlItem.milestoneId === "ms-auth" && wlItem.milestoneTitle === "Sign-in", "worklist item has quest + milestone context", JSON.stringify(wlItem));
    const wlDec = wl.entries.find((e) => e.id === "dec-db");
    assert(Array.isArray(wlDec.relatedMilestoneIds) && wlDec.relatedMilestoneTitles[0] === "Sign-in" && !("milestoneId" in wlDec), "worklist decision has related milestones, no milestone/quest keys", JSON.stringify(wlDec));

    // Dry-run marked NOTHING.
    st = (await req("GET", "/api/state")).json;
    login = st.roadmap.items.find((x) => x.id === "it-login");
    assert(login.notes.filter((n) => n.pending === true).length === 2 && !login.notes.some((n) => n.dispatchId && n.dispatchId.startsWith("disp-") && n.pending === true), "dry-run left founder notes pending, unmarked", JSON.stringify(login.notes));
    assert(!st.roadmap.milestones.find((m) => m.id === "ms-pay").unclearDispatchId, "dry-run left ms-pay flag unmarked");
    assert(!st.decisions.decisions.find((d) => d.id === "dec-db").unclearDispatchId, "dry-run left dec-db flag unmarked");
    // ui_dispatch practice-mode history event.
    const dispEvt = st.historyTail.filter((e) => e.action === "ui_dispatch").pop();
    assert(dispEvt && dispEvt.patch.dryRun === true && /practice mode/.test(dispEvt.summary), "history: ui_dispatch (practice mode)", JSON.stringify(dispEvt));

    // ---- Phase D: LIVE dispatch — synchronous marking, then un-mark on ENOENT ----
    r = await req("POST", "/api/config", { bridge: { dryRun: false } });
    assert(r.status === 200 && r.json.config.bridge.dryRun === false, "config: bridge live (dryRun false)", r.raw);

    r = await req("POST", "/api/dispatch", {});
    assert(r.status === 200 && r.json.dryRun === false && r.json.count === 3, "live dispatch 200 dryRun:false count 3", r.raw);
    const liveDispatchId = r.json.dispatchId;

    // The spawn fails ENOENT -> onDone un-marks -> dispatch_failed appended.
    const restored = await waitFor(async () => {
      const s = (await req("GET", "/api/state")).json;
      const it = s.roadmap.items.find((x) => x.id === "it-login");
      return it.notes.filter((n) => n.pending === true).length === 2 && s.historyTail.some((e) => e.action === "dispatch_failed" && e.patch.dispatchId === liveDispatchId);
    }, 8000);
    assert(restored, "live run failed (ENOENT) -> cards un-marked + dispatch_failed appended");

    st = (await req("GET", "/api/state")).json;
    const failEvt = st.historyTail.filter((e) => e.action === "dispatch_failed").pop();
    assert(failEvt && failEvt.actor === "system" && failEvt.patch.unmarked === 3, "dispatch_failed: actor system, unmarked = 3 (proves 3 were marked)", JSON.stringify(failEvt));
    login = st.roadmap.items.find((x) => x.id === "it-login");
    assert(login.notes.filter((n) => n.author === "founder" && n.pending === true).length === 2 && !login.notes.some((n) => n.dispatchId === liveDispatchId), "un-mark restored notes: pending true, dispatchId removed", JSON.stringify(login.notes));
    assert(!st.roadmap.milestones.find((m) => m.id === "ms-pay").unclearDispatchId && !st.decisions.decisions.find((d) => d.id === "dec-db").unclearDispatchId, "un-mark removed flag dispatch fields");
    // Back-compat: the historic + already-dispatched notes are untouched.
    const noteDone = login.notes.find((n) => n.id === "note-done");
    assert(noteDone && noteDone.dispatchId === "disp-old00001" && noteDone.pending === false, "already-dispatched historic note untouched (never re-included/altered)", JSON.stringify(noteDone));

    // ---- Validate the resulting .questlog is schema-clean ----
    const errors = validateDir(proj);
    assert(errors.length === 0, "validate.mjs: final .questlog is clean", errors.join("; "));

    await req("POST", "/api/shutdown", {});
  } catch (e) {
    bad("exception", String(e && e.stack || e));
  } finally {
    try { child.kill(); } catch {}
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
