#!/usr/bin/env node
// ---------------------------------------------------------------------------
// QUESTLOG — ROADMAP CURRENCY (decision dec-currency-architecture).
//
// GOVERNING PRINCIPLE, binding on everything in this file: AUTOMATE OBSERVATION
// AND ABSENCE-DETECTION; INSTRUCT INTERPRETATION. Every function here either
// records that something was CLAIMED, or notices that something is MISSING.
// Not one of them decides whether a claim is true. Hooks enforce liveness,
// never correctness.
//
// Zero dependencies. Pure except for the two ledger helpers at the bottom,
// which do file IO and are always called by a caller that already holds the
// road lock.
//
// What lives here:
//   C1  assertLinkedOrChore  — the launch gate every INTERNAL questlog spawner
//                              runs before it spawns. A run must name a
//                              milestone that RESOLVES, or declare itself a
//                              chore. (We cannot gate what we do not launch —
//                              see raidLinkage for the detection-only half.)
//   C2  the evidence plane   — append-only, idempotent by (source, ref, kind),
//                              retraction by tombstone, never by deletion.
//   C3  refuseStatusWrite    — automation may write evidence; it may NEVER
//                              write status. This is the enforcement point.
//   C4  isOrphanDecision     — an approved decision that names no milestone and
//                              claims no standing is unrecorded planned work.
//   C7  coverage             — today's chores vs linked vs unlinked, so the
//                              escape hatch stays countable.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import crypto from "node:crypto";

export const EVIDENCE_SOURCES = Object.freeze(["bridge", "sidecar", "raid-watcher", "session", "hook"]);
export const EVIDENCE_KINDS = Object.freeze(["launch", "finish", "verdict", "abandon", "retract"]);
export const ACTIVITY_KINDS = Object.freeze(["launch", "finish", "abandon"]);
export const CLAIM_MAX = 500;
export const REF_MAX = 200;

const SOURCE_SET = new Set(EVIDENCE_SOURCES);
const KIND_SET = new Set(EVIDENCE_KINDS);
const ACT_KIND_SET = new Set(ACTIVITY_KINDS);
const TS_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

const nowIso = () => new Date().toISOString();
const genId = (prefix) => `${prefix}-${crypto.randomBytes(4).toString("hex")}`;

