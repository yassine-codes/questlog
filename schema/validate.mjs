#!/usr/bin/env node
// questlog data validator — stdlib only, zero dependencies.
// Validates a project's .questlog/ directory against Build Plan Section 1
// (structure, enums, id regex, uniqueness, referential integrity, invariants).
//
// Usage:
//   node schema/validate.mjs <projectRoot>        # dir containing .questlog/
//   node schema/validate.mjs --dir <projectRoot>
//   node schema/validate.mjs                      # defaults to process.cwd()
//
// Exit code 0 = valid, 1 = one or more errors. Errors print to stderr.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ID_RE = /^[a-z]+-[a-z0-9][a-z0-9-]*$/;
const TS_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const DISPATCH_ID_RE = /^disp-[a-z0-9][a-z0-9-]*$/;
const STATUS = new Set(["locked", "available", "in_progress", "done", "blocked"]);
const ITEM_STATUS = new Set(["open", "done", "blocked"]);

// --- Jargon lint (Build Plan Section 2.3) ---
// Stoplist: exact, case-sensitive. Keep literal.
const STOPLIST = new Set(["OK", "API", "URL", "HTTP", "HTTPS", "JSON", "JSONL", "MCP", "UI", "ID", "ISO", "UTC", "README", "MIT", "FAQ", "HTML", "CSS", "JS", "SVG", "PNG", "AI"]);
// Acronym token: starts uppercase, >=2 chars, only A-Z 0-9 -, ends uppercase/digit.
// Never matches inside snake_case (_ is a \w char, so \b won't split it) or mixed-case words.
const ACRONYM_RE = /\b[A-Z][A-Z0-9-]*[A-Z0-9]\b/g;
// Bracketed codename: [[inner]] — inner must be a glossary surface form.
const CODENAME_RE = /\[\[([^[\]]+)\]\]/g;
// Case rule (Section 2.1): a surface is case-sensitive iff it has no lowercase letter.
const CASE_SENSITIVE_RE = /^[^a-z]*$/;

function parseArgs(argv) {
  let dir = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") dir = argv[++i];
    else if (!argv[i].startsWith("--")) dir = argv[i];
  }
  return dir;
}

class V {
  constructor() { this.errors = []; }
  err(where, msg) { this.errors.push(`${where}: ${msg}`); }
  // helpers
  reqStr(where, obj, key, { allowEmpty = true } = {}) {
    if (typeof obj[key] !== "string") { this.err(where, `${key} must be a string`); return false; }
    if (!allowEmpty && obj[key].length === 0) { this.err(where, `${key} must be non-empty`); return false; }
    return true;
  }
  ts(where, obj, key, { nullable = false } = {}) {
    const v = obj[key];
    if (v === null) { if (!nullable) this.err(where, `${key} must not be null`); return; }
    if (typeof v !== "string" || !TS_RE.test(v)) this.err(where, `${key} must be ISO-8601 UTC ms (got ${JSON.stringify(v)})`);
  }
  id(where, obj, key, prefix) {
    const v = obj[key];
    if (typeof v !== "string" || !ID_RE.test(v)) { this.err(where, `${key} must match id regex (got ${JSON.stringify(v)})`); return; }
    if (prefix && !v.startsWith(prefix + "-")) this.err(where, `${key} must have prefix "${prefix}-" (got ${v})`);
  }
  enum(where, obj, key, set) {
    if (!set.has(obj[key])) this.err(where, `${key} must be one of [${[...set].join(", ")}] (got ${JSON.stringify(obj[key])})`);
  }
  int(where, obj, key, { min } = {}) {
    const v = obj[key];
    if (!Number.isInteger(v)) { this.err(where, `${key} must be an integer (got ${JSON.stringify(v)})`); return; }
    if (min !== undefined && v < min) this.err(where, `${key} must be >= ${min} (got ${v})`);
  }
  // Optional `plain` (string) + `unclear`/`unclearAt` invariant (Build Plan Section 1.4).
  // { unclear: false } => no unclear flag; pass unclear:false to skip the unclear check (quests).
  plainUnclear(where, obj, { unclear = true } = {}) {
    if ("plain" in obj && typeof obj.plain !== "string") this.err(where, "plain, if present, must be a string");
    if (!unclear) return;
    if ("unclear" in obj) {
      if (typeof obj.unclear !== "boolean") { this.err(where, "unclear, if present, must be a boolean"); return; }
      if (obj.unclear === true) {
        if (typeof obj.unclearAt !== "string" || !TS_RE.test(obj.unclearAt))
          this.err(where, "unclearAt must be a valid ISO-8601 UTC ms timestamp when unclear is true");
        return;
      }
    }
    // unclear absent or false => unclearAt must be null or absent
    if ("unclearAt" in obj && obj.unclearAt !== null)
      this.err(where, "unclearAt must be null or absent when unclear is not true");
  }
  // Batch-dispatch bookkeeping (planner §1.1/§1.2). Optional, additive, back-compat.
  // idKey pattern = disp-…, tsKey = ISO ts, both-or-neither. Leftovers (present on
  // an already-cleared flag) are tolerated: only pattern/ts/both-or-neither are errors.
  dispatchPair(where, obj, idKey, tsKey) {
    const hasId = idKey in obj;
    const hasTs = tsKey in obj;
    if (hasId && (typeof obj[idKey] !== "string" || !DISPATCH_ID_RE.test(obj[idKey])))
      this.err(where, `${idKey}, if present, must match ^disp-[a-z0-9][a-z0-9-]*$`);
    if (hasTs && (typeof obj[tsKey] !== "string" || !TS_RE.test(obj[tsKey])))
      this.err(where, `${tsKey}, if present, must be a valid ISO-8601 UTC ms timestamp`);
    if (hasId !== hasTs)
      this.err(where, `${idKey} and ${tsKey} must both be present or both absent`);
  }
}

function readJson(v, file) {
  if (!fs.existsSync(file)) { v.err(path.basename(file), "file missing"); return null; }
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { v.err(path.basename(file), `invalid JSON: ${e.message}`); return null; }
}

// --- Evidence plane (dec-currency-architecture, C2) -------------------------
// ABSENT is normal and silent: a road written before the evidence plane existed
// validates exactly as it always did. PRESENT is checked strictly, including
// the (source, ref, kind) idempotency key — a duplicate key is a validator
// error, because a duplicate means a writer's upsert-by-key was broken.
const EVIDENCE_SOURCES = new Set(["bridge", "sidecar", "raid-watcher", "session", "hook"]);
const EVIDENCE_KINDS = new Set(["launch", "finish", "verdict", "abandon", "retract"]);
const ACTIVITY_KINDS = new Set(["launch", "finish", "abandon"]);
const ACT_ID_RE = /^act-[a-z0-9][a-z0-9-]*$/;
const CLAIM_MAX = 500;
const REF_MAX = 200;

