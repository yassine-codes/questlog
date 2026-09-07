#!/usr/bin/env node
// QUESTLOG — local UI server.
// Zero dependencies. Node >= 18. Binds 127.0.0.1 only.
//
// Two modes (selected at startup):
//   DIR mode      — single project. Triggered by --dir/--data OR QUESTLOG_DIR.
//                   Serves the dashboard + JSON API over <projectRoot>/.questlog/.
//   CENTRAL mode  — no --dir. Reads a user-level roadmap registry and serves a
//                   world-select overworld plus id-scoped per-roadmap APIs.
//
// Run:  node server.mjs --dir <projectRoot> --port 4177     (dir mode)
//       node server.mjs --port 4177                          (central mode)
// Env:  QUESTLOG_DIR / QUESTLOG_PORT / QUESTLOG_REGISTRY
//
// The .questlog files are the source of truth; this server is a convenience
// layer that speaks the exact same lock + atomic-write + history protocol as
// the MCP server.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readBridgeConfig, createBridge, readConfigFile, configFilePath, questlogHome, cleanEnv as bridgeCleanEnv } from "./bridge.mjs";
import * as currency from "./currency.mjs";
import { planDeletion, scrubDeletedRefs } from "./deletion.mjs";
import * as conflicts from "./conflicts.mjs";
import * as skins from "./skins.mjs";
import * as distiller from "./distiller.mjs";
import * as taskboard from "./taskboard.mjs";
import * as chat from "./chat.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// "/btw" bridge (prototype) — OFF by default. See bridge.mjs + the "Bridge"
// section of README.md. Reading config once at startup keeps the branch gated:
// when QUESTLOG_BTW_BRIDGE !== "1" the controller's trigger() is inert, so the
// server behaves exactly as before. When enabled it defaults to DRY-RUN (logs
// the command it would run, spawns nothing) unless QUESTLOG_BTW_DRYRUN="0".
// ---------------------------------------------------------------------------
// The bridge now reads its config PER-TRIGGER (planner §1.3): env still wins,
// but config.json fills the gap, so the settings panel can toggle the bridge
// with no server restart. getCfg is re-evaluated inside trigger()/fire(); the
// containment invariants inside bridge.mjs are untouched.
const getBridgeCfg = () => readBridgeConfig(process.env, readConfigFile(process.env));
const BRIDGE = createBridge(getBridgeCfg);

// ---------------------------------------------------------------------------
// Args / config
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Accept --dir (contract) and --data (alias) for the project root.
    if (a === "--dir" || a === "--data") out.dir = argv[++i];
    else if (a === "--port") out.port = argv[++i];
    else if (a.startsWith("--dir=")) out.dir = a.slice(6);
    else if (a.startsWith("--data=")) out.dir = a.slice(7);
    else if (a.startsWith("--port=")) out.port = a.slice(7);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// Mode selection (pinned): DIR mode iff --dir/--data given OR QUESTLOG_DIR set.
const DIR_MODE = !!(args.dir || process.env.QUESTLOG_DIR);
const MODE = DIR_MODE ? "dir" : "central";

const PROJECT_ROOT = path.resolve(args.dir || process.env.QUESTLOG_DIR || process.cwd());

// "env var / arg set" is pinned as: present AND value !== "" (planner §1.2).
const isSet = (v) => v !== undefined && v !== null && v !== "";

// Port precedence (pinned, highest first): --port CLI arg > QUESTLOG_PORT env >
// config.json port > 4177. Resolved ONCE at startup; a port change in config
// only applies at the next start (reported via needsRestart everywhere). Both
// PORT and the source it came from are frozen here so /api/config can report,
// honestly, what the RUNNING process actually used.
function resolvePortAtStartup() {
  if (isSet(args.port)) {
    const n = parseInt(args.port, 10);
    if (Number.isInteger(n)) return { value: n, source: "cli" };
  }
  if (isSet(process.env.QUESTLOG_PORT)) {
    const n = parseInt(process.env.QUESTLOG_PORT, 10);
    if (Number.isInteger(n)) return { value: n, source: "env" };
  }
  const fc = readConfigFile(process.env);
  if (fc && Number.isInteger(fc.port) && fc.port >= 1024 && fc.port <= 65535) {
    return { value: fc.port, source: "config" };
  }
  return { value: 4177, source: "default" };
}
const { value: PORT, source: PORT_SOURCE } = resolvePortAtStartup();

// ---------------------------------------------------------------------------
// Version / drift stamp (planner §1.7). sourceHash = SHA-256 (lowercase hex)
// over the exact byte concatenation, in this order, of server.mjs, bridge.mjs,
// index.html, chat.mjs. Node-run: computed once at startup from __dirname. Exe-run: the
// bootstrap (W4) sets QUESTLOG_PACKAGED=1 + QUESTLOG_BUILD_INFO=<path to the
// baked build-info.json>; we read buildId/sourceHash from there (the only
// W2<->W4 coupling). Everything is best-effort — a missing file never crashes.
// ---------------------------------------------------------------------------
const STARTED_AT = new Date().toISOString();

// ---------------------------------------------------------------------------
// F8b — SIDECAR DRIFT REPAIR (decision dec-sidecar-selfhealing).
//
// Founder's verbatim ruling: "regarding f8b yes but instead of a fall back, on
// every update change being detected an agent should launch a session of fable,
// to make queslog match CC newest structure". So "auto" is the AUTHORIZED
// DEFAULT, not an assumption — "dry" and "off" exist for when he wants them.
//
// What launches: ONE headless Fable session whose permission scope allows it to
// edit exactly THREE files and run exactly ONE command. Its change stands only
// if this process then runs the adapter's selftest against REAL transcripts and
// that selftest passes; otherwise the backup is restored.
//
// The argv is built DIRECTLY here and deliberately NOT through chat.profileFlags
// — safeToolName() would strip the path-scoping parentheses out of
// Edit(C:/...) and silently widen the scope to every file on the machine.
// ---------------------------------------------------------------------------
const SIDECAR_REPAIR_MODES = new Set(["auto", "dry", "off"]);
const SIDECAR_REPAIR_MODEL = "fable";          // hardcoded per the founder's ruling — no config key
const SIDECAR_REPAIR_TIMEOUT_MS = 1800000;     // 30 min hard cap on the child
const SIDECAR_MARKER_STALE_MS = 1800000;       // a marker older than this is stale
const SIDECAR_FILES = ["sidecar-adapter.mjs", "sidecar-adapter.selftest.mjs", "sidecar-fingerprint.json"];

// Single-concurrency, three ways: an in-process flag, a marker FILE (so two
// questlog processes cannot both launch), and one launch per drift signature
// per process (so a drift that recurs on every chat open launches once).
let sidecarRepairInFlight = false;
const sidecarRepairSeen = new Set();

function sidecarRepairPaths(env = process.env) {
  const home = questlogHome(env);
  return {
    home,
    marker: path.join(home, ".sidecar-repair-running"),
    backups: path.join(home, "sidecar-backup"),
    logs: path.join(home, "repair-logs"),
  };
}

function driftSignature(drift) {
  const list = Array.isArray(drift) ? drift.slice().sort() : [];
  return crypto.createHash("sha256").update(list.join("|")).digest("hex").slice(0, 16);
}

// Build the EXACT argv. Pure + exported-by-reference for the selftest, so the
// permission scope is asserted rather than trusted.
function buildSidecarRepairArgs(driftReport, repoRoot) {
  const files = SIDECAR_FILES.map((f) => path.join(repoRoot, f).replace(/\\/g, "/"));
  const [adapter, selftest, fingerprint] = files;
  const reasons = (Array.isArray(driftReport && driftReport.drift) ? driftReport.drift : []).map((d) => "  - " + d).join("\n");
  const prompt = [
    "Claude Code's session transcript format has drifted away from what questlog's sidecar adapter expects.",
    "",
    "DRIFT REPORT:",
    reasons || "  - (no reasons recorded)",
    driftReport && driftReport.version ? `Claude Code version seen: ${driftReport.version}` : "",
    driftReport && driftReport.sessionId ? `Session that triggered this: ${driftReport.sessionId}` : "",
    "",
    "YOUR TASK:",
    "1. Read sidecar-adapter.mjs and sidecar-fingerprint.json.",
    "2. Read a REAL current transcript under ~/.claude/projects/ to see the actual shape.",
    "3. Fix readSidecar() in sidecar-adapter.mjs so it parses the current format.",
    "4. Update sidecar-fingerprint.json to record the new shape.",
    "5. Extend sidecar-adapter.selftest.mjs to cover it.",
    "6. Run `node sidecar-adapter.selftest.mjs` until it is green.",
    "",
    "HARD CONSTRAINTS:",
    "- Edit NOTHING but those three files. Nothing else is in your permission scope.",
    "- The adapter must stay read-only, zero-dependency, and must never throw.",
    "- enrich() must keep returning the dock transcript unchanged on every failure path (the splint).",
    "- Your change is kept only if the selftest passes against real transcripts afterwards.",
  ].filter((l) => l !== "").join("\n");

  return [
    "-p", prompt,
    "--model", SIDECAR_REPAIR_MODEL,
    "--output-format", "stream-json", "--verbose",
    "--max-turns", "50",
    // No --mcp-config, so --strict-mcp-config means ZERO MCP servers.
    "--strict-mcp-config",
    // No permission-mode flag of any kind: under headless -p every tool NOT on
    // this list is denied by construction (the observer tier relies on exactly
    // the same principle). Adding one here would only ever widen the scope.
    // Read is unscoped because it must reach live transcripts under ~/.claude;
    // Edit/Write are scoped to exactly the three files; Bash to exactly one command.
    "--allowedTools", [
      "Read",
      `Edit(${adapter})`, `Edit(${selftest})`, `Edit(${fingerprint})`,
      `Write(${adapter})`, `Write(${selftest})`, `Write(${fingerprint})`,
      "Bash(node sidecar-adapter.selftest.mjs:*)",
    ].join(","),
  ];
}

function stamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }

// ---------------------------------------------------------------------------
// G-A / G-B — HOW A REPAIR EVENT REACHES THE FOUNDER.
//
// A REPAIR NOTICE IS NOT A HORIZON SUGGESTION. suggestions.json holds POSSIBLE
// FUTURES the founder may promote onto the road: each one is tagged with the
// road-end milestone it was floated at, ordered against its siblings, and drawn
// as a faint ghost node PAST the road-end. A repair event is the opposite kind
// of thing — a notification that something has ALREADY HAPPENED, which the
// founder cannot promote and should not be asked to. Writing one as a
// suggestion produced a record with no frontierMilestoneId / questId / plain /
// order / createdAt / updatedAt: the road stopped validating AND the renderer
// silently dropped the ghost, so the founder was told nothing. Worst of both.
//
// THE SURFACE CHOSEN INSTEAD: a roadmap item of kind "note_to_founder", hung
// on the milestone the chat was anchored to (falling back to the road's live
// milestone). That kind already exists for exactly this purpose and index.html's
// itemCard() already renders it as a card with its own "Note to Founder" chip,
// its body, and its whole notes thread — the founder reads it where they read
// everything else about that milestone, and it persists on the road instead of
// living only in a log file nobody opens.
//
// The roster / raids panels were the other candidate and were rejected: both
// are LIVE SCANS of running subagent processes and session files, they hold no
// per-road record, and nothing in them survives a restart. A repair is a
// durable fact about this road, not a running process.
//
// ONE CARD PER REPAIR EPISODE. launched -> passed/failed is one story, so the
// first event of a drift signature opens the card and every later event of the
// same signature appends a note to its thread ("passed" also closes the card).
// Nothing bespoke anywhere: the history line goes through appendHistory in the
// canonical shape (id / ts / actor / source / action / targetId / patch /
// summary) that every other writer in this file uses, and the roadmap write is
// the same readJson -> mutate -> atomicWrite under withLock.
// ---------------------------------------------------------------------------

// Episode key ("<road root>|<drift signature>") -> the item id its card lives
// under. Process-lifetime, which is exactly the life of one repair episode:
// launched and its passed/failed both come from this process's own child.
const sidecarNoticeItems = new Map();

const SIDECAR_NOTICE_TITLE = "Claude Code changed how it stores chat history";

// Founder-facing copy, plain register. No codenames and no acronyms — the
// jargon lint reads item titles, bodies and note bodies. The raw drift reasons
// are machine shapes, not prose, so they ride in code spans (which the lint
// strips and index.html's mdlite renders as <code>).
function sidecarNoticeBody(drift) {
  const lines = [
    "Questlog shows you the full story of a chat by reading Claude Code's own record of it. Claude Code changed the shape of that record, so questlog could not read it.",
    "",
    "Your chats kept working the whole time — they fell back to questlog's own shorter record.",
    "",
    "What changed:",
  ];
  for (const d of (Array.isArray(drift) ? drift : [])) lines.push("  • `" + String(d).replace(/`/g, "'") + "`");
  return lines.join("\n");
}

function sidecarNoticeNote(status) {
  if (status === "launched") return "A repair pass has been started. It may change only the three files that do the reading, and its work is kept only if the self-test passes afterwards.";
  if (status === "passed") return "The repair pass finished and the self-test passed. The full chat view is working again.";
  if (status === "failed") return "The repair pass did not pass the self-test, so it was undone. The shorter chat view stays until someone looks at this.";
  if (status === "dry") return "Practice mode is on, so nothing was started. The exact command was written to the repair log for you to read.";
  return "A repair event was recorded (" + String(status) + ").";
}

// Which card does the notice hang on? The milestone the chat was anchored to if
// it still exists, else the road's live milestone, else the last one. Null only
// when the road has no milestones at all — an item pointing at no milestone is
// exactly the invalid record this fix exists to stop writing.
function sidecarNoticeMilestone(roadmap, preferredId) {
  const ms = Array.isArray(roadmap && roadmap.milestones)
    ? roadmap.milestones.filter((m) => m && typeof m.id === "string" && m.id)
    : [];
  if (!ms.length) return null;
  if (preferredId && ms.some((m) => m.id === preferredId)) return preferredId;
  const live = ms.find((m) => m.status === "in_progress")
    || ms.find((m) => m.status === "available")
    || ms.find((m) => m.status === "blocked")
    || ms.find((m) => m.status !== "done")
    || ms[ms.length - 1];
  return live ? live.id : null;
}

// Writes the notice. Called INSIDE the road lock. Returns what it wrote so the
// caller (and the selftest) can find the founder-visible artifact by id.
function writeSidecarRepairNotice(ctx, evt) {
  const ts = nowIso();
  const drift = Array.isArray(evt.drift) ? evt.drift : [];
  const key = ctx.root + "|" + driftSignature(drift);
  const roadmap = readJson(ctx.files.roadmap, () => emptyRoadmap(ctx.root));
  if (!Array.isArray(roadmap.items)) roadmap.items = [];

  const prevId = sidecarNoticeItems.get(key);
  let item = prevId ? roadmap.items.find((it) => it && it.id === prevId) : null;
  const milestoneId = item ? item.milestoneId : sidecarNoticeMilestone(roadmap, evt.milestoneId);

  if (!item && milestoneId) {
    const order = roadmap.items
      .filter((it) => it && it.milestoneId === milestoneId)
      .reduce((n, it) => Math.max(n, (typeof it.order === "number" ? it.order : 0) + 1), 0);
    item = {
      id: genId("it"), milestoneId, order, kind: "note_to_founder",
      title: SIDECAR_NOTICE_TITLE, body: sidecarNoticeBody(drift),
      status: "open", blockedReason: "", notes: [],
      createdAt: ts, updatedAt: ts,
    };
    roadmap.items.push(item);
    sidecarNoticeItems.set(key, item.id);
  }

  if (item) {
    if (!Array.isArray(item.notes)) item.notes = [];
    item.notes.push({ id: genId("note"), author: "agent", body: sidecarNoticeNote(evt.status), ts });
    if (evt.status === "passed") item.status = "done";
    item.updatedAt = ts;
    if (roadmap.project && typeof roadmap.project === "object") roadmap.project.updatedAt = ts;
    atomicWrite(ctx.files.roadmap, roadmap);
  }

  const rec = {
    id: genId("evt"), ts, actor: "system", source: "ui", action: "sidecar_repair",
    targetId: item ? item.id : null,
    patch: { status: String(evt.status), drift, itemId: item ? item.id : null, milestoneId: milestoneId || null },
    summary: `Chat history view: repair ${String(evt.status)} after Claude Code's record of chats changed shape`,
  };
  if (typeof evt.sessionId === "string" && evt.sessionId) rec.sessionId = evt.sessionId;
  appendHistory(ctx, rec);
  return { eventId: rec.id, itemId: item ? item.id : null, milestoneId: milestoneId || null };
}

// Record a repair event: a canonical history line plus the founder-visible card,
// both under the road lock. Best-effort throughout — a logging failure must
// never break a chat open or leave the marker behind.
function logSidecarRepair(ctx, evt) {
  let written = { eventId: null, itemId: null, milestoneId: null };
  try {
    if (ctx && ctx.files) written = withLock(ctx, () => writeSidecarRepairNotice(ctx, evt)) || written;
  } catch { /* best-effort */ }
  try {
    const p = sidecarRepairPaths();
    fs.mkdirSync(p.logs, { recursive: true });
    fs.appendFileSync(path.join(p.logs, "sidecar-repair.log"),
      JSON.stringify({ ts: nowIso(), ...evt, ...written }) + "\n", "utf8");
  } catch { /* best-effort */ }
  return written;
}

// ---------------------------------------------------------------------------
// F-C — WHY THE REPAIR CHILD NEVER RUNS IN THE FOUNDER'S REPO.
//
// THE HOOK CAVEAT: `--allowedTools` governs what the CHILD MODEL may ask for.
// It does not govern the founder's own USER-LEVEL hooks (~/.claude/settings.json
// and friends), which the child's session loads and runs regardless of any
// permission scope this launcher can express. A hook that writes into the
// session's working directory therefore writes wherever we point `cwd` — and
// the prior build proved it: a repair child dropped a whole `.remember/` tree
// into the questlog repo because cwd was the repo. There is no flag that
// prevents this; the only lever is cwd itself.
//
// So: the child runs in a throwaway temp directory holding copies of exactly
// the three files it may edit. Its argv is scoped to those COPIES, and its
// selftest runs there. Only if the acceptance gate passes are those three
// files copied back into the repo — nothing else ever is, whatever the hooks
// left behind. The temp directory is then removed.
// ---------------------------------------------------------------------------

// Build the isolated working directory: a temp dir seeded with copies of the
// three permitted files. Returns null if it cannot be built.
function makeRepairWorkDir(repoRoot) {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "questlog-sidecar-repair-"));
    for (const f of SIDECAR_FILES) {
      const src = path.join(repoRoot, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
    }
    return dir;
  } catch { return null; }
}

// Remove the working directory and everything the hooks put in it. Retried,
// and a final failure is LOGGED with the path rather than swallowed.
function removeRepairWorkDir(dir, tries = 3) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); return; }
  catch (err) {
    if (tries > 1) { setTimeout(() => removeRepairWorkDir(dir, tries - 1), 250); return; }
    try { console.error("[questlog] could not remove repair work dir: " + dir + " — " + String(err && err.message || err)); }
    catch { /* nothing left to try */ }
  }
}

// The three files, and ONLY the three files, come home.
function copyRepairFilesBack(workDir, repoRoot) {
  const copied = [];
  for (const f of SIDECAR_FILES) {
    try {
      const src = path.join(workDir, f);
      if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(repoRoot, f)); copied.push(f); }
    } catch { /* the backup restore is the other half of this safety net */ }
  }
  return copied;
}

// The launcher. Never throws. Returns a small record of what it decided.
// deps.spawn injectable so the selftest can assert the exact argv in dry mode
// AND prove that dry mode does not spawn.
function launchSidecarRepair(driftReport, deps = {}) {
  const mode = deps.mode || "auto";
  const drift = Array.isArray(driftReport && driftReport.drift) ? driftReport.drift : [];
  if (mode === "off" || !drift.length) return { launched: false, reason: "off" };

  const sig = driftSignature(drift);
  if (sidecarRepairSeen.has(sig)) return { launched: false, reason: "already-handled" };

  // C1 — GATE POINT 3 of 5 (dec-currency-architecture). A repair run must name a
  // milestone that resolves, or declare itself a chore, BEFORE any working
  // directory is created. Repairs default to chore:true at the call site: they
  // fix tooling, not road work, so they belong in the chore ledger and not on
  // the map. A driftReport that carries neither does not run.
  {
    const gate = assertLinkedOrChore({
      ctx: driftReport && driftReport.ctx,
      milestoneId: driftReport && driftReport.milestoneId,
      chore: driftReport && driftReport.chore,
    }, deps.gateDeps || {});
    if (!gate.ok) return { launched: false, reason: "unlinked", message: gate.message };
    if (gate.chore) {
      ledgerChore(driftReport && driftReport.ctx, {
        source: "sidecar", ref: sig, kind: "launch",
        label: "chat history view: repair run after Claude Code's record of chats changed shape",
      });
    }
  }
  // Every event of this episode is logged with the same road, chat and card
  // anchor, so launched -> passed/failed lands as ONE thread on ONE card.
  const logEvent = (extra) => logSidecarRepair(driftReport && driftReport.ctx, {
    drift,
    sessionId: driftReport && driftReport.chatId,
    milestoneId: driftReport && driftReport.milestoneId,
    ...extra,
  });
  const repoRoot = __dirname;
  const bin = process.env.QUESTLOG_CHAT_CLAUDE_BIN || "claude";
  const p = sidecarRepairPaths();

  // F-C — the child's cwd. NEVER repoRoot. The argv is scoped to the copies
  // that live here, so even a hook-driven write lands in the temp dir.
  const workDir = (deps.makeWorkDir || makeRepairWorkDir)(repoRoot);
  if (!workDir) return { launched: false, reason: "workdir-failed" };
  const args = buildSidecarRepairArgs({ ...driftReport, drift }, workDir);

  // DRY — log the exact command, write the founder's card, spawn NOTHING.
  if (mode === "dry") {
    sidecarRepairSeen.add(sig);
    const command = bin + " " + args.map((a) => (/[\s",]/.test(a) ? JSON.stringify(a) : a)).join(" ");
    try {
      fs.mkdirSync(p.logs, { recursive: true });
      fs.writeFileSync(path.join(p.logs, `${stamp()}-dry.log`),
        `DRY RUN — nothing was spawned.\ncwd (isolated, NOT the repo): ${workDir}\nrepo: ${repoRoot}\n\n${command}\n`, "utf8");
    } catch { /* best-effort */ }
    logEvent({ status: "dry" });
    removeRepairWorkDir(workDir);
    return { launched: false, reason: "dry", command, args, workDir };
  }

  // AUTO — single concurrency: in-process flag + a marker file with pid+ts.
  // Every bail-out from here on removes the work dir it just built.
  if (sidecarRepairInFlight) { removeRepairWorkDir(workDir); return { launched: false, reason: "in-flight" }; }
  try {
    fs.mkdirSync(p.home, { recursive: true });
    if (fs.existsSync(p.marker)) {
      let age = Infinity;
      try { age = Date.now() - fs.statSync(p.marker).mtimeMs; } catch { /* vanished */ }
      if (age < SIDECAR_MARKER_STALE_MS) { removeRepairWorkDir(workDir); return { launched: false, reason: "marker-held" }; }
      try { fs.unlinkSync(p.marker); } catch { /* raced */ }
    }
    fs.writeFileSync(p.marker, JSON.stringify({ pid: process.pid, ts: nowIso(), drift }), "utf8");
  } catch { removeRepairWorkDir(workDir); return { launched: false, reason: "marker-failed" }; }

  sidecarRepairInFlight = true;
  sidecarRepairSeen.add(sig);

  // Back up the three files BEFORE anything runs. This is what makes the
  // acceptance gate real: a failing repair is rolled back, not argued about.
  const backupDir = path.join(p.backups, stamp());
  const backedUp = [];
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    for (const f of SIDECAR_FILES) {
      const src = path.join(repoRoot, f);
      if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(backupDir, f)); backedUp.push(f); }
    }
  } catch { /* a partial backup still restores what it holds */ }

  const logPath = path.join(p.logs, `${stamp()}.log`);
  let logStream = null;
  try { fs.mkdirSync(p.logs, { recursive: true }); logStream = fs.createWriteStream(logPath, { flags: "a" }); } catch { logStream = null; }

  const release = () => {
    sidecarRepairInFlight = false;
    try { fs.unlinkSync(p.marker); } catch { /* gone */ }
    try { if (logStream) logStream.end(); } catch { /* gone */ }
    // F-C — the work dir goes, and every foreign file the child's hooks left
    // in it goes with it. It was never inside the founder's repo.
    removeRepairWorkDir(workDir);
  };
  const restore = () => {
    try { for (const f of backedUp) fs.copyFileSync(path.join(backupDir, f), path.join(repoRoot, f)); }
    catch { /* best-effort */ }
  };

  logEvent({ status: "launched", logPath, backupDir });

  let child;
  const spawnFn = deps.spawn || spawn;
  try {
    child = spawnFn(bin, args, {
      // F-C — the isolated temp dir, NEVER repoRoot. See the caveat above:
      // the founder's global hooks write into cwd and no allowedTools scope
      // can stop them, so cwd is the only place that decision can be made.
      cwd: workDir,
      env: (deps.cleanEnv || cleanEnvForRepair)(process.env),   // nesting vars cleared
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
  } catch (err) {
    release();
    logEvent({ status: "failed", error: String(err && err.message || err) });
    return { launched: false, reason: "spawn-failed", error: String(err && err.message || err) };
  }

  if (logStream) {
    if (child.stdout) child.stdout.on("data", (d) => { try { logStream.write(d); } catch { /* gone */ } });
    if (child.stderr) child.stderr.on("data", (d) => { try { logStream.write(d); } catch { /* gone */ } });
  }
  const hardTimer = setTimeout(() => {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, shell: false });
      else child.kill("SIGKILL");
    } catch { /* gone */ }
  }, SIDECAR_REPAIR_TIMEOUT_MS);

  child.on("error", (err) => {
    clearTimeout(hardTimer); restore(); release();
    logEvent({ status: "failed", error: String(err && err.message || err) });
  });
  child.on("close", () => {
    clearTimeout(hardTimer);
    // THE ACCEPTANCE GATE. The launcher — not the child — runs the selftest.
    // The child claiming green is not evidence; this is.
    // It runs on the CHILD'S COPIES, in the child's work dir — the repo has not
    // been touched yet and is not touched at all unless this passes.
    let gate = { ok: false, out: "" };
    try {
      const r = spawnSync(process.execPath, [path.join(workDir, "sidecar-adapter.selftest.mjs")], {
        cwd: workDir, env: { ...process.env, SIDECAR_SELFTEST_REQUIRE_REAL: "1" },
        encoding: "utf8", timeout: 300000, windowsHide: true,
      });
      gate = { ok: r.status === 0, out: String(r.stdout || "") + String(r.stderr || "") };
    } catch (err) { gate = { ok: false, out: String(err && err.message || err) }; }
    try { if (logStream) logStream.write("\n--- ACCEPTANCE GATE ---\n" + gate.out + "\n"); } catch { /* gone */ }
    // PASS: exactly three files come home, and nothing else. FAIL: nothing
    // comes home at all, and the backup restore is belt to that braces.
    let copied = [];
    if (gate.ok) copied = copyRepairFilesBack(workDir, repoRoot);
    else restore();
    release();
    logEvent({
      status: gate.ok ? "passed" : "failed", logPath, backupDir,
      restored: !gate.ok, copiedBack: copied,
    });
  });

  return { launched: true, reason: "auto", logPath, backupDir, args, workDir };
}

// The repair child must be a clean top-level Claude run — never nested inside
// this process's own session. bridge.cleanEnv is the canonical stripper; this
// wrapper exists only so the launcher can be given a fake in tests.
function cleanEnvForRepair(env) { return bridgeCleanEnv(env); }