// ---------------------------------------------------------------------------
// C3 — THE STATUS PLANE IS NOT WRITABLE BY AUTOMATION.
//
// Title, plain wording, status and order stay writable only by sessions and the
// founder. Any hook / watcher / evidence write path runs its payload through
// here first. Returns null when clean, or an error record when the payload
// tried to touch a judged field. Callers REFUSE on a non-null result — they do
// not silently strip, because a silent strip hides an attempted violation.
// ---------------------------------------------------------------------------
export const JUDGED_FIELDS = Object.freeze(["status", "statusReason", "title", "plain", "order"]);
export function refuseStatusWrite(payload) {
  if (!payload || typeof payload !== "object") return null;
  for (const f of JUDGED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, f)) {
      return { code: "E_AUTOMATION_STATUS", field: f, message: `automation may never write ${f} — status is session/founder-only (C3)` };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// C1 — THE LAUNCH GATE (hard, and only where it is genuinely enforceable).
//
// A workflow must name a milestone that resolves on THIS road, or declare
// itself a chore, before it runs. Used by every spawner questlog itself owns:
// the bridge (per-note and batch), the sidecar repair launcher, the horizon
// request drain, session resume, and distillation.
//
// HONESTY LIMIT (documented, not worked around): questlog cannot gate Claude
// Code's own workflow tool, or any agent launched outside questlog. Those are
// DETECTED and labelled `unlinked` by raidLinkage below — never prevented.
// ---------------------------------------------------------------------------
export function milestoneResolves(roadmap, milestoneId) {
  if (typeof milestoneId !== "string" || !milestoneId) return false;
  const list = roadmap && Array.isArray(roadmap.milestones) ? roadmap.milestones : [];
  return list.some((m) => m && m.id === milestoneId);
}

export function assertLinkedOrChore({ roadmap, milestoneId, chore } = {}) {
  if (chore === true) return { ok: true, chore: true, milestoneId: null };
  if (milestoneResolves(roadmap, milestoneId)) return { ok: true, chore: false, milestoneId };
  return {
    ok: false,
    chore: false,
    reason: "E_UNLINKED",
    message: typeof milestoneId === "string" && milestoneId
      ? `milestoneId ${milestoneId} does not resolve on this road — name a milestone that exists, or declare this run a chore`
      : "this run named no milestone and no chore flag — name a milestone, or declare it a chore",
  };
}

// ---------------------------------------------------------------------------
// C2 — THE EVIDENCE PLANE.
//
// An entry records that something was CLAIMED: by whom (source), about which
// run (ref), when (ts), and in the writer's own words (claim, verbatim, never
// interpreted). The idempotency key is (source, ref, kind): a watcher restart
// re-observing the same journal MUST leave the file byte-identical.
// ---------------------------------------------------------------------------
export function evidenceKey(e) {
  if (!e || typeof e !== "object") return null;
  return `${e.source}|${e.ref}|${e.kind}`;
}

// Validate + normalize a candidate entry. Returns { entry } or { error }.
// Key order is fixed so a re-write of an unchanged array is byte-identical.
export function normalizeEvidenceEntry(raw, deps = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "evidence entry must be an object" };
  const bad = refuseStatusWrite(raw);
  if (bad) return { error: bad.message, code: bad.code };
  const source = raw.source;
  if (!SOURCE_SET.has(source)) return { error: `source must be one of ${EVIDENCE_SOURCES.join("|")}` };
  const kind = raw.kind;
  if (!KIND_SET.has(kind)) return { error: `kind must be one of ${EVIDENCE_KINDS.join("|")}` };
  const ref = raw.ref;
  if (typeof ref !== "string" || !ref.length || ref.length > REF_MAX) return { error: `ref must be a non-empty string (<= ${REF_MAX} chars)` };
  const claim = raw.claim === undefined ? "" : raw.claim;
  if (typeof claim !== "string") return { error: "claim must be a string" };
  if (claim.length > CLAIM_MAX) return { error: `claim must be <= ${CLAIM_MAX} chars` };
  let ts = raw.ts;
  if (ts === undefined) ts = (deps.now || nowIso)();
  if (typeof ts !== "string" || !TS_RE.test(ts)) return { error: "ts must be an ISO-8601 UTC ms timestamp" };

  const entry = { ts, source, kind, ref, claim };
  if (kind === "verdict") {
    if (typeof raw.ship !== "boolean") return { error: "a verdict entry requires ship: true|false" };
    entry.ship = raw.ship;
  } else if (raw.ship !== undefined) {
    return { error: "ship is only valid on a verdict entry" };
  }
  if (kind === "retract") {
    if (typeof raw.tombstonesRef !== "string" || !raw.tombstonesRef.length) {
      return { error: 'a retract entry requires tombstonesRef: "<source>|<ref>|<kind>"' };
    }
    entry.tombstonesRef = raw.tombstonesRef;
  } else if (raw.tombstonesRef !== undefined) {
    return { error: "tombstonesRef is only valid on a retract entry" };
  }
  if (raw.sessionId !== undefined && raw.sessionId !== null) {
    const sid = raw.sessionId;
    if (typeof sid !== "string" || !sid.length || sid.length > 200) return { error: "sessionId must be a non-empty string (<= 200 chars)" };
    entry.sessionId = sid;
  }
  return { entry };
}

// Upsert-by-key. An entry whose (source, ref, kind) is already present is a
// NO-OP: the array is returned unchanged and changed:false, so the caller can
// skip the write entirely and the file stays byte-identical.
export function upsertEvidence(list, entry) {
  const arr = Array.isArray(list) ? list : [];
  const k = evidenceKey(entry);
  for (const e of arr) if (evidenceKey(e) === k) return { list: arr, changed: false, reason: "duplicate" };
  return { list: arr.concat([entry]), changed: true };
}

// The set of keys tombstoned by a live retract entry.
export function tombstonedKeys(list) {
  const out = new Set();
  for (const e of Array.isArray(list) ? list : []) {
    if (e && e.kind === "retract" && typeof e.tombstonesRef === "string") out.add(e.tombstonesRef);
  }
  return out;
}