function validateEvidence(v, where, m) {
  if (!("evidence" in m)) return;                       // absence is normal
  if (!Array.isArray(m.evidence)) { v.err(where, "evidence, if present, must be an array"); return; }
  const keys = new Set();
  const realKeys = new Set();   // keys of non-retract entries, for tombstone checks
  for (let i = 0; i < m.evidence.length; i++) {
    const e = m.evidence[i];
    const w = `${where}.evidence[${i}]`;
    if (!e || typeof e !== "object" || Array.isArray(e)) { v.err(w, "evidence entry must be an object"); continue; }
    for (const k of Object.keys(e)) {
      if (!["ts", "source", "kind", "ref", "claim", "ship", "sessionId", "tombstonesRef"].includes(k)) v.err(w, `unknown evidence key ${k}`);
    }
    v.ts(w, e, "ts");
    if (!EVIDENCE_SOURCES.has(e.source)) v.err(w, `source must be one of [${[...EVIDENCE_SOURCES].join(", ")}] (got ${JSON.stringify(e.source)})`);
    if (!EVIDENCE_KINDS.has(e.kind)) v.err(w, `kind must be one of [${[...EVIDENCE_KINDS].join(", ")}] (got ${JSON.stringify(e.kind)})`);
    if (typeof e.ref !== "string" || e.ref.length === 0 || e.ref.length > REF_MAX) v.err(w, `ref must be a non-empty string (<= ${REF_MAX} chars)`);
    if (typeof e.claim !== "string") v.err(w, "claim must be a string");
    else if (e.claim.length > CLAIM_MAX) v.err(w, `claim must be <= ${CLAIM_MAX} chars (got ${e.claim.length})`);
    // ship is REQUIRED iff kind is verdict.
    if (e.kind === "verdict") {
      if (typeof e.ship !== "boolean") v.err(w, "a verdict entry requires ship: true|false");
    } else if ("ship" in e) v.err(w, "ship is only valid on a verdict entry");
    // tombstonesRef is REQUIRED iff kind is retract.
    if (e.kind === "retract") {
      if (typeof e.tombstonesRef !== "string" || e.tombstonesRef.length === 0) v.err(w, 'a retract entry requires tombstonesRef: "<source>|<ref>|<kind>"');
    } else if ("tombstonesRef" in e) v.err(w, "tombstonesRef is only valid on a retract entry");
    if ("sessionId" in e && (typeof e.sessionId !== "string" || e.sessionId.length === 0 || e.sessionId.length > 200))
      v.err(w, "sessionId, if present, must be a non-empty string (<= 200 chars)");
    // (source, ref, kind) is the idempotency key — it must be unique.
    const key = `${e.source}|${e.ref}|${e.kind}`;
    if (keys.has(key)) v.err(w, `duplicate evidence key (source, ref, kind) = ${key} — writers must upsert by key, never append twice`);
    keys.add(key);
    if (e.kind !== "retract") realKeys.add(key);
  }
  // A tombstone must point at an entry that is actually here, and a source may
  // only retract its OWN entry (the rest of the rule — no retraction after a
  // human edit — is time-ordered and lives in currency.mjs canRetract).
  for (let i = 0; i < m.evidence.length; i++) {
    const e = m.evidence[i];
    if (!e || e.kind !== "retract" || typeof e.tombstonesRef !== "string") continue;
    const w = `${where}.evidence[${i}]`;
    if (!realKeys.has(e.tombstonesRef)) { v.err(w, `tombstonesRef ${e.tombstonesRef} points at no evidence entry on this milestone`); continue; }
    const target = m.evidence.find((x) => x && x.kind !== "retract" && `${x.source}|${x.ref}|${x.kind}` === e.tombstonesRef);
    if (target && target.source !== e.source) v.err(w, `only ${target.source} may retract its own entry (this retract came from ${e.source})`);
  }
}

// --- Chore activity ledger (dec-currency-architecture) ----------------------
// <projectRoot>/.questlog/activity.jsonl. NOT a road file. ABSENT is normal and
// emits nothing; PRESENT is validated strictly, including the same
// (source, ref, kind) idempotency key.
function validateActivity(v, file) {
  if (!fs.existsSync(file)) return;                     // absence is normal
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) { v.err("activity.jsonl", `unreadable: ${e.message}`); return; }
  const lines = raw.split("\n");
  const ids = new Set();
  const keys = new Set();
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const w = `activity.jsonl:${i + 1}`;
    let e;
    try { e = JSON.parse(t); }
    catch (err) { v.err(w, `invalid JSON: ${err.message}`); continue; }
    if (!e || typeof e !== "object" || Array.isArray(e)) { v.err(w, "each line must be a JSON object"); continue; }
    for (const k of Object.keys(e)) {
      if (!["id", "ts", "source", "ref", "kind", "label"].includes(k)) v.err(w, `unknown key ${k}`);
    }
    if (typeof e.id !== "string" || !ACT_ID_RE.test(e.id)) v.err(w, `id must match ^act-[a-z0-9][a-z0-9-]*$ (got ${JSON.stringify(e.id)})`);
    else if (ids.has(e.id)) v.err(w, `duplicate activity id ${e.id}`);
    else ids.add(e.id);
    v.ts(w, e, "ts");
    if (!EVIDENCE_SOURCES.has(e.source)) v.err(w, `source must be one of [${[...EVIDENCE_SOURCES].join(", ")}] (got ${JSON.stringify(e.source)})`);
    if (!ACTIVITY_KINDS.has(e.kind)) v.err(w, `kind must be one of [${[...ACTIVITY_KINDS].join(", ")}] (got ${JSON.stringify(e.kind)})`);
    if (typeof e.ref !== "string" || e.ref.length === 0 || e.ref.length > REF_MAX) v.err(w, `ref must be a non-empty string (<= ${REF_MAX} chars)`);
    if (typeof e.label !== "string") v.err(w, "label must be a string");
    else if (e.label.length > CLAIM_MAX) v.err(w, `label must be <= ${CLAIM_MAX} chars (got ${e.label.length})`);
    const key = `${e.source}|${e.ref}|${e.kind}`;
    if (keys.has(key)) v.err(w, `duplicate activity key (source, ref, kind) = ${key} — writers must append by key exactly once`);
    keys.add(key);
  }
}

