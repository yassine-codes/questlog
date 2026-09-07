#!/usr/bin/env node
// QUESTLOG — "/btw" BRIDGE (prototype).
//
// When a founder leaves a note on a card or flags one unclear in the dashboard,
// this module can spin off a cheap headless Claude (Sonnet) run that reads the
// roadmap and updates that one card through the questlog MCP tools — no chat
// window, no per-action approval. It is the node-side mapping of the founder's
// "/btw" wish (see docs/bridge-design.md for the full feasibility architecture).
//
// Zero dependencies. Node builtins only. Same house style as server.mjs /
// mcp/server.mjs (no npm, no SDK — we spawn the already-installed `claude` CLI).
//
// CONTAINMENT (all mandatory — see the "Bridge" section of README.md / SKILL.md):
//   * OFF by default. Nothing runs unless QUESTLOG_BTW_BRIDGE=1.
//   * DRY-RUN is the default even when enabled. QUESTLOG_BTW_DRYRUN must be set
//     to "0" to actually spawn; otherwise every trigger only APPENDS a
//     "bridge-dryrun" line (the exact command it would run + the context
//     package path) to a log the founder can read, and spawns nothing.
//   * Single concurrent run. A second trigger while one is in flight re-arms the
//     debounce instead of starting a parallel spawn.
//   * Debounce. Rapid edits on the same card coalesce into one pass.
//   * Hard timeout. The child is killed (SIGTERM then SIGKILL) past the limit.
//   * Kill switch. A kill-switch file (default <dataDir>/bridge/KILL) aborts a
//     pending/next run and terminates an in-flight child.
//   * Nesting-env cleared, neutral cwd. The child is spawned with every
//     CLAUDE*/AI_AGENT/CODEX* env var stripped, from a throwaway temp dir.
//   * Writes scoped. --allowedTools whitelists ONLY the questlog MCP verbs the
//     task needs plus Read; --strict-mcp-config means the child sees ONLY the
//     questlog MCP server (pointed at the target .questlog), so its sole write
//     path is that server, which writes only inside <projectRoot>/.questlog/.
//   * Attributed. The task calls session_hello with a "bridge" label first, so
//     every write it makes is stamped into that road's sessions.json.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertLinkedOrChore, appendActivity } from "./currency.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Absolute path to the questlog MCP server (sibling of this file).
export const MCP_SERVER_PATH = path.join(__dirname, "mcp", "server.mjs");

// The session label every bridge run checks in with, so sessions.json can tell
// bridge-authored writes apart from a human session's.
export const BRIDGE_LABEL = "bridge";

// The narrowest workable write scope: the questlog MCP verbs a card-update pass
// needs, plus Read. NO Bash, NO Edit, NO Write, NO arbitrary fs tools. Combined
// with --strict-mcp-config this means the child's only mutation path is the
// questlog MCP server, which only ever writes inside the target .questlog dir.
export const DEFAULT_ALLOWED_TOOLS = [
  "mcp__questlog__session_hello",
  "mcp__questlog__roadmap_get",
  "mcp__questlog__list_unclear",
  "mcp__questlog__clear_unclear",
  "mcp__questlog__item_upsert",
  "mcp__questlog__item_note_add",
  "mcp__questlog__milestone_upsert",
  "mcp__questlog__milestone_set_status",
  "Read",
];

// ---------------------------------------------------------------------------
// Config file location (planner §1.1). config.json lives in the SAME directory
// as registry.json — homedir/.questlog by default, or the dir of a
// QUESTLOG_REGISTRY override (so a test that points the registry at a temp dir
// gets its config.json there too). These are pure path/read helpers; the write
// path (lock + atomic + autostart) lives entirely in server.mjs.
// ---------------------------------------------------------------------------
export function questlogHome(env = process.env) {
  const reg = env.QUESTLOG_REGISTRY;
  if (typeof reg === "string" && reg) return path.dirname(reg);
  return path.join(os.homedir(), ".questlog");
}
export function configFilePath(env = process.env) {
  return path.join(questlogHome(env), "config.json");
}