function computeSourceHash() {
  try {
    const h = crypto.createHash("sha256");
    for (const f of ["server.mjs", "bridge.mjs", "index.html", "chat.mjs"]) {
      h.update(fs.readFileSync(path.join(__dirname, f)));
    }
    return h.digest("hex");
  } catch {
    return "";
  }
}

const PACKAGED = process.env.QUESTLOG_PACKAGED === "1";
let BUILD_INFO = null;
if (isSet(process.env.QUESTLOG_BUILD_INFO)) {
  try { BUILD_INFO = JSON.parse(fs.readFileSync(process.env.QUESTLOG_BUILD_INFO, "utf8")); }
  catch { BUILD_INFO = null; }
}
const SOURCE_HASH = (PACKAGED && BUILD_INFO && typeof BUILD_INFO.sourceHash === "string" && BUILD_INFO.sourceHash)
  ? BUILD_INFO.sourceHash
  : computeSourceHash();
const BUILD_ID = (PACKAGED && BUILD_INFO && typeof BUILD_INFO.buildId === "string" && BUILD_INFO.buildId)
  ? BUILD_INFO.buildId
  : "dev";

// ---------------------------------------------------------------------------
// Per-roadmap context factory (planner §1.4 implementation note)
// One factory builds {root, dataDir, lockDir, files}. Dir mode builds one at
// startup; central mode builds one per request from the registry entry.
// ---------------------------------------------------------------------------
function makeCtx(root) {
  const dataDir = path.join(root, ".questlog");
  return {
    root,
    dataDir,
    lockDir: path.join(dataDir, ".lock"),
    files: {
      roadmap: path.join(dataDir, "roadmap.json"),
      decisions: path.join(dataDir, "decisions.json"),
      pins: path.join(dataDir, "pins.json"),
      glossary: path.join(dataDir, "glossary.json"),
      history: path.join(dataDir, "history.jsonl"),
      sessions: path.join(dataDir, "sessions.json"),
      batons: path.join(dataDir, "batons.json"),
      suggestions: path.join(dataDir, "suggestions.json"),
      // Held colliding writes (the founder's ruling, 2026-08-27). Its own file
      // for the same reason batons.json is: roadmap.json's strict schema stays
      // untouched, and a road that has never had a collision has no file here.
      conflicts: path.join(dataDir, "conflicts.json"),
      // The chore ledger (dec-currency-architecture). NOT a road file: nothing
      // written here changes what the map shows. Absent until a chore runs.
      activity: path.join(dataDir, "activity.jsonl"),
    },
  };
}

// The single dir-mode context (unused in central mode).
const DIR_CTX = makeCtx(PROJECT_ROOT);

// Chat dock (B1) wiring: resolve a chat's road to a ctx. Dir mode ignores the
// roadId (one road = DIR_CTX); central resolves via the registry. resolveRoadmap
// is a hoisted function declaration, so referencing it here is safe.
const CHAT_DEPS = {
  mode: MODE,
  // Config default chat model (fresh per call, honest after a settings save).
  defaultChatModel() { return computeEffectiveConfig().config.chat.model; },
  // Effective access profiles, fresh per call (honest right after a save).
  chatProfiles() { return computeEffectiveConfig().config.chat.profiles; },
  // The two chat clocks (P2). chat.mjs lets env win over whatever comes back.
  chatTimeouts() {
    const c = computeEffectiveConfig().config.chat;
    return { timeoutMs: c.timeoutMs, idleTimeoutMs: c.idleTimeoutMs };
  },
  // F8b — sidecar enrichment on/off, fresh per call.
  sidecarEnabled() { return computeEffectiveConfig().config.sidecar.enabled !== false; },
  // F8b — the drift sentinel fired. Fire the repair launcher per config, and
  // never let it break the chat open that reported the drift.
  onSidecarDrift(report) {
    try {
      const mode = computeEffectiveConfig().config.sidecar.repair;
      // C1 — a repair fixes questlog's own tooling, not the founder's road, so
      // it declares itself a chore. That is what lets it through the launch gate
      // and what puts it in the chore ledger instead of on a milestone.
      launchSidecarRepair({ chore: true, ...report }, { mode });
    } catch { /* the splint already engaged; a launcher failure changes nothing */ }
  },
  resolveRoadCtx(roadId) {
    if (MODE === "dir") return { ctx: DIR_CTX, roadId: roadId || null, root: DIR_CTX.root };
    if (!roadId) return null;
    const r = resolveRoadmap(roadId);
    if (r.notFound || r.missing) return null;
    return { ctx: r.ctx, roadId, root: r.ctx.root };
  },
};

// ---------------------------------------------------------------------------
// Time / id helpers
// ---------------------------------------------------------------------------
const nowIso = () => new Date().toISOString();
const genId = (prefix) => `${prefix}-${crypto.randomBytes(4).toString("hex")}`;

// ---------------------------------------------------------------------------
// Empty skeletons (used when a file is missing — GET stays valid)
// ---------------------------------------------------------------------------
function emptyRoadmap(root) {
  const ts = nowIso();
  return {
    schemaVersion: 1,
    project: { name: path.basename(root) || "Untitled Project", tagline: "", createdAt: ts, updatedAt: ts },
    quests: [
      { id: "q-main", type: "main", title: "Main Quest", parentMilestoneId: null, side: null, order: 0, status: "in_progress", createdAt: ts, updatedAt: ts },
    ],
    milestones: [],
    items: [],
    assets: [],
  };
}
const emptyDecisions = () => ({ schemaVersion: 1, decisions: [] });
const emptyPins = () => ({ schemaVersion: 1, pins: [] });
const emptyGlossary = () => ({ schemaVersion: 1, terms: [] });
const emptySessions = () => ({ schemaVersion: 1, sessions: [] });
const emptyBatons = () => ({ schemaVersion: 1, batons: [] });
const emptySuggestions = () => ({ schemaVersion: 1, suggestions: [] });

// ---------------------------------------------------------------------------
// Read helpers (tolerant — never throw to the request handler)
// ---------------------------------------------------------------------------
function readJson(file, fallbackFn) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallbackFn();
  }
}

function readHistoryTail(ctx, n) {
  try {
    const raw = fs.readFileSync(ctx.files.history, "utf8");
    const out = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* skip malformed line */ }
    }
    return out.slice(-n);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// DERIVED eventCount (HARNESS-5). sessions.json stores an eventCount that only
// counts what THIS process bumped — one session showed 1 stored against 15+ real
// history events. The honest number is derivable from history.jsonl, so derive
// it at read time and keep the stored one as `storedEventCount` for
// transparency. Disk shape and upsertSession are unchanged: stored becomes
// advisory. Precedent: claimsComplete.
// ---------------------------------------------------------------------------
function deriveEventCounts(historyFile) {
  const counts = new Map();
  let raw;
  try { raw = fs.readFileSync(historyFile, "utf8"); } catch { return counts; }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e; try { e = JSON.parse(t); } catch { continue; }
    const sid = (e && typeof e.sessionId === "string" && e.sessionId) ? e.sessionId : null;
    if (!sid) continue;
    counts.set(sid, (counts.get(sid) || 0) + 1);
  }
  return counts;
}
// Served eventCount = derived (fallback to stored when history is unreadable /
// the session appears nowhere in it), plus storedEventCount. Never writes.
function overlayDerivedSessions(sessions, historyFile) {
  const counts = deriveEventCounts(historyFile);
  return (Array.isArray(sessions) ? sessions : []).map((s) => {
    if (!s || typeof s !== "object") return s;
    const stored = Number.isInteger(s.eventCount) ? s.eventCount : 0;
    const derived = counts.has(s.id) ? counts.get(s.id) : null;
    return Object.assign({}, s, { eventCount: derived === null ? stored : derived, storedEventCount: stored });
  });
}

// The five milestone statuses, always all five keys (0 where absent), so a
// consumer never has to guess whether a missing key means zero or unknown.
// MIRRORED in mcp/server.mjs statusBreakdownOf.
function statusBreakdownOf(milestones) {
  const out = { done: 0, in_progress: 0, available: 0, locked: 0, blocked: 0 };
  for (const m of (Array.isArray(milestones) ? milestones : [])) {
    const s = m && typeof m.status === "string" ? m.status : "locked";
    if (Object.prototype.hasOwnProperty.call(out, s)) out[s]++;
  }
  return out;
}

function statMtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}
function statSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function computeRev(ctx) {
  return [
    statMtime(ctx.files.roadmap),
    statMtime(ctx.files.decisions),
    statMtime(ctx.files.pins),
    statMtime(ctx.files.glossary),
    statSize(ctx.files.history),
    statMtime(ctx.files.sessions),
    statMtime(ctx.files.batons),
    statMtime(ctx.files.suggestions),
    // A hold writes no road file, so without this segment a contested change
    // would sit invisible until something else moved. The dashboard only ever
    // compares rev for equality, so one more segment costs nothing.
    statMtime(ctx.files.conflicts),
  ].join("-");
}

// ---------------------------------------------------------------------------
// Lock + atomic write + history (same protocol as the MCP server)
// All helpers are ctx-parameterized so central mode can run per-roadmap.
// ---------------------------------------------------------------------------
function ensureDataDir(ctx) {
  if (!fs.existsSync(ctx.dataDir)) fs.mkdirSync(ctx.dataDir, { recursive: true });
}

function acquireLock(ctx) {
  ensureDataDir(ctx);
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(ctx.lockDir);
      return; // acquired
    } catch (err) {
      if (err.code !== "EEXIST") throw Object.assign(new Error("E_IO: " + err.message), { code: "E_IO" });
      // Lock exists — check staleness.
      let age = Infinity;
      try { age = Date.now() - fs.statSync(ctx.lockDir).mtimeMs; } catch { /* vanished */ }
      if (age > 5000) {
        try { fs.rmdirSync(ctx.lockDir); } catch { /* someone else cleaned it */ }
        continue; // retry immediately
      }
      if (Date.now() - start > 3000) {
        throw Object.assign(new Error("E_LOCK_TIMEOUT: could not acquire lock"), { code: "E_LOCK_TIMEOUT" });
      }
      // brief busy-wait (synchronous mutation window is tiny)
      const until = Date.now() + 50;
      while (Date.now() < until) { /* spin ~50ms */ }
    }
  }
}