function validateRoadmap(v, rm) {
  if (!rm || typeof rm !== "object") return { questIds: new Set(), milestoneIds: new Set(), mainQuestMsIds: new Set() };
  if (rm.schemaVersion !== 1) v.err("roadmap", "schemaVersion must be 1");
  // project
  const p = rm.project;
  if (!p || typeof p !== "object") v.err("roadmap.project", "missing");
  else {
    v.reqStr("roadmap.project", p, "name", { allowEmpty: false });
    v.reqStr("roadmap.project", p, "tagline");
    v.ts("roadmap.project", p, "createdAt");
    v.ts("roadmap.project", p, "updatedAt");
  }

  const questIds = new Set();
  const questById = new Map();
  const arr = (x) => Array.isArray(x) ? x : (v.err("roadmap", `${x} not an array`), []);

  // quests
  let mainCount = 0;
  for (const q of Array.isArray(rm.quests) ? rm.quests : []) {
    const w = `roadmap.quests[${q && q.id}]`;
    v.id(w, q, "id", "q");
    if (questIds.has(q.id)) v.err(w, `duplicate quest id ${q.id}`);
    questIds.add(q.id); questById.set(q.id, q);
    if (q.type !== "main" && q.type !== "side") v.err(w, `type must be main|side`);
    if (q.type === "main") {
      mainCount++;
      if (q.parentMilestoneId !== null) v.err(w, "main quest parentMilestoneId must be null");
      if (q.side !== null) v.err(w, "main quest side must be null");
    } else if (q.type === "side") {
      if (q.side !== "left" && q.side !== "right") v.err(w, "side quest side must be left|right");
      v.id(w, q, "parentMilestoneId", "ms");
    }
    v.reqStr(w, q, "title", { allowEmpty: false });
    v.int(w, q, "order");
    v.enum(w, q, "status", STATUS);
    v.ts(w, q, "createdAt");
    v.ts(w, q, "updatedAt");
    v.plainUnclear(w, q, { unclear: false }); // quests get `plain` but not the unclear flag
  }
  if (mainCount !== 1) v.err("roadmap.quests", `exactly one quest must have type "main" (found ${mainCount})`);

  // milestones
  const milestoneIds = new Set();
  const msById = new Map();
  const orderByQuest = new Map(); // questId -> Set of orders
  for (const m of Array.isArray(rm.milestones) ? rm.milestones : []) {
    const w = `roadmap.milestones[${m && m.id}]`;
    v.id(w, m, "id", "ms");
    if (milestoneIds.has(m.id)) v.err(w, `duplicate milestone id ${m.id}`);
    milestoneIds.add(m.id); msById.set(m.id, m);
    v.id(w, m, "questId", "q");
    if (m.questId && !questIds.has(m.questId)) v.err(w, `questId ${m.questId} references no quest (E_PARENT_NOT_FOUND)`);
    v.int(w, m, "order", { min: 0 });
    // unique order per quest
    if (Number.isInteger(m.order)) {
      if (!orderByQuest.has(m.questId)) orderByQuest.set(m.questId, new Set());
      const s = orderByQuest.get(m.questId);
      if (s.has(m.order)) v.err(w, `order ${m.order} duplicated within quest ${m.questId}`);
      s.add(m.order);
    }
    v.reqStr(w, m, "title", { allowEmpty: false });
    v.reqStr(w, m, "summary");
    v.enum(w, m, "status", STATUS);
    v.reqStr(w, m, "statusReason");
    if (m.status === "blocked" && (typeof m.statusReason !== "string" || m.statusReason.length === 0))
      v.err(w, "statusReason required non-empty when status is blocked");
    if (m.eta !== null && (typeof m.eta !== "string" || m.eta.length === 0)) v.err(w, "eta must be null or a non-empty string");
    v.ts(w, m, "startedAt", { nullable: true });
    v.ts(w, m, "completedAt", { nullable: true });
    v.ts(w, m, "createdAt");
    v.ts(w, m, "updatedAt");
    v.plainUnclear(w, m);
    v.dispatchPair(w, m, "unclearDispatchId", "unclearDispatchedAt");
    validateEvidence(v, w, m);
  }

  // main-quest milestone ids (for side-quest branch rule + pins)
  const mainQuestMsIds = new Set();
  for (const m of msById.values()) {
    const q = questById.get(m.questId);
    if (q && q.type === "main") mainQuestMsIds.add(m.id);
  }

  // side quest branch rule (relaxed per dec-nested-branching): a side quest may
  // branch off ANY milestone — a main-quest milestone OR another side quest's
  // milestone. Rules: (1) the parent milestone must exist; (2) it must not
  // belong to the quest itself; (3) walking quest -> parentMs -> that ms's quest
  // -> ... must terminate at a MAIN quest without revisiting a quest (a cycle or
  // a chain that never reaches main is E_BRANCH_CYCLE).
  for (const q of questById.values()) {
    if (q.type !== "side" || typeof q.parentMilestoneId !== "string") continue;
    const w = `roadmap.quests[${q.id}]`;
    const parentMs = msById.get(q.parentMilestoneId);
    if (!parentMs) {
      v.err(w, `parentMilestoneId ${q.parentMilestoneId} references no milestone (E_PARENT_NOT_FOUND)`);
      continue;
    }
    if (parentMs.questId === q.id) {
      v.err(w, `parentMilestoneId ${q.parentMilestoneId} belongs to quest ${q.id} itself (E_BRANCH_CYCLE)`);
      continue;
    }
    // Walk the branch chain up toward a main quest, guarding against cycles.
    const seen = new Set([q.id]);
    let curMs = parentMs, reachedMain = false, cycle = false;
    while (curMs) {
      const owner = questById.get(curMs.questId);
      if (!owner) break; // dangling milestone.questId already errored above
      if (owner.type === "main") { reachedMain = true; break; }
      if (seen.has(owner.id)) { cycle = true; break; }
      seen.add(owner.id);
      if (typeof owner.parentMilestoneId !== "string") break;
      curMs = msById.get(owner.parentMilestoneId);
    }
    if (cycle) v.err(w, `branch chain from ${q.id} revisits a quest — cycle (E_BRANCH_CYCLE)`);
    else if (!reachedMain) v.err(w, `branch chain from ${q.id} does not terminate at a main quest (E_BRANCH_CYCLE)`);
  }

  // items
  const itemIds = new Set();
  const noteIds = new Set();
  for (const it of Array.isArray(rm.items) ? rm.items : []) {
    const w = `roadmap.items[${it && it.id}]`;
    v.id(w, it, "id", "it");
    if (itemIds.has(it.id)) v.err(w, `duplicate item id ${it.id}`);
    itemIds.add(it.id);
    v.id(w, it, "milestoneId", "ms");
    if (it.milestoneId && !milestoneIds.has(it.milestoneId)) v.err(w, `milestoneId ${it.milestoneId} references no milestone (E_PARENT_NOT_FOUND)`);
    v.int(w, it, "order", { min: 0 });
    v.enum(w, it, "kind", new Set(["task", "explanation", "note_to_founder", "blocker"]));
    v.reqStr(w, it, "title", { allowEmpty: false });
    v.reqStr(w, it, "body");
    v.enum(w, it, "status", ITEM_STATUS);
    v.reqStr(w, it, "blockedReason");
    if (it.status === "blocked" && (typeof it.blockedReason !== "string" || it.blockedReason.length === 0))
      v.err(w, "blockedReason required non-empty when status is blocked");
    if (!Array.isArray(it.notes)) v.err(w, "notes must be an array");
    else for (const n of it.notes) {
      const nw = `${w}.notes[${n && n.id}]`;
      v.id(nw, n, "id", "note");
      if (noteIds.has(n.id)) v.err(nw, `duplicate note id ${n.id}`);
      noteIds.add(n.id);
      v.enum(nw, n, "author", new Set(["founder", "agent"]));
      v.reqStr(nw, n, "body", { allowEmpty: false });
      v.ts(nw, n, "ts");
      // Batch-dispatch markers (planner §1.1): pending boolean + disp id/ts pair.
      if (n && "pending" in n && typeof n.pending !== "boolean") v.err(nw, "pending, if present, must be a boolean");
      if (n) v.dispatchPair(nw, n, "dispatchId", "dispatchedAt");
    }
    v.ts(w, it, "createdAt");
    v.ts(w, it, "updatedAt");
    v.plainUnclear(w, it);
    v.dispatchPair(w, it, "unclearDispatchId", "unclearDispatchedAt");
  }

  // assets
  const assetIds = new Set();
  for (const a of Array.isArray(rm.assets) ? rm.assets : []) {
    const w = `roadmap.assets[${a && a.id}]`;
    v.id(w, a, "id", "as");
    if (assetIds.has(a.id)) v.err(w, `duplicate asset id ${a.id}`);
    assetIds.add(a.id);
    v.id(w, a, "milestoneId", "ms");
    if (a.milestoneId && !milestoneIds.has(a.milestoneId)) v.err(w, `milestoneId ${a.milestoneId} references no milestone (E_PARENT_NOT_FOUND)`);
    v.enum(w, a, "kind", new Set(["file", "url", "doc", "command"]));
    v.reqStr(w, a, "label", { allowEmpty: false });
    v.reqStr(w, a, "ref", { allowEmpty: false });
    v.ts(w, a, "addedAt");
  }

  return { questIds, milestoneIds, mainQuestMsIds };
}

