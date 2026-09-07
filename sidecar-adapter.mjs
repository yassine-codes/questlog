#!/usr/bin/env node
// ---------------------------------------------------------------------------
// QUESTLOG — SIDECAR ADAPTER (F8b, decision dec-sidecar-selfhealing).
//
// A questlog chat id IS a Claude Code session id (the deliberate design in
// chat.mjs's header). So the FULL-FIDELITY record of every chat already exists
// on disk at ~/.claude/projects/<slug>/<chatId>.jsonl, whether or not questlog's
// own write path managed to capture it. A chat that bricked mid-run can be
// left with four dock lines and a complete Claude session sitting beside it.
// This module reads that sidecar, READ-ONLY, and enriches the rendered
// transcript from it.
//
// THREE HARD RULES:
//   1. READ-ONLY. Nothing in this file ever writes, moves or deletes anything
//      under ~/.claude. It opens files for reading and that is all.
//   2. NEVER THROWS. Every exported function returns a value on every path.
//      A chat must never fail to open because the sidecar was odd.
//   3. THE SPLINT. If anything at all is wrong — missing file, unparseable
//      lines, drifted format, fewer beats than the dock already has — the dock's
//      own transcript is returned UNCHANGED. Enrichment is a bonus, never a
//      dependency.
//
// SELF-HEALING. Claude Code's transcript format is not a published contract; it
// drifts. sidecar-fingerprint.json records the structural shape this parser was
// written against, and checkFingerprint() is run on every read. On drift the
// splint engages AND (per config sidecar.repair) server.mjs launches ONE Fable
// session whose permission scope allows editing NOTHING but this file, its
// selftest, and the fingerprint. That is why the slug derivation below is
// DELIBERATELY DUPLICATED from chat.mjs's claudeSessionExists(): a repair
// session must be able to fix sidecar parsing without ever touching chat.mjs.
// Do not "de-duplicate" it. The duplication is the isolation boundary.
//
// THE HOOK CAVEAT (F-C) — WHY A REPAIR SESSION DOES NOT RUN IN THIS DIRECTORY.
// The repair child's `--allowedTools` scope governs what the MODEL may ask for.
// It does NOT govern the founder's own user-level hooks (~/.claude/settings.json
// and friends): those load with the child's session and run outside any
// permission scope this repo can express. A hook that writes into the session's
// working directory will do so no matter how narrow the tool list is — an
// earlier repair pass dropped a whole `.remember/` tree into this repo exactly
// that way. cwd is the only lever, so server.mjs's launchSidecarRepair() runs
// the child in a throwaway temp directory seeded with copies of these three
// files, and copies ONLY those three back — and only if the acceptance gate
// passes. If you edit that launcher, keep the isolation: nothing foreign may
// land in the founder's repo.
//
// Zero npm deps. Node builtins only.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FINGERPRINT_PATH = path.join(__dirname, "sidecar-fingerprint.json");

// Same caps as chat.mjs's live parser, so a sidecar-sourced beat and a
// dock-sourced beat are the same shape and the renderer needs no special case.
export const TOOL_INPUT_CAP = 16384;
export const TOOL_OUTPUT_CAP = 4096;

// Drift threshold: more than this share of lines failing to parse means the
// file is not what we think it is.
export const UNPARSEABLE_DRIFT_RATIO = 0.10;

// ---------------------------------------------------------------------------
// Path resolution. DELIBERATELY DUPLICATED from chat.mjs — see the header.
// Slug = the absolute road root with \ / : . and whitespace folded to -.
// A path carrying every shape the rule folds — drive letter, backslash,
// space and dot — and the slug it folds down to:
//   C:\Work\My Projects\demo.app
//   -> C--Work-My-Projects-demo-app
// CLAUDE_CONFIG_DIR overrides ~/.claude (that is dq() in Claude Code's source).
// ---------------------------------------------------------------------------
export function sidecarSlug(root) {
  return String(root || "").replace(/[\\/:.\s]/g, "-");
}