function releaseLock(ctx) {
  try { fs.rmdirSync(ctx.lockDir); } catch { /* already gone */ }
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function appendHistory(ctx, evt) {
  fs.appendFileSync(ctx.files.history, JSON.stringify(evt) + "\n", "utf8");
}

// Run a mutation fully inside the roadmap's lock. fn does its own reads /
// writes / history via the helpers. Returns fn's return value.
function withLock(ctx, fn) {
  acquireLock(ctx);
  try {
    return fn();
  } finally {
    releaseLock(ctx);
  }
}

// ---------------------------------------------------------------------------
// ROADMAP CURRENCY (dec-currency-architecture) — the server-side wiring.
//
// C1, THE LAUNCH GATE. This is the ONE helper every internal questlog spawner
// runs before it spawns: the bridge (per-note and batch), the sidecar repair
// launcher, the horizon-request drain, session resume, and distillation. A run
// must name a milestone that RESOLVES on the target road, or declare itself a
// chore. Neither means it does not run.
//
// HONESTY LIMIT, stated here because the code cannot state it for itself:
// questlog CANNOT gate Claude Code's own workflow tool, or any agent launched
// outside questlog. Those are DETECTED and labelled `unlinked` by scanRaids —
// detection, never prevention. No copy anywhere may say "blocked".
//
// `deps` is injectable so a selftest can drive the gate without a real road.
// ---------------------------------------------------------------------------
function assertLinkedOrChore({ ctx, milestoneId, chore } = {}, deps = {}) {
  const read = deps.readRoadmap || ((c) => readJson(c.files.roadmap, () => emptyRoadmap(c.root)));
  const roadmap = ctx ? read(ctx) : { milestones: [] };
  return currency.assertLinkedOrChore({ roadmap, milestoneId, chore });
}

// One chore line into <road>/.questlog/activity.jsonl. Idempotent by
// (source, ref, kind), so a retry writes nothing. Takes the road lock unless
// the caller says it already holds it. Never throws: a ledger failure must
// never break the run it was only observing.
function ledgerChore(ctx, entry, { held = false } = {}) {
  if (!ctx || !ctx.files || !ctx.files.activity) return { written: false, reason: "no-road" };
  const write = () => {
    try { fs.mkdirSync(ctx.dataDir, { recursive: true }); } catch { /* best-effort */ }
    return currency.appendActivity(ctx.files.activity, entry);
  };
  try { return held ? write() : withLock(ctx, write); }
  catch (err) { return { written: false, error: String((err && err.message) || err) }; }
}

// Which registered road owns this milestone id? Used by the raid watcher, which
// learns a milestone id off a workflow's meta and has to find its road. Dir mode
// has exactly one road; central mode scans the registry (reads only).
function findRoadForMilestone(milestoneId) {
  if (typeof milestoneId !== "string" || !milestoneId) return null;
  if (MODE === "dir") {
    const rm = readJson(DIR_CTX.files.roadmap, () => emptyRoadmap(DIR_CTX.root));
    return currency.milestoneResolves(rm, milestoneId) ? DIR_CTX : null;
  }
  for (const e of (readRegistry().roadmaps || [])) {
    if (!e || typeof e.dir !== "string") continue;
    let c;
    try { c = makeCtx(path.resolve(e.dir)); } catch { continue; }
    const rm = readJson(c.files.roadmap, () => emptyRoadmap(c.root));
    if (currency.milestoneResolves(rm, milestoneId)) return c;
  }
  return null;
}

// C2/C3 — write ONE evidence entry onto a milestone, idempotently by
// (source, ref, kind). Returns {written:false, reason:"duplicate"} when the key
// is already present, and in that case the file is not rewritten AT ALL, so a
// watcher restart leaves roadmap.json byte-identical.
//
// C3 is enforced right here: an entry that carries any judged field (status,
// statusReason, title, plain, order) is REFUSED, not stripped. Automation may
// write evidence; it may never write status.
function writeEvidence(ctx, milestoneId, rawEntry, { held = false } = {}) {
  const norm = currency.normalizeEvidenceEntry(rawEntry);
  if (norm.error) return { written: false, error: norm.error, code: norm.code || "E_VALIDATION" };
  const doIt = () => {
    const roadmap = readJson(ctx.files.roadmap, () => emptyRoadmap(ctx.root));
    const ms = (roadmap.milestones || []).find((m) => m && m.id === milestoneId);
    if (!ms) return { written: false, reason: "E_UNLINKED", error: `milestoneId ${milestoneId} does not resolve on this road` };
    const before = Array.isArray(ms.evidence) ? ms.evidence : [];
    const up = currency.upsertEvidence(before, norm.entry);
    if (!up.changed) return { written: false, reason: "duplicate", entry: norm.entry };
    ms.evidence = up.list;
    // NOTE: updatedAt is deliberately NOT bumped and status is deliberately NOT
    // touched. An observation is not an edit of the founder's card.
    atomicWrite(ctx.files.roadmap, roadmap);
    return { written: true, entry: norm.entry };
  };
  try { return held ? doIt() : withLock(ctx, doIt); }
  catch (err) { return { written: false, error: String((err && err.message) || err) }; }
}

// Which milestone does a card belong to? The per-note bridge trigger names a
// card, and the launch gate wants the milestone behind it. A decision borrows
// the first milestone it relates to. Returns null when nothing resolves — and a
// null is a REFUSAL at the gate, not a silent pass.
function milestoneForTarget(ctx, targetType, id) {
  const rm = readJson(ctx.files.roadmap, () => emptyRoadmap(ctx.root));
  if (targetType === "milestone") return currency.milestoneResolves(rm, id) ? id : null;
  const it = (rm.items || []).find((x) => x && x.id === id);
  if (it && typeof it.milestoneId === "string") return it.milestoneId;
  if (targetType === "decision") {
    const dec = readJson(ctx.files.decisions, emptyDecisions);
    const d = (dec.decisions || []).find((x) => x && x.id === id);
    const rel = d && Array.isArray(d.relatedMilestoneIds) ? d.relatedMilestoneIds : [];
    if (rel.length && currency.milestoneResolves(rm, rel[0])) return rel[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// sessions.json — per-roadmap session tracing (planner §1.2)
// upsertSession is called INSIDE the same lock as the mutation it accounts
// for, after appendHistory. Never acquires its own lock.
// ---------------------------------------------------------------------------
function extractSessionId(payload) {
  const s = payload && payload.sessionId;
  return (typeof s === "string" && s.length > 0) ? s : null;
}

function upsertSession(ctx, sessionId, label, delta) {
  if (typeof sessionId !== "string" || !sessionId) return null;
  const data = readJson(ctx.files.sessions, emptySessions);
  if (!data || typeof data !== "object") return null;
  if (!Array.isArray(data.sessions)) data.sessions = [];
  data.schemaVersion = 1;
  const now = nowIso();
  let s = data.sessions.find((x) => x && x.id === sessionId);
  if (s) {
    s.lastSeenAt = now;
    s.eventCount = (Number.isInteger(s.eventCount) ? s.eventCount : 0) + delta;
    if (typeof label === "string" && label.length > 0) s.label = label;
    // C5 — clear-on-write. A board write is a road write: it is what the dirty
    // bit was asking for. A row that was never dirty is left byte-identical.
    if (delta >= 1) currency.clearDirty(s);
  } else {
    s = {
      id: sessionId,
      firstSeenAt: now,
      lastSeenAt: now,
      label: (typeof label === "string" ? label : "") || "",
      eventCount: delta,
    };
    data.sessions.push(s);
  }
  atomicWrite(ctx.files.sessions, data);
  return s;
}

// ---------------------------------------------------------------------------
// Registry (planner §1.1) — user-level roadmap registry.
// Own lock, never nested with a roadmap lock. Reads are lock-free / tolerant.
// ---------------------------------------------------------------------------
function registryPath() {
  return process.env.QUESTLOG_REGISTRY || path.join(os.homedir(), ".questlog", "registry.json");
}
function registryLockDir() {
  return path.join(path.dirname(registryPath()), ".lock");
}
const emptyRegistry = () => ({ schemaVersion: 1, roadmaps: [] });

function readRegistry() {
  const data = readJson(registryPath(), emptyRegistry);
  if (!data || typeof data !== "object" || !Array.isArray(data.roadmaps)) return emptyRegistry();
  if (data.schemaVersion !== 1) data.schemaVersion = 1;
  return data;
}

function sameDir(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
// Registry hygiene (pin — MIRRORED in mcp/server.mjs isRefusedRegistryPath): a
// resolved path is refused iff any path SEGMENT (split on \ or /) equals
// (case-insensitive) "Temp" or "scratchpad", OR the path starts with os.tmpdir().
// Escape hatch: QUESTLOG_ALLOW_TEMP=1 (selftests only). A live road re-registers
// itself on its next dir-mode start, so nothing durable is lost by refusing.
function isRefusedRegistryPath(resolved) {
  if (process.env.QUESTLOG_ALLOW_TEMP === "1") return false;
  const segs = resolved.split(/[\\/]/);
  for (const s of segs) { const l = s.toLowerCase(); if (l === "temp" || l === "scratchpad") return true; }
  try {
    const tmp = path.resolve(os.tmpdir());
    const a = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    const b = process.platform === "win32" ? tmp.toLowerCase() : tmp;
    if (a === b || a.startsWith(b + path.sep) || a.startsWith(b + "/")) return true;
  } catch { /* no tmpdir — ignore */ }
  return false;
}
function slugify(base) {
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function acquireRegistryLock() {
  const lockDir = registryLockDir();
  const parent = path.dirname(lockDir);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw Object.assign(new Error("E_IO: " + err.message), { code: "E_IO" });
      let age = Infinity;
      try { age = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { /* vanished */ }
      if (age > 5000) { try { fs.rmdirSync(lockDir); } catch { /* raced */ } continue; }
      if (Date.now() - start > 3000) {
        throw Object.assign(new Error("E_LOCK_TIMEOUT: could not acquire registry lock"), { code: "E_LOCK_TIMEOUT" });
      }
      const until = Date.now() + 50;
      while (Date.now() < until) { /* spin ~50ms */ }
    }
  }
}
function releaseRegistryLock() {
  try { fs.rmdirSync(registryLockDir()); } catch { /* already gone */ }
}

// Read the display name for a project dir: <dir>/.questlog/roadmap.json
// project.name if readable, else the dir basename.
function nameForDir(resolved) {
  try {
    const rm = JSON.parse(fs.readFileSync(path.join(resolved, ".questlog", "roadmap.json"), "utf8"));
    if (rm && rm.project && typeof rm.project.name === "string" && rm.project.name) return rm.project.name;
  } catch { /* fall through */ }
  return path.basename(resolved);
}

// Upsert-by-dir (planner §1.1). Whole read-modify-write under the registry lock.
function upsertRegistryEntry(inputDir) {
  const resolved = path.resolve(inputDir);
  if (isRefusedRegistryPath(resolved)) {
    throw Object.assign(new Error("temp/scratch path refused"), { code: "E_TEMP_PATH" });
  }
  acquireRegistryLock();
  try {
    const reg = readRegistry();
    if (!Array.isArray(reg.roadmaps)) reg.roadmaps = [];
    const now = nowIso();
    const name = nameForDir(resolved);

    let entry = reg.roadmaps.find(
      (e) => e && typeof e.dir === "string" && sameDir(path.resolve(e.dir), resolved),
    );
    if (entry) {
      // Match: refresh lastSeenAt + name; keep id and addedAt stable.
      entry.lastSeenAt = now;
      entry.name = name;
    } else {
      // New entry.
      const slug = slugify(path.basename(resolved));
      let id;
      if (slug && /^[a-z0-9][a-z0-9-]*$/.test(slug)) id = "rm-" + slug;
      else id = "rm-" + crypto.randomBytes(4).toString("hex"); // 8 hex chars
      // If this id already belongs to a *different* dir, disambiguate.
      if (reg.roadmaps.some((e) => e && e.id === id && !(typeof e.dir === "string" && sameDir(path.resolve(e.dir), resolved)))) {
        id = id + "-" + crypto.randomBytes(2).toString("hex"); // + 4 hex chars
      }
      entry = { id, name, dir: resolved, addedAt: now, lastSeenAt: now };
      reg.roadmaps.push(entry);
    }
    reg.schemaVersion = 1;
    atomicWrite(registryPath(), reg);
    return entry;
  } finally {
    releaseRegistryLock();
  }
}

// ---------------------------------------------------------------------------
// Config file — ~/.questlog/config.json (planner §1.1–§1.6). Read is delegated
// to bridge.mjs (readConfigFile / configFilePath, same-dir-as-registry). Writes
// use the same mkdir-lock + atomic-rename protocol as the registry, with their
// OWN lock dir (.config-lock, 3s timeout / 5s stale) so a config write never
// contends with a roadmap or registry write.
// ---------------------------------------------------------------------------
function configLockDir() {
  return path.join(questlogHome(process.env), ".config-lock");
}
function acquireConfigLock() {
  const lockDir = configLockDir();
  const parent = path.dirname(lockDir);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw Object.assign(new Error("E_IO: " + err.message), { code: "E_IO" });
      let age = Infinity;
      try { age = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { /* vanished */ }
      if (age > 5000) { try { fs.rmdirSync(lockDir); } catch { /* raced */ } continue; }
      if (Date.now() - start > 3000) {
        throw Object.assign(new Error("E_LOCK_TIMEOUT: could not acquire config lock"), { code: "E_LOCK_TIMEOUT" });
      }
      const until = Date.now() + 50;
      while (Date.now() < until) { /* spin ~50ms */ }
    }
  }
}
function releaseConfigLock() {
  try { fs.rmdirSync(configLockDir()); } catch { /* already gone */ }
}

// Autostart Startup-folder file (planner §1.6). Pure text, no COM / admin /
// schtasks. %APPDATA% honored (overridable for tests); references the desktop
// launcher by PATH STRING ONLY — no file overlap, no import.
function autostartDir() {
  const appdata = isSet(process.env.APPDATA)
    ? process.env.APPDATA
    : path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appdata, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}
function autostartFilePath() {
  return path.join(autostartDir(), "questlog-autostart.vbs");
}
// What the Startup entry actually runs. Two layouts (finding #1 fix):
//   * PACKAGED exe: __dirname is the versioned extraction dir (no launcher
//     there), so point autostart straight at the real questlog.exe on disk —
//     process.execPath IS that binary for a SEA. Running it with no args starts
//     the central-mode server, exactly what login-autostart wants.
//   * Node/dev: server.mjs lives at the app root; the launcher is one level
//     down at <appRoot>\desktop\launch.mjs (NOT <appRoot>\launch.mjs).
function autostartTarget() {
  if (PACKAGED) {
    return { kind: "exe", path: process.execPath };
  }
  return { kind: "launcher", path: path.join(__dirname, "desktop", "launch.mjs") };
}
function autostartVbsContent() {
  const t = autostartTarget();
  if (t.kind === "exe") {
    // WScript.Shell.Run(..., 0, False): window style 0 = hidden, so even a
    // console-subsystem exe shows no window at login.
    return 'CreateObject("WScript.Shell").Run """' + t.path + '""", 0, False\r\n';
  }
  // Window style 0 again: node runs the launcher with no window at login.
  // Both paths are quoted — a Node under Program Files has a space in it.
  return 'CreateObject("WScript.Shell").Run """' + process.execPath + '"" ""' +
    t.path + '"" --silent", 0, False\r\n';
}
// Sync the Startup file to `want`. Returns { actual, warning }. Single writer:
// only POST /api/config ever calls this.
function syncAutostartFile(want) {
  const file = autostartFilePath();
  let warning = null;
  if (want) {
    fs.mkdirSync(autostartDir(), { recursive: true });
    fs.writeFileSync(file, autostartVbsContent(), "utf8");
    const t = autostartTarget();
    if (!fs.existsSync(t.path)) {
      warning = (t.kind === "exe" ? "questlog.exe" : "desktop/launch.mjs") +
        " not found; startup entry will do nothing until it exists";
    }
  } else {
    try { fs.unlinkSync(file); } catch { /* already absent */ }
  }
  return { actual: fs.existsSync(file), warning };
}

// Compute the EFFECTIVE config + per-key source, fresh from disk (planner §1.4).
// Port reflects what the RUNNING process resolved at startup (a config change
// needs a restart); bridge/autostart are read live so the settings panel is
// honest immediately after a save.
function computeEffectiveConfig() {
  const fc = readConfigFile(process.env) || {};
  const bcfg = readBridgeConfig(process.env, fc);

  // Port: report the frozen startup value + source (§1.4 note).
  const port = PORT;
  const portSource = PORT_SOURCE;

  // Bridge sources (mirror readBridgeConfig's precedence exactly).
  const bridgeEnabledSource = isSet(process.env.QUESTLOG_BTW_BRIDGE) ? "env"
    : (fc.bridge && fc.bridge.enabled === true) ? "config" : "default";
  const bridgeDryRunSource = isSet(process.env.QUESTLOG_BTW_DRYRUN) ? "env"
    : (fc.bridge && typeof fc.bridge.dryRun === "boolean") ? "config" : "default";
  const bridgeModelSource = isSet(process.env.QUESTLOG_BTW_MODEL) ? "env"
    : (fc.bridge && typeof fc.bridge.model === "string" && fc.bridge.model) ? "config" : "default";
  const bridgeAutoTriggerSource = isSet(process.env.QUESTLOG_BTW_AUTOTRIGGER) ? "env"
    : (fc.bridge && fc.bridge.autoTrigger === true) ? "config" : "default";

  // Autostart is config-only (no env var).
  const autostart = (typeof fc.autostart === "boolean") ? fc.autostart : false;
  const autostartSource = (typeof fc.autostart === "boolean") ? "config" : "default";

  // Raids + roster are config-only (no env vars). Defaults: raids on with the
  // built-in journal glob; roster spawn OFF (copy-command always available, but
  // the server only spawns a resume when the founder opts in).
  const fcRaids = (fc.raids && typeof fc.raids === "object" && !Array.isArray(fc.raids)) ? fc.raids : {};
  const raidsEnabled = (typeof fcRaids.enabled === "boolean") ? fcRaids.enabled : true;
  const raidsEnabledSource = (typeof fcRaids.enabled === "boolean") ? "config" : "default";
  const raidsRoots = Array.isArray(fcRaids.journalRoots) ? fcRaids.journalRoots.filter((s) => typeof s === "string" && s) : [];
  const raidsRootsSource = (Array.isArray(fcRaids.journalRoots) && raidsRoots.length) ? "config" : "default";

  const fcRoster = (fc.roster && typeof fc.roster === "object" && !Array.isArray(fc.roster)) ? fc.roster : {};
  const rosterAllowSpawn = (typeof fcRoster.allowSpawn === "boolean") ? fcRoster.allowSpawn : false;
  const rosterAllowSpawnSource = (typeof fcRoster.allowSpawn === "boolean") ? "config" : "default";

  // Archaeology is config-only (no env var). repoPaths default []: absent =>
  // the milestone-provenance join stays board-side (sessions only, no commits).
  const fcArch = (fc.archaeology && typeof fc.archaeology === "object" && !Array.isArray(fc.archaeology)) ? fc.archaeology : {};
  const archRepoPaths = Array.isArray(fcArch.repoPaths) ? fcArch.repoPaths.filter((s) => typeof s === "string" && s) : [];
  const archRepoPathsSource = (Array.isArray(fcArch.repoPaths) && archRepoPaths.length) ? "config" : "default";

  // Skins (Wave 3, §1) — config-only. active default "parchment".
  const fcSkins = (fc.skins && typeof fc.skins === "object" && !Array.isArray(fc.skins)) ? fc.skins : {};
  const skinsActive = (typeof fcSkins.active === "string" && fcSkins.active) ? fcSkins.active : "parchment";
  const skinsActiveSource = (typeof fcSkins.active === "string" && fcSkins.active) ? "config" : "default";

  // Distillery (Wave 3, §3) — config-only. live default false (dry-run only).
  const fcDist = (fc.distillery && typeof fc.distillery === "object" && !Array.isArray(fc.distillery)) ? fc.distillery : {};
  const distLive = (typeof fcDist.live === "boolean") ? fcDist.live : false;
  const distLiveSource = (typeof fcDist.live === "boolean") ? "config" : "default";

  // Task board (Wave 3, §4) — config-only. enabled default false; empty window.
  const fcTb = (fc.taskboard && typeof fc.taskboard === "object" && !Array.isArray(fc.taskboard)) ? fc.taskboard : {};
  const tbEnabled = (typeof fcTb.enabled === "boolean") ? fcTb.enabled : false;
  const tbEnabledSource = (typeof fcTb.enabled === "boolean") ? "config" : "default";
  const tbWindow = taskboard.normalizeWindow(fcTb.capacityWindow);
  const tbWindowSource = (fcTb.capacityWindow && typeof fcTb.capacityWindow === "object") ? "config" : "default";

  // Chat dock (v3) — config-only. Model default "sonnet"; a per-chat picker can
  // still override at creation. Same [a-z0-9.-] rule as bridge.model.
  const fcChat = (fc.chat && typeof fc.chat === "object" && !Array.isArray(fc.chat)) ? fc.chat : {};
  const chatModel = (typeof fcChat.model === "string" && fcChat.model) ? fcChat.model : "sonnet";
  const chatModelSource = (typeof fcChat.model === "string" && fcChat.model) ? "config" : "default";
  // Access profiles (dec-chat-access-tiers): config entries REPLACE a built-in
  // by name; every entry is re-clamped against the frozen ceiling here too, so
  // even a config that somehow got past validation cannot widen a profile.
  const fcProfiles = (fcChat.profiles && typeof fcChat.profiles === "object" && !Array.isArray(fcChat.profiles)) ? fcChat.profiles : {};
  const chatProfiles = {};
  for (const [name, def] of Object.entries(chat.DEFAULT_PROFILES)) {
    chatProfiles[name] = { label: def.label, allowedTools: Array.isArray(def.allowedTools) ? def.allowedTools.slice() : null, permissionMode: def.permissionMode, source: "default" };
  }
  for (const [name, def] of Object.entries(fcProfiles)) {
    if (!def || typeof def !== "object" || Array.isArray(def)) continue;
    const base = chatProfiles[name] || { label: name, allowedTools: [], permissionMode: null };
    chatProfiles[name] = {
      label: (typeof def.label === "string" && def.label) ? def.label : base.label,
      allowedTools: Array.isArray(def.allowedTools) ? def.allowedTools.filter((t) => typeof t === "string" && t)
        : (def.allowedTools === null ? null : base.allowedTools),
      permissionMode: chat.clampPermissionMode(name, def.permissionMode),
      source: "config",
    };
  }
  const chatProfilesSource = Object.keys(fcProfiles).length ? "config" : "default";

  // Chat clocks (P2). Env wins over config wins over the built-in default —
  // the same precedence the bridge keys use, so the envLocked() treatment in
  // the settings panel is honest for these too.
  const envTimeout = isSet(process.env.QUESTLOG_CHAT_TIMEOUT_MS);
  const envIdle = isSet(process.env.QUESTLOG_CHAT_IDLE_TIMEOUT_MS);
  const cfgTimeout = (typeof fcChat.timeoutMs === "number" && Number.isFinite(fcChat.timeoutMs) && fcChat.timeoutMs > 0) ? fcChat.timeoutMs : null;
  const cfgIdle = (typeof fcChat.idleTimeoutMs === "number" && Number.isFinite(fcChat.idleTimeoutMs) && fcChat.idleTimeoutMs > 0) ? fcChat.idleTimeoutMs : null;
  const chatTimeoutMs = chat.chatTimeoutMs(process.env, { timeoutMs: cfgTimeout });
  const chatIdleTimeoutMs = chat.chatIdleTimeoutMs(process.env, { idleTimeoutMs: cfgIdle });
  const chatTimeoutSource = envTimeout ? "env" : (cfgTimeout !== null ? "config" : "default");
  const chatIdleSource = envIdle ? "env" : (cfgIdle !== null ? "config" : "default");

  // Sidecar (F8b, dec-sidecar-selfhealing). enabled default true — the read is
  // read-only and splints on any doubt. repair default "auto": that is the
  // founder's own verbatim standing instruction ("on every update change being
  // detected an agent should launch a session of fable"), not an assumption.
  // "dry" logs and notes the exact command without spawning; "off" does neither.
  const fcSide = (fc.sidecar && typeof fc.sidecar === "object" && !Array.isArray(fc.sidecar)) ? fc.sidecar : {};
  const sidecarEnabled = (typeof fcSide.enabled === "boolean") ? fcSide.enabled : true;
  const sidecarEnabledSource = (typeof fcSide.enabled === "boolean") ? "config" : "default";
  const envRepair = (typeof process.env.QUESTLOG_SIDECAR_REPAIR === "string" && SIDECAR_REPAIR_MODES.has(process.env.QUESTLOG_SIDECAR_REPAIR))
    ? process.env.QUESTLOG_SIDECAR_REPAIR : null;
  const cfgRepair = (typeof fcSide.repair === "string" && SIDECAR_REPAIR_MODES.has(fcSide.repair)) ? fcSide.repair : null;
  const sidecarRepair = envRepair || cfgRepair || "auto";
  const sidecarRepairSource = envRepair ? "env" : (cfgRepair ? "config" : "default");

  return {
    config: {
      port,
      autostart,
      bridge: { enabled: bcfg.enabled, dryRun: bcfg.dryRun, model: bcfg.model, autoTrigger: bcfg.autoTrigger },
      raids: { enabled: raidsEnabled, journalRoots: raidsRoots },
      roster: { allowSpawn: rosterAllowSpawn },
      archaeology: { repoPaths: archRepoPaths },
      skins: { active: skinsActive },
      distillery: { live: distLive },
      taskboard: { enabled: tbEnabled, capacityWindow: tbWindow },
      chat: { model: chatModel, profiles: chatProfiles, timeoutMs: chatTimeoutMs, idleTimeoutMs: chatIdleTimeoutMs },
      sidecar: { enabled: sidecarEnabled, repair: sidecarRepair },
    },
    sources: {
      port: portSource,
      autostart: autostartSource,
      "bridge.enabled": bridgeEnabledSource,
      "bridge.dryRun": bridgeDryRunSource,
      "bridge.model": bridgeModelSource,
      "bridge.autoTrigger": bridgeAutoTriggerSource,
      "raids.enabled": raidsEnabledSource,
      "raids.journalRoots": raidsRootsSource,
      "roster.allowSpawn": rosterAllowSpawnSource,
      "archaeology.repoPaths": archRepoPathsSource,
      "skins.active": skinsActiveSource,
      "distillery.live": distLiveSource,
      "taskboard.enabled": tbEnabledSource,
      "taskboard.capacityWindow": tbWindowSource,
      "chat.model": chatModelSource,
      "chat.profiles": chatProfilesSource,
      "chat.timeoutMs": chatTimeoutSource,
      "chat.idleTimeoutMs": chatIdleSource,
      "sidecar.enabled": sidecarEnabledSource,
      "sidecar.repair": sidecarRepairSource,
    },
  };
}

// GET /api/config (planner §1.4) — both modes, computed fresh per request.
function handleConfigGet(res) {
  const { config, sources } = computeEffectiveConfig();
  sendJson(res, 200, {
    schemaVersion: 1,
    path: configFilePath(process.env),
    config,
    sources,
    needsRestart: ["port"],
    autostartFile: autostartFilePath(),
    autostartActual: fs.existsSync(autostartFilePath()),
  });
}

// Validate a POST /api/config body (planner §1.5). Returns an error string, or
// null if valid. Unknown keys (top-level or under bridge) are rejected.
function validateConfigBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body must be an object";
  const allowedTop = new Set(["port", "autostart", "bridge", "raids", "roster", "archaeology", "skins", "distillery", "taskboard", "chat", "sidecar"]);
  for (const k of Object.keys(body)) if (!allowedTop.has(k)) return `unknown key: ${k}`;
  if ("port" in body) {
    const p = body.port;
    if (!Number.isInteger(p) || p < 1024 || p > 65535) return "port must be an integer 1024-65535";
  }
  if ("autostart" in body) {
    if (typeof body.autostart !== "boolean") return "autostart must be a boolean";
  }
  if ("bridge" in body) {
    const b = body.bridge;
    if (!b || typeof b !== "object" || Array.isArray(b)) return "bridge must be an object";
    const allowedB = new Set(["enabled", "dryRun", "model", "autoTrigger"]);
    for (const k of Object.keys(b)) if (!allowedB.has(k)) return `unknown bridge key: ${k}`;
    if ("enabled" in b && typeof b.enabled !== "boolean") return "bridge.enabled must be a boolean";
    if ("dryRun" in b && typeof b.dryRun !== "boolean") return "bridge.dryRun must be a boolean";
    if ("autoTrigger" in b && typeof b.autoTrigger !== "boolean") return "bridge.autoTrigger must be a boolean";
    if ("model" in b) {
      const m = b.model;
      if (typeof m !== "string" || m.length === 0 || m.length > 40 || !/^[a-z0-9.-]+$/.test(m)) {
        return "bridge.model must be a nonempty string, <=40 chars, [a-z0-9.-] only";
      }
    }
  }
  if ("raids" in body) {
    const r = body.raids;
    if (!r || typeof r !== "object" || Array.isArray(r)) return "raids must be an object";
    const allowedR = new Set(["enabled", "journalRoots"]);
    for (const k of Object.keys(r)) if (!allowedR.has(k)) return `unknown raids key: ${k}`;
    if ("enabled" in r && typeof r.enabled !== "boolean") return "raids.enabled must be a boolean";
    if ("journalRoots" in r) {
      if (!Array.isArray(r.journalRoots)) return "raids.journalRoots must be an array of strings";
      for (const s of r.journalRoots) if (typeof s !== "string" || s.length === 0) return "raids.journalRoots entries must be non-empty strings";
    }
  }
  if ("roster" in body) {
    const ro = body.roster;
    if (!ro || typeof ro !== "object" || Array.isArray(ro)) return "roster must be an object";
    const allowedRo = new Set(["allowSpawn"]);
    for (const k of Object.keys(ro)) if (!allowedRo.has(k)) return `unknown roster key: ${k}`;
    if ("allowSpawn" in ro && typeof ro.allowSpawn !== "boolean") return "roster.allowSpawn must be a boolean";
  }
  if ("archaeology" in body) {
    const a = body.archaeology;
    if (!a || typeof a !== "object" || Array.isArray(a)) return "archaeology must be an object";
    const allowedA = new Set(["repoPaths"]);
    for (const k of Object.keys(a)) if (!allowedA.has(k)) return `unknown archaeology key: ${k}`;
    if ("repoPaths" in a) {
      if (!Array.isArray(a.repoPaths)) return "archaeology.repoPaths must be an array of strings";
      for (const s of a.repoPaths) if (typeof s !== "string" || s.length === 0) return "archaeology.repoPaths entries must be non-empty strings";
    }
  }
  if ("skins" in body) {
    const sk = body.skins;
    if (!sk || typeof sk !== "object" || Array.isArray(sk)) return "skins must be an object";
    const allowedSk = new Set(["active"]);
    for (const k of Object.keys(sk)) if (!allowedSk.has(k)) return `unknown skins key: ${k}`;
    if ("active" in sk) {
      if (typeof sk.active !== "string" || sk.active.length === 0 || sk.active.length > 60) return "skins.active must be a non-empty string <=60 chars";
    }
  }
  if ("distillery" in body) {
    const d = body.distillery;
    if (!d || typeof d !== "object" || Array.isArray(d)) return "distillery must be an object";
    const allowedD = new Set(["live"]);
    for (const k of Object.keys(d)) if (!allowedD.has(k)) return `unknown distillery key: ${k}`;
    if ("live" in d && typeof d.live !== "boolean") return "distillery.live must be a boolean";
  }
  if ("taskboard" in body) {
    const t = body.taskboard;
    if (!t || typeof t !== "object" || Array.isArray(t)) return "taskboard must be an object";
    const allowedT = new Set(["enabled", "capacityWindow"]);
    for (const k of Object.keys(t)) if (!allowedT.has(k)) return `unknown taskboard key: ${k}`;
    if ("enabled" in t && typeof t.enabled !== "boolean") return "taskboard.enabled must be a boolean";
    if ("capacityWindow" in t) {
      const w = t.capacityWindow;
      if (!w || typeof w !== "object" || Array.isArray(w)) return "taskboard.capacityWindow must be an object";
      const allowedW = new Set(["startHour", "endHour", "maxTokens"]);
      for (const k of Object.keys(w)) if (!allowedW.has(k)) return `unknown capacityWindow key: ${k}`;
      if ("startHour" in w && (!Number.isInteger(w.startHour) || w.startHour < 0 || w.startHour > 24)) return "capacityWindow.startHour must be an integer 0-24";
      if ("endHour" in w && (!Number.isInteger(w.endHour) || w.endHour < 0 || w.endHour > 24)) return "capacityWindow.endHour must be an integer 0-24";
      if ("maxTokens" in w && (typeof w.maxTokens !== "number" || !Number.isFinite(w.maxTokens) || w.maxTokens < 0)) return "capacityWindow.maxTokens must be a non-negative number";
    }
  }
  if ("chat" in body) {
    const c = body.chat;
    if (!c || typeof c !== "object" || Array.isArray(c)) return "chat must be an object";
    const allowedC = new Set(["model", "profiles", "timeoutMs", "idleTimeoutMs"]);
    for (const k of Object.keys(c)) if (!allowedC.has(k)) return `unknown chat key: ${k}`;
    // The two clocks (P2). Bounded so a typo can neither disarm the ceiling nor
    // set a watchdog so tight that every real turn is killed.
    for (const [key, min, max] of [["timeoutMs", 60000, 86400000], ["idleTimeoutMs", 10000, 86400000]]) {
      if (!(key in c)) continue;
      const v = c[key];
      if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v < min || v > max) {
        return `chat.${key} must be a whole number of milliseconds between ${min} and ${max}`;
      }
    }
    if ("timeoutMs" in c && "idleTimeoutMs" in c && c.idleTimeoutMs > c.timeoutMs) {
      return "chat.idleTimeoutMs must not exceed chat.timeoutMs — a quiet-time limit longer than the ceiling can never fire";
    }
    if ("model" in c) {
      const m = c.model;
      if (typeof m !== "string" || m.length === 0 || m.length > 40 || !/^[a-z0-9.-]+$/.test(m)) {
        return "chat.model must be a nonempty string, <=40 chars, [a-z0-9.-] only";
      }
    }
    // chat.profiles — access tiers. LAYER (a) of the escalation ceiling: a
    // permission mode that exceeds what dec-chat-access-tiers authorized for
    // that profile NAME is rejected here, before it can ever reach the file.
    // (Layer (b) re-clamps at spawn time in chat.profileFlags.)
    if ("profiles" in c) {
      const ps = c.profiles;
      if (!ps || typeof ps !== "object" || Array.isArray(ps)) return "chat.profiles must be an object";
      for (const [name, def] of Object.entries(ps)) {
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) return `chat.profiles key "${name}" must be lowercase letters/digits/dashes, <=40 chars`;
        if (def === null) continue; // reset this profile to its built-in default
        if (typeof def !== "object" || Array.isArray(def)) return `chat.profiles.${name} must be an object or null`;
        const allowedP = new Set(["label", "allowedTools", "permissionMode"]);
        for (const k of Object.keys(def)) if (!allowedP.has(k)) return `unknown chat.profiles.${name} key: ${k}`;
        if ("label" in def && (typeof def.label !== "string" || def.label.length === 0 || def.label.length > 60)) {
          return `chat.profiles.${name}.label must be a non-empty string <=60 chars`;
        }
        if ("allowedTools" in def && def.allowedTools !== null) {
          if (!Array.isArray(def.allowedTools)) return `chat.profiles.${name}.allowedTools must be an array of strings or null`;
          for (const t of def.allowedTools) {
            if (typeof t !== "string" || t.length === 0 || t.length > 120 || t.includes(",")) {
              return `chat.profiles.${name}.allowedTools entries must be non-empty strings <=120 chars with no commas`;
            }
          }
          // HARNESS-4 layer (a): a board-level profile may not carry file or
          // command tools. Layer (b) re-denies them at spawn time in
          // chat.buildFlags, so even a hand-edited file cannot widen the tier.
          if (chat.BOARD_LEVEL_PROFILES.includes(name)) {
            const bad = def.allowedTools.filter((t) => chat.BOARD_DENY_TOOLS.includes(t));
            if (bad.length) {
              return `chat.profiles.${name}.allowedTools may not contain ${bad.join(", ")} — board-level profiles cannot carry file/command tools`;
            }
          }
        }
        if ("permissionMode" in def && def.permissionMode !== null && def.permissionMode !== "") {
          const want = def.permissionMode;
          if (typeof want !== "string") return `chat.profiles.${name}.permissionMode must be a string or null`;
          const ceiling = Object.prototype.hasOwnProperty.call(chat.AUTHORIZED_CEILING, name) ? chat.AUTHORIZED_CEILING[name] : null;
          if (ceiling === null) {
            return `chat.profiles.${name}.permissionMode must be null — the founder authorised no permission mode for "${name}" (dec-chat-access-tiers)`;
          }
          if (want !== ceiling) {
            return `chat.profiles.${name}.permissionMode may only be "${ceiling}" or null — "${want}" exceeds what the founder authorised for "${name}" (dec-chat-access-tiers)`;
          }
        }
      }
    }
  }
  if ("sidecar" in body) {
    const sd = body.sidecar;
    if (!sd || typeof sd !== "object" || Array.isArray(sd)) return "sidecar must be an object";
    const allowedSd = new Set(["enabled", "repair"]);
    for (const k of Object.keys(sd)) if (!allowedSd.has(k)) return `unknown sidecar key: ${k}`;
    if ("enabled" in sd && typeof sd.enabled !== "boolean") return "sidecar.enabled must be a boolean";
    if ("repair" in sd) {
      if (typeof sd.repair !== "string" || !SIDECAR_REPAIR_MODES.has(sd.repair)) {
        return `sidecar.repair must be one of: ${[...SIDECAR_REPAIR_MODES].join(", ")}`;
      }
    }
  }
  return null;
}

// POST /api/config (planner §1.5) — partial merge. lock -> read -> merge ->
// atomic write -> (if autostart in body) sync Startup file -> respond with the
// new EFFECTIVE config. Unknown keys already IN THE FILE are preserved.
function handleConfigPost(res, body) {
  const err = validateConfigBody(body);
  if (err) return sendJson(res, 400, { error: "E_VALIDATION", message: err });

  let autostartResult = { actual: fs.existsSync(autostartFilePath()), warning: null };
  try {
    acquireConfigLock();
    try {
      // Read-modify-write. A wrong/absent schemaVersion is treated as absent, so
      // we start fresh (its keys are NOT preserved); a valid file's unknown keys
      // ARE preserved.
      let base;
      // Strip a leading UTF-8 BOM before parse (finding #2) so a founder's
      // hand-edited keys in a BOM-saved config.json survive the read-modify-write
      // instead of being silently dropped.
      try { base = JSON.parse(fs.readFileSync(configFilePath(process.env), "utf8").replace(/^\uFEFF/, "")); }
      catch { base = null; }
      if (!base || typeof base !== "object" || Array.isArray(base) || base.schemaVersion !== 1) {
        base = { schemaVersion: 1 };
      }
      base.schemaVersion = 1;

      if ("port" in body) base.port = body.port;
      if ("autostart" in body) base.autostart = body.autostart;
      if ("bridge" in body) {
        if (!base.bridge || typeof base.bridge !== "object" || Array.isArray(base.bridge)) base.bridge = {};
        if ("enabled" in body.bridge) base.bridge.enabled = body.bridge.enabled;
        if ("dryRun" in body.bridge) base.bridge.dryRun = body.bridge.dryRun;
        if ("model" in body.bridge) base.bridge.model = body.bridge.model;
        if ("autoTrigger" in body.bridge) base.bridge.autoTrigger = body.bridge.autoTrigger;
      }
      if ("raids" in body) {
        if (!base.raids || typeof base.raids !== "object" || Array.isArray(base.raids)) base.raids = {};
        if ("enabled" in body.raids) base.raids.enabled = body.raids.enabled;
        if ("journalRoots" in body.raids) base.raids.journalRoots = body.raids.journalRoots;
      }
      if ("roster" in body) {
        if (!base.roster || typeof base.roster !== "object" || Array.isArray(base.roster)) base.roster = {};
        if ("allowSpawn" in body.roster) base.roster.allowSpawn = body.roster.allowSpawn;
      }
      if ("archaeology" in body) {
        if (!base.archaeology || typeof base.archaeology !== "object" || Array.isArray(base.archaeology)) base.archaeology = {};
        if ("repoPaths" in body.archaeology) base.archaeology.repoPaths = body.archaeology.repoPaths;
      }
      if ("skins" in body) {
        if (!base.skins || typeof base.skins !== "object" || Array.isArray(base.skins)) base.skins = {};
        if ("active" in body.skins) base.skins.active = body.skins.active;
      }
      if ("distillery" in body) {
        if (!base.distillery || typeof base.distillery !== "object" || Array.isArray(base.distillery)) base.distillery = {};
        if ("live" in body.distillery) base.distillery.live = body.distillery.live;
      }
      if ("chat" in body) {
        if (!base.chat || typeof base.chat !== "object" || Array.isArray(base.chat)) base.chat = {};
        if ("model" in body.chat) base.chat.model = body.chat.model;
        if ("timeoutMs" in body.chat) base.chat.timeoutMs = body.chat.timeoutMs;
        if ("idleTimeoutMs" in body.chat) base.chat.idleTimeoutMs = body.chat.idleTimeoutMs;
        if ("profiles" in body.chat) {
          if (!base.chat.profiles || typeof base.chat.profiles !== "object" || Array.isArray(base.chat.profiles)) base.chat.profiles = {};
          for (const [name, def] of Object.entries(body.chat.profiles)) {
            // null = "reset this profile": drop the override so the built-in
            // default in chat.DEFAULT_PROFILES takes over again.
            if (def === null) delete base.chat.profiles[name];
            else base.chat.profiles[name] = def;
          }
          if (Object.keys(base.chat.profiles).length === 0) delete base.chat.profiles;
        }
      }
      if ("sidecar" in body) {
        if (!base.sidecar || typeof base.sidecar !== "object" || Array.isArray(base.sidecar)) base.sidecar = {};
        if ("enabled" in body.sidecar) base.sidecar.enabled = body.sidecar.enabled;
        if ("repair" in body.sidecar) base.sidecar.repair = body.sidecar.repair;
      }
      if ("taskboard" in body) {
        if (!base.taskboard || typeof base.taskboard !== "object" || Array.isArray(base.taskboard)) base.taskboard = {};
        if ("enabled" in body.taskboard) base.taskboard.enabled = body.taskboard.enabled;
        if ("capacityWindow" in body.taskboard) {
          if (!base.taskboard.capacityWindow || typeof base.taskboard.capacityWindow !== "object" || Array.isArray(base.taskboard.capacityWindow)) base.taskboard.capacityWindow = {};
          const w = body.taskboard.capacityWindow;
          if ("startHour" in w) base.taskboard.capacityWindow.startHour = w.startHour;
          if ("endHour" in w) base.taskboard.capacityWindow.endHour = w.endHour;
          if ("maxTokens" in w) base.taskboard.capacityWindow.maxTokens = w.maxTokens;
        }
      }

      // Ensure the target dir exists, then atomic tmp-rename write.
      fs.mkdirSync(path.dirname(configFilePath(process.env)), { recursive: true });
      atomicWrite(configFilePath(process.env), base);

      // Autostart is the one side effect: single writer = this handler (§1.6).
      if ("autostart" in body) autostartResult = syncAutostartFile(body.autostart);
    } finally {
      releaseConfigLock();
    }
  } catch (e) {
    return sendJson(res, 500, { error: e.code || "E_IO", message: e.message });
  }

  // Re-render from disk (no optimistic UI): env still wins where set.
  const { config, sources } = computeEffectiveConfig();
  sendJson(res, 200, {
    ok: true,
    config,
    sources,
    needsRestart: ["port"],
    autostartActual: autostartResult.actual,
    warning: autostartResult.warning,
  });
}

// GET /api/version (planner §1.7) — drift stamp, both modes.
function handleVersion(res) {
  sendJson(res, 200, {
    app: "questlog",
    schemaVersion: 1,
    mode: MODE,
    pid: process.pid,
    port: PORT,
    packaged: PACKAGED,
    buildId: BUILD_ID,
    sourceHash: SOURCE_HASH,
    startedAt: STARTED_AT,
    node: process.version,
  });
}

// POST /api/shutdown (planner §1.8) — loopback-only graceful stop for the
// launcher's drift-restart. Flush the response, then close + exit.
function handleShutdown(res) {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ ok: true }), () => {
    try { server.close(); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 50);
  });
}