function validateDecisions(v, dec, milestoneIds) {
  if (!dec) return;
  if (dec.schemaVersion !== 1) v.err("decisions", "schemaVersion must be 1");
  const ids = new Set();
  for (const d of Array.isArray(dec.decisions) ? dec.decisions : []) {
    const w = `decisions[${d && d.id}]`;
    v.id(w, d, "id", "dec");
    if (ids.has(d.id)) v.err(w, `duplicate decision id ${d.id}`);
    ids.add(d.id);
    v.ts(w, d, "ts");
    v.reqStr(w, d, "title", { allowEmpty: false });
    v.reqStr(w, d, "rationale");
    v.reqStr(w, d, "impact");
    if (!Array.isArray(d.relatedMilestoneIds)) v.err(w, "relatedMilestoneIds must be an array");
    else for (const mid of d.relatedMilestoneIds) {
      if (typeof mid !== "string" || !ID_RE.test(mid)) v.err(w, `relatedMilestoneIds entry invalid: ${JSON.stringify(mid)}`);
      else if (milestoneIds && !milestoneIds.has(mid)) v.err(w, `relatedMilestoneIds ${mid} references no milestone`);
    }
    v.enum(w, d, "proposedBy", new Set(["agent", "founder"]));
    if (typeof d.approved !== "boolean") v.err(w, "approved must be boolean");
    v.enum(w, d, "status", new Set(["proposed", "approved", "rejected", "superseded"]));
    // invariant: approved === true  <=>  status === approved (+ approvedAt set)
    if (d.approved === true) {
      if (d.status !== "approved") v.err(w, "approved:true requires status:approved");
      if (typeof d.approvedAt !== "string" || !TS_RE.test(d.approvedAt)) v.err(w, "approved:true requires approvedAt timestamp");
    } else {
      if (d.status === "approved") v.err(w, "status:approved requires approved:true");
      if (d.approvedAt !== null) v.err(w, "approvedAt must be null when not approved");
    }
    if (d.supersededBy !== null && (typeof d.supersededBy !== "string" || !d.supersededBy.startsWith("dec-")))
      v.err(w, "supersededBy must be null or a dec- id");
    // C4 — `standing` marks a policy ruling that legitimately never becomes a
    // milestone. It is only ever a boolean; the ORPHAN predicate itself is a
    // detector, not a validation error (an orphan is valid data, surfaced to
    // the founder at session start and nudged at stop — never blocked).
    if ("standing" in d && typeof d.standing !== "boolean") v.err(w, "standing, if present, must be a boolean");
    v.plainUnclear(w, d);
    v.dispatchPair(w, d, "unclearDispatchId", "unclearDispatchedAt");
  }
}

function validatePins(v, pins, mainQuestMsIds) {
  if (!pins) return;
  if (pins.schemaVersion !== 1) v.err("pins", "schemaVersion must be 1");
  const ids = new Set();
  for (const p of Array.isArray(pins.pins) ? pins.pins : []) {
    const w = `pins[${p && p.id}]`;
    v.id(w, p, "id", "pin");
    if (ids.has(p.id)) v.err(w, `duplicate pin id ${p.id}`);
    ids.add(p.id);
    v.ts(w, p, "ts");
    if (p.kind !== "compaction" && p.kind !== "save_point") v.err(w, 'kind must be "compaction" or "save_point"');
    v.reqStr(w, p, "label", { allowEmpty: false });
    if (p.afterMilestoneId !== null) {
      v.id(w, p, "afterMilestoneId", "ms");
      if (typeof p.afterMilestoneId === "string" && mainQuestMsIds && !mainQuestMsIds.has(p.afterMilestoneId))
        v.err(w, `afterMilestoneId ${p.afterMilestoneId} must be a main-quest milestone or null`);
    }
    v.reqStr(w, p, "summary");
    if (p.synthesisDocPath !== null && (typeof p.synthesisDocPath !== "string" || p.synthesisDocPath.length === 0))
      v.err(w, "synthesisDocPath must be null or a non-empty string");
    // Optional save-point extras (continuity §2 / PreCompact hook).
    if ("sessionId" in p && p.sessionId !== null && (typeof p.sessionId !== "string" || p.sessionId.length === 0 || p.sessionId.length > 200))
      v.err(w, "sessionId, if present, must be null or a non-empty string (<=200 chars)");
    if ("synthesisPending" in p && typeof p.synthesisPending !== "boolean")
      v.err(w, "synthesisPending, if present, must be a boolean");
  }
}