// "live" = not tombstoned by a matching retract. Retract entries themselves are
// bookkeeping, not observations, so they are excluded from the live view.
export function liveEvidence(list) {
  const arr = Array.isArray(list) ? list : [];
  const dead = tombstonedKeys(arr);
  return arr.filter((e) => e && e.kind !== "retract" && !dead.has(evidenceKey(e)));
}

// ORDER COMES FROM TIMESTAMPS, NEVER FILE POSITION. Every comparison below
// sorts by ts first.
export function byTs(a, b) {
  const at = String((a && a.ts) || ""), bt = String((b && b.ts) || "");
  if (at < bt) return -1;
  if (at > bt) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// C3 — claimsComplete. DERIVED at read time, NEVER stored, so it can never
// desync from the evidence it is derived from.
//
//   claimsComplete(ms) = evidence has a live finish entry
//     AND no live verdict {ship:false} with ts >= that finish's ts
//     AND no live abandon with ts >= that finish's ts
//
// It means EXACTLY: "the evidence array contains an unretracted, unrefuted
// finish claim." It does not mean verified. Copy must read "claims complete".
// ---------------------------------------------------------------------------
export function claimsComplete(ms) {
  const live = liveEvidence(ms && ms.evidence);
  if (!live.length) return false;
  const finishes = live.filter((e) => e.kind === "finish").sort(byTs);
  if (!finishes.length) return false;
  // The LATEST finish has the smallest set of entries that could refute it, so
  // if any finish survives, this one does.
  const f = finishes[finishes.length - 1];
  for (const e of live) {
    if (String(e.ts) < String(f.ts)) continue;
    if (e.kind === "abandon") return false;
    if (e.kind === "verdict" && e.ship === false) return false;
  }
  return true;
}

export function hasEvidence(ms) {
  return Array.isArray(ms && ms.evidence) && ms.evidence.length > 0;
}

// ---------------------------------------------------------------------------
// C2 — RETRACTION. A tombstone, never a deletion, and only when:
//   (a) the same SOURCE authored the entry being retracted, and
//   (b) no history event with actor "founder" or source "mcp" / "ui" targets
//       that milestone after the target entry's ts.
// (b) is the "a human has since spoken here" rule: once a person has edited the
// card, a watcher does not get to quietly withdraw what it said before them.
// ---------------------------------------------------------------------------
export const HUMAN_EVENT_SOURCES = Object.freeze(["mcp", "ui"]);
export function humanTouchedSince(historyEvents, milestoneId, sinceTs) {
  for (const ev of Array.isArray(historyEvents) ? historyEvents : []) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.targetId !== milestoneId) continue;
    if (!(String(ev.ts || "") > String(sinceTs || ""))) continue;
    if (ev.actor === "founder" || ev.source === "mcp" || ev.source === "ui") return true;
  }
  return false;
}

export function canRetract({ evidence, targetKey, source, historyEvents, milestoneId } = {}) {
  const arr = Array.isArray(evidence) ? evidence : [];
  const target = arr.find((e) => evidenceKey(e) === targetKey && e.kind !== "retract");
  if (!target) return { ok: false, reason: "E_NO_TARGET", message: `no evidence entry with key ${targetKey}` };
  if (target.source !== source) {
    return { ok: false, reason: "E_NOT_AUTHOR", message: `only ${target.source} may retract its own entry (you are ${source})` };
  }
  if (humanTouchedSince(historyEvents, milestoneId, target.ts)) {
    return { ok: false, reason: "E_HUMAN_EDIT", message: "a person edited this milestone after that entry — it stands" };
  }
  return { ok: true, target };
}

// ---------------------------------------------------------------------------
// C4 — THE ORPHAN PREDICATE. Deliberately free of semantics: it reads three
// fields and nothing else. An approved decision with no related milestone and
// no standing flag is planned work that was never written down.
//
// It is a DETECTOR, never a gate: decision_log / decision_set_approval are
// untouched, because decision capture is the one reliably-performed behavior
// and write-time friction risks losing it.
// ---------------------------------------------------------------------------
export function isOrphanDecision(d) {
  if (!d || typeof d !== "object") return false;
  if (d.status !== "approved") return false;
  const rel = Array.isArray(d.relatedMilestoneIds) ? d.relatedMilestoneIds : [];
  if (rel.length !== 0) return false;
  return d.standing !== true;
}
export function orphanDecisions(decisions) {
  const arr = Array.isArray(decisions) ? decisions : (decisions && Array.isArray(decisions.decisions) ? decisions.decisions : []);
  return arr.filter(isOrphanDecision);
}