// ---------------------------------------------------------------------------
// Roadmap family tree — read-side lineage (planner §2.1).
// Pure functions of one registry read. Central mode only; dir mode never
// builds lineage (flat single road). All reads are tolerant: a malformed
// origin is treated as absent (root); an origin naming a parent not in the
// registry is an orphan; hand-edited cycles / over-deep chains are cut at read
// time and the deeper node becomes a flagged root. Registry array order makes
// every decision deterministic.
// ---------------------------------------------------------------------------
const MAX_LINEAGE_DEPTH = 8;
const RM_ID_RE = /^rm-[a-z0-9][a-z0-9-]*$/;
const MS_ID_RE = /^ms-[a-z0-9][a-z0-9-]*$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function hasControlChars(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

// Normalize a registry entry's origin. Returns a well-formed origin object
// (roadmapId, milestoneId, ts, and sessionId iff valid) or null. A null result
// means "treat as root" — this is the read-side tolerance for malformed edges.
function normalizeOrigin(o) {
  if (!o || typeof o !== "object") return null;
  const roadmapId = o.roadmapId;
  const milestoneId = o.milestoneId;
  const ts = o.ts;
  if (typeof roadmapId !== "string" || !RM_ID_RE.test(roadmapId)) return null;
  if (typeof milestoneId !== "string" || !MS_ID_RE.test(milestoneId)) return null;
  if (typeof ts !== "string" || !TS_RE.test(ts)) return null;
  const out = { roadmapId, milestoneId, ts };
  const sid = o.sessionId;
  if (typeof sid === "string" && sid.length > 0 && sid.length <= 200 && !hasControlChars(sid)) {
    out.sessionId = sid;
  }
  return out;
}

// buildLineage(reg) -> { byId, order, parentOf, childrenOf, roots, flags }.
// - byId:       Map id -> registry entry (first occurrence wins on dup ids)
// - order:      ids in registry array order (deduped)
// - parentOf:   Map childId -> parentId (accepted edges only)
// - childrenOf: Map parentId -> [childIds] sorted by (origin.ts asc, then id)
// - roots:      root ids in registry array order (after cycle/too_deep cuts)
// - flags:      Map id -> { origin: normOrigin|null, orphan, lineageError }
function buildLineage(reg) {
  const byId = new Map();
  const order = [];
  for (const e of (reg.roadmaps || [])) {
    if (!e || typeof e.id !== "string" || !e.id) continue;
    if (byId.has(e.id)) continue; // first occurrence wins
    byId.set(e.id, e);
    order.push(e.id);
  }

  const flags = new Map();
  for (const id of order) {
    flags.set(id, { origin: normalizeOrigin(byId.get(id).origin), orphan: false, lineageError: null });
  }

  // Accept candidate edges in registry array order; keep the graph a forest.
  const parentOf = new Map();
  for (const id of order) {
    const origin = flags.get(id).origin;
    if (!origin) continue; // no well-formed origin -> root
    const parent = origin.roadmapId;
    if (parent === id) {
      // Self-parent: the tightest possible family loop.
      flags.get(id).lineageError = "cycle";
      continue;
    }
    if (!byId.has(parent)) {
      // Parent not in the registry -> orphan. Keep origin echoed for the stub.
      flags.get(id).orphan = true;
      continue;
    }
    // Would this edge close a cycle against already-accepted edges? Walk up
    // from parent following accepted edges; the forest guarantees termination.
    let cur = parent;
    let closes = false;
    const seen = new Set();
    while (cur !== undefined) {
      if (cur === id) { closes = true; break; }
      if (seen.has(cur)) break; // safety; a forest never revisits
      seen.add(cur);
      cur = parentOf.get(cur);
    }
    if (closes) {
      flags.get(id).lineageError = "cycle";
      continue;
    }
    parentOf.set(id, parent);
  }

  // Build childrenOf from accepted edges.
  const childrenOf = new Map();
  for (const id of order) childrenOf.set(id, []);
  for (const [child, parent] of parentOf) childrenOf.get(parent).push(child);

  // Depth from roots in the accepted forest; cut every node deeper than the cap.
  const depth = new Map();
  const queue = [];
  for (const id of order) {
    if (!parentOf.has(id)) { depth.set(id, 0); queue.push(id); }
  }
  while (queue.length) {
    const n = queue.shift();
    for (const c of childrenOf.get(n) || []) {
      depth.set(c, depth.get(n) + 1);
      queue.push(c);
    }
  }
  for (const id of order) {
    const d = depth.get(id);
    if (d !== undefined && d > MAX_LINEAGE_DEPTH) {
      const parent = parentOf.get(id);
      if (parent !== undefined) {
        parentOf.delete(id);
        const arr = childrenOf.get(parent);
        const ix = arr.indexOf(id);
        if (ix >= 0) arr.splice(ix, 1);
      }
      if (!flags.get(id).lineageError) flags.get(id).lineageError = "too_deep";
    }
  }

  // Deterministic child order: (origin.ts ascending, then id ascending).
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => {
      const oa = flags.get(a).origin, ob = flags.get(b).origin;
      const ta = (oa && oa.ts) || "";
      const tb = (ob && ob.ts) || "";
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
  }

  const roots = order.filter((id) => !parentOf.has(id));
  return { byId, order, parentOf, childrenOf, roots, flags };
}

// Pre-order DFS descendant ids of `id` (excludes self). childrenOf is a forest,
// so this always terminates.
function descendantsPreOrder(id, childrenOf) {
  const out = [];
  const visit = (n) => {
    for (const c of childrenOf.get(n) || []) { out.push(c); visit(c); }
  };
  visit(id);
  return out;
}

// Tolerant per-roadmap summary read for a registry entry: milestone counts,
// main-quest status, updatedAt, name/tagline (with the same fallbacks the
// world card uses), and the session roster. Never throws.
function readRoadSummary(entry) {
  const resolved = path.resolve(entry.dir);
  const ctx = makeCtx(resolved);
  const dirExists = fs.existsSync(resolved);
  let rmData = null;
  if (dirExists) {
    try { rmData = JSON.parse(fs.readFileSync(ctx.files.roadmap, "utf8")); }
    catch { rmData = null; }
  }
  const missing = !dirExists || !rmData || typeof rmData !== "object";

  let rawSessions = [];
  try {
    const sd = JSON.parse(fs.readFileSync(ctx.files.sessions, "utf8"));
    if (sd && Array.isArray(sd.sessions)) rawSessions = sd.sessions;
  } catch { rawSessions = []; }
  // Derived eventCount overlay (HARNESS-5) — one history scan per road, and the
  // summary itself is memoized per request by makeSummaryGetter.
  const sessions = overlayDerivedSessions(
    rawSessions.filter((s) => s && typeof s.id === "string" && s.id.length > 0),
    ctx.files.history,
  );
  const sessionIds = new Set(sessions.map((s) => s.id));
  const basename = path.basename(resolved);

  if (missing) {
    return {
      missing: true, resolved, rmData: null,
      name: entry.name || basename, tagline: "",
      done: 0, total: 0, status: null, updatedAt: null,
      statusBreakdown: statusBreakdownOf([]),
      sessions, sessionIds, rawSessionsLen: rawSessions.length,
    };
  }
  const project = rmData.project || {};
  const milestones = Array.isArray(rmData.milestones) ? rmData.milestones : [];
  const quests = Array.isArray(rmData.quests) ? rmData.quests : [];
  const done = milestones.filter((m) => m && m.status === "done").length;
  const total = milestones.length;
  const mainQuest = quests.find((q) => q && q.type === "main") || quests[0] || null;
  const status = mainQuest && mainQuest.status ? mainQuest.status : "available";
  return {
    missing: false, resolved, rmData,
    name: (typeof project.name === "string" && project.name) ? project.name : (entry.name || basename),
    tagline: typeof project.tagline === "string" ? project.tagline : "",
    done, total, status, updatedAt: project.updatedAt || null,
    statusBreakdown: statusBreakdownOf(milestones), // CONTEXT-1: computed once here
    sessions, sessionIds, rawSessionsLen: rawSessions.length,
  };
}

// Memoized summary getter over one lineage's byId map (one read per road/poll).
function makeSummaryGetter(lin) {
  const cache = new Map();
  return (id) => {
    if (cache.has(id)) return cache.get(id);
    const entry = lin.byId.get(id);
    const s = entry ? readRoadSummary(entry) : null;
    cache.set(id, s);
    return s;
  };
}

// Full-story roll-up for one road: own counts + recursive live-descendant
// counts + missing-descendant tally + unique session count across own and live
// descendants. Returns null for a missing (unreadable) road (planner §2.2).
function computeFullStory(id, lin, getSummary) {
  const self = getSummary(id);
  if (!self || self.missing) return null;
  let dDone = 0, dTotal = 0, missingDesc = 0;
  const sessionIds = new Set(self.sessionIds);
  for (const c of descendantsPreOrder(id, lin.childrenOf)) {
    const cs = getSummary(c);
    if (!cs || cs.missing) { missingDesc++; continue; }
    dDone += cs.done;
    dTotal += cs.total;
    for (const sid of cs.sessionIds) sessionIds.add(sid);
  }
  return {
    own: { done: self.done, total: self.total },
    descendants: { done: dDone, total: dTotal },
    missingDescendants: missingDesc,
    sessionCount: sessionIds.size,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limitBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error("payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Read + JSON-parse a request body. On failure, send the error response and
// return null; on success return {value}. (Wrapper distinguishes a parsed
// `null` body from an error, which a bare return value could not.)
async function readAndParse(req, res) {
  let raw;
  try { raw = await readBody(req); }
  catch { sendJson(res, 413, { error: "E_VALIDATION", message: "payload too large" }); return null; }
  try { return { value: JSON.parse(raw) }; }
  catch { sendJson(res, 400, { error: "E_VALIDATION", message: "invalid JSON body" }); return null; }
}

// ---------------------------------------------------------------------------
// API: GET /api/state  (dir mode and /api/r/<id>/state)
// ---------------------------------------------------------------------------
function handleState(res, ctx) {
  const roadmap = readJson(ctx.files.roadmap, () => emptyRoadmap(ctx.root));
  const decisions = readJson(ctx.files.decisions, emptyDecisions);
  const pins = readJson(ctx.files.pins, emptyPins);
  const glossary = readJson(ctx.files.glossary, emptyGlossary);
  // Derived eventCount overlay (HARNESS-5) — served numbers only; disk is untouched.
  const sessionsRaw = readJson(ctx.files.sessions, emptySessions);
  const sessions = Object.assign({}, sessionsRaw, { sessions: overlayDerivedSessions(sessionsRaw.sessions, ctx.files.history) });
  const suggestions = readJson(ctx.files.suggestions, emptySuggestions);
  const historyTail = readHistoryTail(ctx, 30);
  // The held colliding writes, plus the DERIVED version of every record the
  // board can write to. `versions` is what lets the dashboard say which version
  // its change was based on; like `derived` it is computed here and stored
  // nowhere, so `roadmap` stays exactly what is on disk.
  const conflictsDoc = readJson(ctx.files.conflicts, conflicts.emptyConflicts);
  sendJson(res, 200, { rev: computeRev(ctx), roadmap, decisions, pins, glossary, sessions, suggestions, historyTail,
                       conflicts: conflictsDoc, versions: conflicts.versionsOf(roadmap, decisions),
                       derived: deriveCurrency(roadmap, decisions) });
}

// ---------------------------------------------------------------------------
// C3 — the DERIVED layer, computed at read time and NEVER stored.
//
// It is served as its OWN top-level key, deliberately not folded into the
// milestone objects: `roadmap` must stay exactly what is on disk, so the
// escape hatch (POST /api/file/roadmap) round-trips and a derived value can
// never be written back and desync from the evidence it came from.
//
// `claimsComplete` means: the evidence array holds an unretracted, unrefuted
// finish claim. It does NOT mean verified, and the interface must never say so.
// ---------------------------------------------------------------------------
function deriveCurrency(roadmap, decisions) {
  const ms = (roadmap && Array.isArray(roadmap.milestones)) ? roadmap.milestones : [];
  const decs = (decisions && Array.isArray(decisions.decisions)) ? decisions.decisions : [];
  return {
    claimsComplete: ms.filter((m) => currency.claimsComplete(m)).map((m) => m.id),
    evidenced: ms.filter((m) => currency.hasEvidence(m)).map((m) => m.id),
    orphanDecisions: decs.filter((d) => currency.isOrphanDecision(d)).map((d) => d.id),
  };
}

// ---------------------------------------------------------------------------
// API: GET /api/r/<id>/state  (central mode ONLY) — planner §2.3 / §2.4
// Everything /api/state returns, PLUS three additive top-level keys —
// lineage, portals, fullStory — and an EXTENDED rev that folds in the registry
// mtime and every descendant's roadmap.json + sessions.json mtimes (so a change
// on any descendant re-renders the parent). The `roadmap` payload is read
// straight from disk and never mutated: the portal overlay lives only in the
// separate `portals`/`lineage` arrays, so POST /api/file/roadmap round-trips.
// Dir-mode /api/state gets NONE of this (it calls handleState, unchanged).
// ---------------------------------------------------------------------------
function handleStateCentral(res, ctx, id) {
  // Same on-disk reads as handleState (never mutated).
  const roadmap = readJson(ctx.files.roadmap, () => emptyRoadmap(ctx.root));
  const decisions = readJson(ctx.files.decisions, emptyDecisions);
  const pins = readJson(ctx.files.pins, emptyPins);
  const glossary = readJson(ctx.files.glossary, emptyGlossary);
  // Derived eventCount overlay (HARNESS-5) — served numbers only; disk is untouched.
  const sessionsRaw = readJson(ctx.files.sessions, emptySessions);
  const sessions = Object.assign({}, sessionsRaw, { sessions: overlayDerivedSessions(sessionsRaw.sessions, ctx.files.history) });
  const suggestions = readJson(ctx.files.suggestions, emptySuggestions);
  const historyTail = readHistoryTail(ctx, 30);
  // Same two derived keys dir mode serves (held collisions + record versions):
  // one dashboard, one contract, whichever door it came in through.
  const conflictsDoc = readJson(ctx.files.conflicts, conflicts.emptyConflicts);
  const recordVersions = conflicts.versionsOf(roadmap, decisions);

  const reg = readRegistry();
  const lin = buildLineage(reg);
  const getSummary = makeSummaryGetter(lin);
  const fl = lin.flags.get(id) || { origin: null, orphan: false, lineageError: null };
  const self = getSummary(id);
  const descIds = descendantsPreOrder(id, lin.childrenOf);

  // Extended rev: own rev, registry mtime, then per-descendant (pre-order)
  // roadmap + sessions mtimes (0 for missing files).
  const revParts = [computeRev(ctx), statMtime(registryPath())];
  for (const d of descIds) {
    const de = lin.byId.get(d);
    if (de && typeof de.dir === "string") {
      const dctx = makeCtx(path.resolve(de.dir));
      revParts.push(statMtime(dctx.files.roadmap));
      revParts.push(statMtime(dctx.files.sessions));
    } else {
      revParts.push(0);
      revParts.push(0);
    }
  }
  const rev = revParts.join("-");

  // A direct child's full-story-rolled progress (own + descendants), or null.
  const childProgress = (cid) => {
    const cf = computeFullStory(cid, lin, getSummary);
    return cf ? { done: cf.own.done + cf.descendants.done, total: cf.own.total + cf.descendants.total } : null;
  };

  // lineage — origin echo, orphan/error flags, parent card, direct-child cards.
  const parentId = lin.parentOf.get(id);
  let parent = null;
  if (parentId !== undefined) {
    const ps = getSummary(parentId);
    parent = { id: parentId, name: ps ? ps.name : parentId, missing: ps ? ps.missing : true };
  }
  const childIds = lin.childrenOf.get(id) || [];
  const lineageChildren = childIds.map((cid) => {
    const cs = getSummary(cid);
    const cfl = lin.flags.get(cid) || { origin: null };
    const missing = cs ? cs.missing : true;
    return {
      id: cid,
      name: cs ? cs.name : cid,
      missing,
      originMilestoneId: (cfl.origin && cfl.origin.milestoneId) || null,
      progress: childProgress(cid),
      status: missing ? null : cs.status,
      updatedAt: missing ? null : cs.updatedAt,
      // CONTEXT-1 — a cross-road roll-up is only honest if it says WHERE and WHEN
      // it came from. Prose roll-ups ("19 of 19") go stale silently; these do not.
      statusBreakdown: missing ? null : cs.statusBreakdown,
      asOf: missing ? null : cs.updatedAt,
      sourceRoadId: cid,
    };
  });
  const lineage = {
    origin: fl.origin || null,
    orphan: !!fl.orphan,
    lineageError: fl.lineageError || null,
    parent,
    children: lineageChildren,
  };

  // portals — one per DIRECT child. Match the child's origin.milestoneId against
  // THIS road's milestones across ANY quest (a promoted side quest's portal
  // milestone lives on a side quest). A renamed/deleted portal milestone still
  // emits an entry with milestoneMissing:true; disk is never touched.
  const selfMilestones = (self && !self.missing && Array.isArray(self.rmData.milestones))
    ? self.rmData.milestones
    : (Array.isArray(roadmap.milestones) ? roadmap.milestones : []);
  const msIds = new Set(selfMilestones.filter((m) => m && typeof m.id === "string").map((m) => m.id));
  const portals = childIds.map((cid) => {
    const cs = getSummary(cid);
    const cfl = lin.flags.get(cid) || { origin: null };
    const msId = (cfl.origin && cfl.origin.milestoneId) || null;
    const childMissing = cs ? cs.missing : true;
    return {
      milestoneId: msId,
      milestoneMissing: !(msId && msIds.has(msId)),
      childId: cid,
      childName: cs ? cs.name : cid,
      childMissing,
      progress: childProgress(cid),
      status: childMissing ? null : cs.status,
      updatedAt: childMissing ? null : cs.updatedAt,
      // CONTEXT-1 — live mirrored status breakdown + provenance stamp, so the
      // portal card states a fact with a source and a time rather than prose.
      statusBreakdown: childMissing ? null : cs.statusBreakdown,
      asOf: childMissing ? null : cs.updatedAt,
      sourceRoadId: cid,
    };
  });

  // fullStory — own + recursive live-descendant counts, plus an aggregated,
  // deduped session trace across self + descendants (planner §2.3).
  const own = (self && !self.missing) ? { done: self.done, total: self.total } : { done: 0, total: 0 };
  let dDone = 0, dTotal = 0, missingDesc = 0;
  let liveRoads = (self && !self.missing) ? 1 : 0;
  const roadsOrder = [id, ...descIds];
  const sessAgg = new Map();
  for (const rid of roadsOrder) {
    const rs = getSummary(rid);
    if (!rs || rs.missing) { if (rid !== id) missingDesc++; continue; }
    if (rid !== id) { dDone += rs.done; dTotal += rs.total; liveRoads++; }
    for (const sess of rs.sessions) {
      const sid = sess.id;
      let agg = sessAgg.get(sid);
      if (!agg) {
        agg = { id: sid, _ownLabel: "", _firstLabel: "", firstSeenAt: null, lastSeenAt: null, eventCount: 0, roads: [] };
        sessAgg.set(sid, agg);
      }
      const ev = Number.isInteger(sess.eventCount) ? sess.eventCount : 0;
      agg.eventCount += ev;
      const fseen = (typeof sess.firstSeenAt === "string") ? sess.firstSeenAt : null;
      const lseen = (typeof sess.lastSeenAt === "string") ? sess.lastSeenAt : null;
      if (fseen && (agg.firstSeenAt === null || fseen < agg.firstSeenAt)) agg.firstSeenAt = fseen;
      if (lseen && (agg.lastSeenAt === null || lseen > agg.lastSeenAt)) agg.lastSeenAt = lseen;
      const lbl = (typeof sess.label === "string") ? sess.label : "";
      if (rid === id && lbl && !agg._ownLabel) agg._ownLabel = lbl;
      if (lbl && !agg._firstLabel) agg._firstLabel = lbl;
      agg.roads.push({ id: rid, name: rs.name, eventCount: ev });
    }
  }
  const aggSessions = [...sessAgg.values()].map((a) => ({
    id: a.id,
    label: a._ownLabel || a._firstLabel || "",
    firstSeenAt: a.firstSeenAt,
    lastSeenAt: a.lastSeenAt,
    eventCount: a.eventCount,
    roads: a.roads,
  }));
  aggSessions.sort((x, y) => {
    const lx = x.lastSeenAt || "", ly = y.lastSeenAt || "";
    if (lx < ly) return 1;
    if (lx > ly) return -1;
    return x.id < y.id ? -1 : (x.id > y.id ? 1 : 0);
  });
  const fullStory = {
    own,
    descendants: { done: dDone, total: dTotal },
    missingDescendants: missingDesc,
    roads: liveRoads,
    sessions: aggSessions,
  };

  sendJson(res, 200, { rev, roadmap, decisions, pins, glossary, sessions, suggestions, historyTail, lineage, portals, fullStory,
                       conflicts: conflictsDoc, versions: recordVersions,
                       derived: deriveCurrency(roadmap, decisions) });
}

// ---------------------------------------------------------------------------
// API: POST /api/note  {itemId, body, sessionId?}
// ---------------------------------------------------------------------------
function handleNote(res, ctx, payload) {
  const itemId = payload && payload.itemId;
  const body = payload && payload.body;
  const sessionId = extractSessionId(payload);
  if (typeof itemId !== "string" || !itemId || typeof body !== "string" || !body.trim()) {
    return sendJson(res, 400, { error: "E_VALIDATION", message: "itemId and non-empty body required" });
  }
  let result;
  try {
    result = withLock(ctx, () => {
      const roadmap = readJson(ctx.files.roadmap, () => emptyRoadmap(ctx.root));
      const item = (roadmap.items || []).find((it) => it.id === itemId);
      if (!item) return { notFound: true };
      const ts = nowIso();
      // planner §1.1: POST /api/note is the ONLY writer that marks a founder note
      // pending — it joins the waiting list until a dispatch consumes it. (MCP
      // item_note_add deliberately does NOT set pending; chat notes are handled in chat.)
      const note = { id: genId("note"), author: "founder", body: String(body), ts, pending: true };
      if (!Array.isArray(item.notes)) item.notes = [];
      item.notes.push(note);
      item.updatedAt = ts;
      if (roadmap.project) roadmap.project.updatedAt = ts;
      atomicWrite(ctx.files.roadmap, roadmap);
      const evt = {
        id: genId("evt"), ts, actor: "founder", source: "ui", action: "ui_note_add",
        targetId: itemId, summary: `Founder added a note on "${item.title || itemId}"`,
      };
      if (sessionId) evt.sessionId = sessionId;
      appendHistory(ctx, evt);
      if (sessionId) upsertSession(ctx, sessionId, undefined, 1);
      return { item };
    });
  } catch (err) {
    return sendJson(res, 500, { error: err.code || "E_IO", message: err.message });
  }
  if (result.notFound) return sendJson(res, 404, { error: "not_found", message: `no item ${itemId}` });
  // Additive, non-blocking: after the founder's own note write has landed, offer
  // it to the bridge. Inert unless QUESTLOG_BTW_BRIDGE=1; never alters the write.
  // C1 — the card's own milestone is the link this pass runs under. If it does
  // not resolve, runBridgeOnce refuses before it spawns anything.
  BRIDGE.trigger(ctx, { itemId, trigger: "note", targetType: "item", noteText: String(body), title: result.item.title || itemId,
                        milestoneId: milestoneForTarget(ctx, "item", itemId) });
  sendJson(res, 200, result.item);
}

// ---------------------------------------------------------------------------
// COLLIDING WRITES — the board's half of the founder's ruling (2026-08-27).
//
// When two writers change the same record, the second change is HELD: applied
// to nothing, discarded by nothing, surfaced as a decision showing BOTH
// versions. The FIRST write stands as current while the hold is open, so the
// board stays readable rather than frozen, and the second sits on the card as a
// contested change until the founder rules. A warning shown after the loss is
// not a decision, it is a receipt.
//
// The detection lives in conflicts.mjs (recordVersion — a content hash derived
// at read time and stored nowhere), so this server and the MCP server judge
// staleness by exactly the same rule.
//
// ONE CRITICAL SECTION, non-negotiable: basisOf/isStale are evaluated and
// holdWrite is called INSIDE the handler's existing withLock, on the record
// that lock just read. Split them and two stale writers can both believe they
// were first.
//
// EXEMPT, and each says so at its own site: POST /api/note (an append never
// collides — two notes on one card are two notes, not one lost note), the
// create paths (nothing to be stale against), /api/promote and /api/demote
// (structural multi-record moves, logged as a known gap in the README),
// /api/dispatch, /api/request-suggestions, and everything under config, skins
// and the task board, which is not road data.
// ---------------------------------------------------------------------------

// The basis a UI write claims: the version of the record it was looking at,
// read from state.versions. Absent = a blind write, which goes through
// unchanged — that is documented back-compat, not an oversight.
function basisOf(payload) {
  if (!payload || payload.baseVersion === undefined || payload.baseVersion === null) return null;
  return String(payload.baseVersion);
}
// Stale means: this writer's basis is not the version now on disk. No basis at
// all is never stale — there is nothing to compare.
function isStale(basis, rec) {
  return !!(basis && basis !== conflicts.recordVersion(rec));
}

// Record one held change and account for it like every other mutation: the road
// file is NOT written, conflicts.json is, and history gains a conflict_held
// event. Caller already holds the lock; returns the conflict for the 409 body.
function holdWrite(ctx, { ts, action, targetType, targetId, title, basis, current, proposed, input, sessionId }) {
  const doc = readJson(ctx.files.conflicts, conflicts.emptyConflicts);
  doc.schemaVersion = 1;
  if (!Array.isArray(doc.conflicts)) doc.conflicts = [];
  const cf = conflicts.newConflict({
    id: genId("cf"), ts, source: "ui", actor: "founder", sessionId,
    action, targetType, targetId,
    baseVersion: basis, currentVersion: conflicts.recordVersion(current),
    current, proposed, input,
  });
  doc.conflicts.push(cf);
  atomicWrite(ctx.files.conflicts, doc);
  const evt = {
    id: genId("evt"), ts, actor: "founder", source: "ui", action: "conflict_held",
    targetId,
    summary: `Held a change to "${title}": it was based on a version that is no longer current; waiting on a ruling`,
    patch: { conflictId: cf.id, baseVersion: cf.baseVersion, currentVersion: cf.currentVersion },
  };
  if (sessionId) evt.sessionId = sessionId;
  appendHistory(ctx, evt);
  if (sessionId) upsertSession(ctx, sessionId, undefined, 1);
  return cf;
}

// A record that just left the road takes its open holds with it — there is
// nothing left to contest, and a conflict pointing at a missing id is a
// validator error. Voided, never deleted, with one conflict_void event each so
// the log still shows the argument existed. Caller holds the lock.
function voidHoldsFor(ctx, ids, ts, sessionId) {
  const doc = readJson(ctx.files.conflicts, conflicts.emptyConflicts);
  const voided = conflicts.voidConflictsFor(doc, ids, ts);
  if (!voided.length) return [];
  atomicWrite(ctx.files.conflicts, doc);
  for (const cf of voided) {
    const evt = {
      id: genId("evt"), ts, actor: "founder", source: "ui", action: "conflict_void",
      targetId: cf.targetId,
      summary: `A contested change was voided: ${cf.targetId} was deleted, so there is nothing left to rule on`,
      patch: { conflictId: cf.id, voidReason: cf.voidReason },
    };
    if (sessionId) evt.sessionId = sessionId;
    appendHistory(ctx, evt);
    if (sessionId) upsertSession(ctx, sessionId, undefined, 1);
  }
  return voided;
}

// Carry out a ruling of "keep the held version". The WHOLE record is written,
// not a field merge: what the founder chose is what they were shown side by
// side, so applying it replaces the card with exactly that. Caller holds the
// lock. Returns {ok:false, code, message, dependents} rather than throwing,
// because the caller turns it into an HTTP status.
function applyHeldChange(ctx, cf, ts) {
  if (cf.proposed === null || cf.proposed === undefined) {
    // A held DELETE proposes no record at all, so the ruling re-runs the
    // deletion NOW, against today's road. Dependents that appeared while the
    // hold sat open are a real refusal, honestly reported — the conflict stays
    // open rather than quietly taking more than the founder agreed to.
    const inp = (cf.input && typeof cf.input === "object") ? cf.input : {};
    const roadmap = readJson(ctx.files.roadmap, () => emptyRoadmap(ctx.root));
    const plan = planDeletion(roadmap, cf.targetType, cf.targetId, { force: inp.force === true });
    if (!plan.ok) return { ok: false, code: plan.code, message: plan.message, dependents: plan.dependents };
    const decisions = readJson(ctx.files.decisions, emptyDecisions);
    const pins = readJson(ctx.files.pins, emptyPins);
    const suggestions = readJson(ctx.files.suggestions, emptySuggestions);
    const { changed, scrubbed } = scrubDeletedRefs({ decisions, pins, suggestions }, plan.removedMsIds, plan.removedQuestIds);
    if (changed.decisions) atomicWrite(ctx.files.decisions, decisions);
    if (changed.pins) atomicWrite(ctx.files.pins, pins);
    if (changed.suggestions) atomicWrite(ctx.files.suggestions, suggestions);
    if (roadmap.project) roadmap.project.updatedAt = ts;
    atomicWrite(ctx.files.roadmap, roadmap);
    return { ok: true, deleted: plan.record, cascaded: plan.cascaded, scrubbed };
  }
  if (cf.targetType === "decision") {
    const decisions = readJson(ctx.files.decisions, emptyDecisions);
    const list = decisions.decisions || [];
    const i = list.findIndex((d) => d && d.id === cf.targetId);
    if (i < 0) return { ok: false, code: "E_NOT_FOUND", message: `no decision ${cf.targetId}`, dependents: [] };
    list[i] = Object.assign({}, cf.proposed);   // decisions carry no updatedAt
    atomicWrite(ctx.files.decisions, decisions);
    return { ok: true, record: list[i] };
  }
  // A term lives in glossary.json, not on the road, so it needs its own branch:
  // without one it fell through to the roadmap below, got mapped to "quests",
  // and every ruling on a held term answered 404. Explicit, not a default — a
  // sixth targetType should still 404 honestly rather than land in the glossary.
  if (cf.targetType === "term") {
    const glossary = readJson(ctx.files.glossary, emptyGlossary);
    const list = Array.isArray(glossary.terms) ? glossary.terms : [];
    const i = list.findIndex((t) => t && t.id === cf.targetId);
    if (i < 0) return { ok: false, code: "E_NOT_FOUND", message: `no term ${cf.targetId}`, dependents: [] };
    list[i] = Object.assign({}, cf.proposed);   // terms carry no updatedAt either
    atomicWrite(ctx.files.glossary, glossary);
    return { ok: true, record: list[i] };
  }
  const roadmap = readJson(ctx.files.roadmap, () => emptyRoadmap(ctx.root));
  const key = cf.targetType === "milestone" ? "milestones" : cf.targetType === "item" ? "items" : "quests";
  const list = Array.isArray(roadmap[key]) ? roadmap[key] : [];
  const i = list.findIndex((r) => r && r.id === cf.targetId);
  if (i < 0) return { ok: false, code: "E_NOT_FOUND", message: `no ${cf.targetType} ${cf.targetId}`, dependents: [] };
  list[i] = Object.assign({}, cf.proposed, { updatedAt: ts });
  if (roadmap.project) roadmap.project.updatedAt = ts;
  atomicWrite(ctx.files.roadmap, roadmap);
  return { ok: true, record: list[i] };
}

// ---------------------------------------------------------------------------
// API: POST /api/conflict/resolve  {id, keep, sessionId?}
//
// The founder's ruling, given from the board. keep:"current" lets the first
// write stand and closes the argument; keep:"held" writes the second version
// over the record. Either way the conflict becomes "ruled" and keeps both
// versions inside it — the log of what was decided is the point.
// ---------------------------------------------------------------------------
function handleConflictResolve(res, ctx, payload) {
  const id = payload && payload.id;
  const keep = payload && payload.keep;
  const sessionId = extractSessionId(payload);
  if (typeof id !== "string" || !id) {
    return sendJson(res, 400, { error: "E_VALIDATION", message: "id (string) required" });
  }
  if (keep !== "current" && keep !== "held") {
    return sendJson(res, 400, { error: "E_VALIDATION", message: "keep must be current|held" });
  }
  let result;
  try {
    result = withLock(ctx, () => {
      const doc = readJson(ctx.files.conflicts, conflicts.emptyConflicts);
      const list = Array.isArray(doc.conflicts) ? doc.conflicts : [];
      const cf = list.find((c) => c && c.id === id);
      if (!cf) return { notFound: true };
      if (cf.status !== "open") return { settled: cf };
      const ts = nowIso();
      let applied = null;
      if (keep === "held") {
        applied = applyHeldChange(ctx, cf, ts);
        if (!applied.ok) return { blocked: applied };
      }
      cf.status = "ruled";
      cf.ruling = { keep, ts, by: "founder" };
      atomicWrite(ctx.files.conflicts, doc);
      const title = (cf.current && (cf.current.title || cf.current.term || cf.current.label)) || cf.targetId;
      const evt = {
        id: genId("evt"), ts, actor: "founder", source: "ui", action: "conflict_ruled",
        targetId: cf.targetId,
        summary: keep === "held"
          ? `Founder ruled on "${title}": the held change is applied`
          : `Founder ruled on "${title}": the standing version keeps`,
        patch: { keep, conflictId: cf.id },
      };
      if (sessionId) evt.sessionId = sessionId;
      appendHistory(ctx, evt);
      if (sessionId) upsertSession(ctx, sessionId, undefined, 1);
      return { conflict: cf, applied };
    });
  } catch (err) {
    return sendJson(res, 500, { error: err.code || "E_IO", message: err.message });
  }
  if (result.notFound) return sendJson(res, 404, { error: "not_found", message: `no conflict ${id}` });
  if (result.settled) {
    return sendJson(res, 409, { error: "E_VALIDATION", message: `conflict ${id} is already ${result.settled.status}`, conflict: result.settled });
  }
  if (result.blocked) {
    const b = result.blocked;
    const code = b.code === "E_NOT_FOUND" ? 404 : b.code === "E_CONFLICT" ? 409 : 400;
    return sendJson(res, code, { error: b.code, message: b.message, dependents: b.dependents || [] });
  }
  sendJson(res, 200, result);
}

// ---------------------------------------------------------------------------
// API: POST /api/decision/approve  {id, approved, sessionId?}
// ---------------------------------------------------------------------------
function handleDecisionApprove(res, ctx, payload) {
  const id = payload && payload.id;
  const sessionId = extractSessionId(payload);
  const hasApproved = payload && payload.approved !== undefined && payload.approved !== null;
  const hasSet = payload && payload.set !== undefined && payload.set !== null;
  if (typeof id !== "string" || !id) {
    return sendJson(res, 400, { error: "E_VALIDATION", message: "id (string) required" });
  }
  if (hasApproved === hasSet) {
    return sendJson(res, 400, { error: "E_VALIDATION", message: "provide exactly one of approved (boolean) or set (approved|rejected|proposed)" });
  }
  let target;
  if (hasApproved) {
    if (typeof payload.approved !== "boolean") return sendJson(res, 400, { error: "E_VALIDATION", message: "approved must be a boolean" });
    target = payload.approved ? "approved" : "rejected";
  } else {
    if (payload.set !== "approved" && payload.set !== "rejected" && payload.set !== "proposed")
      return sendJson(res, 400, { error: "E_VALIDATION", message: "set must be one of approved|rejected|proposed" });
    target = payload.set;
  }
  let result;
  try {
    result = withLock(ctx, () => {
      const decisions = readJson(ctx.files.decisions, emptyDecisions);
      const dec = (decisions.decisions || []).find((d) => d.id === id);
      if (!dec) return { notFound: true };
      const ts = nowIso();
      // The change lands on the live record, or on a clone of it when this
      // writer's basis is stale — same lines either way, so the held version is
      // exactly the record this write would have produced.
      const basis = basisOf(payload);
      const stale = isStale(basis, dec);
      const rec = stale ? conflicts.cloneRecord(dec) : dec;
      if (target === "approved") { rec.approved = true; rec.status = "approved"; rec.approvedAt = ts; }
      else if (target === "rejected") { rec.approved = false; rec.status = "rejected"; rec.approvedAt = null; }
      else { rec.approved = false; rec.status = "proposed"; rec.approvedAt = null; } // proposed = revoke
      if (stale) {
        return { held: holdWrite(ctx, {
          ts, action: "ui_decision_approve", targetType: "decision", targetId: id,
          title: dec.title || id, basis, current: dec, proposed: rec, sessionId,
          input: { id, set: target },
        }) };
      }
      atomicWrite(ctx.files.decisions, decisions);
      const verb = target === "approved" ? "approved" : target === "rejected" ? "rejected" : "revoked (back to proposed)";
      const evt = {
        id: genId("evt"), ts, actor: "founder", source: "ui", action: "ui_decision_approve",
        targetId: id, summary: `Founder ${verb} decision "${dec.title || id}"`,
        patch: { approved: dec.approved, status: dec.status },
      };
      if (sessionId) evt.sessionId = sessionId;
      appendHistory(ctx, evt);
      if (sessionId) upsertSession(ctx, sessionId, undefined, 1);
      return { decision: dec };
    });
  } catch (err) {
    return sendJson(res, 500, { error: err.code || "E_IO", message: err.message });
  }
  if (result.notFound) return sendJson(res, 404, { error: "not_found", message: `no decision ${id}` });
  if (result.held) return sendJson(res, 409, { error: "E_CONTESTED", conflict: result.held });
  sendJson(res, 200, result.decision);
}

// ---------------------------------------------------------------------------
// API: POST /api/unclear  {targetType, id, unclear, sessionId?}
// The "this is jargon / I don't get this" toggle. Flags a milestone, item, or
// decision as unclear (or clears the flag). One history event per toggle.
// ---------------------------------------------------------------------------
function handleUnclear(res, ctx, payload) {
  const targetType = payload && payload.targetType;
  const id = payload && payload.id;
  const unclear = payload && payload.unclear;
  const sessionId = extractSessionId(payload);
  if (targetType !== "milestone" && targetType !== "item" && targetType !== "decision") {
    return sendJson(res, 400, { error: "E_VALIDATION", message: "targetType must be milestone|item|decision" });
  }
  if (typeof id !== "string" || !id) {
    return sendJson(res, 400, { error: "E_VALIDATION", message: "id (string) required" });
  }
  if (typeof unclear !== "boolean") {
    return sendJson(res, 400, { error: "E_VALIDATION", message: "unclear (boolean) required" });
  }
  let result;
  try {
    result = withLock(ctx, () => {
      const ts = nowIso();
      const basis = basisOf(payload);
      // `found` is what is on disk (the version that stands); `rec` is what the
      // change lands on — the same object, or a clone of it when this writer's
      // basis is stale. `commit` is the write, skipped entirely on a hold.
      let found, commit;
      if (targetType === "decision") {
        const decisions = readJson(ctx.files.decisions, emptyDecisions);
        found = (decisions.decisions || []).find((d) => d.id === id);
        if (!found) return { notFound: true };
        // decisions have no updatedAt — skip bumping it
        commit = () => atomicWrite(ctx.files.decisions, decisions);
      } else {
        const roadmap = readJson(ctx.files.roadmap, () => emptyRoadmap(ctx.root));
        const coll = targetType === "milestone" ? (roadmap.milestones || []) : (roadmap.items || []);
        found = coll.find((r) => r.id === id);
        if (!found) return { notFound: true };
        commit = () => {
          if (roadmap.project) roadmap.project.updatedAt = ts;
          atomicWrite(ctx.files.roadmap, roadmap);
        };
      }
      const stale = isStale(basis, found);
      const rec = stale ? conflicts.cloneRecord(found) : found;
      rec.unclear = unclear;
      rec.unclearAt = unclear ? ts : null;
      // planner §1.2: any /api/unclear toggle (raise OR clear) drops the dispatch
      // bookkeeping — re-flagging re-queues the flag as fresh pending work.
      delete rec.unclearDispatchId;
      delete rec.unclearDispatchedAt;
      if (targetType !== "decision") rec.updatedAt = ts;
      if (stale) {
        return { held: holdWrite(ctx, {
          ts, action: "ui_unclear_set", targetType, targetId: id,
          title: found.title || found.label || id, basis, current: found, proposed: rec, sessionId,
          input: { targetType, id, unclear },
        }) };
      }
      commit();
      const title = rec.title || rec.label || id;
      const evt = {
        id: genId("evt"), ts, actor: "founder", source: "ui", action: "ui_unclear_set",
        targetId: id,
        summary: unclear
          ? `Founder flagged "${title}" as unclear`
          : `Founder removed the unclear flag on "${title}"`,
        patch: { unclear },
      };
      if (sessionId) evt.sessionId = sessionId;
      appendHistory(ctx, evt);
      if (sessionId) upsertSession(ctx, sessionId, undefined, 1);
      return { rec };
    });
  } catch (err) {
    return sendJson(res, 500, { error: err.code || "E_IO", message: err.message });
  }
  if (result.notFound) return sendJson(res, 404, { error: "not_found", message: `no ${targetType} ${id}` });
  // Held, not applied and not discarded. 409 is the soft outcome the dashboard
  // knows how to render: the card grows a contested block and the header a
  // ruling badge. The bridge is deliberately NOT triggered — nothing changed.
  if (result.held) return sendJson(res, 409, { error: "E_CONTESTED", conflict: result.held });
  // Additive, non-blocking: only a NEW unclear flag (the founder saying "I can't
  // follow this") is worth a bridge pass; clearing the flag is not. Inert unless
  // QUESTLOG_BTW_BRIDGE=1.
  if (unclear === true) {
    BRIDGE.trigger(ctx, { itemId: id, trigger: "unclear", targetType, noteText: "", title: result.rec.title || result.rec.label || id,
                          milestoneId: milestoneForTarget(ctx, targetType, id) });
  }
  sendJson(res, 200, result.rec);
}

// ---------------------------------------------------------------------------
// API: POST /api/delete  {targetType, id, force?, sessionId?}
//
// The dashboard's half of deleting. The MCP tools could already delete; the
// board could not, so removing a milestone, a side quest or a card by hand meant
// opening roadmap.json in an editor. Both surfaces now run the SAME rules —
// deletion.mjs owns the dependent story and the cascade — and differ only in how
// they report: the tool raises E_CONFLICT as a sentence for an agent to read,
// this endpoint returns 409 with a STRUCTURED `dependents` array so the card can
// list what would go with it and ask.
//
// Deletion is irreversible from the founder's side, so two things are
// non-negotiable and both live below: the UI confirms before it ever calls here
// (an inline two-step strip, no browser confirm()), and every delete writes one
// history event carrying the FULL deleted records in its patch — history is the
// recovery path, so it has to hold enough to put the road back by hand.
// ---------------------------------------------------------------------------
function handleDelete(res, ctx, payload) {
  const targetType = payload && payload.targetType;
  const id = payload && payload.id;
  const force = payload && payload.force === true;   // only a literal true cascades
  const sessionId = extractSessionId(payload);
  if (targetType !== "milestone" && targetType !== "item" && targetType !== "quest") {
    return sendJson(res, 400, { error: "E_VALIDATION", message: "targetType must be milestone|item|quest" });
  }
  if (typeof id !== "string" || !id) {
    return sendJson(res, 400, { error: "E_VALIDATION", message: "id (string) required" });
  }
  let result;
  try {
    result = withLock(ctx, () => {
      const ts = nowIso();
      const roadmap = readJson(ctx.files.roadmap, () => emptyRoadmap(ctx.root));
      // The basis check comes BEFORE planDeletion, because planDeletion mutates
      // the road it is handed. A delete based on a version that is no longer
      // current is held like any other change — `proposed` is null, since a
      // delete proposes no record, and the ruling re-runs the deletion.
      const basis = basisOf(payload);
      if (basis) {
        const coll = targetType === "milestone" ? roadmap.milestones
                   : targetType === "item" ? roadmap.items : roadmap.quests;
        const found = (Array.isArray(coll) ? coll : []).find((r) => r && r.id === id);
        // Deleting something that is not there is a 404 in planDeletion's own
        // words, not a hold — there is no version to have been stale against.
        if (found && isStale(basis, found)) {
          return { held: holdWrite(ctx, {
            ts, action: `ui_${targetType}_delete`, targetType, targetId: id,
            title: found.title || found.label || id, basis, current: found, proposed: null, sessionId,
            input: { targetType, id, force },
          }) };
        }
      }
      const plan = planDeletion(roadmap, targetType, id, { force });
      if (!plan.ok) return { plan };
      // The scrub, before the roadmap is written: a deleted ms-/q- id is
      // referenced from decisions.json, pins.json and suggestions.json, and the
      // validator errors on every dangling one. Only files that moved are written.
      const decisions = readJson(ctx.files.decisions, emptyDecisions);
      const pins = readJson(ctx.files.pins, emptyPins);
      const suggestions = readJson(ctx.files.suggestions, emptySuggestions);
      const { changed, scrubbed } = scrubDeletedRefs({ decisions, pins, suggestions }, plan.removedMsIds, plan.removedQuestIds);
      if (changed.decisions) atomicWrite(ctx.files.decisions, decisions);
      if (changed.pins) atomicWrite(ctx.files.pins, pins);
      if (changed.suggestions) atomicWrite(ctx.files.suggestions, suggestions);
      if (roadmap.project) roadmap.project.updatedAt = ts;
      atomicWrite(ctx.files.roadmap, roadmap);
      const kind = targetType === "quest" ? "side quest" : targetType;
      const title = plan.record.title || plan.record.label || id;
      const evt = {
        id: genId("evt"), ts, actor: "founder", source: "ui",
        action: targetType === "milestone" ? "ui_milestone_delete"
              : targetType === "item" ? "ui_item_delete" : "ui_quest_delete",
        targetId: id,
        summary: `Founder deleted ${kind} "${title}"${plan.cascaded.length ? ` (+${plan.cascaded.length} cascaded)` : ""}`,
        // The whole records ride along, exactly as the MCP tools write them.
        patch: { deleted: plan.record, cascaded: plan.cascaded, scrubbed },
      };
      if (sessionId) evt.sessionId = sessionId;
      appendHistory(ctx, evt);
      if (sessionId) upsertSession(ctx, sessionId, undefined, 1);
      // Anything that just left the road takes its open holds with it.
      const voided = voidHoldsFor(ctx, [plan.record.id, ...plan.cascaded.map((r) => r && r.id).filter(Boolean)], ts, sessionId);
      return { deleted: plan.record, cascaded: plan.cascaded, scrubbed, voidedConflicts: voided.map((c) => c.id) };
    });
  } catch (err) {
    return sendJson(res, 500, { error: err.code || "E_IO", message: err.message });
  }
  if (result.held) return sendJson(res, 409, { error: "E_CONTESTED", conflict: result.held });
  if (result.plan) {
    const p = result.plan;
    const code = p.code === "E_NOT_FOUND" ? 404 : p.code === "E_CONFLICT" ? 409 : 400;
    return sendJson(res, code, { error: p.code, message: p.message, dependents: p.dependents });
  }
  sendJson(res, 200, result);
}

// ---------------------------------------------------------------------------
// Batch dispatch (planner §2). The founder goes over the roadmap, leaves notes
// and "unclear" flags, then presses ONE "Send to agent" button. The server
// assembles a structured worklist — one entry per CARD, carrying its milestone/
// quest context, current text, all UNDISPATCHED founder notes verbatim, and its
// standing unclear flag — and hands it to the bridge as a single session.
//
// Pending predicates (MUST mirror the UI's computePending, planner §1.1/§1.2):
//   - founder note pending  := note.author==="founder" && note.pending===true
//   - standing unclear flag := rec.unclear===true && !rec.unclearDispatchId
// The dispatch id is genId("disp") → matches ^disp-[a-z0-9][a-z0-9-]*$.
// ---------------------------------------------------------------------------

// Assemble the worklist (the ONE shared shape, planner §2.3) from an in-memory
// roadmap + decisions. Returns { worklist, summary, raw } where `raw` carries the
// live object references the caller marks on a live dispatch. Pure read — never
// mutates roadmap/decisions.
function assembleDispatch(roadmap, decisions, dispatchId, ts) {
  const projectName = (roadmap.project && typeof roadmap.project.name === "string") ? roadmap.project.name : "";
  const quests = Array.isArray(roadmap.quests) ? roadmap.quests : [];
  const milestones = Array.isArray(roadmap.milestones) ? roadmap.milestones : [];
  const items = Array.isArray(roadmap.items) ? roadmap.items : [];
  const decs = (decisions && Array.isArray(decisions.decisions)) ? decisions.decisions : [];
  const qById = new Map(quests.map((q) => [q.id, q]));
  const msById = new Map(milestones.map((m) => [m.id, m]));

  const raw = []; // { entry, sortKey, notesToMark:[note], flagRec:rec|null, flagKind }

  // Items — pending founder notes and/or a standing unclear flag.
  for (const it of items) {
    const pendingNotes = (Array.isArray(it.notes) ? it.notes : [])
      .filter((n) => n && n.author === "founder" && n.pending === true)
      .slice()
      .sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
    const flagPending = it.unclear === true && !it.unclearDispatchId;
    if (pendingNotes.length === 0 && !flagPending) continue;
    const ms = msById.get(it.milestoneId);
    const q = ms ? qById.get(ms.questId) : null;
    const entry = {
      n: 0, targetType: "item", id: it.id, title: it.title || "",
      questId: q ? q.id : null, questTitle: q ? (q.title || "") : "",
      milestoneId: it.milestoneId || null, milestoneTitle: ms ? (ms.title || "") : "",
      currentText: it.body || "", currentPlain: it.plain || "",
      unclear: !!flagPending, unclearAt: flagPending ? (it.unclearAt || null) : null,
      notes: pendingNotes.map((n) => ({ noteId: n.id, body: n.body, ts: n.ts })),
    };
    const signals = pendingNotes.map((n) => String(n.ts || ""))
      .concat(flagPending && it.unclearAt ? [String(it.unclearAt)] : []);
    const sortKey = signals.length ? signals.reduce((a, b) => (a < b ? a : b)) : "";
    raw.push({ entry, sortKey, notesToMark: pendingNotes, flagRec: flagPending ? it : null, flagKind: "roadmap" });
  }

  // Milestones — standing unclear flag only.
  for (const m of milestones) {
    const flagPending = m.unclear === true && !m.unclearDispatchId;
    if (!flagPending) continue;
    const q = qById.get(m.questId);
    const entry = {
      n: 0, targetType: "milestone", id: m.id, title: m.title || "",
      questId: q ? q.id : null, questTitle: q ? (q.title || "") : "",
      currentText: m.summary || "", currentPlain: m.plain || "",
      unclear: true, unclearAt: m.unclearAt || null, notes: [],
    };
    raw.push({ entry, sortKey: String(m.unclearAt || ""), notesToMark: [], flagRec: m, flagKind: "roadmap" });
  }

  // Decisions — standing unclear flag only. Omit quest/milestone; add related.
  for (const d of decs) {
    const flagPending = d.unclear === true && !d.unclearDispatchId;
    if (!flagPending) continue;
    const relIds = Array.isArray(d.relatedMilestoneIds) ? d.relatedMilestoneIds : [];
    const relTitles = relIds.map((mid) => { const mm = msById.get(mid); return mm ? (mm.title || "") : ""; });
    const entry = {
      n: 0, targetType: "decision", id: d.id, title: d.title || "",
      currentText: `${d.rationale || ""}\n${d.impact || ""}`, currentPlain: d.plain || "",
      unclear: true, unclearAt: d.unclearAt || null, notes: [],
      relatedMilestoneIds: relIds.slice(), relatedMilestoneTitles: relTitles,
    };
    raw.push({ entry, sortKey: String(d.unclearAt || ""), notesToMark: [], flagRec: d, flagKind: "decisions" });
  }

  // Drain order: oldest pending signal first (min note ts / unclearAt), id tiebreak.
  raw.sort((a, b) => (a.sortKey < b.sortKey ? -1 : (a.sortKey > b.sortKey ? 1 : (a.entry.id < b.entry.id ? -1 : (a.entry.id > b.entry.id ? 1 : 0)))));
  raw.forEach((r, i) => { r.entry.n = i + 1; });

  const worklist = { dispatchId, ts, projectName, entries: raw.map((r) => r.entry) };
  const summary = raw.map((r) => ({
    targetType: r.entry.targetType, id: r.entry.id, title: r.entry.title,
    noteCount: r.entry.notes.length, unclear: r.entry.unclear,
  }));
  return { worklist, summary, raw };
}

// Un-mark a live dispatch's cards after a failed/timeout/killed run (planner
// §1.1/§1.2). Re-reads from disk and only touches records still bearing THIS
// dispatchId. Returns the number of cards restored. Runs INSIDE a lock.
function unmarkDispatch(ctx, worklist, dispatchId) {
  const roadmap = readJson(ctx.files.roadmap, () => emptyRoadmap(ctx.root));
  const decisions = readJson(ctx.files.decisions, emptyDecisions);
  const itById = new Map((roadmap.items || []).map((x) => [x.id, x]));
  const msById = new Map((roadmap.milestones || []).map((x) => [x.id, x]));
  const decById = new Map((decisions.decisions || []).map((x) => [x.id, x]));
  let touchedR = false, touchedD = false, cards = 0;
  for (const e of (worklist.entries || [])) {
    let restored = false;
    if (e.targetType === "item") {
      const it = itById.get(e.id);
      if (it) {
        for (const en of (e.notes || [])) {
          const note = (it.notes || []).find((n) => n && n.id === en.noteId);
          if (note && note.dispatchId === dispatchId) {
            note.pending = true; delete note.dispatchId; delete note.dispatchedAt;
            touchedR = true; restored = true;
          }
        }
        if (e.unclear && it.unclear === true && it.unclearDispatchId === dispatchId) {
          delete it.unclearDispatchId; delete it.unclearDispatchedAt; touchedR = true; restored = true;
        }
      }
    } else if (e.targetType === "milestone") {
      const m = msById.get(e.id);
      if (m && e.unclear && m.unclear === true && m.unclearDispatchId === dispatchId) {
        delete m.unclearDispatchId; delete m.unclearDispatchedAt; touchedR = true; restored = true;
      }
    } else if (e.targetType === "decision") {
      const d = decById.get(e.id);
      if (d && e.unclear && d.unclear === true && d.unclearDispatchId === dispatchId) {
        delete d.unclearDispatchId; delete d.unclearDispatchedAt; touchedD = true; restored = true;
      }
    }
    if (restored) cards++;
  }
  if (touchedR) atomicWrite(ctx.files.roadmap, roadmap);
  if (touchedD) atomicWrite(ctx.files.decisions, decisions);
  return cards;
}

// Close-out callback for a LIVE run (planner §2.2.6). Never throws into the
// bridge. Appends dispatch_done on success; on any other outcome un-marks the
// cards and appends dispatch_failed.
function dispatchOnDone(ctx, worklist, dispatchId, result) {
  try {
    if (result && result.status === "done") {
      withLock(ctx, () => {
        appendHistory(ctx, {
          id: genId("evt"), ts: nowIso(), actor: "system", source: "ui", action: "dispatch_done",
          targetId: null, patch: { dispatchId, status: "done" },
          summary: `Helper finished dispatch ${dispatchId}`,
        });
      });
    } else {
      withLock(ctx, () => {
        const unmarked = unmarkDispatch(ctx, worklist, dispatchId);
        const status = (result && result.status) || "error";
        appendHistory(ctx, {
          id: genId("evt"), ts: nowIso(), actor: "system", source: "ui", action: "dispatch_failed",
          targetId: null, patch: { dispatchId, status, unmarked },
          summary: `Helper run did not finish; ${unmarked} card(s) put back in the waiting list`,
        });
      });
    }
  } catch { /* onDone must never throw into the server */ }
}

// ---------------------------------------------------------------------------
// API: POST /api/dispatch  (dir mode)  +  POST /api/r/<id>/dispatch  (central)
// Body: {} (optional sessionId, stamped on ui_dispatch like the other handlers).
// ---------------------------------------------------------------------------
async function handleDispatch(res, ctx, payload) {
  const sessionId = extractSessionId(payload);
  const cfg = getBridgeCfg();
  if (!cfg.enabled) {
    return sendJson(res, 409, { error: "E_BRIDGE_DISABLED", message: "the background helper is switched off — turn it on in Settings" });
  }
  // Synchronous reservation — blocks a second dispatch and any auto-trigger fire.
  if (!BRIDGE.reserveBatch()) {
    return sendJson(res, 409, { error: "E_BRIDGE_BUSY", message: "the helper is still working through the last send" });
  }

  let assembled;
  try {
    assembled = withLock(ctx, () => {
      const roadmap = readJson(ctx.files.roadmap, () => emptyRoadmap(ctx.root));
      const decisions = readJson(ctx.files.decisions, emptyDecisions);
      const ts = nowIso();
      const dispatchId = genId("disp");
      const { worklist, summary, raw } = assembleDispatch(roadmap, decisions, dispatchId, ts);
      if (summary.length === 0) return { nothingPending: true };
      const count = summary.length;

      if (cfg.dryRun) {
        // Practice mode: mark nothing, just record the intent.
        const evt = {
          id: genId("evt"), ts, actor: "founder", source: "ui", action: "ui_dispatch",
          targetId: null, patch: { dispatchId, count, dryRun: true },
          summary: `Founder sent ${count} card(s) to the helper (practice mode)`,
        };
        if (sessionId) evt.sessionId = sessionId;
        appendHistory(ctx, evt);
        if (sessionId) upsertSession(ctx, sessionId, undefined, 1);
        return { dryRun: true, worklist, summary, dispatchId, count };
      }

      // Live: stamp every consumed note + flag, then atomic-write what changed.
      let touchedR = false, touchedD = false;
      for (const r of raw) {
        for (const n of r.notesToMark) {
          n.pending = false; n.dispatchId = dispatchId; n.dispatchedAt = ts; touchedR = true;
        }
        if (r.flagRec) {
          r.flagRec.unclearDispatchId = dispatchId; r.flagRec.unclearDispatchedAt = ts;
          if (r.flagKind === "decisions") touchedD = true; else touchedR = true;
        }
      }
      if (touchedR) atomicWrite(ctx.files.roadmap, roadmap);
      if (touchedD) atomicWrite(ctx.files.decisions, decisions);
      const evt = {
        id: genId("evt"), ts, actor: "founder", source: "ui", action: "ui_dispatch",
        targetId: null, patch: { dispatchId, count, dryRun: false },
        summary: `Founder sent ${count} card(s) to the helper`,
      };
      if (sessionId) evt.sessionId = sessionId;
      appendHistory(ctx, evt);
      if (sessionId) upsertSession(ctx, sessionId, undefined, 1);
      return { dryRun: false, worklist, summary, dispatchId, count };
    });
  } catch (err) {
    BRIDGE.cancelBatchReservation();
    return sendJson(res, 500, { error: err.code || "E_IO", message: err.message });
  }

  if (assembled.nothingPending) {
    BRIDGE.cancelBatchReservation();
    return sendJson(res, 409, { error: "E_NOTHING_PENDING", message: "nothing is waiting to send" });
  }

  const { worklist, summary, dispatchId, count, dryRun } = assembled;

  // C1 — THE LAUNCH GATE, gate point 2 of 5. The batch dispatch is a CHORE BY
  // CONSTRUCTION: it is card hygiene (drain the pending notes and unclear flags),
  // not road work, so it stamps chore:true rather than naming a milestone. The
  // gate still runs of its own accord here — the gate is the thing that makes the
  // chore flag mean something, and a spawner that skipped it would be trusting
  // the spawner it calls to gate on its behalf. The chore lands in the ledger so
  // the coverage line can count it; a chore is recorded, never hidden.
  const gate = assertLinkedOrChore({ ctx, chore: true });
  if (!gate.ok) {
    BRIDGE.cancelBatchReservation();
    return sendJson(res, 409, { error: gate.reason || "E_UNLINKED", message: gate.message });
  }
  ledgerChore(ctx, {
    source: "bridge", ref: dispatchId, kind: "launch",
    label: `founder sent ${count} card(s) to the helper${dryRun ? " (practice mode)" : ""}`,
  });

  if (dryRun) {
    // Dry-run is fast (no spawn); await so we can return the context package path.
    let contextPackagePath = null;
    try {
      const result = await BRIDGE.runBatch(ctx, { worklist, dispatchId, chore: true, dryRun: true });
      contextPackagePath = (result && result.contextPackagePath) || null;
    } catch { /* runBatch clears the reservation in its own finally */ }
    return sendJson(res, 200, { ok: true, dryRun: true, dispatchId, count, entries: summary, contextPackagePath });
  }

  // Live: fire-and-forget. The response returns immediately; onDone closes out.
  // runBatch settles its own reservation and never rejects; the .catch is a belt-
  // and-suspenders guard so a stray rejection can never surface as unhandled.
  Promise.resolve(
    BRIDGE.runBatch(ctx, { worklist, dispatchId, chore: true, onDone: (result) => dispatchOnDone(ctx, worklist, dispatchId, result) }),
  ).catch(() => {});
  return sendJson(res, 200, { ok: true, dryRun: false, dispatchId, count, entries: summary });
}

// ---------------------------------------------------------------------------
// API: POST /api/file/:name   body = full JSON  (escape hatch; no sessionId)
//
// The one guarded writer that REFUSES instead of holding. A whole-file
// overwrite has no card to sit a contested change on and no single record to
// show two versions of, so a stale one is turned away BEFORE the loss rather
// than held after it. `baseRev` is optional and rides in the query string —
// it cannot ride in the body, because the body IS the file. Absent baseRev is
// today's behaviour, unchanged.
// ---------------------------------------------------------------------------
function handleFilePut(res, ctx, name, rawBody, baseRev) {
  if (!["roadmap", "decisions", "pins", "glossary"].includes(name)) {
    return sendJson(res, 404, { error: "not_found", message: `unknown file ${name}` });
  }
  let data;
  try { data = JSON.parse(rawBody); }
  catch { return sendJson(res, 400, { error: "E_VALIDATION", message: "body is not valid JSON" }); }
  if (!data || typeof data !== "object" || data.schemaVersion !== 1) {
    return sendJson(res, 400, { error: "E_VALIDATION", message: "schemaVersion must be 1" });
  }
  if (baseRev) {
    const rev = computeRev(ctx);
    if (baseRev !== rev) {
      return sendJson(res, 409, { error: "E_STALE", rev,
        message: `the road moved since you read it (rev ${rev}); re-read ${name}.json and re-apply your edit` });
    }
  }
  try {
    withLock(ctx, () => {
      atomicWrite(ctx.files[name], data);
      appendHistory(ctx, {
        id: genId("evt"), ts: nowIso(), actor: "founder", source: "ui", action: "file_edit",
        targetId: null, summary: `Founder overwrote ${name}.json via UI escape hatch`,
      });
    });
  } catch (err) {
    return sendJson(res, 500, { error: err.code || "E_IO", message: err.message });
  }
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// API: GET /api/registry  (central mode) — planner §1.4 + §2.2
// Lock-free, tolerant reads. Dead entries reported missing:true, never removed.
// Existing fields are byte-identical to before; lineage fields are additive:
// origin (echoed), orphan, lineageError, children, fullStory.
// ---------------------------------------------------------------------------
function handleRegistry(res) {
  const reg = readRegistry();
  const lin = buildLineage(reg);
  const getSummary = makeSummaryGetter(lin);
  const revParts = [statMtime(registryPath())];
  const roadmaps = [];
  for (const e of (reg.roadmaps || [])) {
    if (!e || typeof e.dir !== "string" || !e.id) continue;
    const resolved = path.resolve(e.dir);
    const ctx = makeCtx(resolved);
    revParts.push(statMtime(ctx.files.roadmap));
    revParts.push(statMtime(ctx.files.sessions));

    // Base fields read from this exact entry's dir (byte-identical to legacy).
    const s = readRoadSummary(e);
    const base = s.missing ? {
      id: e.id,
      name: e.name || path.basename(resolved),
      tagline: "",
      dir: e.dir,
      addedAt: e.addedAt || null,
      lastSeenAt: e.lastSeenAt || null,
      missing: true,
      progress: null,
      status: null,
      sessionCount: null,
      updatedAt: null,
    } : {
      id: e.id,
      name: s.name,
      tagline: s.tagline,
      dir: e.dir,
      addedAt: e.addedAt || null,
      lastSeenAt: e.lastSeenAt || null,
      missing: false,
      progress: { done: s.done, total: s.total },
      status: s.status,
      sessionCount: s.rawSessionsLen,
      updatedAt: s.updatedAt,
    };

    // Additive lineage fields (planner §2.2).
    const fl = lin.flags.get(e.id) || { origin: null, orphan: false, lineageError: null };
    base.origin = fl.origin || null;
    base.orphan = !!fl.orphan;
    base.lineageError = fl.lineageError || null;
    base.children = (lin.childrenOf.get(e.id) || []).slice();
    base.fullStory = computeFullStory(e.id, lin, getSummary);

    roadmaps.push(base);
  }
  sendJson(res, 200, { rev: revParts.join("-"), roadmaps });
}

// Resolve an id-scoped roadmap from the registry.
function resolveRoadmap(id) {
  const reg = readRegistry();
  const e = (reg.roadmaps || []).find((x) => x && x.id === id);
  if (!e || typeof e.dir !== "string") return { notFound: true };
  const resolved = path.resolve(e.dir);
  if (!fs.existsSync(resolved)) return { missing: true, dir: e.dir };
  return { entry: e, ctx: makeCtx(resolved) };
}

// ---------------------------------------------------------------------------
// RAIDS (§4) — a read-only view of subagent workflow runs ("raids") under the
// founder's ~/.claude/projects tree. No fs.watch: a 5s-memoized scan computed on
// GET (mirrors the poll style). Hand-rolled glob (zero deps). Never mutates.
// ---------------------------------------------------------------------------
const RAIDS_DEFAULT_GLOB = path.join(os.homedir(), ".claude", "projects", "*", "*", "subagents", "workflows", "wf_*");
const RAIDS_TTL_MS = 5000;
let RAIDS_CACHE = null; // { at:ms, key:string, value:{rev,raids} }

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Expand a glob whose only wildcard is "*" (any run of chars within one path
// segment) into matching existing filesystem paths. Zero deps, tolerant.
function expandGlob(pattern) {
  const norm = pattern.replace(/\\/g, "/");
  let segs = norm.split("/");
  let cur;
  if (/^[A-Za-z]:$/.test(segs[0])) { cur = [segs[0] + "/"]; segs = segs.slice(1); }
  else if (norm.startsWith("/")) { cur = ["/"]; segs = segs.slice(1); }
  else { cur = ["."]; }
  for (const seg of segs) {
    if (seg === "") continue;
    if (!seg.includes("*")) {
      cur = cur.map((b) => path.join(b, seg)).filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
    } else {
      const re = new RegExp("^" + seg.split("*").map(escapeRe).join(".*") + "$");
      const next = [];
      for (const b of cur) {
        let entries = [];
        try { entries = fs.readdirSync(b); } catch { entries = []; }
        for (const nm of entries) if (re.test(nm)) next.push(path.join(b, nm));
      }
      cur = next;
    }
    if (cur.length === 0) break;
  }
  return cur;
}

// Tolerant parse of a workflow meta `script` string for name/description/phases.
function parseRaidMeta(script) {
  const out = { name: null, description: "", phases: [] };
  if (typeof script !== "string") return out;
  const nameM = script.match(/name\s*:\s*['"]([^'"]*)['"]/);
  if (nameM) out.name = nameM[1];
  const descM = script.match(/description\s*:\s*['"]([^'"]*)['"]/);
  if (descM) out.description = descM[1];
  const phasesM = script.match(/phases\s*:\s*\[([\s\S]*?)\]/);
  if (phasesM) {
    const objRe = /\{([^{}]*)\}/g;
    let m;
    while ((m = objRe.exec(phasesM[1]))) {
      const obj = m[1];
      const tM = obj.match(/title\s*:\s*['"]([^'"]*)['"]/);
      const mdM = obj.match(/model\s*:\s*['"]([^'"]*)['"]/);
      if (tM) out.phases.push({ title: tM[1], model: mdM ? mdM[1] : "" });
    }
  }
  return out;
}

function scanRaids(roots) {
  const now = Date.now();
  const seen = new Set();
  const raids = [];
  const revParts = [];
  for (const root of roots) {
    for (const wfDir of expandGlob(root)) {
      if (seen.has(wfDir)) continue;
      seen.add(wfDir);
      try { if (!fs.statSync(wfDir).isDirectory()) continue; } catch { continue; }
      const journalPath = path.join(wfDir, "journal.jsonl");
      if (!fs.existsSync(journalPath)) continue; // a run without a journal is not a raid
      const id = path.basename(wfDir);
      // meta at <sessionDir>/workflows/<id>.json (sessionDir = up 3 from wfDir).
      const sessionDir = path.dirname(path.dirname(path.dirname(wfDir)));
      let meta = null, metaText = "";
      try {
        metaText = fs.readFileSync(path.join(sessionDir, "workflows", id + ".json"), "utf8");
        meta = JSON.parse(metaText);
      } catch { meta = null; }
      const parsed = parseRaidMeta(meta && meta.script);
      // §3 — DETECTION ONLY. We read the two linkage keys off the meta, tolerantly
      // (they may sit at the top level or anywhere inside the script), and label
      // the run. We do NOT and CANNOT stop it: this workflow was launched by
      // Claude Code, not by questlog. `unlinked` means "named no milestone and no
      // chore flag" — never "blocked".
      const link = currency.parseRaidLinkage(metaText || (meta && meta.script) || "");
      const linkCtx = link.milestoneId ? findRoadForMilestone(link.milestoneId) : null;
      const linked = currency.raidLinkage({ milestoneId: link.milestoneId, chore: link.chore, resolves: !!linkCtx });
      let agentsStarted = 0, agentsDone = 0;
      try {
        const raw = fs.readFileSync(journalPath, "utf8");
        for (const line of raw.split("\n")) {
          const t = line.trim(); if (!t) continue;
          let o; try { o = JSON.parse(t); } catch { continue; }
          if (o && o.type === "started") agentsStarted++;
          else if (o && o.type === "result") agentsDone++;
        }
      } catch { /* unreadable journal */ }
      // lastActivityAt = newest mtime among files in the wf dir (and the dir).
      let lastMtime = statMtime(wfDir);
      try { for (const f of fs.readdirSync(wfDir)) { const mt = statMtime(path.join(wfDir, f)); if (mt > lastMtime) lastMtime = mt; } } catch { /* ignore */ }
      const lastActivityAt = lastMtime ? new Date(lastMtime).toISOString() : null;
      const running = lastMtime && (now - lastMtime < 10 * 60 * 1000);
      const status = running ? "running" : ((agentsStarted === agentsDone && agentsStarted > 0) ? "done" : "stalled");
      const startedAt = (meta && typeof meta.timestamp === "string") ? meta.timestamp : lastActivityAt;
      revParts.push(String(lastMtime || 0));
      raids.push({
        id,
        name: parsed.name || id,
        description: parsed.description,
        taskId: (meta && typeof meta.taskId === "string") ? meta.taskId : null,
        startedAt,
        phases: parsed.phases,
        phasesTotal: parsed.phases.length,
        agentsStarted,
        agentsDone,
        lastActivityAt,
        status,
        journalDir: wfDir,
        milestoneId: linked === "milestone" ? link.milestoneId : null,
        chore: link.chore === true,
        linked,
      });

      // THE RAID WATCHER'S EVIDENCE WRITE. Observation, not judgement: it
      // records that this run was launched, and later that it CLAIMED to
      // finish. It never writes status (C3), never bumps updatedAt, and is
      // idempotent by (source, ref, kind), so a watcher restart re-observing the
      // same journal leaves roadmap.json byte-identical.
      try {
        if (linked === "milestone" && linkCtx) {
          writeEvidence(linkCtx, link.milestoneId, {
            source: "raid-watcher", ref: id, kind: "launch",
            claim: `workflow "${parsed.name || id}" set out with ${parsed.phases.length} phase(s)`,
          });
          if (status === "done") {
            writeEvidence(linkCtx, link.milestoneId, {
              source: "raid-watcher", ref: id, kind: "finish",
              claim: `workflow "${parsed.name || id}" reported all ${agentsDone} agent(s) returned`,
            });
          }
        } else if (linked === "chore") {
          // A chore never touches the road — it lands in the ledger instead.
          const chCtx = (MODE === "dir") ? DIR_CTX : null;
          if (chCtx) {
            ledgerChore(chCtx, { source: "raid-watcher", ref: id, kind: "launch", label: `workflow "${parsed.name || id}" declared itself a chore` });
            if (status === "done") ledgerChore(chCtx, { source: "raid-watcher", ref: id, kind: "finish", label: `workflow "${parsed.name || id}" finished` });
          }
        }
      } catch { /* the watcher is a reader first: a write failure never breaks the scan */ }
    }
  }
  raids.sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  return { rev: revParts.join("-") || "0", raids };
}

// C7 — the coverage line's inputs. Chore ledger lines + evidence launches across
// every road we can see, joined to today's unlinked raids. Reads only.
function collectCoverageInputs(raids) {
  const ctxs = [];
  if (MODE === "dir") ctxs.push(DIR_CTX);
  else {
    for (const e of (readRegistry().roadmaps || [])) {
      if (!e || typeof e.dir !== "string") continue;
      try { ctxs.push(makeCtx(path.resolve(e.dir))); } catch { /* skip a bad entry */ }
    }
  }
  const activityEntries = [];
  const milestones = [];
  for (const c of ctxs) {
    try { activityEntries.push(...currency.readActivity(c.files.activity)); } catch { /* absent is normal */ }
    try {
      const rm = readJson(c.files.roadmap, () => emptyRoadmap(c.root));
      for (const m of (rm.milestones || [])) if (Array.isArray(m && m.evidence) && m.evidence.length) milestones.push(m);
    } catch { /* unreadable road — skip */ }
  }
  return currency.coverage({ activityEntries, milestones, raids: Array.isArray(raids) ? raids : [] });
}

// GET /api/raids (both modes).
function handleRaids(res) {
  const { config } = computeEffectiveConfig();
  if (!config.raids.enabled) return sendJson(res, 200, { rev: "disabled", raids: [], enabled: false });
  const roots = config.raids.journalRoots.length ? config.raids.journalRoots : [RAIDS_DEFAULT_GLOB];
  const key = roots.join("|");
  const now = Date.now();
  if (RAIDS_CACHE && RAIDS_CACHE.key === key && (now - RAIDS_CACHE.at) < RAIDS_TTL_MS) {
    return sendJson(res, 200, RAIDS_CACHE.value);
  }
  let value;
  try { value = scanRaids(roots); } catch (err) { return sendJson(res, 500, { error: "E_IO", message: err.message }); }
  // C7 — the coverage declaration rides along with the scan it is computed from.
  try { value = { ...value, coverage: collectCoverageInputs(value.raids) }; }
  catch { /* a coverage failure must never cost the founder the raids panel */ }
  RAIDS_CACHE = { at: now, key, value };
  sendJson(res, 200, value);
}

// ---------------------------------------------------------------------------
// SKINS (Wave 3, §1) — themable palettes. Built-ins live in the app's skins/
// dir (read-only); user skins in <questlogHome>/skins/. GET lists them with a
// per-skin `valid` flag; POST apply writes skins.active via the config lock +
// atomic write, but only after the skin passes the readability floors.
// ---------------------------------------------------------------------------
function appSkinsDir() { return path.join(__dirname, "skins"); }
function userSkinsDir() { return path.join(questlogHome(process.env), "skins"); }

// Write a single config key inside the config lock (same protocol as
// handleConfigPost, minus the autostart side effect). Used by skin apply.
function writeConfigMerge(mutator) {
  acquireConfigLock();
  try {
    let base;
    try { base = JSON.parse(fs.readFileSync(configFilePath(process.env), "utf8").replace(/^﻿/, "")); }
    catch { base = null; }
    if (!base || typeof base !== "object" || Array.isArray(base) || base.schemaVersion !== 1) base = { schemaVersion: 1 };
    base.schemaVersion = 1;
    mutator(base);
    fs.mkdirSync(path.dirname(configFilePath(process.env)), { recursive: true });
    atomicWrite(configFilePath(process.env), base);
  } finally {
    releaseConfigLock();
  }
}

// GET /api/skins — both modes.
function handleSkinsGet(res) {
  const { config } = computeEffectiveConfig();
  let list;
  try { list = skins.listSkins(appSkinsDir(), userSkinsDir()); }
  catch (err) { return sendJson(res, 500, { error: "E_IO", message: err && err.message ? err.message : String(err) }); }
  sendJson(res, 200, {
    active: config.skins.active,
    skins: list.map((s) => ({
      name: s.name, author: s.author, source: s.source,
      tokens: s.tokens, road: s.road, valid: s.valid,
      contrastFailures: s.contrastFailures || [],
    })),
  });
}

// POST /api/skins/apply {name} — both modes.
function handleSkinsApply(res, body) {
  const name = body && body.name;
  if (typeof name !== "string" || !name) return sendJson(res, 400, { error: "E_VALIDATION", message: "name required" });
  let skin;
  try { skin = skins.resolveSkin(appSkinsDir(), userSkinsDir(), name); }
  catch (err) { return sendJson(res, 500, { error: "E_IO", message: err && err.message ? err.message : String(err) }); }
  if (!skin) return sendJson(res, 404, { error: "not_found", message: `no skin named ${name}` });
  if (skin.shapeError) return sendJson(res, 400, { error: "E_SKIN_SHAPE", message: skin.shapeError });
  const check = skins.validateContrast(skins.effectiveTokens(skin.tokens));
  if (!check.valid) {
    const f = check.failures[0];
    return sendJson(res, 400, {
      error: "E_SKIN_CONTRAST",
      message: `skin "${name}" fails readability floor: ${f.pair}` + (f.got != null ? ` (got ${f.got}, need ${f.need})` : ` (need ${f.need})`),
      failures: check.failures,
    });
  }
  try { writeConfigMerge((base) => { if (!base.skins || typeof base.skins !== "object" || Array.isArray(base.skins)) base.skins = {}; base.skins.active = name; }); }
  catch (e) { return sendJson(res, 500, { error: e.code || "E_IO", message: e.message }); }
  sendJson(res, 200, { ok: true, active: name });
}

// ---------------------------------------------------------------------------
// DISTILLERY (Wave 3, §3) — POST /api/distill {id}. Resolves the workflow via
// scanRaids, then DRY-RUNs by default (returns the exact headless command +
// inputs, spawns nothing). Live spawning gated by config distillery.live
// (default false); output only ever lands in <app>/distillery-drafts/ as an
// UNREVIEWED draft — never a skills dir.
// ---------------------------------------------------------------------------
function draftsDir() { return path.join(__dirname, "distillery-drafts"); }

function resolveRaidById(id) {
  const { config } = computeEffectiveConfig();
  const roots = config.raids.journalRoots.length ? config.raids.journalRoots : [RAIDS_DEFAULT_GLOB];
  const { raids } = scanRaids(roots);
  return raids.find((r) => r.id === id) || null;
}

async function handleDistill(res, body) {
  const id = body && body.id;
  if (typeof id !== "string" || !id) return sendJson(res, 400, { error: "E_VALIDATION", message: "id required" });
  let raid;
  try { raid = resolveRaidById(id); }
  catch (err) { return sendJson(res, 500, { error: "E_IO", message: err && err.message ? err.message : String(err) }); }
  if (!raid) return sendJson(res, 404, { error: "not_found", message: `no completed workflow ${id}` });

  // C1 — GATE POINT 5b of 5. Distilling a finished workflow into a draft skill
  // is curation of questlog's own tooling, not work on the founder's road, so
  // it declares itself a chore. The optional roadmapId only says WHICH road's
  // chore ledger should count it; it never scopes what is distilled.
  const dctx = (MODE === "dir")
    ? DIR_CTX
    : (() => { const rr = body && typeof body.roadmapId === "string" ? resolveRoadmap(body.roadmapId) : null; return rr && !rr.notFound && !rr.missing ? rr.ctx : null; })();
  const gate = assertLinkedOrChore({ ctx: dctx, chore: true });
  if (!gate.ok) return sendJson(res, 409, { error: "E_UNLINKED", message: gate.message });
  ledgerChore(dctx, { source: "session", ref: id, kind: "launch", label: `distilled the workflow "${raid.name || id}" into a draft` });

  const { config } = computeEffectiveConfig();
  const plan = distiller.planDistill(raid, draftsDir());
  // Log the exact command the founder can audit (dry-run always logs; live too).
  process.stderr.write(`[distill] ${config.distillery.live ? "LIVE" : "DRY-RUN"} ${id}: ${plan.command}\n`);

  if (!config.distillery.live) {
    return sendJson(res, 200, { dryRun: true, command: plan.command, inputs: plan.inputs, model: plan.model });
  }
  // LIVE (gated). Cleared nesting env, --model sonnet. Writes one draft.
  try {
    const result = await distiller.runDistill(raid, draftsDir(), {}, { spawn });
    return sendJson(res, result.ok ? 200 : 500, { dryRun: false, ...result });
  } catch (err) {
    return sendJson(res, 500, { error: "E_IO", message: err && err.message ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------------------
// TASK BOARD (Wave 3, §4) — GET/POST /api/taskboard. Queue at
// <questlogHome>/taskboard.json. Founder adds/edits/approves; agents may add
// with approvedAt:null (ineligible until approved). NO scheduler exists — the
// trigger is a pure reporter, off by default.
// ---------------------------------------------------------------------------
const TASKBOARD_LOCK = ".taskboard-lock";
function acquireTaskboardLock() {
  const lockDir = path.join(questlogHome(process.env), TASKBOARD_LOCK);
  const parent = path.dirname(lockDir);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(lockDir); return; }
    catch (err) {
      if (err.code !== "EEXIST") throw Object.assign(new Error("E_IO: " + err.message), { code: "E_IO" });
      let age = Infinity;
      try { age = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { /* vanished */ }
      if (age > 5000) { try { fs.rmdirSync(lockDir); } catch { /* raced */ } continue; }
      if (Date.now() - start > 3000) throw Object.assign(new Error("E_LOCK_TIMEOUT: could not acquire taskboard lock"), { code: "E_LOCK_TIMEOUT" });
      const until = Date.now() + 50; while (Date.now() < until) { /* spin */ }
    }
  }
}
function releaseTaskboardLock() { try { fs.rmdirSync(path.join(questlogHome(process.env), TASKBOARD_LOCK)); } catch { /* gone */ } }

function handleTaskboardGet(res) {
  const { config } = computeEffectiveConfig();
  const board = taskboard.readBoard(taskboard.boardPath(questlogHome(process.env)));
  const eligible = config.taskboard.enabled
    ? taskboard.pickEligible(board, config.taskboard.capacityWindow).map((it) => it.id)
    : [];
  sendJson(res, 200, {
    enabled: config.taskboard.enabled,
    capacityWindow: config.taskboard.capacityWindow,
    items: board.items,
    eligible,
  });
}

// POST /api/taskboard { op, ... }. Ops: add (founder|agent), approve, update,
// remove. Founder-scoped ops stamp approvedAt; agent add leaves it null.
function handleTaskboardPost(res, body) {
  const op = body && body.op;
  if (typeof op !== "string") return sendJson(res, 400, { error: "E_VALIDATION", message: "op required" });
  const file = taskboard.boardPath(questlogHome(process.env));
  try {
    acquireTaskboardLock();
    try {
      const board = taskboard.readBoard(file);
      if (op === "add") {
        const verr = taskboard.validateItem(body.item || {});
        if (verr) return sendJson(res, 400, { error: "E_VALIDATION", message: verr });
        // `by:"founder"` approves on add; anything else (agents) stays null.
        const item = taskboard.makeItem(body.item || {}, { approvedByFounder: body.by === "founder" });
        board.items.push(item);
        taskboard.writeBoard(file, board);
        return sendJson(res, 200, { ok: true, item });
      }
      if (op === "approve") {
        const it = board.items.find((x) => x.id === body.id);
        if (!it) return sendJson(res, 404, { error: "not_found", message: `no item ${body.id}` });
        it.approvedAt = new Date().toISOString();
        taskboard.writeBoard(file, board);
        return sendJson(res, 200, { ok: true, item: it });
      }
      if (op === "update") {
        const it = board.items.find((x) => x.id === body.id);
        if (!it) return sendJson(res, 404, { error: "not_found", message: `no item ${body.id}` });
        const patch = body.fields || {};
        const merged = { ...it, ...patch, id: it.id };
        const verr = taskboard.validateItem(merged);
        if (verr) return sendJson(res, 400, { error: "E_VALIDATION", message: verr });
        Object.assign(it, taskboard.makeItem(merged, {}));
        taskboard.writeBoard(file, board);
        return sendJson(res, 200, { ok: true, item: it });
      }
      if (op === "remove") {
        const before = board.items.length;
        board.items = board.items.filter((x) => x.id !== body.id);
        if (board.items.length === before) return sendJson(res, 404, { error: "not_found", message: `no item ${body.id}` });
        taskboard.writeBoard(file, board);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 400, { error: "E_VALIDATION", message: `unknown op: ${op}` });
    } finally {
      releaseTaskboardLock();
    }
  } catch (e) {
    return sendJson(res, 500, { error: e.code || "E_IO", message: e.message });
  }
}

// ---------------------------------------------------------------------------
// ROSTER (§5) — GET /api/sessions (central only): every road's session ledger +
// batons, with a DERIVED status and a copy-paste resume command. POST
// /api/sessions/resume spawns a detached resume, gated by config roster.allowSpawn.
// ---------------------------------------------------------------------------
// A baton's kind. Absent === "handoff" (batons written before kinds existed).
function batonKind(b) { return (b && typeof b.kind === "string" && b.kind) ? b.kind : "handoff"; }
// The handoff chain only. Briefs are addressed work items, NOT handoffs: if they
// counted here, addressing a brief would flip its author to
// "completed"/"superseded" on the roster. Mirrors mcp/server.mjs freshestBaton.
function handoffBatons(batons) { return batons.filter((b) => batonKind(b) !== "brief"); }

function deriveSessionStatus(s, batons) {
  const id = s.id;
  if (batons.some((b) => b && b.fromSessionId === id && b.status === "picked_up")) return "superseded";
  if (batons.some((b) => b && b.fromSessionId === id && b.status === "open")) return "completed";
  const times = [s.lastSeenAt, s.lastPulse]
    .filter((t) => typeof t === "string").map((t) => Date.parse(t)).filter((n) => Number.isFinite(n));
  const latest = times.length ? Math.max(...times) : NaN;
  if (Number.isFinite(latest) && (Date.now() - latest) < 10 * 60 * 1000) return "active";
  return "idle";
}
function sessionBatonId(id, batons) {
  let f = null;
  for (const b of batons) if (b && b.fromSessionId === id) { if (!f || String(b.ts || "") > String(f.ts || "")) f = b; }
  return f ? f.id : null;
}

// POST /api/registry/unregister {id} — remove ONE registry entry (central mode).
// Registry-only: the road's .questlog/ bytes on disk are NEVER touched. 404 for
// an unknown id. Returns the removed entry. A live road re-registers itself on
// its next dir-mode start (see the caption on the overworld remove control).
function handleUnregister(res, payload) {
  const id = payload && payload.id;
  if (typeof id !== "string" || !id) {
    return sendJson(res, 400, { error: "E_VALIDATION", message: "id (string) required" });
  }
  let removed = null;
  acquireRegistryLock();
  try {
    const reg = readRegistry();
    if (!Array.isArray(reg.roadmaps)) reg.roadmaps = [];
    const idx = reg.roadmaps.findIndex((e) => e && e.id === id);
    if (idx === -1) { releaseRegistryLock(); return sendJson(res, 404, { error: "not_found", message: `no roadmap ${id}` }); }
    removed = reg.roadmaps[idx];
    reg.roadmaps.splice(idx, 1); // registry entry only — e.dir on disk is left untouched
    reg.schemaVersion = 1;
    atomicWrite(registryPath(), reg);
  } finally {
    releaseRegistryLock();
  }
  return sendJson(res, 200, { removed });
}

function handleSessionsRoster(res) {
  const reg = readRegistry();
  const revParts = [statMtime(registryPath())];
  const projects = [];
  for (const e of (reg.roadmaps || [])) {
    if (!e || typeof e.dir !== "string" || !e.id) continue;
    const resolved = path.resolve(e.dir);
    const ctx = makeCtx(resolved);
    revParts.push(statMtime(ctx.files.sessions), statMtime(ctx.files.batons));
    const sd = readJson(ctx.files.sessions, emptySessions);
    const bd = readJson(ctx.files.batons, emptyBatons);
    // Derived eventCount overlay (HARNESS-5) — one history scan per road.
    const rawS = overlayDerivedSessions(Array.isArray(sd.sessions) ? sd.sessions : [], ctx.files.history);
    const batons = Array.isArray(bd.batons) ? bd.batons : [];
    const handoffs = handoffBatons(batons);
    // Open briefs addressed to each session — the "N briefs waiting" chip.
    const briefsBySession = new Map();
    for (const b of batons) {
      if (!b || batonKind(b) !== "brief" || b.status !== "open") continue;
      const to = (typeof b.toSessionId === "string" && b.toSessionId) ? b.toSessionId : null;
      if (!to) continue;
      briefsBySession.set(to, (briefsBySession.get(to) || 0) + 1);
    }
    const name = readRoadSummary(e).name;
    // NOTE: this map is a whitelist — a field not named here is DROPPED from the
    // API. parentSessionId and briefsWaiting must be listed or lineage and the
    // brief chip silently vanish.
    const sessions = rawS.filter((s) => s && typeof s.id === "string" && s.id).map((s) => ({
      id: s.id,
      label: typeof s.label === "string" ? s.label : "",
      firstSeenAt: s.firstSeenAt || null,
      lastSeenAt: s.lastSeenAt || null,
      lastPulse: (typeof s.lastPulse === "string") ? s.lastPulse : null,
      focus: (typeof s.focus === "string") ? s.focus : "",
      eventCount: Number.isInteger(s.eventCount) ? s.eventCount : 0,
      storedEventCount: Number.isInteger(s.storedEventCount) ? s.storedEventCount : 0,
      parentSessionId: (typeof s.parentSessionId === "string" && s.parentSessionId) ? s.parentSessionId : null,
      briefsWaiting: briefsBySession.get(s.id) || 0,
      status: deriveSessionStatus(s, handoffs),
      batonId: sessionBatonId(s.id, handoffs),
      resumeCommand: `cd "${resolved}"; claude --resume ${s.id}`,
    }));
    sessions.sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")));
    // Lineage order: each child immediately after its parent (parents keep the
    // recency order above). Unknown parents stay at top level.
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const kids = new Map();
    for (const s of sessions) {
      const p = (s.parentSessionId && byId.has(s.parentSessionId) && s.parentSessionId !== s.id) ? s.parentSessionId : null;
      s.depth = 0;
      if (p) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(s); }
    }
    const ordered = [];
    const seen = new Set();
    const walk = (s, depth) => {
      if (seen.has(s.id) || depth > 8) return;
      seen.add(s.id); s.depth = depth; ordered.push(s);
      for (const k of (kids.get(s.id) || [])) walk(k, depth + 1);
    };
    for (const s of sessions) {
      const p = (s.parentSessionId && byId.has(s.parentSessionId) && s.parentSessionId !== s.id) ? s.parentSessionId : null;
      if (!p) walk(s, 0);
    }
    for (const s of sessions) if (!seen.has(s.id)) walk(s, 0); // orphaned cycles
    sessions.length = 0; sessions.push(...ordered);
    projects.push({ roadmapId: e.id, name, dir: e.dir, sessions });
  }
  sendJson(res, 200, { rev: revParts.join("-"), projects });
}

// POST /api/sessions/resume {roadmapId, sessionId, autonomy?} — central only.
function handleSessionsResume(res, payload) {
  const { config } = computeEffectiveConfig();
  const roadmapId = payload && payload.roadmapId;
  const sessionId = payload && payload.sessionId;
  const autonomy = !!(payload && payload.autonomy === true);
  if (typeof roadmapId !== "string" || !roadmapId || typeof sessionId !== "string" || !sessionId) {
    return sendJson(res, 400, { error: "E_VALIDATION", message: "roadmapId and sessionId required" });
  }
  if (!config.roster.allowSpawn) {
    return sendJson(res, 409, { error: "E_SPAWN_DISABLED", message: "spawning is off — enable roster.allowSpawn in Settings (the copy command still works)" });
  }
  // Guard against command injection through the session id.
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    return sendJson(res, 400, { error: "E_VALIDATION", message: "sessionId has unexpected characters" });
  }
  const r = resolveRoadmap(roadmapId);
  if (r.notFound) return sendJson(res, 404, { error: "not_found", message: `no roadmap ${roadmapId}` });
  const dir = r.ctx ? r.ctx.root : (r.dir || null);
  if (!dir) return sendJson(res, 404, { error: "E_MISSING_DIR", message: "roadmap dir not found" });
  // C1 — GATE POINT 5a of 5. Resuming a session is housekeeping, not road work:
  // it re-opens a window, it does not commit to a milestone. So it declares
  // itself a chore, passes the gate on that basis, and is counted in the chore
  // ledger where the coverage line can see it.
  const gate = assertLinkedOrChore({ ctx: r.ctx, chore: true });
  if (!gate.ok) return sendJson(res, 409, { error: "E_UNLINKED", message: gate.message });
  ledgerChore(r.ctx, { source: "session", ref: sessionId, kind: "launch", label: "resumed a session window on this road" });

  const inner = `cd '${String(dir).replace(/'/g, "''")}'; claude --resume ${sessionId}` + (autonomy ? " --dangerously-skip-permissions" : "");
  try {
    const child = spawn("cmd", ["/c", "start", "powershell", "-NoExit", "-Command", inner], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
  } catch (err) {
    return sendJson(res, 500, { error: "E_IO", message: err && err.message ? err.message : String(err) });
  }
  sendJson(res, 200, { ok: true, roadmapId, sessionId, autonomy });
}

// ---------------------------------------------------------------------------
// ARCHAEOLOGY (Wave-2) — GET /api/archaeology/<roadId>/<milestoneId>.
// Board-side provenance for one milestone: which AI sessions touched it (scanned
// once from history.jsonl), OPTIONALLY joined to real git commits via the
// config-gated `archaeology.repoPaths` key. Zero npm deps: git is the system
// binary, spawned read-only (git log never mutates), only when repoPaths is set.
//   * absent/empty archaeology.repoPaths  => the `commits` key is OMITTED, 200.
//   * git binary unavailable / all repos fail => `commits` OMITTED, still 200.
//   * repoPaths set + git works            => `commits` present (matched rows).
// Cached briefly like RAIDS_CACHE, keyed by road+milestone+rev+repoPaths.
// ---------------------------------------------------------------------------
const ARCH_TTL_MS = 5000;
const ARCH_CACHE = new Map(); // compositeKey -> { at:ms, value }

// Scan the ledger once and group the matching, session-stamped events by
// sessionId. An event matches when its targetId is the milestone itself, one of
// the milestone's items, or a decision that relates to the milestone. Events
// without a sessionId are excluded (a session must have stamped an event).
function scanArchaeologySessions(ctx, mid) {
  const roadmap = readJson(ctx.files.roadmap, () => emptyRoadmap(ctx.root));
  const decisionsData = readJson(ctx.files.decisions, emptyDecisions);
  const items = Array.isArray(roadmap.items) ? roadmap.items : [];
  const decs = Array.isArray(decisionsData.decisions) ? decisionsData.decisions : [];

  const targetSet = new Set([mid]);
  for (const it of items) {
    if (it && it.milestoneId === mid && typeof it.id === "string") targetSet.add(it.id);
  }
  for (const d of decs) {
    if (d && Array.isArray(d.relatedMilestoneIds) && d.relatedMilestoneIds.includes(mid) && typeof d.id === "string") targetSet.add(d.id);
  }

  const sessData = readJson(ctx.files.sessions, emptySessions);
  const labelById = new Map();
  for (const s of (Array.isArray(sessData.sessions) ? sessData.sessions : [])) {
    if (s && typeof s.id === "string") labelById.set(s.id, typeof s.label === "string" ? s.label : "");
  }

  const groups = new Map(); // sessionId -> {sessionId,label,firstSeen,lastSeen,eventCount}
  let raw = "";
  try { raw = fs.readFileSync(ctx.files.history, "utf8"); } catch { raw = ""; }
  for (const line of raw.split("\n")) {
    const t = line.trim(); if (!t) continue;
    let e; try { e = JSON.parse(t); } catch { continue; }
    if (!e || typeof e !== "object") continue;
    if (!targetSet.has(e.targetId)) continue;
    const sid = (typeof e.sessionId === "string" && e.sessionId) ? e.sessionId : null;
    if (!sid) continue; // matching-but-anonymous events don't attribute
    const ts = (typeof e.ts === "string") ? e.ts : null;
    let g = groups.get(sid);
    if (!g) {
      g = { sessionId: sid, label: labelById.has(sid) ? labelById.get(sid) : "", firstSeen: ts, lastSeen: ts, eventCount: 0 };
      groups.set(sid, g);
    }
    g.eventCount++;
    if (ts) {
      if (!g.firstSeen || ts < g.firstSeen) g.firstSeen = ts;
      if (!g.lastSeen || ts > g.lastSeen) g.lastSeen = ts;
    }
  }
  const sessions = Array.from(groups.values());
  sessions.sort((a, b) => String(b.lastSeen || "").localeCompare(String(a.lastSeen || "")));
  return sessions;
}

// Pull the Claude-Session join key out of a commit body. Accepts the canonical
// trailer `Claude-Session: https://claude.ai/code/session_<id>` (id = the tail)
// and a bare `Claude-Session: <id>`. Returns the id iff it's in sessionSet.
function extractCommitSession(body, sessionSet) {
  for (const line of String(body || "").split(/\r?\n/)) {
    const m = line.match(/^\s*Claude-Session:\s*(.+?)\s*$/i);
    if (!m) continue;
    const val = m[1].trim();
    const um = val.match(/session_([A-Za-z0-9._-]+)/);
    const id = um ? um[1] : val;
    if (sessionSet.has(id)) return id;
    if (sessionSet.has(val)) return val;
  }
  return null;
}

// Read-only `git log` over one repo, keeping only commits whose Claude-Session
// trailer names a session in sessionSet. Returns an array on success (possibly
// empty) or null when git itself could not run (binary missing / spawn error /
// not a git repo) so the caller can decide whether to omit `commits`.
function gitCommitsForSessions(repo, sessionSet) {
  try { if (!fs.statSync(repo).isDirectory()) return null; } catch { return null; }
  let r;
  try {
    r = spawnSync("git", ["-C", repo, "log", "--no-color", "--format=%H%x1f%s%x1f%cI%x1f%B%x1e", "-n", "4000"], {
      encoding: "utf8", timeout: 8000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    });
  } catch { return null; }
  if (!r || r.error || r.status !== 0 || typeof r.stdout !== "string") return null;
  const commits = [];
  for (const rec of r.stdout.split("\x1e")) {
    const t = rec.replace(/^[\r\n]+/, "");
    if (!t.trim()) continue;
    const parts = t.split("\x1f");
    if (parts.length < 4) continue;
    const hash = (parts[0] || "").trim();
    if (!/^[0-9a-f]{7,40}$/.test(hash)) continue;
    const sid = extractCommitSession(parts[3], sessionSet);
    if (!sid) continue;
    commits.push({ hash, subject: (parts[1] || "").trim(), ts: (parts[2] || "").trim(), sessionId: sid, repo });
  }
  return commits;
}

// GET /api/archaeology/<roadId>/<milestoneId>. ctx is already resolved by the
// router (DIR_CTX in dir mode, the registry-resolved ctx in central mode).
function handleArchaeology(res, ctx, id, mid) {
  const rev = computeRev(ctx);
  const { config } = computeEffectiveConfig();
  const repoPaths = config.archaeology.repoPaths;
  // Joined on U+0000, impossible inside an id or a path. Written as an escape,
  // never a raw byte: a raw NUL makes git and file(1) call this file binary.
  const cacheKey = [id, mid, rev, repoPaths.join("|")].join("\u0000");
  const now = Date.now();
  const hit = ARCH_CACHE.get(cacheKey);
  if (hit && (now - hit.at) < ARCH_TTL_MS) return sendJson(res, 200, hit.value);

  const sessions = scanArchaeologySessions(ctx, mid);
  const value = { rev, milestoneId: mid, sessions };

  if (repoPaths.length) {
    const sessionSet = new Set(sessions.map((s) => s.sessionId));
    if (sessionSet.size === 0) {
      value.commits = []; // config-gated on, nothing to match — key present, empty
    } else {
      let commits = [];
      let anyGitRan = false;
      for (const repo of repoPaths) {
        let rows = null;
        try { rows = gitCommitsForSessions(path.resolve(repo), sessionSet); } catch { rows = null; }
        if (rows === null) continue; // git failed for this repo — don't count it
        anyGitRan = true;
        commits = commits.concat(rows);
      }
      if (anyGitRan) {
        commits.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
        value.commits = commits;
      }
      // else: git never ran successfully anywhere => omit `commits` (still 200)
    }
  }

  ARCH_CACHE.set(cacheKey, { at: now, value });
  if (ARCH_CACHE.size > 128) { const k = ARCH_CACHE.keys().next().value; ARCH_CACHE.delete(k); }
  sendJson(res, 200, value);
}

// ---------------------------------------------------------------------------
// HORIZON REQUESTS (F2, dec-horizon-tree) — POST /api/request-suggestions
//   { milestoneId, sessionId? }
// The founder commissions a fresh horizon generation at an anchor. ZERO LLM in
// the server (the zero-dep invariant): this only records the ask. The agent
// path already exists — suggestions_upsert drains the request and clears the
// marker. The marker lives in suggestions.json's additive `requests` array, so
// a road that has never been asked has no new bytes at all.
// ---------------------------------------------------------------------------
function handleRequestSuggestions(res, ctx, payload) {
  const milestoneId = payload && payload.milestoneId;
  const sessionId = extractSessionId(payload);
  if (typeof milestoneId !== "string" || !milestoneId) {
    return sendJson(res, 400, { error: "E_VALIDATION", message: "milestoneId (string) required" });
  }
  // C1 — GATE POINT 4 of 5. The request IS the anchor: it records a milestoneId,
  // and nothing may be generated for an anchor that does not resolve. The drain
  // that answers this request (suggestions_upsert, or any future spawn) inherits
  // the same anchor, so the gate holds for the whole chain.
  const gate = assertLinkedOrChore({ ctx, milestoneId });
  if (!gate.ok) return sendJson(res, 404, { error: "not_found", message: `no milestone ${milestoneId}` });

  let result;
  try {
    result = withLock(ctx, () => {
      const roadmap = readJson(ctx.files.roadmap, () => emptyRoadmap(ctx.root));
      const ms = (roadmap.milestones || []).find((m) => m && m.id === milestoneId);
      if (!ms) return { notFound: true };
      const data = readJson(ctx.files.suggestions, emptySuggestions);
      data.schemaVersion = 1;
      if (!Array.isArray(data.suggestions)) data.suggestions = [];
      if (!Array.isArray(data.requests)) data.requests = [];
      const ts = nowIso();
      let req = data.requests.find((r) => r && r.milestoneId === milestoneId);
      let fresh = false;
      if (req) {
        req.requestedAt = ts;                      // asking twice re-stamps, never duplicates
        if (sessionId) req.sessionId = sessionId;
      } else {
        req = { id: genId("rq"), milestoneId, requestedAt: ts };
        if (sessionId) req.sessionId = sessionId;
        data.requests.push(req);
        fresh = true;
      }
      atomicWrite(ctx.files.suggestions, data);
      const evt = {
        id: genId("evt"), ts, actor: "founder", source: "ui", action: "suggestion_request",
        targetId: milestoneId,
        summary: `Founder asked for fresh horizons at "${ms.title || milestoneId}"`,
        patch: { requestId: req.id, fresh },
      };
      if (sessionId) evt.sessionId = sessionId;
      appendHistory(ctx, evt);
      if (sessionId) upsertSession(ctx, sessionId, undefined, 1);
      return { request: req, fresh };
    });
  } catch (err) {
    return sendJson(res, 500, { error: err.code || "E_IO", message: err.message });
  }
  if (result.notFound) return sendJson(res, 404, { error: "not_found", message: `no milestone ${milestoneId}` });
  sendJson(res, 200, result);
}

// ---------------------------------------------------------------------------
// PROMOTE / DEMOTE (F3, dec-promotion-controls)
//
// DOCTRINE (unchanged, enforced in UI copy): same goal stays inline; an own
// definition of done earns its own map.
//
// PROMOTE order is the crash-safety order, and it is not negotiable:
//   1. write the child road    2. verify it reads back
//   3. rewrite the parent      4. registry origin edge
//   5. history on both roads + a decision_log entry
// A crash anywhere before (3) leaves the ORIGINAL parent completely intact —
// the worst case is an unreferenced folder, never a hole in the parent.
// DEMOTE is the mirror: build the whole inline payload first, and only then
// rewrite the parent, drop the registry entry, and log both sides.
// ---------------------------------------------------------------------------

// Every quest in the subtree rooted at rootQuestId (a side quest and every
// nested branch hanging off ITS milestones), plus everything attached to them.
function collectQuestSubtree(rm, rootQuestId) {
  const quests = Array.isArray(rm.quests) ? rm.quests : [];
  const milestones = Array.isArray(rm.milestones) ? rm.milestones : [];
  const questIds = new Set([rootQuestId]);
  for (let guard = 0; guard < 64; guard++) {
    let grew = false;
    for (const q of quests) {
      if (!q || questIds.has(q.id) || q.type !== "side") continue;
      const pm = milestones.find((m) => m && m.id === q.parentMilestoneId);
      if (pm && questIds.has(pm.questId)) { questIds.add(q.id); grew = true; }
    }
    if (!grew) break;
  }
  const ms = milestones.filter((m) => m && questIds.has(m.questId));
  const msIds = new Set(ms.map((m) => m.id));
  const items = (Array.isArray(rm.items) ? rm.items : []).filter((it) => it && msIds.has(it.milestoneId));
  const assets = (Array.isArray(rm.assets) ? rm.assets : []).filter((a) => a && msIds.has(a.milestoneId));
  return { questIds, milestones: ms, msIds, items, assets };
}

function registryEntryForDir(dir) {
  const resolved = path.resolve(dir);
  const reg = readRegistry();
  return (reg.roadmaps || []).find((e) => e && typeof e.dir === "string" && sameDir(path.resolve(e.dir), resolved)) || null;
}
function registryEntryById(id) {
  const reg = readRegistry();
  return (reg.roadmaps || []).find((e) => e && e.id === id) || null;
}
// Reject a self-edge and any cycle up the parent chain (same rule as the MCP
// registry tools — a promotion births a child, never a loop).
function originWouldCycle(reg, childId, parentId) {
  if (childId === parentId) return true;
  const byId = new Map((reg.roadmaps || []).filter((e) => e && e.id).map((e) => [e.id, e]));
  let cur = parentId;
  for (let guard = 0; guard < 64 && cur; guard++) {
    if (cur === childId) return true;
    const e = byId.get(cur);
    cur = (e && e.origin && e.origin.roadmapId) || null;
  }
  return false;
}
// Registry write for the promotion edge. Own lock, never nested inside a
// roadmap lock (both promote and demote call this OUTSIDE withLock).
function registryUpsertWithOrigin(childDir, parentRmId, portalMsId) {
  const entry = upsertRegistryEntry(childDir);      // takes + releases the registry lock
  acquireRegistryLock();
  try {
    const reg = readRegistry();
    if (!Array.isArray(reg.roadmaps)) reg.roadmaps = [];
    const e = reg.roadmaps.find((x) => x && x.id === entry.id);
    if (!e) throw Object.assign(new Error("registry entry vanished"), { code: "E_IO" });
    if (!reg.roadmaps.some((x) => x && x.id === parentRmId)) {
      throw Object.assign(new Error(`parent ${parentRmId} is not in the registry`), { code: "E_VALIDATION" });
    }
    if (originWouldCycle(reg, e.id, parentRmId)) {
      throw Object.assign(new Error("that promotion would create a cycle in the family tree"), { code: "E_VALIDATION" });
    }
    e.origin = { roadmapId: parentRmId, milestoneId: portalMsId, ts: nowIso() };
    e.lastSeenAt = nowIso();
    reg.schemaVersion = 1;
    atomicWrite(registryPath(), reg);
    return e;
  } finally {
    releaseRegistryLock();
  }
}
function registryRemoveById(id) {
  acquireRegistryLock();
  try {
    const reg = readRegistry();
    if (!Array.isArray(reg.roadmaps)) reg.roadmaps = [];
    const i = reg.roadmaps.findIndex((e) => e && e.id === id);
    if (i === -1) return null;
    const removed = reg.roadmaps[i];
    reg.roadmaps.splice(i, 1);
    reg.schemaVersion = 1;
    atomicWrite(registryPath(), reg);
    return removed;
  } finally {
    releaseRegistryLock();
  }
}

// POST /api/promote  { questId, targetDir, sessionId? }  (parent = ctx)
function handlePromote(res, ctx, parentRmIdHint, payload) {
  const questId = payload && payload.questId;
  const targetDir = payload && payload.targetDir;
  const sessionId = extractSessionId(payload);
  if (typeof questId !== "string" || !questId || typeof targetDir !== "string" || !targetDir.trim()) {
    return sendJson(res, 400, { error: "E_VALIDATION", message: "questId and targetDir required" });
  }
  const childRoot = path.resolve(targetDir.trim());
  const parentEntry = parentRmIdHint ? registryEntryById(parentRmIdHint) : registryEntryForDir(ctx.root);
  if (!parentEntry) {
    return sendJson(res, 409, { error: "E_NOT_REGISTERED", message: "this road is not in the registry, so a child cannot record its origin" });
  }
  if (sameDir(childRoot, path.resolve(ctx.root))) {
    return sendJson(res, 400, { error: "E_VALIDATION", message: "a road cannot be promoted into its own folder" });
  }
  const existing = registryEntryForDir(childRoot);
  if (existing) {
    return sendJson(res, 409, { error: "E_EXISTS", message: `${childRoot} is already a registered road (${existing.id})` });
  }
  if (isRefusedRegistryPath(childRoot)) {
    return sendJson(res, 400, { error: "E_TEMP_PATH", message: `refusing a temp/scratch path: ${childRoot}` });
  }

  const ts = nowIso();
  const rm = readJson(ctx.files.roadmap, () => emptyRoadmap(ctx.root));
  const quest = (rm.quests || []).find((q) => q && q.id === questId);
  if (!quest) return sendJson(res, 404, { error: "not_found", message: `no quest ${questId}` });
  if (quest.type !== "side") return sendJson(res, 400, { error: "E_VALIDATION", message: "only a side quest can be promoted (the main road IS this map)" });
  const sub = collectQuestSubtree(rm, questId);
  if (sub.milestones.length === 0) {
    return sendJson(res, 400, { error: "E_VALIDATION", message: "that side quest has no milestones — nothing to promote" });
  }

  // ---- (1) write the child road -------------------------------------------
  const childCtx = makeCtx(childRoot);
  const portalMsId = genId("ms");
  const sugAll = readJson(ctx.files.suggestions, emptySuggestions);
  const movedSug = (Array.isArray(sugAll.suggestions) ? sugAll.suggestions : []).filter((s) => s && sub.msIds.has(s.frontierMilestoneId));
  const movedReq = (Array.isArray(sugAll.requests) ? sugAll.requests : []).filter((r) => r && sub.msIds.has(r.milestoneId));
  try {
    ensureDataDir(childCtx);
    const childQuests = [];
    for (const q of rm.quests || []) {
      if (!q || !sub.questIds.has(q.id)) continue;
      if (q.id === questId) {
        childQuests.push(Object.assign({}, q, { type: "main", parentMilestoneId: null, side: null, order: 0, updatedAt: ts }));
      } else {
        childQuests.push(Object.assign({}, q, { updatedAt: q.updatedAt || ts }));
      }
    }
    const childRm = {
      schemaVersion: 1,
      project: {
        name: quest.title || path.basename(childRoot),
        tagline: (rm.project && rm.project.name) ? `Promoted out of ${rm.project.name}` : "",
        createdAt: ts, updatedAt: ts,
      },
      quests: childQuests,
      milestones: sub.milestones.map((m) => Object.assign({}, m)),
      items: sub.items.map((it) => Object.assign({}, it)),
      assets: sub.assets.map((a) => Object.assign({}, a)),
    };
    withLock(childCtx, () => {
      atomicWrite(childCtx.files.roadmap, childRm);
      if (movedSug.length || movedReq.length) {
        const cs = { schemaVersion: 1, suggestions: movedSug.map((s) => Object.assign({}, s)) };
        if (movedReq.length) cs.requests = movedReq.map((r) => Object.assign({}, r));
        atomicWrite(childCtx.files.suggestions, cs);
      }
      const evt = {
        id: genId("evt"), ts, actor: "founder", source: "ui", action: "promote",
        targetId: portalMsId,
        summary: `This road was promoted out of "${(rm.project && rm.project.name) || parentEntry.name}" (side quest "${quest.title || questId}")`,
        patch: { parentRoadmapId: parentEntry.id, portalMilestoneId: portalMsId, milestones: sub.milestones.length },
      };
      if (sessionId) evt.sessionId = sessionId;
      appendHistory(childCtx, evt);
      if (sessionId) upsertSession(childCtx, sessionId, undefined, 1);
    });
  } catch (err) {
    return sendJson(res, 500, { error: err.code || "E_IO", message: `could not write the child road: ${err.message}` });
  }

  // ---- (2) verify the child reads back ------------------------------------
  {
    const back = readJson(childCtx.files.roadmap, () => null);
    const ok = back && Array.isArray(back.milestones) && back.milestones.length === sub.milestones.length &&
      sub.milestones.every((m) => back.milestones.some((x) => x && x.id === m.id));
    if (!ok) {
      return sendJson(res, 500, { error: "E_IO", message: "the child road did not read back intact — the parent was NOT touched" });
    }
  }

  // ---- (3) rewrite the parent: the subtree collapses to ONE portal --------
  let portalMs = null;
  try {
    withLock(ctx, () => {
      const cur = readJson(ctx.files.roadmap, () => emptyRoadmap(ctx.root));
      cur.quests = (cur.quests || []).filter((q) => q && (!sub.questIds.has(q.id) || q.id === questId));
      cur.milestones = (cur.milestones || []).filter((m) => m && !sub.msIds.has(m.id));
      cur.items = (cur.items || []).filter((it) => it && !sub.msIds.has(it.milestoneId));
      cur.assets = (cur.assets || []).filter((a) => a && !sub.msIds.has(a.milestoneId));
      portalMs = {
        id: portalMsId, questId: questId, order: 0,
        title: quest.title || "Promoted road", summary: "",
        status: "in_progress", statusReason: "", eta: null,
        startedAt: null, completedAt: null, createdAt: ts, updatedAt: ts,
        plain: "This branch grew its own finish line, so it became its own map. Open it to see the work.",
      };
      cur.milestones.push(portalMs);
      const q = cur.quests.find((x) => x && x.id === questId);
      if (q) q.updatedAt = ts;
      if (cur.project) cur.project.updatedAt = ts;
      atomicWrite(ctx.files.roadmap, cur);

      // suggestions that travelled with the milestones leave the parent
      const sg = readJson(ctx.files.suggestions, emptySuggestions);
      if (Array.isArray(sg.suggestions)) {
        sg.schemaVersion = 1;
        sg.suggestions = sg.suggestions.filter((s) => s && !sub.msIds.has(s.frontierMilestoneId));
        if (Array.isArray(sg.requests)) {
          sg.requests = sg.requests.filter((r) => r && !sub.msIds.has(r.milestoneId));
          if (sg.requests.length === 0) delete sg.requests;
        }
        atomicWrite(ctx.files.suggestions, sg);
      }

      // (5a) decision_log entry on the parent — the ruling that was applied
      const decs = readJson(ctx.files.decisions, emptyDecisions);
      if (!Array.isArray(decs.decisions)) decs.decisions = [];
      decs.schemaVersion = 1;
      decs.decisions.push({
        id: genId("dec"), ts,
        title: `Promoted "${quest.title || questId}" into its own road`,
        rationale: "Same goal stays inline; an own definition of done earns its own map. This branch had its own finish line.",
        impact: `${sub.milestones.length} milestone(s) moved to ${childRoot}. The branch now shows as one doorway on this road.`,
        relatedMilestoneIds: [portalMsId],
        proposedBy: "founder", approved: true, approvedAt: ts, status: "approved", supersededBy: null,
        plain: "We split this branch out into its own map because it had its own finish line. The old branch is now a single door you can walk through.",
      });
      atomicWrite(ctx.files.decisions, decs);
    });
  } catch (err) {
    return sendJson(res, 500, { error: err.code || "E_IO", message: `parent rewrite failed: ${err.message}` });
  }

  // ---- (4) registry: the child + its origin edge ---------------------------
  let childEntry = null;
  try {
    childEntry = registryUpsertWithOrigin(childRoot, parentEntry.id, portalMsId);
  } catch (err) {
    return sendJson(res, 500, {
      error: err.code || "E_IO",
      message: `the roads are written but the registry edge failed: ${err.message}`,
      portalMilestoneId: portalMsId, childDir: childRoot,
    });
  }

  // ---- (5b) history on the parent -----------------------------------------
  try {
    withLock(ctx, () => {
      const evt = {
        id: genId("evt"), ts: nowIso(), actor: "founder", source: "ui", action: "promote",
        targetId: portalMsId,
        summary: `Promoted side quest "${quest.title || questId}" into its own road "${childEntry.name}"`,
        patch: { childRoadmapId: childEntry.id, childDir: childRoot, milestones: sub.milestones.length },
      };
      if (sessionId) evt.sessionId = sessionId;
      appendHistory(ctx, evt);
      if (sessionId) upsertSession(ctx, sessionId, undefined, 1);
    });
  } catch { /* the move is done; a history append failure must not undo it */ }

  sendJson(res, 200, {
    ok: true, childId: childEntry.id, childName: childEntry.name, childDir: childRoot,
    portalMilestoneId: portalMsId, questId, movedMilestones: sub.milestones.length,
  });
}

// POST /api/demote  { childId, sessionId? }  — dissolve a child road back inline.
function handleDemote(res, payload) {
  const childId = payload && payload.childId;
  const sessionId = extractSessionId(payload);
  if (typeof childId !== "string" || !childId) {
    return sendJson(res, 400, { error: "E_VALIDATION", message: "childId (string) required" });
  }
  const reg = readRegistry();
  const childEntry = (reg.roadmaps || []).find((e) => e && e.id === childId);
  if (!childEntry) return sendJson(res, 404, { error: "not_found", message: `no roadmap ${childId}` });
  // ORPHAN REFUSAL: a road with children of its own cannot dissolve — its
  // grandchildren would lose their parent.
  const grandkids = (reg.roadmaps || []).filter((e) => e && e.origin && e.origin.roadmapId === childId);
  if (grandkids.length) {
    return sendJson(res, 409, {
      error: "E_HAS_CHILDREN",
      message: `${childId} has ${grandkids.length} child road(s) of its own — demote them first`,
      children: grandkids.map((e) => e.id),
    });
  }
  const origin = childEntry.origin;
  if (!origin || !origin.roadmapId || !origin.milestoneId) {
    return sendJson(res, 409, { error: "E_NO_ORIGIN", message: `${childId} is a root road — there is nothing to fold it back into` });
  }
  const parentEntry = (reg.roadmaps || []).find((e) => e && e.id === origin.roadmapId);
  if (!parentEntry) return sendJson(res, 404, { error: "not_found", message: `parent road ${origin.roadmapId} is not in the registry` });
  const parentRoot = path.resolve(parentEntry.dir);
  const childRoot = path.resolve(childEntry.dir);
  if (!fs.existsSync(parentRoot)) return sendJson(res, 404, { error: "E_MISSING_DIR", message: `parent dir not found: ${parentRoot}` });
  if (!fs.existsSync(childRoot)) return sendJson(res, 404, { error: "E_MISSING_DIR", message: `child dir not found: ${childRoot}` });
  const parentCtx = makeCtx(parentRoot), childCtx = makeCtx(childRoot);

  const prm = readJson(parentCtx.files.roadmap, () => null);
  const crm = readJson(childCtx.files.roadmap, () => null);
  if (!prm || !crm) return sendJson(res, 500, { error: "E_IO", message: "could not read both roads" });
  const portal = (prm.milestones || []).find((m) => m && m.id === origin.milestoneId);
  if (!portal) return sendJson(res, 404, { error: "not_found", message: `portal milestone ${origin.milestoneId} is gone from the parent` });
  const hostQuest = (prm.quests || []).find((q) => q && q.id === portal.questId);
  if (!hostQuest) return sendJson(res, 500, { error: "E_IO", message: "the portal milestone has no quest" });

  // ---- build the WHOLE inline payload before the parent is touched --------
  const cMain = (crm.quests || []).find((q) => q && q.type === "main") || (crm.quests || [])[0] || null;
  if (!cMain) return sendJson(res, 500, { error: "E_IO", message: "the child road has no main quest" });
  const ts = nowIso();
  const inlineQuests = [];
  for (const q of crm.quests || []) {
    if (!q || q.id === cMain.id) continue;
    inlineQuests.push(Object.assign({}, q, { type: "side", updatedAt: ts }));
  }
  // The child's MAIN quest re-inlines as the host side quest (ids preserved):
  // its milestones simply become that quest's milestones again.
  const inlineMs = (crm.milestones || []).map((m) => Object.assign({}, m, {
    questId: (m.questId === cMain.id) ? hostQuest.id : m.questId,
  }));
  const inlineMsIds = new Set(inlineMs.map((m) => m.id));
  const inlineItems = (crm.items || []).filter((it) => it && inlineMsIds.has(it.milestoneId)).map((it) => Object.assign({}, it));
  const inlineAssets = (crm.assets || []).filter((a) => a && inlineMsIds.has(a.milestoneId)).map((a) => Object.assign({}, a));
  const csug = readJson(childCtx.files.suggestions, emptySuggestions);
  const inlineSug = (Array.isArray(csug.suggestions) ? csug.suggestions : [])
    .filter((s) => s && inlineMsIds.has(s.frontierMilestoneId))
    .map((s) => Object.assign({}, s, { questId: (s.questId === cMain.id) ? hostQuest.id : s.questId }));
  const inlineReq = (Array.isArray(csug.requests) ? csug.requests : [])
    .filter((r) => r && inlineMsIds.has(r.milestoneId)).map((r) => Object.assign({}, r));
  // id collision guard — nothing may land on top of parent data
  const pIds = new Set((prm.milestones || []).map((m) => m && m.id));
  const clash = inlineMs.filter((m) => pIds.has(m.id) && m.id !== portal.id);
  if (clash.length) {
    return sendJson(res, 409, { error: "E_ID_CLASH", message: `milestone id(s) already on the parent: ${clash.slice(0, 3).map((m) => m.id).join(", ")}` });
  }

  // ---- rewrite the parent (payload is complete) ---------------------------
  try {
    withLock(parentCtx, () => {
      const cur = readJson(parentCtx.files.roadmap, () => emptyRoadmap(parentCtx.root));
      cur.milestones = (cur.milestones || []).filter((m) => m && m.id !== portal.id);
      cur.items = (cur.items || []).filter((it) => it && it.milestoneId !== portal.id);
      cur.assets = (cur.assets || []).filter((a) => a && a.milestoneId !== portal.id);
      cur.quests = (cur.quests || []).concat(inlineQuests);
      cur.milestones = cur.milestones.concat(inlineMs);
      cur.items = (cur.items || []).concat(inlineItems);
      cur.assets = (cur.assets || []).concat(inlineAssets);
      const hq = cur.quests.find((q) => q && q.id === hostQuest.id);
      if (hq) { hq.type = "side"; hq.updatedAt = ts; }
      if (cur.project) cur.project.updatedAt = ts;
      atomicWrite(parentCtx.files.roadmap, cur);

      if (inlineSug.length || inlineReq.length) {
        const sg = readJson(parentCtx.files.suggestions, emptySuggestions);
        sg.schemaVersion = 1;
        if (!Array.isArray(sg.suggestions)) sg.suggestions = [];
        const have = new Set(sg.suggestions.map((s) => s && s.id));
        sg.suggestions = sg.suggestions.concat(inlineSug.filter((s) => !have.has(s.id)));
        if (inlineReq.length) {
          if (!Array.isArray(sg.requests)) sg.requests = [];
          const haveR = new Set(sg.requests.map((r) => r && r.id));
          sg.requests = sg.requests.concat(inlineReq.filter((r) => !haveR.has(r.id)));
        }
        atomicWrite(parentCtx.files.suggestions, sg);
      }

      // The portal milestone is gone, so nothing may still point at it: strip it
      // from every decision's relatedMilestoneIds, supersede the promotion
      // ruling it belonged to, and record the reversal. No dangling reference
      // survives a round trip — that is what "no orphaned data" means here.
      {
        const decs = readJson(parentCtx.files.decisions, emptyDecisions);
        if (!Array.isArray(decs.decisions)) decs.decisions = [];
        decs.schemaVersion = 1;
        const newDecId = genId("dec");
        const touched = [];
        for (const d of decs.decisions) {
          if (!d || !Array.isArray(d.relatedMilestoneIds)) continue;
          if (!d.relatedMilestoneIds.includes(portal.id)) continue;
          d.relatedMilestoneIds = d.relatedMilestoneIds.filter((x) => x !== portal.id);
          // The ruling WAS made and WAS approved — that stays true. supersededBy
          // is how the log says "and this later ruling replaced it"; rewriting
          // status would falsify the record.
          d.supersededBy = newDecId;
          touched.push(d.id);
        }
        decs.decisions.push({
          id: newDecId, ts,
          title: `Dissolved "${childEntry.name}" back into "${hostQuest.title || hostQuest.id}"`,
          rationale: "It turned out to share this road's definition of done, so it belongs inline. Same goal stays inline; an own definition of done earns its own map.",
          impact: `${inlineMs.length} milestone(s) returned to this road as a side quest. The doorway and the family-tree link are gone; the old folder is kept as an archive.`,
          relatedMilestoneIds: inlineMs.slice(0, 12).map((m) => m.id),
          proposedBy: "founder", approved: true, approvedAt: ts, status: "approved", supersededBy: null,
          plain: "We folded that separate map back into this road. Its steps are a branch here again, and the door it used to sit behind is gone.",
        });
        atomicWrite(parentCtx.files.decisions, decs);
        if (touched.length && sessionId) { /* attribution is carried by the event below */ }
      }

      const evt = {
        id: genId("evt"), ts, actor: "founder", source: "ui", action: "demote",
        targetId: hostQuest.id,
        summary: `Dissolved road "${childEntry.name}" back into side quest "${hostQuest.title || hostQuest.id}"`,
        patch: { childRoadmapId: childId, portalMilestoneId: portal.id, milestones: inlineMs.length },
      };
      if (sessionId) evt.sessionId = sessionId;
      appendHistory(parentCtx, evt);
      if (sessionId) upsertSession(parentCtx, sessionId, undefined, 1);
    });
  } catch (err) {
    return sendJson(res, 500, { error: err.code || "E_IO", message: `parent rewrite failed — the child road is untouched: ${err.message}` });
  }

  // ---- registry: the edge and the entry go away ---------------------------
  let removed = null;
  try { removed = registryRemoveById(childId); }
  catch (err) { return sendJson(res, 500, { error: err.code || "E_IO", message: `data is back inline but the registry entry remains: ${err.message}` }); }

  // ---- history on the child side (its folder stays as an inert archive) ---
  try {
    withLock(childCtx, () => {
      const evt = {
        id: genId("evt"), ts: nowIso(), actor: "founder", source: "ui", action: "demote",
        targetId: null,
        summary: `This road was dissolved back into "${parentEntry.name}"; its milestones now live there. This folder is kept as an archive.`,
        patch: { parentRoadmapId: parentEntry.id, questId: hostQuest.id, milestones: inlineMs.length },
      };
      if (sessionId) evt.sessionId = sessionId;
      appendHistory(childCtx, evt);
    });
  } catch { /* the fold-back is done; a history append failure must not undo it */ }

  sendJson(res, 200, {
    ok: true, childId, parentId: parentEntry.id, questId: hostQuest.id,
    inlinedMilestones: inlineMs.length, portalMilestoneId: portal.id,
    registryRemoved: !!removed, childDirLeftOnDisk: childRoot,
  });
}

// ---------------------------------------------------------------------------
// Static: GET /  -> index.html
// ---------------------------------------------------------------------------
function serveIndex(res) {
  const file = path.join(__dirname, "index.html");
  fs.readFile(file, (err, buf) => {
    if (err) { sendJson(res, 500, { error: "E_IO", message: "index.html missing" }); return; }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": buf.length,
      "Cache-Control": "no-store",
    });
    res.end(buf);
  });
}

// The escape hatch's optional basis. It rides in the query string because the
// request BODY is the file — a baseRev in there would be written to disk.
function baseRevOf(req) {
  try { return new URL(req.url, "http://127.0.0.1").searchParams.get("baseRev"); }
  catch { return null; }
}

// ---------------------------------------------------------------------------
// Router — dir mode
// ---------------------------------------------------------------------------
async function routeDir(req, res, p, method) {
  const ctx = DIR_CTX;

  if (method === "GET" && (p === "/" || p === "/index.html")) return serveIndex(res);
  if (method === "GET" && p === "/api/state") return handleState(res, ctx);

  // Archaeology (dir mode): the single road IS this dir; roadId in the path is
  // accepted as-is and served against DIR_CTX (one road, no registry lookup).
  {
    const am = p.match(/^\/api\/archaeology\/([a-z0-9-]+)\/([^/]+)$/);
    if (method === "GET" && am) return handleArchaeology(res, ctx, am[1], decodeURIComponent(am[2]));
  }

  if (method === "POST" && p === "/api/note") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handleNote(res, ctx, pb.value);
  }
  if (method === "POST" && p === "/api/decision/approve") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handleDecisionApprove(res, ctx, pb.value);
  }
  if (method === "POST" && p === "/api/unclear") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handleUnclear(res, ctx, pb.value);
  }
  if (method === "POST" && p === "/api/delete") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handleDelete(res, ctx, pb.value);
  }
  // The founder's ruling on a held colliding write.
  if (method === "POST" && p === "/api/conflict/resolve") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handleConflictResolve(res, ctx, pb.value);
  }
  if (method === "POST" && p === "/api/dispatch") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handleDispatch(res, ctx, pb.value);
  }
  // F2 — commission a fresh horizon at an anchor (both modes).
  if (method === "POST" && p === "/api/request-suggestions") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handleRequestSuggestions(res, ctx, pb.value);
  }
  // F3 — promote a side quest out / dissolve a child back in. Both need the
  // registry, which dir mode also writes (this road auto-registers at startup).
  if (method === "POST" && p === "/api/promote") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handlePromote(res, ctx, null, pb.value);
  }
  if (method === "POST" && p === "/api/demote") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handleDemote(res, pb.value);
  }
  if (method === "POST" && p.startsWith("/api/file/")) {
    const name = decodeURIComponent(p.slice("/api/file/".length));
    const raw = await readBody(req);
    return handleFilePut(res, ctx, name, raw, baseRevOf(req));
  }

  // /r/* and /api/registry are central-only → 404 here.
  return sendJson(res, 404, { error: "not_found" });
}