// batons.json is OPTIONAL per roadmap (continuity §2). ABSENT is normal — no
// output at all. PRESENT is validated strictly. Kept a separate file so the
// strict roadmap schema stays untouched.
const BATON_ID_RE = /^baton-[0-9a-f]{8}$/;
function validateBatons(v, file) {
  if (!fs.existsSync(file)) return; // absence is normal — emit nothing
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { v.err("batons.json", `invalid JSON: ${e.message}`); return; }
  if (!data || typeof data !== "object" || Array.isArray(data)) { v.err("batons", "must be an object"); return; }
  if (data.schemaVersion !== 1) v.err("batons", "schemaVersion must be 1");
  if (!Array.isArray(data.batons)) { v.err("batons", "batons must be an array"); return; }
  const ids = new Set();
  const hasCtrl = (s) => { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 0x20 || c === 0x7f) return true; } return false; };
  const sidOk = (x) => typeof x === "string" && x.length > 0 && x.length <= 200 && !hasCtrl(x);
  const strList = (w, obj, key) => {
    if (!Array.isArray(obj[key])) { v.err(w, `${key} must be an array of strings`); return; }
    for (const s of obj[key]) if (typeof s !== "string") v.err(w, `${key} entries must be strings`);
  };
  for (const b of data.batons) {
    if (!b || typeof b !== "object" || Array.isArray(b)) { v.err("batons", "each baton must be an object"); continue; }
    const w = `batons[${b.id}]`;
    if (typeof b.id !== "string" || !BATON_ID_RE.test(b.id)) v.err(w, "id must match ^baton-[0-9a-f]{8}$");
    else { if (ids.has(b.id)) v.err(w, `duplicate baton id ${b.id}`); ids.add(b.id); }
    v.ts(w, b, "ts");
    if (!sidOk(b.fromSessionId)) v.err(w, "fromSessionId must be a non-empty string (<=200 chars, no control chars)");
    if (b.toSessionId !== null && !sidOk(b.toSessionId)) v.err(w, "toSessionId must be null or a non-empty string (<=200 chars)");
    if (typeof b.label !== "string" || b.label.length === 0) v.err(w, "label must be a non-empty string");
    strList(w, b, "done");
    strList(w, b, "inFlight");
    strList(w, b, "next");
    strList(w, b, "warnings");
    if (b.docPath !== null && (typeof b.docPath !== "string" || b.docPath.length === 0)) v.err(w, "docPath must be null or a non-empty string");
    if (b.status !== "open" && b.status !== "picked_up") v.err(w, 'status must be "open" or "picked_up"');
    if (b.status === "picked_up" && b.toSessionId === null) v.err(w, "picked_up baton must have a toSessionId");
  }
}

// conflicts.json is OPTIONAL per roadmap (the founder's ruling, 2026-08-27).
// ABSENT is normal — a road where nothing has ever collided has no file, and
// the validator emits nothing at all. PRESENT is validated strictly.
//
// One cross-file rule lives here and nowhere else: an OPEN conflict must point
// at a record that still exists. A hold on a deleted record is not an argument
// anybody can settle, so the delete paths VOID it (status "void" + voidReason)
// rather than leaving it dangling. A dangling open conflict means one of them
// forgot, and that is exactly what this catches.
const CONFLICT_TARGETS = new Set(["milestone", "item", "quest", "decision", "term"]);
function validateConflicts(v, file, knownIds) {
  if (!fs.existsSync(file)) return; // absence is normal — emit nothing
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { v.err("conflicts.json", `invalid JSON: ${e.message}`); return; }
  if (!data || typeof data !== "object" || Array.isArray(data)) { v.err("conflicts", "must be an object"); return; }
  if (data.schemaVersion !== 1) v.err("conflicts", "schemaVersion must be 1");
  if (!Array.isArray(data.conflicts)) { v.err("conflicts", "conflicts must be an array"); return; }
  const ids = new Set();
  const nonEmptyStr = (x) => typeof x === "string" && x.length > 0;
  for (const c of data.conflicts) {
    if (!c || typeof c !== "object" || Array.isArray(c)) { v.err("conflicts", "each conflict must be an object"); continue; }
    const w = `conflicts[${c && c.id}]`;
    v.id(w, c, "id", "cf");
    if (typeof c.id === "string") { if (ids.has(c.id)) v.err(w, `duplicate conflict id ${c.id}`); ids.add(c.id); }
    v.ts(w, c, "ts");
    v.enum(w, c, "status", new Set(["open", "ruled", "void"]));
    v.enum(w, c, "targetType", CONFLICT_TARGETS);
    v.enum(w, c, "source", new Set(["mcp", "ui"]));
    v.enum(w, c, "actor", new Set(["agent", "founder"]));
    v.reqStr(w, c, "action", { allowEmpty: false });
    if (typeof c.targetId !== "string" || !ID_RE.test(c.targetId)) v.err(w, "targetId must be an id");
    if (!nonEmptyStr(c.baseVersion)) v.err(w, "baseVersion must be a non-empty string");
    if (!nonEmptyStr(c.currentVersion)) v.err(w, "currentVersion must be a non-empty string");
    // BOTH versions, always: a conflict that lost one of them is a receipt, not
    // a decision, and the whole point of this file is that it is not that.
    if (!c.current || typeof c.current !== "object" || Array.isArray(c.current))
      v.err(w, "current must be the whole record as it stood");
    if (c.proposed !== null && (typeof c.proposed !== "object" || Array.isArray(c.proposed)))
      v.err(w, "proposed must be an object, or null for a held delete (which proposes no record)");
    if ("sessionId" in c && (typeof c.sessionId !== "string" || c.sessionId.length === 0 || c.sessionId.length > 200))
      v.err(w, "sessionId, if present, must be a non-empty string (<=200 chars)");
    // ruling exists iff ruled — no ruling on an open argument, and no ruled
    // conflict without the ruling that settled it.
    const hasRuling = "ruling" in c && c.ruling !== undefined && c.ruling !== null;
    if (c.status === "ruled") {
      if (!hasRuling || typeof c.ruling !== "object" || Array.isArray(c.ruling)) { v.err(w, "a ruled conflict must carry a ruling object"); }
      else {
        v.enum(`${w}.ruling`, c.ruling, "keep", new Set(["current", "held"]));
        v.ts(`${w}.ruling`, c.ruling, "ts");
      }
    } else if (hasRuling) {
      v.err(w, `status is "${c.status}" but a ruling is recorded — only a ruled conflict has one`);
    }
    if (c.status === "void" && !nonEmptyStr(c.voidReason)) v.err(w, "a void conflict must say why (voidReason)");
    if (c.status === "open" && typeof c.targetId === "string" && c.targetType !== "term"
        && knownIds && !knownIds.has(c.targetId)) {
      v.err(w, `open conflict targets ${c.targetId}, which is not on the road (a deleted target's conflicts must be voided, not left open)`);
    }
  }
}