// Tolerant read of config.json. Missing / unparseable / wrong-schemaVersion all
// collapse to null ("treated as absent" per §1.1) — never throws, never crashes
// a request handler or the boot path.
export function readConfigFile(env = process.env) {
  try {
    const raw = fs.readFileSync(configFilePath(env), "utf8");
    // Strip a leading UTF-8 BOM (finding #2): a founder hand-editing config.json
    // in an editor that writes a BOM would otherwise make JSON.parse throw, the
    // file be treated as absent, and their hand-edited keys silently dropped on
    // the next save. Node's readFileSync does not strip the BOM for us.
    const data = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!data || typeof data !== "object" || Array.isArray(data) || data.schemaVersion !== 1) return null;
    return data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Config — env-first, with an OPTIONAL config-file fallback (planner §1.2).
// One-arg calls (env only) behave exactly as before (back-compat: existing
// tests keep passing). The optional second arg is the parsed config.json object
// (or null); env still WINS per key, config fills the gap, hard defaults last.
// "env var set" is pinned as: present in env AND value !== "".
// ---------------------------------------------------------------------------
export function readBridgeConfig(env = process.env, fileCfg = null) {
  const intOr = (v, def) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  const envSet = (v) => v !== undefined && v !== null && v !== "";
  const fb = (fileCfg && typeof fileCfg === "object" && fileCfg.bridge && typeof fileCfg.bridge === "object")
    ? fileCfg.bridge
    : {};

  // Master switch. env set → (value === "1"); else config.bridge.enabled === true; else false.
  const enabled = envSet(env.QUESTLOG_BTW_BRIDGE) ? (env.QUESTLOG_BTW_BRIDGE === "1") : (fb.enabled === true);
  // Dry-run. env set → (value !== "0"); else config.bridge.dryRun (boolean); else true.
  const dryRun = envSet(env.QUESTLOG_BTW_DRYRUN)
    ? (env.QUESTLOG_BTW_DRYRUN !== "0")
    : (typeof fb.dryRun === "boolean" ? fb.dryRun : true);
  // Model. env set (nonempty) → env; else config.bridge.model (nonempty string); else "sonnet".
  const model = envSet(env.QUESTLOG_BTW_MODEL)
    ? env.QUESTLOG_BTW_MODEL
    : ((typeof fb.model === "string" && fb.model) ? fb.model : "sonnet");
  // Auto-trigger (planner §5.1). The questlog DEFAULT is batch-only (false): notes
  // and flags accumulate as pending work until the founder presses "Send to agent".
  // env set → (value === "1"); else config.bridge.autoTrigger === true; else false.
  const autoTrigger = envSet(env.QUESTLOG_BTW_AUTOTRIGGER)
    ? (env.QUESTLOG_BTW_AUTOTRIGGER === "1")
    : (fb.autoTrigger === true);

  return {
    // Founder-facing knobs (env > config > default; see above).
    enabled,
    dryRun,
    model,
    autoTrigger,
    // All remaining knobs stay ENV-ONLY, untouched — not founder-facing.
    // Idle window (ms) rapid edits on one card coalesce within.
    debounceMs: intOr(env.QUESTLOG_BTW_DEBOUNCE_MS, 8000),
    // Hard wall-clock cap (ms) before the child is killed.
    timeoutMs: intOr(env.QUESTLOG_BTW_TIMEOUT_MS, 120000),
    // Turn cap — a second guard against a runaway loop.
    maxTurns: intOr(env.QUESTLOG_BTW_MAX_TURNS, 8),
    // The `claude` executable (override for tests / non-PATH installs).
    claudeBin: env.QUESTLOG_BTW_CLAUDE_BIN || "claude",
    // Optional explicit allowedTools override (space-separated). Rarely needed.
    allowedTools: (typeof env.QUESTLOG_BTW_ALLOWED_TOOLS === "string" && env.QUESTLOG_BTW_ALLOWED_TOOLS.trim())
      ? env.QUESTLOG_BTW_ALLOWED_TOOLS.trim().split(/\s+/)
      : DEFAULT_ALLOWED_TOOLS.slice(),
  };
}

// Per-roadmap paths for the bridge's own runtime files (log, context packages,
// kill switch). Kept in <dataDir>/bridge/ so the .questlog root stays clean and
// the validator (which only reads the known data files) never sees them.
export function bridgePaths(ctx, env = process.env) {
  const dir = path.join(ctx.dataDir, "bridge");
  return {
    dir,
    log: env.QUESTLOG_BTW_LOG || path.join(dir, "bridge.log"),
    kill: env.QUESTLOG_BTW_KILL || path.join(dir, "KILL"),
  };
}

// ---------------------------------------------------------------------------
// Env hygiene — strip every nesting/session var so the child is a clean,
// top-level Claude run (never a nested one). Prefix match so newly-introduced
// CLAUDE*/CODEX* vars are stripped too. PATH/HOME/subscription-OAuth are kept.
// ---------------------------------------------------------------------------
export function cleanEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === "AI_AGENT") continue;
    if (k.startsWith("CLAUDE")) continue;   // CLAUDECODE, CLAUDE_CODE_*, CLAUDE_*
    if (k.startsWith("CODEX")) continue;    // CODEX_COMPANION_*, etc.
    out[k] = v;
  }
  return out;
}