// ---------------------------------------------------------------------------
// Router — central mode
// ---------------------------------------------------------------------------
async function routeCentral(req, res, p, method) {
  // Static: overworld and road views both render index.html; client routes.
  if (method === "GET" && p === "/") return serveIndex(res);
  if (method === "GET" && /^\/r\/[a-z0-9-]+$/.test(p)) return serveIndex(res);
  if (method === "GET" && p === "/api/registry") return handleRegistry(res);
  if (method === "POST" && p === "/api/registry/unregister") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handleUnregister(res, pb.value);
  }
  if (method === "GET" && p === "/api/sessions") return handleSessionsRoster(res);
  if (method === "POST" && p === "/api/sessions/resume") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handleSessionsResume(res, pb.value);
  }
  // F3 — demote names the CHILD road, so it is registry-scoped, not road-scoped
  // (the id-scoped alias below works too, for a UI that only knows API_PREFIX).
  if (method === "POST" && p === "/api/demote") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handleDemote(res, pb.value);
  }

  // Archaeology (central mode): roadId resolved via the registry, same as /r/*.
  {
    const am = p.match(/^\/api\/archaeology\/([a-z0-9-]+)\/([^/]+)$/);
    if (method === "GET" && am) {
      const aid = am[1];
      const mid = decodeURIComponent(am[2]);
      const r = resolveRoadmap(aid);
      if (r.notFound) return sendJson(res, 404, { error: "not_found", message: `no roadmap ${aid}` });
      if (r.missing) return sendJson(res, 404, { error: "E_MISSING_DIR", message: `registered dir not found: ${r.dir}` });
      return handleArchaeology(res, r.ctx, aid, mid);
    }
  }

  // Per-roadmap id-scoped API.
  const m = p.match(/^\/api\/r\/([a-z0-9-]+)(\/.*)?$/);
  if (m) {
    const id = m[1];
    const rest = m[2] || "";
    return await routeScoped(req, res, method, id, rest);
  }

  return sendJson(res, 404, { error: "not_found" });
}