function validateHistory(v, file) {
  if (!fs.existsSync(file)) { v.err("history.jsonl", "file missing"); return; }
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n");
  const ids = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue; // tolerate trailing newline / blank lines
    let e;
    try { e = JSON.parse(line); }
    catch (err) { v.err(`history.jsonl:${i + 1}`, `invalid JSON: ${err.message}`); continue; }
    const w = `history.jsonl:${i + 1}`;
    v.id(w, e, "id", "evt");
    if (ids.has(e.id)) v.err(w, `duplicate event id ${e.id}`);
    ids.add(e.id);
    v.ts(w, e, "ts");
    v.enum(w, e, "actor", new Set(["agent", "founder", "system"]));
    v.enum(w, e, "source", new Set(["mcp", "ui", "file", "hook"]));
    v.reqStr(w, e, "action", { allowEmpty: false });
    if (e.targetId !== null && (typeof e.targetId !== "string" || !ID_RE.test(e.targetId)))
      v.err(w, `targetId must be null or an id (got ${JSON.stringify(e.targetId)})`);
    v.reqStr(w, e, "summary", { allowEmpty: false });
    if ("patch" in e && (typeof e.patch !== "object" || e.patch === null || Array.isArray(e.patch)))
      v.err(w, "patch, if present, must be an object");
    // Optional sessionId (Build Plan §1.3): type + non-empty only, no prefix rule.
    if ("sessionId" in e && (typeof e.sessionId !== "string" || e.sessionId.length === 0))
      v.err(w, "sessionId, if present, must be a non-empty string");
  }
}

// sessions.json is OPTIONAL per roadmap (Build Plan §1.2). ABSENT is normal —
// no output at all (not even a warning). PRESENT is validated strictly.
function validateSessions(v, file) {
  if (!fs.existsSync(file)) return; // absence is normal — emit nothing
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { v.err("sessions.json", `invalid JSON: ${e.message}`); return; }
  if (!data || typeof data !== "object" || Array.isArray(data)) { v.err("sessions", "must be an object"); return; }
  if (data.schemaVersion !== 1) v.err("sessions", "schemaVersion must be 1");
  if (!Array.isArray(data.sessions)) { v.err("sessions", "sessions must be an array"); return; }
  const ids = new Set();
  for (const s of data.sessions) {
    if (!s || typeof s !== "object" || Array.isArray(s)) { v.err("sessions", "each session must be an object"); continue; }
    const w = `sessions[${s.id}]`;
    // id: free-form non-empty string (NOT the id regex), <=200 chars, no control chars, unique.
    if (typeof s.id !== "string" || s.id.length === 0) {
      v.err(w, "id must be a non-empty string");
    } else {
      if (s.id.length > 200) v.err(w, "id must be <= 200 characters");
      for (let i = 0; i < s.id.length; i++) { const c = s.id.charCodeAt(i); if (c < 0x20 || c === 0x7f) { v.err(w, "id must not contain control characters"); break; } }
      if (ids.has(s.id)) v.err(w, `duplicate session id ${s.id}`);
      ids.add(s.id);
    }
    v.ts(w, s, "firstSeenAt");
    v.ts(w, s, "lastSeenAt");
    if (typeof s.label !== "string") v.err(w, "label must be a string");
    v.int(w, s, "eventCount", { min: 0 });
    // Optional continuity fields (§2 / pulse hook). Old files omit them.
    if ("lastPulse" in s && s.lastPulse !== null && (typeof s.lastPulse !== "string" || !TS_RE.test(s.lastPulse)))
      v.err(w, "lastPulse, if present, must be null or an ISO-8601 UTC ms timestamp");
    if ("focus" in s && (typeof s.focus !== "string" || s.focus.length > 120))
      v.err(w, "focus, if present, must be a string of <=120 chars");
    // C5 — the dirty bit. Both keys are optional and ABSENCE IS CLEAN, so every
    // road written before the bit existed validates unchanged. dirtyAt only ever
    // rides along with dirty:true (it is deleted when the bit is cleared).
    if ("dirty" in s && typeof s.dirty !== "boolean")
      v.err(w, "dirty, if present, must be a boolean");
    if ("dirtyAt" in s && s.dirtyAt !== null && (typeof s.dirtyAt !== "string" || !TS_RE.test(s.dirtyAt)))
      v.err(w, "dirtyAt, if present, must be null or an ISO-8601 UTC ms timestamp");
    if (s.dirtyAt && s.dirty !== true)
      v.err(w, "dirtyAt is only meaningful alongside dirty:true — a cleared bit drops the stamp");
  }
}