// ---------------------------------------------------------------------------
// C5 — THE DIRTY BIT. Mechanical, and honest about what it cannot know.
//
// A MUTATING tool use marks the session row dirty; any questlog write clears it;
// the Stop hook nudges if it is still set at the end. It never blocks.
//
// HONESTY LIMIT (stated, not worked around): we cannot read a command's intent.
// `Bash` / `PowerShell` count as mutating even when the command only reads, so a
// false nudge is possible. That is why the nudge copy offers the ignore path and
// why the bit never gates anything. A pure-research session — Read, Grep, Glob,
// WebFetch, WebSearch, ToolSearch, and questlog's own read tools — is NEVER
// flagged, because none of those is in the mutating set.
//
// questlog's own MCP tools are excluded wholesale: its writes CLEAR the bit
// (that is the whole point), and its reads were never going to set it.
// ---------------------------------------------------------------------------
export const MUTATING_TOOLS = Object.freeze(["Edit", "Write", "NotebookEdit", "MultiEdit", "Bash", "PowerShell"]);
const MUTATING_SET = new Set(MUTATING_TOOLS);

export function isQuestlogTool(toolName) {
  if (typeof toolName !== "string") return false;
  const m = toolName.match(/^mcp__([^_]+(?:_[^_]+)*)__/);
  return !!m && /questlog/i.test(m[1]);
}

export function isMutatingTool(toolName) {
  if (typeof toolName !== "string" || !toolName) return false;
  if (MUTATING_SET.has(toolName)) return true;
  // Any OTHER MCP server's tool: we cannot see what it does, so we assume it
  // changed something. questlog's own tools are the one exclusion.
  if (toolName.startsWith("mcp__")) return !isQuestlogTool(toolName);
  return false;
}

// Mark a sessions.json row dirty. Idempotent: an already-dirty row keeps its
// ORIGINAL dirtyAt (the nudge is about "since when", not "most recently").
// Returns true when the row actually changed.
export function markDirty(row, ts) {
  if (!row || typeof row !== "object") return false;
  if (row.dirty === true) return false;
  row.dirty = true;
  row.dirtyAt = ts || nowIso();
  return true;
}

// Clear on ANY questlog write. Only touches a row that was actually dirty, so a
// clean file is never rewritten with new keys. Returns true when it changed.
export function clearDirty(row) {
  if (!row || typeof row !== "object") return false;
  if (row.dirty !== true && row.dirtyAt === undefined) return false;
  row.dirty = false;
  delete row.dirtyAt;
  return true;
}

export function isDirty(row) {
  return !!(row && typeof row === "object" && row.dirty === true);
}

export const DIRTY_NUDGE = "questlog: this session changed things but wrote nothing to the road — record a milestone update, item, or decision (or ignore if this was housekeeping)";
export function orphanNudge(n) {
  return `questlog: ${n} approved decision(s) name no milestone and no standing flag — link or mark standing`;
}