async function routeScoped(req, res, method, id, rest) {
  const r = resolveRoadmap(id);
  if (r.notFound) return sendJson(res, 404, { error: "not_found", message: `no roadmap ${id}` });
  if (r.missing) return sendJson(res, 404, { error: "E_MISSING_DIR", message: `registered dir not found: ${r.dir}` });
  const ctx = r.ctx;

  if (method === "GET" && rest === "/state") return handleStateCentral(res, ctx, id);

  if (method === "POST" && rest === "/note") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handleNote(res, ctx, pb.value);
  }
  if (method === "POST" && rest === "/decision/approve") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handleDecisionApprove(res, ctx, pb.value);
  }
  if (method === "POST" && rest === "/unclear") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handleUnclear(res, ctx, pb.value);
  }
  if (method === "POST" && rest === "/delete") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handleDelete(res, ctx, pb.value);
  }
  // The founder's ruling on a held colliding write.
  if (method === "POST" && rest === "/conflict/resolve") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handleConflictResolve(res, ctx, pb.value);
  }
  if (method === "POST" && rest === "/dispatch") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handleDispatch(res, ctx, pb.value);
  }
  if (method === "POST" && rest === "/request-suggestions") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handleRequestSuggestions(res, ctx, pb.value);
  }
  if (method === "POST" && rest === "/promote") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handlePromote(res, ctx, id, pb.value);
  }
  if (method === "POST" && rest === "/demote") {
    const pb = await readAndParse(req, res); if (!pb) return;
    return handleDemote(res, pb.value);
  }
  if (method === "POST" && rest.startsWith("/file/")) {
    const name = decodeURIComponent(rest.slice("/file/".length));
    const raw = await readBody(req);
    return handleFilePut(res, ctx, name, raw, baseRevOf(req));
  }

  return sendJson(res, 404, { error: "not_found" });
}