// suggestions.json is OPTIONAL per roadmap (Horizon suggestions). ABSENT is
// normal — no output at all. PRESENT is validated strictly. Suggestions are
// possibilities floated past a road-end, NEVER milestones and NEVER counted in
// any tally, so they live in their own file (roadmap.json's schema is untouched).
// HORIZON TREES (dec-horizon-tree): a suggestion MAY carry branchIndex (0-4,
// which parallel direction) + seqIndex (0-2, position along it). A group WITH
// branchIndex anywhere may hold up to 5 x 3 = 15 records and no two may claim
// the same (branchIndex, seqIndex) seat; a LEGACY group (none of them carries
// branchIndex) keeps the original max of 3.
const SUGGESTION_ID_RE = /^sg-[0-9a-f]{8}$/;
const REQUEST_ID_RE = /^rq-[0-9a-f]{8}$/;
function validateSuggestions(v, file, milestoneIds, questIds) {
  if (!fs.existsSync(file)) return; // absence is normal — emit nothing
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { v.err("suggestions.json", `invalid JSON: ${e.message}`); return; }
  if (!data || typeof data !== "object" || Array.isArray(data)) { v.err("suggestions", "must be an object"); return; }
  if (data.schemaVersion !== 1) v.err("suggestions", "schemaVersion must be 1");
  if (!Array.isArray(data.suggestions)) { v.err("suggestions", "suggestions must be an array"); return; }
  const ids = new Set();
  const perFrontier = new Map(); // anchor -> {n, grouped, seats:Set}
  for (const s of data.suggestions) {
    if (!s || typeof s !== "object" || Array.isArray(s)) { v.err("suggestions", "each suggestion must be an object"); continue; }
    const w = `suggestions[${s && s.id}]`;
    if (typeof s.id !== "string" || !SUGGESTION_ID_RE.test(s.id)) v.err(w, "id must match ^sg-[0-9a-f]{8}$");
    else { if (ids.has(s.id)) v.err(w, `duplicate suggestion id ${s.id}`); ids.add(s.id); }
    if (typeof s.frontierMilestoneId !== "string" || !ID_RE.test(s.frontierMilestoneId) || !s.frontierMilestoneId.startsWith("ms-"))
      v.err(w, "frontierMilestoneId must be an ms- id");
    else if (milestoneIds && !milestoneIds.has(s.frontierMilestoneId))
      v.err(w, `frontierMilestoneId ${s.frontierMilestoneId} not found in roadmap`);
    if (typeof s.questId !== "string" || !ID_RE.test(s.questId) || !s.questId.startsWith("q-"))
      v.err(w, "questId must be a q- id");
    else if (questIds && !questIds.has(s.questId))
      v.err(w, `questId ${s.questId} not found in roadmap`);
    v.reqStr(w, s, "title", { allowEmpty: false });
    v.reqStr(w, s, "plain", { allowEmpty: false });
    if ("summary" in s && typeof s.summary !== "string") v.err(w, "summary, if present, must be a string");
    v.int(w, s, "order", { min: 0 });
    v.ts(w, s, "createdAt");
    v.ts(w, s, "updatedAt");
    // horizon-tree grouping fields — both OPTIONAL, but seqIndex needs branchIndex
    const hasB = "branchIndex" in s && s.branchIndex !== undefined;
    const hasS = "seqIndex" in s && s.seqIndex !== undefined;
    if (hasB && (!Number.isInteger(s.branchIndex) || s.branchIndex < 0 || s.branchIndex > 4))
      v.err(w, "branchIndex, if present, must be an integer 0-4");
    if (hasS && (!Number.isInteger(s.seqIndex) || s.seqIndex < 0 || s.seqIndex > 2))
      v.err(w, "seqIndex, if present, must be an integer 0-2");
    if (hasS && !hasB) v.err(w, "seqIndex requires branchIndex (a sequential child belongs to a parallel direction)");
    if (typeof s.frontierMilestoneId === "string") {
      let g = perFrontier.get(s.frontierMilestoneId);
      if (!g) { g = { n: 0, grouped: false, seats: new Set() }; perFrontier.set(s.frontierMilestoneId, g); }
      g.n++;
      if (hasB) {
        g.grouped = true;
        const seat = `${s.branchIndex}:${hasS ? s.seqIndex : 0}`;
        if (g.seats.has(seat)) v.err(w, `two suggestions claim seat (branchIndex ${s.branchIndex}, seqIndex ${hasS ? s.seqIndex : 0}) at anchor ${s.frontierMilestoneId}`);
        g.seats.add(seat);
      }
      if (g.n === 16) v.err(w, `more than 15 suggestions at anchor ${s.frontierMilestoneId} (max 5 directions x 3 steps)`);
      if (!g.grouped && g.n === 4) v.err(w, `more than 3 legacy suggestions for road-end ${s.frontierMilestoneId} (max 3 without branchIndex)`);
    }
  }
  // requests[] — pending founder commissions (additive, optional).
  if ("requests" in data && data.requests !== undefined) {
    if (!Array.isArray(data.requests)) { v.err("suggestions", "requests, if present, must be an array"); return; }
    const rids = new Set();
    for (const r of data.requests) {
      if (!r || typeof r !== "object" || Array.isArray(r)) { v.err("suggestions.requests", "each request must be an object"); continue; }
      const w = `suggestions.requests[${r && r.id}]`;
      if (typeof r.id !== "string" || !REQUEST_ID_RE.test(r.id)) v.err(w, "id must match ^rq-[0-9a-f]{8}$");
      else { if (rids.has(r.id)) v.err(w, `duplicate request id ${r.id}`); rids.add(r.id); }
      if (typeof r.milestoneId !== "string" || !ID_RE.test(r.milestoneId) || !r.milestoneId.startsWith("ms-"))
        v.err(w, "milestoneId must be an ms- id");
      else if (milestoneIds && !milestoneIds.has(r.milestoneId))
        v.err(w, `milestoneId ${r.milestoneId} not found in roadmap`);
      v.ts(w, r, "requestedAt");
      if ("sessionId" in r && (typeof r.sessionId !== "string" || !r.sessionId || r.sessionId.length > 200))
        v.err(w, "sessionId, if present, must be a non-empty string of <=200 chars");
    }
  }
}

// Structural validation of glossary.json (Build Plan Section 1.1) + builds the
// surface-form membership sets used by the jargon lint. Returns { csSet, ciSet }
// where csSet holds case-sensitive (all-caps) surfaces compared exactly and
// ciSet holds the rest, lowercased.
function validateGlossary(v, gloss) {
  const csSet = new Set();
  const ciSet = new Set();
  if (!gloss || typeof gloss !== "object") { v.err("glossary", "must be an object"); return { csSet, ciSet }; }
  if (gloss.schemaVersion !== 1) v.err("glossary", "schemaVersion must be 1");
  if (!Array.isArray(gloss.terms)) { v.err("glossary", "terms must be an array"); return { csSet, ciSet }; }

  const ids = new Set();
  const surfaceOwner = new Map(); // membership key -> first term id that claimed it
  for (const t of gloss.terms) {
    const w = `glossary.terms[${t && t.id}]`;
    v.id(w, t, "id", "term");
    if (t && ids.has(t.id)) v.err(w, `duplicate term id ${t.id}`);
    if (t) ids.add(t.id);
    v.reqStr(w, t, "term", { allowEmpty: false });
    v.reqStr(w, t, "plain", { allowEmpty: false });
    if (t && "note" in t && typeof t.note !== "string") v.err(w, "note, if present, must be a string");
    if (t && "link" in t && t.link !== null && (typeof t.link !== "string" || t.link.length === 0))
      v.err(w, "link, if present, must be null or a non-empty string");
    let aliases = [];
    if (t && "aliases" in t) {
      if (!Array.isArray(t.aliases)) v.err(w, "aliases, if present, must be an array");
      else { aliases = t.aliases; for (const a of aliases) if (typeof a !== "string" || a.length === 0) v.err(w, `aliases entry must be a non-empty string (got ${JSON.stringify(a)})`); }
    }
    if (!t) continue;
    // Collect surface forms and enforce uniqueness across ALL entries (Section 2.1 case rule).
    const surfaces = [t.term, ...aliases].filter((s) => typeof s === "string" && s.length > 0);
    for (const s of surfaces) {
      const cs = CASE_SENSITIVE_RE.test(s);
      const key = cs ? "cs:" + s : "ci:" + s.toLowerCase();
      if (surfaceOwner.has(key)) v.err(w, `surface form "${s}" duplicates one already defined by ${surfaceOwner.get(key)}`);
      else surfaceOwner.set(key, t.id);
      if (cs) csSet.add(s); else ciSet.add(s.toLowerCase());
    }
  }
  return { csSet, ciSet };
}

// Membership test (Section 2.3): a token/codename passes iff it is in the
// stoplist OR equals some glossary surface (exact for all-caps, case-insensitive
// otherwise).
function passesJargon(token, csSet, ciSet) {
  if (STOPLIST.has(token)) return true;
  if (csSet.has(token)) return true;
  if (ciSet.has(token.toLowerCase())) return true;
  return false;
}