// The exact list of env keys cleanEnv would remove (for the dry-run log / audit).
export function strippedEnvKeys(env = process.env) {
  return Object.keys(env).filter(
    (k) => k === "AI_AGENT" || k.startsWith("CLAUDE") || k.startsWith("CODEX"),
  );
}

// ---------------------------------------------------------------------------
// The task prompt. Plain natural language — NOT a slash command (the design doc
// deliberately avoids the unverified custom-slash-command path). It instructs
// the child to attribute itself, act on exactly one card, and stay in plain
// language. `noteText` is the founder's own words, echoed verbatim.
// ---------------------------------------------------------------------------
export function buildPrompt({ trigger, itemId, targetType, noteText, sessionId, title }) {
  const what = trigger === "unclear"
    ? `The founder flagged the ${targetType || "card"} "${title || itemId}" (id ${itemId}) as unclear — they could not follow it.`
    : `The founder left a note on the card "${title || itemId}" (id ${itemId}).`;
  const note = noteText ? `\n\nThe founder's words:\n"""\n${noteText}\n"""` : "";
  return [
    "You are the questlog bridge: a quiet background helper that keeps a founder's project roadmap clear.",
    what,
    note,
    "",
    "Do these steps in order, then stop:",
    `1. Call session_hello with sessionId "${sessionId}" and label "${BRIDGE_LABEL}" so your work is attributed to a bridge session.`,
    "2. Call roadmap_get to load the current roadmap.",
    `3. Find ${itemId}. Read what it says now and what the founder just told you.`,
    "4. Act on it: rewrite the card so it answers the founder in plain words a non-engineer understands. If they asked for a clearer explanation, improve the body; if they flagged it unclear, make it plainer.",
    "5. Save your rewrite with the matching upsert tool (same id), always filling the plain field, then add one short note (author \"agent\") saying what you changed.",
    "",
    `Rules: touch ONLY ${itemId} and its own note thread. Every field you write must read plainly — no abbreviations, no new jargon. Use only the questlog tools; do not run commands or edit files. When the card is clearer, you are done.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The BATCH task prompt (planner §3). Same voice + containment as buildPrompt,
// but list-driven: the founder went over the roadmap, left notes and unclear
// flags on N cards, and sent them all as one worklist. The child works the list
// in order, touching only the listed cards. Every founder note is echoed
// verbatim. The template is pinned — worker code must not drift it.
// ---------------------------------------------------------------------------
export function buildBatchPrompt({ worklist, sessionId }) {
  const entries = (worklist && Array.isArray(worklist.entries)) ? worklist.entries : [];
  const N = entries.length;
  const lines = [];
  lines.push("You are the questlog bridge: a quiet background helper that keeps a founder's project roadmap clear.");
  lines.push(`The founder went over the roadmap, left notes and "unclear" flags on ${N} card(s), and sent them all to you as one worklist.`);
  lines.push("");
  lines.push("Do these steps in order, then stop:");
  lines.push(`1. Call session_hello with sessionId "${sessionId}" and label "${BRIDGE_LABEL}" so your work is attributed to a bridge session.`);
  lines.push("2. Call roadmap_get once to load the current roadmap.");
  lines.push("3. Work through the worklist below IN ORDER, one entry at a time. For each entry:");
  lines.push("   a. Find the card by its id and read what it says now.");
  lines.push('   b. If the entry says "flagged unclear", rewrite it so a non-engineer can follow it, and clear the flag with clear_unclear (id + your full plain rewrite).');
  lines.push("   c. If the entry has founder notes, act on each note: answer or apply what the founder asked, rewriting the card with the matching upsert tool (same id), always filling the plain field.");
  lines.push('   d. For an item, finish by adding ONE short note (author "agent") saying what you changed. For a milestone or decision, your plain rewrite is the answer; do not add item notes elsewhere.');
  lines.push("4. After the last entry, stop.");
  lines.push("");
  lines.push(`WORKLIST (${N} entries):`);
  for (const e of entries) {
    lines.push("");
    lines.push(`--- Entry ${e.n} of ${N}: ${e.targetType} ${e.id} ---`);
    let cardLine = `Card: "${e.title || ""}"`;
    if (e.milestoneTitle) cardLine += `, on milestone "${e.milestoneTitle}" (${e.milestoneId})`;
    if (e.questTitle) cardLine += `, quest "${e.questTitle}"`;
    lines.push(cardLine);
    // Decisions carry related-milestone context instead of a parent milestone/quest.
    if (e.targetType === "decision" && Array.isArray(e.relatedMilestoneTitles) && e.relatedMilestoneTitles.length) {
      lines.push(`Related milestones: ${e.relatedMilestoneTitles.filter(Boolean).join("; ")}`);
    }
    lines.push("What it says now:");
    lines.push('"""');
    lines.push(String(e.currentText || ""));
    lines.push('"""');
    lines.push(`Flagged unclear: ${e.unclear ? `yes (flagged ${e.unclearAt || "earlier"})` : "no"}`);
    const notes = Array.isArray(e.notes) ? e.notes : [];
    for (let k = 0; k < notes.length; k++) {
      const nt = notes[k];
      lines.push(`Founder note ${k + 1} (their exact words, ${nt.ts || ""}):`);
      lines.push('"""');
      lines.push(String(nt.body || ""));
      lines.push('"""');
    }
  }
  lines.push("");
  lines.push("Rules: touch ONLY the cards listed above and their own note threads. Every field you write must read plainly — no abbreviations, no new jargon. Use only the questlog tools; do not run commands or edit files. When every entry is handled, you are done.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The spawn argv. Every flag is load-bearing; the "why" for each lives in the
// README/SKILL "Bridge" section. Passed straight to child_process.spawn (no
// shell), so each element is one argument and nothing is re-parsed.
// ---------------------------------------------------------------------------
export function buildArgs({ prompt, model, maxTurns, allowedTools, mcpConfigPath, targetRoot, sessionId }) {
  return [
    "-p", prompt,                    // print mode: non-interactive, read full context, exit
    "--model", model,                // route to the cheap side-task model (Sonnet)
    "--output-format", "json",       // machine-readable result we can capture + attribute
    "--max-turns", String(maxTurns), // cap runaway loops
    "--permission-mode", "acceptEdits", // proven to let allowed tools act without a TTY prompt
    "--session-id", sessionId,       // pin the child's session id = the one it says hello with
    "--mcp-config", mcpConfigPath,   // inject ONLY the questlog MCP effector (pointed at target)
    "--strict-mcp-config",           // and ONLY that — ignore the user's global/project MCP servers
    "--add-dir", targetRoot,         // let Read see the target project (cwd is a neutral temp dir)
    "--allowedTools", ...allowedTools, // the sole tools the child may use — narrow write scope
  ];
}

// Shell-ish rendering of a command for the dry-run log (display only — the real
// spawn never goes through a shell).
export function renderCommand(bin, args) {
  const q = (s) => (/[\s"'\\]/.test(s) ? '"' + s.replace(/(["\\])/g, "\\$1") + '"' : s);
  return [bin, ...args].map(q).join(" ");
}

// ---------------------------------------------------------------------------
// C1 — THE LAUNCH GATE (dec-currency-architecture). Gate point 1 of 5.
//
// A bridge pass must name a milestone that RESOLVES on the target road, or
// declare itself a chore. No resolving milestoneId and no chore flag means it
// DOES NOT RUN — checked before mkdtemp, before any spawn, and logged to
// bridge.log so a refusal is as auditable as a run.
//
// A chore does not touch the road at all: it writes one line to the chore
// ledger (.questlog/activity.jsonl) and nothing else.
// ---------------------------------------------------------------------------
function readRoadmapTolerant(ctx) {
  try { return JSON.parse(fs.readFileSync(path.join(ctx.dataDir, "roadmap.json"), "utf8")); }
  catch { return { milestones: [] }; }
}
function activityPath(ctx) { return path.join(ctx.dataDir, "activity.jsonl"); }

// Shared by both spawners. Returns null when the run may proceed, or the exact
// refusal record to return to the caller.
export function gateSpawn(ctx, { milestoneId, chore, ref, label, log, ts }) {
  const verdict = assertLinkedOrChore({ roadmap: readRoadmapTolerant(ctx), milestoneId, chore });
  if (!verdict.ok) {
    appendLog(log, { ts, kind: "bridge-refused", reason: "E_UNLINKED", message: verdict.message, milestoneId: milestoneId || null, ref: ref || null });
    return { status: "refused", reason: "E_UNLINKED", message: verdict.message, milestoneId: milestoneId || null };
  }
  if (verdict.chore && ref) {
    // Chores are recorded, never hidden — that is what keeps the escape hatch
    // countable in the coverage line.
    try { fs.mkdirSync(ctx.dataDir, { recursive: true }); } catch { /* best-effort */ }
    try { appendActivity(activityPath(ctx), { ts, source: "bridge", ref, kind: "launch", label: label || "" }); }
    catch { /* the ledger must never break a run */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// One bridge pass. Builds the context package, then either logs it (dry-run) or
// spawns the child (live). Returns a promise that resolves to a result record.
// Deps are injectable for tests (spawn, now).
// ---------------------------------------------------------------------------
export async function runBridgeOnce(cfg, ctx, payload, deps = {}) {
  const spawnFn = deps.spawn || spawn;
  const now = deps.now || (() => new Date());
  const bp = bridgePaths(ctx, deps.env || process.env);
  const ts = now().toISOString();

  fs.mkdirSync(bp.dir, { recursive: true });

  // C1 — the gate, BEFORE the kill switch, the mkdtemp and the spawn.
  const refused = gateSpawn(ctx, {
    milestoneId: payload && payload.milestoneId,
    chore: payload && payload.chore,
    ref: (payload && payload.itemId) || null,
    label: `bridge pass on ${(payload && payload.itemId) || "a card"}`,
    log: bp.log, ts,
  });
  if (refused) return refused;

  // Kill switch: an existing kill file aborts before we do anything expensive.
  if (fs.existsSync(bp.kill)) {
    appendLog(bp.log, { ts, kind: "bridge-aborted", reason: "kill-switch present", killPath: bp.kill, itemId: payload.itemId });
    return { status: "killed", reason: "kill-switch" };
  }

  const sessionId = deps.sessionId || crypto.randomUUID();
  const prompt = buildPrompt({ ...payload, sessionId });

  // Neutral throwaway cwd — never the project, never the user's home.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "questlog-bridge-"));
  const mcpConfigPath = path.join(workDir, "questlog-mcp.json");
  const mcpConfig = {
    mcpServers: {
      questlog: { command: "node", args: [MCP_SERVER_PATH, "--dir", ctx.root] },
    },
  };
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf8");

  const args = buildArgs({
    prompt, model: cfg.model, maxTurns: cfg.maxTurns, allowedTools: cfg.allowedTools,
    mcpConfigPath, targetRoot: ctx.root, sessionId,
  });
  const command = renderCommand(cfg.claudeBin, args);

  // The context package: everything a founder (or auditor) needs to see exactly
  // what would run. Written every time — dry-run and live both.
  const ctxPkgPath = path.join(bp.dir, `ctx-${ts.replace(/[:.]/g, "-")}-${payload.itemId}.json`);
  const contextPackage = {
    ts, trigger: payload.trigger, itemId: payload.itemId, targetType: payload.targetType || null,
    sessionId, model: cfg.model, dryRun: cfg.dryRun,
    workDir, cwd: workDir, mcpConfigPath, mcpConfig,
    bin: cfg.claudeBin, args, command,
    strippedEnvKeys: strippedEnvKeys(deps.env || process.env),
    allowedTools: cfg.allowedTools,
    prompt,
  };
  fs.writeFileSync(ctxPkgPath, JSON.stringify(contextPackage, null, 2), "utf8");

  if (cfg.dryRun) {
    appendLog(bp.log, {
      ts, kind: "bridge-dryrun", trigger: payload.trigger, itemId: payload.itemId,
      sessionId, command, contextPackage: ctxPkgPath,
    });
    return { status: "dryrun", sessionId, command, contextPackagePath: ctxPkgPath, workDir };
  }

  // ---- LIVE ----
  appendLog(bp.log, { ts, kind: "bridge-spawn", trigger: payload.trigger, itemId: payload.itemId, sessionId, command, contextPackage: ctxPkgPath });

  const child = spawnFn(cfg.claudeBin, args, {
    cwd: workDir,
    env: cleanEnv(deps.env || process.env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "", stderr = "";
  if (child.stdout) child.stdout.on("data", (d) => { stdout += d.toString(); });
  if (child.stderr) child.stderr.on("data", (d) => { stderr += d.toString(); });

  // Hard timeout — SIGTERM, then SIGKILL a moment later if it lingers.
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 2000);
  }, cfg.timeoutMs);

  // Kill switch honored mid-flight too — poll for the file appearing.
  const killPoll = setInterval(() => {
    if (fs.existsSync(bp.kill)) {
      try { child.kill("SIGTERM"); } catch { /* gone */ }
    }
  }, 1000);

  const exit = await new Promise((resolve) => {
    child.on("error", (err) => resolve({ code: null, signal: null, error: err }));
    child.on("close", (code, signal) => resolve({ code, signal, error: null }));
  });
  clearTimeout(killTimer);
  clearInterval(killPoll);

  const done = now().toISOString();
  const record = {
    ts: done, kind: "bridge-done", trigger: payload.trigger, itemId: payload.itemId, sessionId,
    exitCode: exit.code, signal: exit.signal, timedOut,
    error: exit.error ? String(exit.error.message || exit.error) : null,
    contextPackage: ctxPkgPath,
  };
  // Persist child output next to the context package for auditing.
  const outPath = path.join(bp.dir, `out-${done.replace(/[:.]/g, "-")}-${payload.itemId}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ ...record, stdout, stderr }, null, 2), "utf8");
  record.output = outPath;
  appendLog(bp.log, record);

  return {
    status: timedOut ? "timeout" : (exit.error ? "error" : "done"),
    sessionId, exitCode: exit.code, signal: exit.signal, timedOut,
    stdout, stderr, outputPath: outPath, contextPackagePath: ctxPkgPath, workDir,
  };
}