// ---------------------------------------------------------------------------
// Router — top
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const method = req.method || "GET";

  try {
    // Boot probe + desktop-integration endpoints served by BOTH modes (the
    // launcher and settings panel must reach these in dir and central alike).
    if (method === "GET" && p === "/api/mode") return sendJson(res, 200, { mode: MODE });
    if (method === "GET" && p === "/api/version") return handleVersion(res);
    if (method === "GET" && p === "/api/raids") return handleRaids(res);
    if (method === "GET" && p === "/api/config") return handleConfigGet(res);
    if (method === "POST" && p === "/api/config") {
      const pb = await readAndParse(req, res); if (!pb) return;
      return handleConfigPost(res, pb.value);
    }
    // Wave 3 — skins / distillery / task board (app-global; both modes).
    if (method === "GET" && p === "/api/skins") return handleSkinsGet(res);
    if (method === "POST" && p === "/api/skins/apply") {
      const pb = await readAndParse(req, res); if (!pb) return;
      return handleSkinsApply(res, pb.value);
    }
    if (method === "POST" && p === "/api/distill") {
      const pb = await readAndParse(req, res); if (!pb) return;
      return await handleDistill(res, pb.value);
    }
    if (method === "GET" && p === "/api/taskboard") return handleTaskboardGet(res);
    if (method === "POST" && p === "/api/taskboard") {
      const pb = await readAndParse(req, res); if (!pb) return;
      return handleTaskboardPost(res, pb.value);
    }
    if (method === "POST" && p === "/api/shutdown") return handleShutdown(res);

    // Chat dock (B1) — top-level, served in BOTH modes (chats are per home).
    if (method === "POST" && p === "/api/chats") {
      const pb = await readAndParse(req, res); if (!pb) return;
      return chat.handleChatCreate(res, pb.value, CHAT_DEPS);
    }
    if (method === "GET" && p === "/api/chats") return chat.handleChatList(res, CHAT_DEPS);
    {
      const cm = p.match(/^\/api\/chat\/([^/]+)(\/send|\/stream)?$/);
      if (cm) {
        const cid = decodeURIComponent(cm[1]);
        const sub = cm[2] || "";
        if (method === "GET" && sub === "") return chat.handleChatGet(res, cid, CHAT_DEPS);
        if (method === "GET" && sub === "/stream") return chat.handleChatStream(req, res, cid, CHAT_DEPS);
        if (method === "POST" && sub === "/send") {
          const pb = await readAndParse(req, res); if (!pb) return;
          return chat.handleChatSend(res, cid, pb.value, CHAT_DEPS);
        }
      }
    }

    if (MODE === "dir") return await routeDir(req, res, p, method);
    return await routeCentral(req, res, p, method);
  } catch (err) {
    return sendJson(res, 500, { error: "E_IO", message: err && err.message ? err.message : String(err) });
  }
});

