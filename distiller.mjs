// ---------------------------------------------------------------------------
// distiller.mjs — Questlog "distillery" (Wave 3, §3).
//
// Turns ONE completed workflow (its meta `script` + journal.jsonl) into a
// machine-distilled SKILL.md DRAFT via a single headless `claude` run. Zero npm
// deps; reuses bridge.mjs env-hygiene + command rendering so the child is a
// clean, top-level Claude run (never nested — cleanEnv strips CLAUDE*/CODEX*).
//
// SAFETY (founder consent lines):
//   * DRY-RUN is the default. planDistill() returns the exact command + inputs
//     and spawns NOTHING. Live spawning is gated by config distillery.live
//     (default false) and only ever performed by runDistill().
//   * Output goes ONLY to <app>/distillery-drafts/<wfname>-<date>.SKILL.md,
//     stamped UNREVIEWED. It NEVER writes into any skills dir. Installing a
//     draft is a manual, human step outside this module.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { cleanEnv, renderCommand } from "./bridge.mjs";

// The distiller instruction (module const, per contract §3).
export const DISTILLER_PROMPT =
  "Read this workflow script and journal. Extract the reusable orchestration " +
  "pattern (phases, model choices, gating, verification). Emit a SKILL.md draft.";

// A short, filesystem-safe slug for the workflow name.
export function slugify(s) {
  return String(s || "workflow").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "workflow";
}

export function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// The mandatory header stamped at the top of every emitted draft.
export function draftHeader({ wfId, wfPath, date }) {
  return [
    "<!--",
    `  source workflow id:   ${wfId}`,
    `  source workflow path: ${wfPath}`,
    `  distilled:            ${date}`,
    "  UNREVIEWED DRAFT — machine-distilled, do not install without founder review",
    "-->",
    "",
  ].join("\n");
}

// The full prompt handed to the child. It names the exact files to read and the
// exact output path + header the child must write, so the run is fully specified.
export function buildDistillPrompt({ scriptPath, journalPath, outPath, wfId, wfPath, date }) {
  return [
    DISTILLER_PROMPT,
    "",
    `Workflow script (meta JSON, read its "script" field): ${scriptPath}`,
    `Journal (JSONL, one event per line): ${journalPath}`,
    "",
    "Write the SKILL.md draft to EXACTLY this path (create parent dirs if needed):",
    `  ${outPath}`,
    "",
    "The file MUST begin with this exact HTML-comment header, verbatim, then the drafted skill:",
    draftHeader({ wfId, wfPath, date }),
    "Do not write to any other location. Do not install anything.",
  ].join("\n");
}

// The headless spawn argv. `--model sonnet` per contract; Read to inspect the
// two source files, Write to emit the single draft; cwd is neutral, the source
// dir is exposed read-through via --add-dir.
export function buildDistillArgs({ prompt, model = "sonnet", addDir }) {
  const args = [
    "-p", prompt,
    "--model", model,
    "--output-format", "json",
    "--max-turns", "12",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Read", "Write",
  ];
  if (addDir) { args.push("--add-dir", addDir); }
  return args;
}

// Resolve every path this distillation touches from a scanRaids() raid record.
// journalDir = <...>/subagents/workflows/<id>; meta lives at
// <sessionDir>/workflows/<id>.json (sessionDir = up 3 from journalDir).
export function resolveDistillInputs(raid, draftsDir, now = new Date()) {
  const journalDir = raid.journalDir;
  const wfId = raid.id;
  const sessionDir = path.dirname(path.dirname(path.dirname(journalDir)));
  const scriptPath = path.join(sessionDir, "workflows", wfId + ".json");
  const journalPath = path.join(journalDir, "journal.jsonl");
  const date = dateStamp(now);
  const wfname = slugify(raid.name || wfId);
  const outPath = path.join(draftsDir, `${wfname}-${date}.SKILL.md`);
  return { scriptPath, journalPath, outPath, sessionDir, wfId, wfPath: scriptPath, date };
}

// DRY-RUN plan — the default. Builds the exact command + inputs, spawns nothing.
// `bin` defaults to "claude"; caller may override (tests / non-PATH installs).
export function planDistill(raid, draftsDir, opts = {}) {
  const bin = opts.bin || "claude";
  const model = opts.model || "sonnet";
  const now = opts.now || new Date();
  const inputs = resolveDistillInputs(raid, draftsDir, now);
  const prompt = buildDistillPrompt(inputs);
  const args = buildDistillArgs({ prompt, model, addDir: inputs.sessionDir });
  const command = renderCommand(bin, args);
  return {
    dryRun: true,
    command,
    inputs: { scriptPath: inputs.scriptPath, journalPath: inputs.journalPath, outPath: inputs.outPath },
    model,
    strippedEnvNote: "nesting env cleared (CLAUDE*/CODEX*) per global CLAUDE.md",
  };
}

// LIVE run — ONLY reached when distillery.live is true. Spawns the headless
// child with a cleaned env, returns a promise resolving to a result record.
// Deps.spawn injectable for tests (never spawns in dry-run / self-test).
export function runDistill(raid, draftsDir, opts = {}, deps = {}) {
  const spawnFn = deps.spawn || (() => { throw new Error("no spawn provided"); });
  const bin = opts.bin || "claude";
  const model = opts.model || "sonnet";
  const now = opts.now || new Date();
  const env = (deps.cleanEnv || cleanEnv)(deps.env || process.env);
  const inputs = resolveDistillInputs(raid, draftsDir, now);
  const prompt = buildDistillPrompt(inputs);
  const args = buildDistillArgs({ prompt, model, addDir: inputs.sessionDir });
  const command = renderCommand(bin, args);
  try { fs.mkdirSync(draftsDir, { recursive: true }); } catch { /* best effort */ }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(bin, args, { cwd: opts.cwd || draftsDir, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, error: err && err.message ? err.message : String(err), command, inputs });
      return;
    }
    let out = "", errOut = "";
    if (child.stdout) child.stdout.on("data", (c) => { out += c.toString(); });
    if (child.stderr) child.stderr.on("data", (c) => { errOut += c.toString(); });
    child.on("error", (err) => resolve({ ok: false, error: err && err.message ? err.message : String(err), command, inputs }));
    child.on("close", (code) => resolve({
      ok: code === 0 && fs.existsSync(inputs.outPath),
      code, command,
      inputs: { scriptPath: inputs.scriptPath, journalPath: inputs.journalPath, outPath: inputs.outPath },
      stdoutTail: out.slice(-2000), stderrTail: errOut.slice(-2000),
    }));
  });
}