export function sidecarPathFor(chatId, root, env = process.env) {
  try {
    if (typeof chatId !== "string" || !chatId) return null;
    if (!/^[A-Za-z0-9._-]+$/.test(chatId)) return null;         // never build a path from junk
    const e = env || {};
    const cfgDir = (typeof e.CLAUDE_CONFIG_DIR === "string" && e.CLAUDE_CONFIG_DIR)
      ? e.CLAUDE_CONFIG_DIR
      : path.join(os.homedir(), ".claude");
    return path.join(cfgDir, "projects", sidecarSlug(root), `${chatId}.jsonl`);
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Fingerprint + drift sentinel.
// ---------------------------------------------------------------------------
let _fpCache = null;
export function readFingerprint(file = FINGERPRINT_PATH) {
  if (_fpCache && file === FINGERPRINT_PATH) return _fpCache;
  let fp = null;
  try { fp = JSON.parse(fs.readFileSync(file, "utf8")); } catch { fp = null; }
  if (!fp || typeof fp !== "object") fp = null;
  if (file === FINGERPRINT_PATH) _fpCache = fp;
  return fp;
}
// Test hook — drop the cached fingerprint so a selftest can swap the file.
export function _resetFingerprintCache() { _fpCache = null; }

function majorMinor(v) {
  const m = /^(\d+)\.(\d+)/.exec(String(v || ""));
  return m ? `${m[1]}.${m[2]}` : null;
}

// checkFingerprint(rawLines, fingerprint) -> {ok, drift:[reasons]}
// rawLines: the raw string lines of the sidecar file (blank lines tolerated).
// Every reason is a short, human-readable string; they become the repair
// session's mandate, so they must name what actually changed.
export function checkFingerprint(rawLines, fingerprint) {
  const drift = [];
  try {
    const fp = fingerprint || readFingerprint();
    if (!fp) return { ok: true, drift: [] };     // no fingerprint = nothing to compare; splint stays off
    const lines = Array.isArray(rawLines) ? rawLines : [];
    const nonEmpty = lines.filter((l) => typeof l === "string" && l.trim());
    if (!nonEmpty.length) return { ok: true, drift: [] };

    const knownLineTypes = new Set(Array.isArray(fp.knownLineTypes) ? fp.knownLineTypes : []);
    const knownBlockTypes = new Set(Array.isArray(fp.knownBlockTypes) ? fp.knownBlockTypes : []);
    const required = Array.isArray(fp.requiredLineFields) ? fp.requiredLineFields : [];
    // requiredLineFields are only meaningful on the MESSAGE lines that form the
    // parentUuid chain. Real transcripts carry bookkeeping lines
    // (queue-operation, last-prompt, custom-title, mode…) that legitimately
    // have no uuid/parentUuid/timestamp — demanding those fields of every line
    // would flag today's own data as drift and launch repair sessions forever.
    const messageTypes = new Set(Array.isArray(fp.messageLineTypes) ? fp.messageLineTypes : ["user", "assistant"]);

    let bad = 0;
    const unknownLine = new Set();
    const unknownBlock = new Set();
    const missingField = new Set();
    const versions = new Set();

    for (const raw of nonEmpty) {
      let o;
      try { o = JSON.parse(raw); } catch { bad++; continue; }
      if (!o || typeof o !== "object") { bad++; continue; }
      const t = typeof o.type === "string" ? o.type : "(no type)";
      if (knownLineTypes.size && !knownLineTypes.has(t)) unknownLine.add(t);
      if (typeof o.version === "string" && o.version) versions.add(o.version);
      if (messageTypes.has(t)) {
        for (const f of required) if (!(f in o)) missingField.add(`${t}.${f}`);
        const c = o.message && o.message.content;
        if (Array.isArray(c)) {
          for (const b of c) {
            if (!b || typeof b !== "object") continue;
            const bt = typeof b.type === "string" ? b.type : "(no type)";
            if (knownBlockTypes.size && !knownBlockTypes.has(bt)) unknownBlock.add(bt);
          }
        }
      }
    }

    const ratio = bad / nonEmpty.length;
    if (ratio > UNPARSEABLE_DRIFT_RATIO) {
      drift.push(`${bad} of ${nonEmpty.length} lines (${Math.round(ratio * 100)}%) could not be parsed as JSON objects`);
    }
    for (const t of unknownLine) drift.push(`unknown line type "${t}"`);
    for (const b of unknownBlock) drift.push(`unknown content block type "${b}"`);
    for (const f of missingField) drift.push(`required field missing: ${f}`);
    // Version: only a MAJOR.MINOR move counts. Patch releases churn constantly
    // and have never moved the shape.
    const seen = majorMinor(fp.versionSeen);
    if (seen) {
      for (const v of versions) {
        const mm = majorMinor(v);
        if (mm && mm !== seen) drift.push(`Claude Code version ${v} is outside the recorded ${fp.versionSeen}`);
      }
    }
  } catch (err) {
    // The sentinel itself must never break a chat open.
    return { ok: true, drift: [] };
  }
  return { ok: drift.length === 0, drift };
}

// ---------------------------------------------------------------------------
// Ordering. Claude Code stamps every message line with `uuid` and `parentUuid`,
// which is a linked list giving exact chronological order even when the file
// order is disturbed. Walk it; fall back to timestamp; fall back to file order.
// ---------------------------------------------------------------------------
function orderLines(msgLines) {
  try {
    const byUuid = new Map();
    for (const l of msgLines) if (l && typeof l.uuid === "string" && l.uuid) byUuid.set(l.uuid, l);
    // A chain is usable only if the links actually resolve.
    const children = new Map();
    let roots = [];
    let linked = 0;
    for (const l of msgLines) {
      const p = l && typeof l.parentUuid === "string" ? l.parentUuid : null;
      if (p && byUuid.has(p)) {
        linked++;
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(l);
      } else roots.push(l);
    }
    if (linked >= msgLines.length - roots.length && roots.length && linked > 0) {
      // Stable file-order tiebreak among roots and among siblings.
      const idx = new Map(msgLines.map((l, i) => [l, i]));
      const byIdx = (a, b) => idx.get(a) - idx.get(b);
      roots = roots.slice().sort(byIdx);
      const out = [];
      const seen = new Set();
      const walk = (node) => {
        if (!node || seen.has(node)) return;
        seen.add(node); out.push(node);
        const kids = children.get(node.uuid);
        if (kids) for (const k of kids.slice().sort(byIdx)) walk(k);
      };
      for (const r of roots) walk(r);
      // Anything the walk missed (a cycle, an orphan) keeps its file position.
      for (const l of msgLines) if (!seen.has(l)) out.push(l);
      if (out.length === msgLines.length) return out;
    }
  } catch { /* fall through */ }
  // Fallback 1: timestamps, if they are all present and sortable.
  try {
    if (msgLines.every((l) => l && typeof l.timestamp === "string" && l.timestamp)) {
      const idx = new Map(msgLines.map((l, i) => [l, i]));
      return msgLines.slice().sort((a, b) => {
        const c = String(a.timestamp).localeCompare(String(b.timestamp));
        return c !== 0 ? c : idx.get(a) - idx.get(b);
      });
    }
  } catch { /* fall through */ }
  // Fallback 2: file order, unchanged.
  return msgLines;
}

// ---------------------------------------------------------------------------
// readSidecar — the parse. Maps Claude Code's own lines onto schema-v2 beats
// (the exact shapes chat.mjs persists), so the renderer needs no special case.
//
// Wave 1 scope: `thinking` blocks and `isSidechain` (subagent) lines are
// DROPPED. Thinking is signature-only in the sampled sessions, and subagent
// streams need their own nesting UI that wave 1 does not have.
// ---------------------------------------------------------------------------
function capInputValue(input) {
  if (input === undefined || input === null) return { value: null, truncated: false };
  let s; try { s = JSON.stringify(input); } catch { return { value: null, truncated: false }; }
  if (typeof s !== "string") return { value: null, truncated: false };
  if (s.length <= TOOL_INPUT_CAP) return { value: input, truncated: false };
  return { value: s.slice(0, TOOL_INPUT_CAP), truncated: true };
}

function flattenContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (content === undefined || content === null) return "";
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  const parts = [];
  for (const c of content) {
    if (typeof c === "string") { parts.push(c); continue; }
    if (!c || typeof c !== "object") continue;
    if (typeof c.text === "string") parts.push(c.text);
    else if (c.type === "image") parts.push("[image]");
    else { try { parts.push(JSON.stringify(c)); } catch { /* skip */ } }
  }
  return parts.join("\n");
}

// toolUseResult is a per-tool-shaped structured object that rides the SAME line
// as the tool_result block. When the block's own content is empty (some tools
// report only through toolUseResult) fall back to it so the chip still unfurls.
function outputFromLine(block, line) {
  let s = flattenContent(block && block.content);
  if (!s && line && line.toolUseResult !== undefined && line.toolUseResult !== null) {
    const r = line.toolUseResult;
    if (typeof r === "string") s = r;
    else { try { s = JSON.stringify(r, null, 2); } catch { s = ""; } }
  }
  if (s.length <= TOOL_OUTPUT_CAP) return { output: s, truncated: false };
  return { output: s.slice(0, TOOL_OUTPUT_CAP), truncated: true };
}

// ---------------------------------------------------------------------------
// F-B — HONEST ATTRIBUTION OF USER-ROLE LINES.
//
// Claude Code files a lot of things under the `user` role that the founder
// never typed: skill preambles (isMeta), slash-command echoes, local command
// output, system reminders, and — for questlog chats specifically — our own
// anchoring preamble, which is glued in front of the founder's first message
// before it is sent.
//
// Rendering any of that under a "YOU" header is a lie about who said what, so
// every one of these becomes a `system` beat with a named `origin`. The only
// thing that stays `user` is text the founder actually typed.
// ---------------------------------------------------------------------------

// The exact separator handleChatSend puts between the preamble and the
// founder's words (chat.mjs: `preamble + "\n\n---\n\n" + text`).
const PREAMBLE_SEP = "\n\n---\n\n";
// First lines of the two preambles chat.mjs can build. Matching on the opening
// sentence keeps this cheap and keeps a false positive nearly impossible.
const PREAMBLE_OPENERS = [
  "You are in a chat anchored to a milestone card",
  "You are the board-level chat for",
];

// Which injected thing is this? Returns null when the text is genuinely the
// founder's own. `line` is the raw transcript line (for isMeta).
export function classifyInjected(line, text) {
  const t = typeof text === "string" ? text : "";
  const head = t.slice(0, 400);

  // A skill's instructions, injected when the skill is invoked.
  const skillMatch = /^Base directory for this skill:\s*(.+?)\s*$/m.exec(head);
  if (skillMatch) {
    const p = skillMatch[1].replace(/[\\/]+$/, "");
    const name = p.split(/[\\/]/).filter(Boolean).pop() || "a skill";
    return { origin: "skill", skill: name };
  }
  // Slash-command echo and its stdout.
  if (/^\s*<command-(name|message|args)>/.test(head)) return { origin: "command" };
  if (/^\s*<local-command-(stdout|stderr)>/.test(head)) return { origin: "command" };
  // Harness-injected reminders and caveats.
  if (/^\s*<system-reminder>/.test(head)) return { origin: "system" };
  if (/^\s*Caveat: The messages below were generated by the user while running local commands/.test(head)) {
    return { origin: "system" };
  }
  // isMeta is Claude Code's own "this was not typed by the human" marker. It is
  // checked LAST so the more specific origins above win the label.
  if (line && line.isMeta === true) return { origin: "system" };
  return null;
}

// Split questlog's own anchoring preamble off the founder's first message.
// Returns {brief, text} or null when there is no preamble to peel.
export function splitPreamble(text) {
  const t = typeof text === "string" ? text : "";
  if (!PREAMBLE_OPENERS.some((o) => t.startsWith(o))) return null;
  const i = t.indexOf(PREAMBLE_SEP);
  if (i < 0) return { brief: t, text: "" };
  return { brief: t.slice(0, i), text: t.slice(i + PREAMBLE_SEP.length) };
}

export function readSidecar(chatId, root, env = process.env) {
  let file = null;
  try {
    file = sidecarPathFor(chatId, root, env);
    if (!file) return { ok: false, reason: "no-path" };
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); }
    catch { return { ok: false, reason: "not-found", file }; }

    const rawLines = raw.split("\n").filter((l) => l.trim());
    if (!rawLines.length) return { ok: false, reason: "empty", file };

    // The sentinel runs on EVERY read, before the beats are trusted.
    const fpCheck = checkFingerprint(rawLines, readFingerprint());

    const parsed = [];
    let unparseable = 0;
    let version = null;
    for (const l of rawLines) {
      let o; try { o = JSON.parse(l); } catch { unparseable++; continue; }
      if (!o || typeof o !== "object") { unparseable++; continue; }
      if (typeof o.version === "string" && o.version) version = o.version;
      parsed.push(o);
    }

    // Only message-bearing, non-sidechain lines become beats.
    const msgLines = parsed.filter((o) =>
      (o.type === "user" || o.type === "assistant") &&
      !o.isSidechain &&
      o.message && (typeof o.message.content === "string" || Array.isArray(o.message.content)));

    const ordered = orderLines(msgLines);

    const beats = [];
    const byToolUseId = new Map();
    let seq = 0;

    // F-B — one funnel for every text block, so no path can sneak injected
    // text under the founder's name. Assistant prose is never re-attributed.
    const pushText = (line, role, ts, text) => {
      if (typeof text !== "string" || !text.trim()) return;
      if (role === "assistant") {
        beats.push({ kind: "text", ts, seq: seq++, text, source: "sidecar" });
        return;
      }
      const injected = classifyInjected(line, text);
      if (injected) {
        const b = { kind: "system", origin: injected.origin, ts, seq: seq++, text, source: "sidecar" };
        if (injected.skill) b.skill = injected.skill;
        beats.push(b);
        return;
      }
      // questlog's own preamble: the brief is system, the remainder is the
      // founder's actual words and keeps the user voice.
      const split = splitPreamble(text);
      if (split) {
        beats.push({ kind: "system", origin: "brief", ts, seq: seq++, text: split.brief, source: "sidecar" });
        if (split.text.trim()) beats.push({ kind: "user", ts, seq: seq++, text: split.text, source: "sidecar" });
        return;
      }
      beats.push({ kind: "user", ts, seq: seq++, text, source: "sidecar" });
    };

    for (const line of ordered) {
      const ts = (typeof line.timestamp === "string" && line.timestamp) ? line.timestamp : null;
      const content = line.message.content;
      const role = line.message.role || line.type;

      if (typeof content === "string") {
        // A plain-string user message is USUALLY the founder's own prompt —
        // but not always (see classifyInjected). pushText decides honestly.
        pushText(line, role, ts, content);
        continue;
      }

      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "thinking") continue;                      // wave 1: dropped
        if (b.type === "text") {
          pushText(line, role, ts, b.text);
        } else if (b.type === "tool_use") {
          const name = (typeof b.name === "string" && b.name) ? b.name : "tool";
          const toolUseId = (typeof b.id === "string" && b.id) ? b.id : null;
          const { value, truncated } = capInputValue(b.input);
          const beat = {
            kind: "tool", ts, seq: seq++, name, toolUseId,
            detail: summarizeInput(name, b.input),
            input: value, inputTruncated: truncated, source: "sidecar",
          };
          if (typeof line.attributionSkill === "string" && line.attributionSkill) beat.attributionSkill = line.attributionSkill;
          beats.push(beat);
          if (toolUseId) byToolUseId.set(toolUseId, beat);
        } else if (b.type === "tool_result") {
          const toolUseId = (typeof b.tool_use_id === "string" && b.tool_use_id) ? b.tool_use_id : null;
          const beat = toolUseId ? byToolUseId.get(toolUseId) : null;
          const { output, truncated } = outputFromLine(b, line);
          if (beat) {
            beat.output = output;
            beat.outputTruncated = truncated;
            if (b.is_error) beat.outputIsError = true;
          }
          // An orphan tool_result (its tool_use is outside this file) still
          // deserves to render rather than vanish.
          else if (output) {
            beats.push({ kind: "tool", ts, seq: seq++, name: "tool", detail: "result", toolUseId, input: null, output, outputTruncated: truncated, outputIsError: !!b.is_error, source: "sidecar" });
          }
        }
        // image / fallback / anything else: not a beat in wave 1.
      }
    }

    return {
      ok: true,
      beats,
      meta: {
        file,
        lines: rawLines.length,
        parsed: parsed.length,
        unparseable,
        version,
        messageLines: msgLines.length,
        // The message-line uuids in the order the causal walk put them. This is
        // the ORDERING INVARIANT the selftest checks: a valid topological order
        // of the parentUuid DAG. Real transcripts are resumed, forked and
        // slash-command-echoed, so per-event timestamps are NOT a reliable
        // monotonic proxy for causal order — the chain is.
        order: ordered.map((l) => (typeof l.uuid === "string" ? l.uuid : null)),
        parents: ordered.map((l) => (typeof l.parentUuid === "string" ? l.parentUuid : null)),
      },
      drift: fpCheck.drift,
    };
  } catch (err) {
    // Rule 2: never throw.
    return { ok: false, reason: "error:" + String(err && err.message || err), file };
  }
}