// ---------------------------------------------------------------------------
// One BATCH pass (planner §3.2). One session works a whole worklist. Same
// containment as runBridgeOnce (kill-switch pre-check + 1s poll, SIGTERM→SIGKILL,
// cleanEnv, neutral mkdtemp cwd, --model, --output-format json, acceptEdits,
// --session-id, questlog-only --mcp-config + --strict-mcp-config, --add-dir,
// --allowedTools). Turn/time budgets scale with N via the pinned formulas.
// Writes worklist-<dispatchId>.json + ctx-batch-<ts>-<dispatchId>.json (+ out-…
// for live) in <dataDir>/bridge/. Deps injectable for tests (spawn, now, env,
// sessionId). Returns a result record; never throws.
// ---------------------------------------------------------------------------
export async function runBatchOnce(cfg, ctx, batch, deps = {}) {
  const spawnFn = deps.spawn || spawn;
  const now = deps.now || (() => new Date());
  const env = deps.env || process.env;
  const bp = bridgePaths(ctx, env);
  const ts = now().toISOString();

  const worklist = batch.worklist || { entries: [] };
  const dispatchId = batch.dispatchId;
  const dryRun = (batch.dryRun !== undefined) ? batch.dryRun : cfg.dryRun;
  const entries = Array.isArray(worklist.entries) ? worklist.entries : [];
  const N = entries.length;

  fs.mkdirSync(bp.dir, { recursive: true });

  // C1 — the gate. The batch dispatch is a CHORE by construction (it is card
  // hygiene: the founder's waiting notes and flags, rewritten in place), so
  // handleDispatch stamps chore:true. A caller that stamps neither a resolving
  // milestoneId nor the chore flag does not run.
  const refusedBatch = gateSpawn(ctx, {
    milestoneId: batch && batch.milestoneId,
    chore: batch && batch.chore,
    ref: dispatchId,
    label: `batch dispatch of ${N} card(s)`,
    log: bp.log, ts,
  });
  if (refusedBatch) return { ...refusedBatch, dispatchId, count: N };

  // The worklist file — the ONE shared shape (server assembler → this file →
  // the prompt). Written every time (dry-run and live) so an auditor can read it.
  const worklistPath = path.join(bp.dir, `worklist-${dispatchId}.json`);
  fs.writeFileSync(worklistPath, JSON.stringify(worklist, null, 2), "utf8");

  // Kill switch: an existing kill file aborts before we do anything expensive.
  if (fs.existsSync(bp.kill)) {
    appendLog(bp.log, { ts, kind: "bridge-aborted", reason: "kill-switch present", killPath: bp.kill, dispatchId });
    return { status: "killed", reason: "kill-switch", dispatchId, worklistPath, count: N };
  }

  const sessionId = deps.sessionId || crypto.randomUUID();
  const prompt = buildBatchPrompt({ worklist, sessionId });

  // Turn / time budgets (planner §3.2 — PINNED formulas). Founder env caps are
  // absolute; otherwise scale with the number of entries.
  const envSet = (v) => v !== undefined && v !== null && v !== "";
  const maxTurns = envSet(env.QUESTLOG_BTW_MAX_TURNS)
    ? parseInt(env.QUESTLOG_BTW_MAX_TURNS, 10)
    : Math.min(60, Math.max(8, 4 + 4 * N));
  const timeoutMs = envSet(env.QUESTLOG_BTW_TIMEOUT_MS)
    ? parseInt(env.QUESTLOG_BTW_TIMEOUT_MS, 10)
    : Math.min(900000, 120000 + 60000 * (N - 1));

  // Neutral throwaway cwd — never the project, never the user's home.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "questlog-bridge-"));
  const mcpConfigPath = path.join(workDir, "questlog-mcp.json");
  const mcpConfig = {
    mcpServers: {
      questlog: { command: "node", args: [MCP_SERVER_PATH, "--dir", ctx.root] },
    },
  };
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf8");

  const args = buildArgs({
    prompt, model: cfg.model, maxTurns, allowedTools: cfg.allowedTools,
    mcpConfigPath, targetRoot: ctx.root, sessionId,
  });
  const command = renderCommand(cfg.claudeBin, args);

  const ctxPkgPath = path.join(bp.dir, `ctx-batch-${ts.replace(/[:.]/g, "-")}-${dispatchId}.json`);
  const contextPackage = {
    ts, kind: "batch", dispatchId, count: N, sessionId, model: cfg.model, dryRun,
    maxTurns, timeoutMs, workDir, cwd: workDir, mcpConfigPath, mcpConfig,
    bin: cfg.claudeBin, args, command,
    strippedEnvKeys: strippedEnvKeys(env), allowedTools: cfg.allowedTools,
    worklistPath, prompt,
  };
  fs.writeFileSync(ctxPkgPath, JSON.stringify(contextPackage, null, 2), "utf8");

  if (dryRun) {
    appendLog(bp.log, {
      ts, kind: "bridge-dryrun-batch", dispatchId, count: N,
      sessionId, command, contextPackage: ctxPkgPath, worklist: worklistPath,
    });
    return { status: "dryrun", dispatchId, sessionId, command, contextPackagePath: ctxPkgPath, worklistPath, workDir, count: N };
  }

  // ---- LIVE ----
  appendLog(bp.log, { ts, kind: "bridge-spawn-batch", dispatchId, count: N, sessionId, command, contextPackage: ctxPkgPath, worklist: worklistPath });

  const child = spawnFn(cfg.claudeBin, args, {
    cwd: workDir,
    env: cleanEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "", stderr = "";
  if (child.stdout) child.stdout.on("data", (d) => { stdout += d.toString(); });
  if (child.stderr) child.stderr.on("data", (d) => { stderr += d.toString(); });

  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 2000);
  }, timeoutMs);

  const killPoll = setInterval(() => {
    if (fs.existsSync(bp.kill)) {
      try { child.kill("SIGTERM"); } catch { /* gone */ }
    }
  }, 1000);

  const exit = await new Promise((resolve) => {
    child.on("error", (err) => resolve({ code: null, signal: null, error: err }));
    child.on("close", (code, signal) => resolve({ code, signal, error: null }));
  });
  clearTimeout(killTimer);
  clearInterval(killPoll);

  const done = now().toISOString();
  const record = {
    ts: done, kind: "bridge-done-batch", dispatchId, count: N, sessionId,
    exitCode: exit.code, signal: exit.signal, timedOut,
    error: exit.error ? String(exit.error.message || exit.error) : null,
    contextPackage: ctxPkgPath,
  };
  const outPath = path.join(bp.dir, `out-${done.replace(/[:.]/g, "-")}-${dispatchId}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ ...record, stdout, stderr }, null, 2), "utf8");
  record.output = outPath;
  appendLog(bp.log, record);

  return {
    status: timedOut ? "timeout" : (exit.error ? "error" : "done"),
    dispatchId, sessionId, exitCode: exit.code, signal: exit.signal, timedOut,
    stdout, stderr, outputPath: outPath, contextPackagePath: ctxPkgPath, worklistPath, workDir, count: N,
  };
}

function appendLog(logPath, obj) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(obj) + "\n", "utf8");
  } catch { /* logging is best-effort; never throw into a request handler */ }
}

// ---------------------------------------------------------------------------
// Debounce + single-concurrency controller. `trigger()` is the additive call
// the server makes after a founder note/flag write. It NEVER blocks or alters
// the founder's own write — it only schedules a coalesced background pass.
// ---------------------------------------------------------------------------
export function createBridge(cfgArg, deps = {}) {
  const setT = deps.setTimeout || setTimeout;
  const clrT = deps.clearTimeout || clearTimeout;
  const run = deps.runBridgeOnce || runBridgeOnce;
  const runB = deps.runBatchOnce || runBatchOnce;

  // Accept a plain config object (legacy / tests) OR a getter re-read per call
  // (planner §1.3: server passes `() => readBridgeConfig(process.env,
  // readConfigFile())` so toggling the bridge in the settings panel takes effect
  // on the NEXT trigger with no restart). Wrapping a plain object keeps every
  // existing caller working byte-for-byte.
  const getCfg = typeof cfgArg === "function" ? cfgArg : () => cfgArg;

  const timers = new Map(); // key -> timer handle
  const pending = new Map(); // key -> latest {ctx, payload}
  let running = false;
  // Batch dispatch reservation (planner §3.3). reserveBatch() flips this true
  // synchronously so a second dispatch (or an auto-trigger debounce fire) sees the
  // helper as busy before runBatch even begins its async work. Cleared when the
  // batch run settles (or on an assembler-error via cancelBatchReservation).
  let batchReserved = false;
  const onRun = deps.onRun || (() => {}); // test/proof hook: called with the result

  function key(ctx, payload) {
    return `${ctx.dataDir}::${payload.itemId}`;
  }

  async function fire(k) {
    const job = pending.get(k);
    if (!job) return;
    // Re-read config at spawn time so dryRun/model/enabled are current (§1.3).
    const cfg = getCfg();
    // Single concurrency: if a per-item run is in flight OR a batch dispatch is
    // reserved/running, re-arm rather than parallelize (planner §3.3).
    if (running || batchReserved) {
      timers.set(k, setT(() => { fire(k); }, cfg.debounceMs));
      return;
    }
    pending.delete(k);
    timers.delete(k);
    running = true;
    let result;
    try {
      result = await run(cfg, job.ctx, job.payload, deps);
    } catch (err) {
      result = { status: "error", error: String(err && err.message || err) };
    } finally {
      running = false;
    }
    try { onRun(result, job); } catch { /* hook must never break the chain */ }
    // If more edits arrived for other cards while we ran, they have their own
    // timers; nothing to drain here.
  }

  function trigger(ctx, payload) {
    // Re-read config on every trigger (§1.3/§5.1). The questlog DEFAULT is
    // batch-only: per-note auto-triggering is INERT unless the founder both turns
    // the helper ON and opts in to the old "act on each note right away" behavior
    // (bridge.autoTrigger). A founder flipping either switch in settings is
    // honored by the very next note/flag, no server restart.
    const cfg = getCfg();
    if (!(cfg.enabled && cfg.autoTrigger === true)) return false;
    const k = key(ctx, payload);
    pending.set(k, { ctx, payload });
    if (timers.has(k)) clrT(timers.get(k));
    timers.set(k, setT(() => { fire(k); }, cfg.debounceMs));
    return true;
  }

  // Synchronous batch reservation (planner §3.3). Returns false when a per-item
  // run is in flight OR a batch is already reserved/running, so the dispatch
  // endpoint can answer E_BRIDGE_BUSY without racing. Reserving here also makes a
  // concurrent auto-trigger debounce fire re-arm instead of spawning.
  function reserveBatch() {
    if (running || batchReserved) return false;
    batchReserved = true;
    return true;
  }
  // Release a reservation the caller decided not to use (0 pending / assembler error).
  function cancelBatchReservation() {
    batchReserved = false;
  }
  // Consume the reservation and run one batch pass, then call onDone(result).
  // Clears running + the reservation in a finally so a failed run never wedges
  // the helper. onDone is best-effort and must never throw into the caller.
  async function runBatch(ctx, opts) {
    const cfg = getCfg();
    const dry = (opts && opts.dryRun !== undefined) ? opts.dryRun : cfg.dryRun;
    running = true;
    let result = { status: "error", error: "batch did not run" };
    try {
      try {
        // C1 — the linkage travels with the batch so runBatchOnce can gate it.
        result = await runB(cfg, ctx, {
          worklist: opts.worklist, dispatchId: opts.dispatchId, dryRun: dry,
          milestoneId: opts.milestoneId, chore: opts.chore,
        }, deps);
      } catch (err) {
        result = { status: "error", error: String(err && err.message || err), dispatchId: opts && opts.dispatchId };
      }
      if (opts && typeof opts.onDone === "function") {
        try { await opts.onDone(result); } catch { /* onDone must never break the chain */ }
      }
    } finally {
      running = false;
      batchReserved = false;
    }
    try { onRun(result, { ctx, worklist: opts && opts.worklist, dispatchId: opts && opts.dispatchId, batch: true }); }
    catch { /* hook must never break the chain */ }
    return result;
  }

  return {
    trigger,
    reserveBatch,
    cancelBatchReservation,
    runBatch,
    // Introspection for tests.
    _state: () => ({ running, batchReserved, pendingKeys: [...pending.keys()], timerKeys: [...timers.keys()] }),
  };
}