// Strip backtick code spans and bare URLs before tokenizing (code is code, not prose).
function preStrip(s) {
  return s.replace(/`[^`]*`/g, " ").replace(/https?:\/\/[^\s]+/g, " ");
}

function lintField(v, where, text, csSet, ciSet, seen) {
  if (typeof text !== "string" || text.length === 0) return;
  const stripped = preStrip(text);
  // Codenames handled by their own class; remove them before the acronym scan so a
  // single [[TOKEN]] is not double-reported.
  const forAcronyms = stripped.replace(CODENAME_RE, " ");
  // Both dedupe keys below join on U+0000, impossible inside a field path or a
  // token. Escapes, never raw bytes: a raw NUL makes git call this file binary.
  let m;
  ACRONYM_RE.lastIndex = 0;
  while ((m = ACRONYM_RE.exec(forAcronyms))) {
    const tok = m[0];
    if (passesJargon(tok, csSet, ciSet)) continue;
    const key = where + "\u0000" + tok;
    if (!seen.has(key)) { seen.add(key); v.err(where, `jargon "${tok}" not in glossary.json (define it or rewrite)`); }
  }
  CODENAME_RE.lastIndex = 0;
  while ((m = CODENAME_RE.exec(stripped))) {
    const inner = m[1];
    if (passesJargon(inner, csSet, ciSet)) continue;
    const key = where + "\u0000[[" + inner + "]]";
    if (!seen.has(key)) { seen.add(key); v.err(where, `codename "[[${inner}]]" not in glossary.json`); }
  }
}

// Scan every prose field (Section 2.3 field list) for undefined jargon.
// history.jsonl is intentionally NOT scanned (append-only past). Neither is
// conflicts.json, for the same reason and one more: its entries are COPIES of
// records that were already linted where they live, and the held version may
// legitimately carry a term nobody has defined yet — the lint must never be the
// thing that blocks a hold.
function runJargonLint(v, rm, dec, pins, gloss, csSet, ciSet, sug) {
  const seen = new Set();
  const F = (where, text) => lintField(v, where, text, csSet, ciSet, seen);
  if (rm && typeof rm === "object") {
    if (rm.project && typeof rm.project === "object") {
      F("roadmap.project.name", rm.project.name);
      F("roadmap.project.tagline", rm.project.tagline);
    }
    for (const q of Array.isArray(rm.quests) ? rm.quests : []) {
      const w = `roadmap.quests[${q && q.id}]`;
      F(`${w}.title`, q && q.title);
      F(`${w}.plain`, q && q.plain);
    }
    for (const m of Array.isArray(rm.milestones) ? rm.milestones : []) {
      const w = `roadmap.milestones[${m && m.id}]`;
      F(`${w}.title`, m && m.title);
      F(`${w}.summary`, m && m.summary);
      F(`${w}.statusReason`, m && m.statusReason);
      F(`${w}.plain`, m && m.plain);
    }
    for (const it of Array.isArray(rm.items) ? rm.items : []) {
      const w = `roadmap.items[${it && it.id}]`;
      F(`${w}.title`, it && it.title);
      F(`${w}.body`, it && it.body);
      F(`${w}.blockedReason`, it && it.blockedReason);
      F(`${w}.plain`, it && it.plain);
      for (const n of it && Array.isArray(it.notes) ? it.notes : [])
        F(`${w}.notes[${n && n.id}].body`, n && n.body);
    }
    for (const a of Array.isArray(rm.assets) ? rm.assets : []) {
      const w = `roadmap.assets[${a && a.id}]`;
      F(`${w}.label`, a && a.label);
    }
  }
  for (const d of dec && Array.isArray(dec.decisions) ? dec.decisions : []) {
    const w = `decisions[${d && d.id}]`;
    F(`${w}.title`, d && d.title);
    F(`${w}.rationale`, d && d.rationale);
    F(`${w}.impact`, d && d.impact);
    F(`${w}.plain`, d && d.plain);
  }
  for (const p of pins && Array.isArray(pins.pins) ? pins.pins : []) {
    const w = `pins[${p && p.id}]`;
    F(`${w}.label`, p && p.label);
    F(`${w}.summary`, p && p.summary);
  }
  for (const t of gloss && Array.isArray(gloss.terms) ? gloss.terms : []) {
    const w = `glossary.terms[${t && t.id}]`;
    F(`${w}.plain`, t && t.plain);
    F(`${w}.note`, t && t.note);
  }
  for (const s of sug && Array.isArray(sug.suggestions) ? sug.suggestions : []) {
    const w = `suggestions[${s && s.id}]`;
    F(`${w}.title`, s && s.title);
    F(`${w}.plain`, s && s.plain);
    F(`${w}.summary`, s && s.summary);
  }
}

export function validateDir(projectRoot) {
  const v = new V();
  const dataDir = path.join(projectRoot, ".questlog");
  if (!fs.existsSync(dataDir)) { v.err(".questlog", `directory not found at ${dataDir}`); return v.errors; }

  const rm = readJson(v, path.join(dataDir, "roadmap.json"));
  const dec = readJson(v, path.join(dataDir, "decisions.json"));
  const pins = readJson(v, path.join(dataDir, "pins.json"));

  const { questIds, milestoneIds, mainQuestMsIds } = validateRoadmap(v, rm);
  validateDecisions(v, dec, milestoneIds);
  validatePins(v, pins, mainQuestMsIds);
  validateHistory(v, path.join(dataDir, "history.jsonl"));
  validateSessions(v, path.join(dataDir, "sessions.json"));
  validateBatons(v, path.join(dataDir, "batons.json"));
  validateActivity(v, path.join(dataDir, "activity.jsonl"));
  const sugPath = path.join(dataDir, "suggestions.json");
  validateSuggestions(v, sugPath, milestoneIds, questIds);
  const sug = fs.existsSync(sugPath) ? readJson(v, sugPath) : null;

  // Held colliding writes. Every id an open conflict may point at: the road's
  // own records plus the decisions, which are the other thing two writers argue
  // over (glossary terms are excluded — this validator never collects term ids).
  const conflictTargets = new Set([...milestoneIds, ...questIds]);
  for (const it of (rm && Array.isArray(rm.items) ? rm.items : [])) if (it && typeof it.id === "string") conflictTargets.add(it.id);
  for (const d of (dec && Array.isArray(dec.decisions) ? dec.decisions : [])) if (d && typeof d.id === "string") conflictTargets.add(d.id);
  validateConflicts(v, path.join(dataDir, "conflicts.json"), conflictTargets);

  // glossary.json is OPTIONAL per project. Present => validate + run the jargon
  // lint. Absent => warn on stdout and skip the lint (Build Plan Section 1.4).
  const glossPath = path.join(dataDir, "glossary.json");
  if (fs.existsSync(glossPath)) {
    const gloss = readJson(v, glossPath);
    if (gloss) {
      const { csSet, ciSet } = validateGlossary(v, gloss);
      runJargonLint(v, rm, dec, pins, gloss, csSet, ciSet, sug);
    }
  } else {
    console.log("WARNING: no glossary.json — jargon lint skipped");
  }

  return v.errors;
}

// CLI entry
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = parseArgs(process.argv.slice(2));
  const errors = validateDir(root);
  if (errors.length === 0) {
    console.log(`OK: ${path.join(root, ".questlog")} is valid against questlog schema (Section 1).`);
    process.exit(0);
  } else {
    console.error(`INVALID: ${errors.length} error(s) in ${path.join(root, ".questlog")}:`);
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }
}