// A compact one-line summary of a tool's input — the chip's resting label. The
// FULL input is on the beat; this is only what shows before the unfurl.
export function summarizeInput(name, input) {
  const n = (typeof name === "string" && name) ? name : "tool";
  if (!input || typeof input !== "object") return n;
  const parts = [];
  for (const k of Object.keys(input)) {
    let v = input[k];
    if (typeof v === "string") v = v.length > 60 ? v.slice(0, 60) + "…" : v;
    else { try { v = JSON.stringify(v); } catch { v = String(v); } }
    parts.push(`${k}: ${v}`);
    if (parts.join(", ").length > 120) break;
  }
  const s = parts.join(", ");
  let out = s ? `${n} — ${s}` : n;
  if (out.length > 240) out = out.slice(0, 240) + "…";
  return out;
}

// ---------------------------------------------------------------------------
// enrich — THE SPLINT LIVES HERE.
//
// Sidecar beats win ONLY when there are strictly more of them than the dock
// already holds. Otherwise the dock transcript is returned byte-identical.
// Dock-only lines — the briefed user line, retry lines, error lines — carry
// information the sidecar cannot have (they are questlog's own record of what
// questlog did) and are merged back in by timestamp.
// ---------------------------------------------------------------------------
const DOCK_ONLY_ROLES = new Set(["error", "retry"]);