// ---------------------------------------------------------------------------
// §3 — RAID LINKAGE (DETECTION ONLY, never prevention).
//
// Tolerant extraction of the two meta keys off a workflow's meta JSON, then the
// three-way label. `unlinked` means "this workflow named no milestone and no
// chore flag" — it does NOT mean blocked, and no copy anywhere may say blocked.
// ---------------------------------------------------------------------------
export function parseRaidLinkage(metaText) {
  const out = { milestoneId: null, chore: false };
  if (typeof metaText !== "string" || !metaText) return out;
  const mid = metaText.match(/["']?questlogMilestoneId["']?\s*:\s*["']([^"']*)["']/);
  if (mid && mid[1]) out.milestoneId = mid[1];
  const ch = metaText.match(/["']?questlogChore["']?\s*:\s*(true|false|["'](?:true|false)["'])/i);
  if (ch) out.chore = /true/i.test(ch[1]);
  return out;
}

export function raidLinkage({ milestoneId, chore, resolves }) {
  if (typeof milestoneId === "string" && milestoneId && resolves) return "milestone";
  if (chore === true) return "chore";
  return "unlinked";
}

// ---------------------------------------------------------------------------
// The chore activity ledger — <projectRoot>/.questlog/activity.jsonl.
// Append-only, one JSON object per line, same (source, ref, kind) idempotency,
// written under the road lock by the caller. NOT a road file.
// ---------------------------------------------------------------------------
export function activityKey(e) {
  if (!e || typeof e !== "object") return null;
  return `${e.source}|${e.ref}|${e.kind}`;
}

export function normalizeActivityEntry(raw, deps = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "activity entry must be an object" };
  const bad = refuseStatusWrite(raw);
  if (bad) return { error: bad.message, code: bad.code };
  if (!SOURCE_SET.has(raw.source)) return { error: `source must be one of ${EVIDENCE_SOURCES.join("|")}` };
  if (!ACT_KIND_SET.has(raw.kind)) return { error: `kind must be one of ${ACTIVITY_KINDS.join("|")}` };
  if (typeof raw.ref !== "string" || !raw.ref.length || raw.ref.length > REF_MAX) return { error: `ref must be a non-empty string (<= ${REF_MAX} chars)` };
  const label = raw.label === undefined ? "" : raw.label;
  if (typeof label !== "string" || label.length > CLAIM_MAX) return { error: `label must be a string (<= ${CLAIM_MAX} chars)` };
  let ts = raw.ts;
  if (ts === undefined) ts = (deps.now || nowIso)();
  if (typeof ts !== "string" || !TS_RE.test(ts)) return { error: "ts must be an ISO-8601 UTC ms timestamp" };
  const id = typeof raw.id === "string" && /^act-[a-z0-9][a-z0-9-]*$/.test(raw.id) ? raw.id : (deps.genId || genId)("act");
  return { entry: { id, ts, source: raw.source, ref: raw.ref, kind: raw.kind, label } };
}

export function readActivity(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* a torn line is skipped, never fatal */ }
  }
  return out;
}

// Append one chore line, idempotently. Returns {written:boolean, entry|error}.
// The caller must already hold the road lock.
export function appendActivity(file, raw, deps = {}) {
  const norm = normalizeActivityEntry(raw, deps);
  if (norm.error) return { written: false, error: norm.error, code: norm.code };
  const k = activityKey(norm.entry);
  for (const e of readActivity(file)) {
    if (activityKey(e) === k) return { written: false, reason: "duplicate", entry: e };
  }
  try {
    fs.appendFileSync(file, JSON.stringify(norm.entry) + "\n", "utf8");
  } catch (err) {
    return { written: false, error: String((err && err.message) || err) };
  }
  return { written: true, entry: norm.entry };
}

// ---------------------------------------------------------------------------
// C7 — COVERAGE. "today: N chores, M linked, K unlinked", so escape-hatch
// overuse becomes a founder conversation instead of silent rot. Today is the
// LOCAL date (the founder's day, not UTC's).
// ---------------------------------------------------------------------------
export function localDateKey(ts, now) {
  const d = ts === undefined || ts === null ? (now || new Date()) : new Date(ts);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// activityEntries: chore ledger lines (all roads). milestones: every milestone
// whose evidence we can see (all roads). raids: the scanned workflow list.
export function coverage({ activityEntries = [], milestones = [], raids = [], now } = {}) {
  const today = localDateKey(undefined, now || new Date());
  let chores = 0, linked = 0, unlinked = 0;
  for (const e of activityEntries) {
    if (!e || e.kind !== "launch") continue;
    if (localDateKey(e.ts) === today) chores++;
  }
  for (const m of milestones) {
    for (const e of liveEvidence(m && m.evidence)) {
      if (e.kind !== "launch") continue;
      if (localDateKey(e.ts) === today) linked++;
    }
  }
  for (const r of raids) {
    if (!r || r.linked !== "unlinked") continue;
    const stamp = r.startedAt || r.lastActivityAt;
    if (localDateKey(stamp) === today) unlinked++;
  }
  return { today, chores, linked, unlinked };
}

// One line of plain wording for the panel header and the roster.
export function coverageLine(c) {
  if (!c) return "";
  return `today: ${c.chores} chore${c.chores === 1 ? "" : "s"}, ${c.linked} linked, ${c.unlinked} unlinked`;
}