// TEST HOOK (G-A/G-B). QUESTLOG_NO_LISTEN=1 imports this module for its pure
// helpers WITHOUT opening a port, so chat.selftest.mjs can drive the
// real logSidecarRepair against a real road and then validate that road. It is
// never set in normal operation, and nothing else about the boot changes.
const NO_LISTEN = process.env.QUESTLOG_NO_LISTEN === "1";
export { logSidecarRepair, writeSidecarRepairNotice, sidecarNoticeMilestone, sidecarNoticeBody, sidecarNoticeNote, SIDECAR_NOTICE_TITLE, makeCtx };
// dec-currency-architecture — the launch gate and the two writers it guards,
// exported so a selftest can drive the REAL code path (with QUESTLOG_NO_LISTEN=1
// so importing this file opens no port).
export { assertLinkedOrChore, ledgerChore, writeEvidence, deriveCurrency, launchSidecarRepair, findRoadForMilestone, milestoneForTarget };

if (!NO_LISTEN) server.listen(PORT, "127.0.0.1", () => {
  if (MODE === "dir") {
    process.stderr.write(`QUESTLOG UI (dir mode) serving http://127.0.0.1:${PORT}  (project: ${PROJECT_ROOT})\n`);
    // Auto-register this project in the user-level registry (non-fatal).
    try {
      const entry = upsertRegistryEntry(PROJECT_ROOT);
      process.stderr.write(`QUESTLOG: registered "${entry.name}" as ${entry.id}\n`);
    } catch (err) {
      if (err && err.code === "E_TEMP_PATH") {
        process.stderr.write(`QUESTLOG: registry auto-register skipped: temp path (${PROJECT_ROOT})\n`);
      } else {
        process.stderr.write(`QUESTLOG: registry auto-register failed: ${err && err.message ? err.message : err}\n`);
      }
    }
  } else {
    process.stderr.write(`QUESTLOG UI (central mode) serving http://127.0.0.1:${PORT}  (registry: ${registryPath()})\n`);
  }
});