export function enrich(dockTranscript, sidecarResult) {
  const dock = Array.isArray(dockTranscript) ? dockTranscript : [];
  try {
    if (!sidecarResult || sidecarResult.ok !== true || !Array.isArray(sidecarResult.beats)) return dock;
    if (Array.isArray(sidecarResult.drift) && sidecarResult.drift.length) return dock;   // drift => splint
    const beats = sidecarResult.beats;

    // "More beats than the dock has" is the whole test. Count comparable lines.
    // F-B: `system` beats are injected text, not conversation, so they do not
    // count towards "the sidecar knows more" — they must never be the reason
    // the splint releases.
    const dockBeats = dock.filter((e) => e && (e.role === "assistant" || e.role === "tool" || e.role === "user"));
    const realBeats = beats.filter((b) => b && b.kind !== "system");
    if (realBeats.length <= dockBeats.length) return dock;

    const out = [];
    for (const b of beats) {
      if (b.kind === "text") out.push({ ts: b.ts, role: "assistant", text: b.text, seq: b.seq, source: "sidecar" });
      else if (b.kind === "user") out.push({ ts: b.ts, role: "user", text: b.text, seq: b.seq, source: "sidecar" });
      else if (b.kind === "system") {
        // F-B — attributed honestly: never the founder's voice.
        const line = { ts: b.ts, role: "system", origin: b.origin || "system", text: b.text, seq: b.seq, source: "sidecar" };
        if (b.skill) line.skill = b.skill;
        out.push(line);
      }
      else if (b.kind === "tool") {
        const line = { ts: b.ts, role: "tool", seq: b.seq, name: b.name, detail: b.detail, source: "sidecar" };
        if (b.toolUseId) line.toolUseId = b.toolUseId;
        if (b.input !== undefined && b.input !== null) line.input = b.input;
        if (b.inputTruncated) line.inputTruncated = true;
        if (b.output !== undefined) line.output = b.output;
        if (b.outputTruncated) line.outputTruncated = true;
        if (b.outputIsError) line.outputIsError = true;
        if (b.attributionSkill) line.attributionSkill = b.attributionSkill;
        out.push(line);
      }
    }

    // Merge the dock-only lines back in by ts. A user line whose text already
    // appears as a sidecar user beat replaces it, so the briefed chip survives.
    const extras = [];
    for (const e of dock) {
      if (!e || typeof e !== "object") continue;
      if (DOCK_ONLY_ROLES.has(e.role)) { extras.push(e); continue; }
      if (e.role === "user") {
        const twin = out.find((o) => o.role === "user" && typeof o.text === "string" &&
          (o.text === e.text || (typeof e.text === "string" && e.text && o.text.indexOf(e.text) >= 0)));
        if (twin) { twin.text = e.text; if (e.briefed) twin.briefed = true; twin.source = "dock"; }
        else extras.push(e);
        continue;
      }
      if (e.role === "result") extras.push(e);
    }

    // The sidecar spine is the CAUSAL order (the parentUuid chain), and it is
    // authoritative. Claude Code's own per-event timestamps are not perfectly
    // monotonic along that chain — a tool_result line can be stamped a few ms
    // before the assistant line that requested it — so a global sort by ts
    // would SCRAMBLE beats that are already correctly ordered. Instead the
    // spine is left exactly as parsed and each dock-only line is INSERTED at
    // the first position whose beat is later than it.
    if (!extras.length) return out;
    extras.sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
    const merged = [];
    let i = 0;
    for (const e of extras) {
      const et = typeof e.ts === "string" ? e.ts : "";
      if (et) {
        while (i < out.length && String(out[i].ts || "") <= et) merged.push(out[i++]);
      } else {
        while (i < out.length) merged.push(out[i++]);      // no ts => goes at the end
      }
      merged.push(e);
    }
    while (i < out.length) merged.push(out[i++]);
    return merged;
  } catch {
    return dock;    // the splint, one more time
  }
}
