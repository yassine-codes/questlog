#!/usr/bin/env node
// QUESTLOG — MCP server (stdio, hand-rolled JSON-RPC 2.0, no SDK).
// Zero dependencies. Node >= 18.
//
// Run:  node mcp/server.mjs --dir <projectRoot>
// Env:  QUESTLOG_DIR  (default: cwd)
//
// A convenience layer of tools over the plain files in <projectRoot>/.questlog/.
// The files are the source of truth; this server speaks the exact same
// lock + atomic-write + history protocol as the UI server (data-contract §4).
//
// Protocol: newline-delimited JSON-RPC 2.0 over stdin/stdout. Handshake is
// initialize -> tools/list -> tools/call. Tool results use the MCP content
// shape; domain failures return {content:[{type:"text",text:"E_CODE: msg"}],
// isError:true} (never a JSON-RPC error for domain problems).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import process from "node:process";
import readline from "node:readline";
import * as currency from "../currency.mjs";
import { planDeletion, scrubDeletedRefs } from "../deletion.mjs";
import * as conflicts from "../conflicts.mjs";

// ---------------------------------------------------------------------------
// Args / config
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir" || a === "--data") out.dir = argv[++i];
    else if (a.startsWith("--dir=")) out.dir = a.slice(6);
    else if (a.startsWith("--data=")) out.dir = a.slice(7);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PROJECT_ROOT = path.resolve(args.dir || process.env.QUESTLOG_DIR || process.cwd());
const DATA_DIR = path.join(PROJECT_ROOT, ".questlog");
const LOCK_DIR = path.join(DATA_DIR, ".lock");

// filesFor(root) — the .questlog file map for ANY road root. READ tools that
// accept a roadmapId build their map with this; every WRITE path keeps using
// FILES (this server's one --dir road) so cross-road reach is read-only by
// construction.
function filesFor(root) {
  const d = path.join(root, ".questlog");
  return {
    roadmap: path.join(d, "roadmap.json"),
    decisions: path.join(d, "decisions.json"),
    pins: path.join(d, "pins.json"),
    glossary: path.join(d, "glossary.json"),
    sessions: path.join(d, "sessions.json"),
    batons: path.join(d, "batons.json"),
    suggestions: path.join(d, "suggestions.json"),
    // Held colliding writes (the founder's ruling, 2026-08-27). Its own file,
    // like batons.json: roadmap.json's strict schema stays untouched, and a
    // road that has never had a collision has no file here at all.
    conflicts: path.join(d, "conflicts.json"),
    history: path.join(d, "history.jsonl"),
  };
}

const FILES = filesFor(PROJECT_ROOT);

// ---------------------------------------------------------------------------
// Domain error helper
// ---------------------------------------------------------------------------
class DomainError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new DomainError(code, message); };

// ---------------------------------------------------------------------------
// Time / id helpers
// ---------------------------------------------------------------------------
const nowIso = () => new Date().toISOString();
const genId = (prefix) => `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
const ID_RE = /^[a-z]+-[a-z0-9][a-z0-9-]*$/;
const STATUS = new Set(["locked", "available", "in_progress", "done", "blocked"]);
const ITEM_STATUS = new Set(["open", "done", "blocked"]);

function validId(id, prefix) {
  return typeof id === "string" && ID_RE.test(id) && id.startsWith(prefix + "-");
}

// ---------------------------------------------------------------------------
// Empty skeletons
// ---------------------------------------------------------------------------
function emptyRoadmap() {
  const ts = nowIso();
  return {
    schemaVersion: 1,
    project: { name: path.basename(PROJECT_ROOT) || "Untitled Project", tagline: "", createdAt: ts, updatedAt: ts },
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
const emptyBatons = () => ({ schemaVersion: 1, batons: [] });
const emptySuggestions = () => ({ schemaVersion: 1, suggestions: [] });
const emptyConflicts = conflicts.emptyConflicts;

function readJson(file, fallbackFn) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallbackFn(); }
}

// history.jsonl is APPEND-ordered, not TIME-ordered (decision dec-time-ordering:
// a bridge/child run can append events stamped earlier than lines already on
// disk). Order therefore comes from the `ts` field, never file position. Every
// reader below sorts by ts before windowing.
function readHistoryAll(historyFile) {
  try {
    const raw = fs.readFileSync(historyFile, "utf8");
    const out = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* skip malformed */ }
    }
    return out;
  } catch { return []; }
}
const evtTs = (e) => (e && typeof e.ts === "string") ? e.ts : "";
// Ascending by ts. Array#sort is stable in V8, so equal timestamps keep their
// file order (the only tie-break that carries any information).
function sortByTs(events) {
  return events.slice().sort((a, b) => { const x = evtTs(a), y = evtTs(b); return x < y ? -1 : (x > y ? 1 : 0); });
}
function readHistoryTail(n, historyFile = FILES.history) {
  return sortByTs(readHistoryAll(historyFile)).slice(-n);
}

// deriveEventCounts — ONE scan of history.jsonl -> Map sessionId -> event count.
// The stored sessions.json eventCount is advisory only: it counts what THIS
// server bumped and undercounts everything written by another writer (UI, file
// edits, a second MCP process). Same principle that made claimsComplete derived.
function deriveEventCounts(historyFile) {
  const counts = new Map();
  for (const e of readHistoryAll(historyFile)) {
    const sid = (e && typeof e.sessionId === "string" && e.sessionId) ? e.sessionId : null;
    if (!sid) continue;
    counts.set(sid, (counts.get(sid) || 0) + 1);
  }
  return counts;
}
// Overlay derived counts onto a sessions array WITHOUT touching disk: served
// eventCount becomes the derived number (falling back to stored when history is
// unreadable), and the stored number is kept as storedEventCount.
function overlayDerivedSessions(sessions, historyFile) {
  const counts = deriveEventCounts(historyFile);
  return (Array.isArray(sessions) ? sessions : []).map((s) => {
    if (!s || typeof s !== "object") return s;
    const stored = Number.isInteger(s.eventCount) ? s.eventCount : 0;
    const derived = counts.has(s.id) ? counts.get(s.id) : null;
    return Object.assign({}, s, { eventCount: derived === null ? stored : derived, storedEventCount: stored });
  });
}

// ---------------------------------------------------------------------------
// Lock + atomic write + history (data-contract §4 — same protocol as server.mjs)
// ---------------------------------------------------------------------------
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function acquireLock() {
  ensureDataDir();
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(LOCK_DIR); return; }
    catch (err) {
      if (err.code !== "EEXIST") fail("E_IO", err.message);
      let age = Infinity;
      try { age = Date.now() - fs.statSync(LOCK_DIR).mtimeMs; } catch { /* vanished */ }
      if (age > 5000) { try { fs.rmdirSync(LOCK_DIR); } catch { /* raced */ } continue; }
      if (Date.now() - start > 3000) fail("E_LOCK_TIMEOUT", "could not acquire lock");
      const until = Date.now() + 50;
      while (Date.now() < until) { /* spin ~50ms */ }
    }
  }
}
function releaseLock() { try { fs.rmdirSync(LOCK_DIR); } catch { /* already gone */ } }

function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
function appendHistory(evt) {
  fs.appendFileSync(FILES.history, JSON.stringify(evt) + "\n", "utf8");
}
function withLock(fn) {
  acquireLock();
  try { return fn(); } finally { releaseLock(); }
}
function historyEvent({ actor = "agent", action, targetId = null, summary, patch }) {
  const evt = { id: genId("evt"), ts: nowIso(), actor, source: "mcp", action, targetId, summary };
  if (patch !== undefined) evt.patch = patch;
  return evt;
}

// ---------------------------------------------------------------------------
// sessions.json — per-roadmap AI session tracing (Build Plan §1.2)
// ---------------------------------------------------------------------------
const emptySessions = () => ({ schemaVersion: 1, sessions: [] });

// Cached {id, label} from the most recent session_hello (process lifetime).
let SESSION_CACHE = null;

function validSessionId(x) {
  if (typeof x !== "string") return null;
  if (x.length === 0 || x.length > 200) return null;
  for (let i = 0; i < x.length; i++) { const c = x.charCodeAt(i); if (c < 0x20 || c === 0x7f) return null; }
  return x;
}
function checkSessionId(x) {
  const s = validSessionId(x);
  if (s === null) fail("E_VALIDATION", "sessionId must be a non-empty string (<=200 chars, no control characters)");
  return s;
}

// Resolution order (Build Plan §1.6), evaluated per mutating call:
//   (1) explicit sessionId argument  (2) cached session_hello  (3) $CLAUDE_SESSION_ID
// Never throws — an invalid/absent value simply yields null (no stamp).
function resolveSessionId(input) {
  if (input && input.sessionId !== undefined && input.sessionId !== null) {
    return validSessionId(input.sessionId); // explicit but invalid => null (no misattribution)
  }
  if (SESSION_CACHE && SESSION_CACHE.id) return SESSION_CACHE.id;
  return validSessionId(process.env.CLAUDE_SESSION_ID);
}

// upsertSession — called INSIDE the same per-roadmap lock as the mutation it
// accounts for, AFTER appendHistory. delta is added to eventCount. Atomic write.
//
// C5 — the primary CLEAR-ON-WRITE point for the dirty bit. Every mutating MCP
// tool reaches here through stampHistory, so "this session wrote to the road"
// and "the bit is cleared" are the same moment. A row that was never dirty is
// left byte-identical (no key is added).
function upsertSession(sessionId, label, delta) {
  const data = readJson(FILES.sessions, emptySessions);
  data.schemaVersion = 1;
  if (!Array.isArray(data.sessions)) data.sessions = [];
  const ts = nowIso();
  let s = data.sessions.find((x) => x && x.id === sessionId);
  if (s) {
    s.lastSeenAt = ts;
    s.eventCount = (Number.isInteger(s.eventCount) ? s.eventCount : 0) + delta;
    if (typeof label === "string" && label.length > 0) s.label = label;
    if (delta >= 1) currency.clearDirty(s);
  } else {
    s = { id: sessionId, firstSeenAt: ts, lastSeenAt: ts, label: (typeof label === "string" ? label : ""), eventCount: delta };
    data.sessions.push(s);
  }
  atomicWrite(FILES.sessions, data);
  return s;
}

// stampHistory — append a history event with the resolved sessionId (if any),
// then account it against sessions.json. Used by every mutating tool, inside
// that tool's existing lock, in place of a bare appendHistory().
function stampHistory(input, evt) {
  const sid = resolveSessionId(input);
  if (sid) evt.sessionId = sid;
  appendHistory(evt);
  if (sid) upsertSession(sid, undefined, 1);
}

// ---------------------------------------------------------------------------
// COLLIDING WRITES — the tool layer's half of the founder's ruling (2026-08-27).
//
// When two writers change the same record, the second change is HELD: applied
// to nothing, discarded by nothing, surfaced as a decision showing BOTH
// versions for the founder to rule on. The FIRST write stands as current while
// the hold is open, so the board stays readable rather than frozen. A warning
// shown after the loss is not a decision, it is a receipt.
//
// WHERE A TOOL'S BASIS COMES FROM. A write is stale when the version it was
// based on is no longer the version on disk (conflicts.recordVersion — a
// content hash derived at read time and stored nowhere; server.mjs judges by
// the same function, so the two surfaces cannot disagree). A caller may state
// its basis outright with `baseVersion`. When it does not, SEEN answers for it:
// what THIS PROCESS last served for that id. One MCP process is one agent
// session, so "what this process last read" is exactly "the version this writer
// based its change on".
//
// A write with no basis at all — never read here, no baseVersion — is a BLIND
// write and goes through unchanged. That is documented back-compat, not an
// oversight: a direct file edit by hand carries no basis either, and pretending
// otherwise would be a lie rather than a safeguard.
//
// ONE CRITICAL SECTION, non-negotiable: the basis check and the hold both
// happen inside the tool's existing withLock, on the record that lock just
// read. Split them and two stale writers can both believe they were first.
// ---------------------------------------------------------------------------

// id -> the version this process last served or wrote for that record.
const SEEN = new Map();

// Remember one record, or a list of them. Called by the read tools that hand
// records to an agent (roadmap_get on its OWN road, list_unclear) and after
// every successful write, so a tool can write twice in a row without the second
// call looking stale to itself.
function remember(rec) {
  if (rec && typeof rec === "object" && typeof rec.id === "string") SEEN.set(rec.id, conflicts.recordVersion(rec));
  return rec;
}
function rememberAll(list) {
  for (const rec of (Array.isArray(list) ? list : [])) remember(rec);
}

// The version this write claims it was based on: stated, else remembered, else
// nothing (a blind write).
function basisFor(input, id) {
  if (input && input.baseVersion !== undefined && input.baseVersion !== null) return String(input.baseVersion);
  return SEEN.get(id);
}
// Stale means: this writer's basis is not the version now on disk.
function isStale(basis, rec) {
  return !!(basis && basis !== conflicts.recordVersion(rec));
}
// The `baseVersion` argument, worded once and spread over every guarded tool.
const BASE_VERSION_ARG = {
  type: "string",
  description: "Optional. The version of the record this change was based on (see the `versions` map the dashboard serves, or roadmap_get). Omit and this server uses the version IT last served you. If the record has moved on since, the change is HELD as a conflict for the founder to rule on rather than overwriting what landed first.",
};

// Record one held change and refuse the write. The road file is NOT written;
// conflicts.json is, and history gains a conflict_held event. Always throws
// E_CONTESTED — deliberately NOT E_CONFLICT, which delete already owns with the
// meaning "this record has dependents". Caller already holds the lock.
function holdChange({ input, ts, action, targetType, targetId, title, basis, current, proposed }) {
  const doc = readJson(FILES.conflicts, emptyConflicts);
  doc.schemaVersion = 1;
  if (!Array.isArray(doc.conflicts)) doc.conflicts = [];
  const cf = conflicts.newConflict({
    id: genId("cf"), ts, source: "mcp", actor: "agent", sessionId: resolveSessionId(input),
    action, targetType, targetId,
    baseVersion: basis, currentVersion: conflicts.recordVersion(current),
    current, proposed,
    // The raw call, minus the session bookkeeping, so a ruling of "keep the
    // held version" can be carried out later without the writer trying again.
    input: strippedInput(input),
  });
  doc.conflicts.push(cf);
  atomicWrite(FILES.conflicts, doc);
  stampHistory(input, historyEvent({
    action: "conflict_held", targetId,
    summary: `Held a change to "${title}": it was based on a version that is no longer current; waiting on a ruling`,
    patch: { conflictId: cf.id, baseVersion: cf.baseVersion, currentVersion: cf.currentVersion },
  }));
  fail("E_CONTESTED", `a change to "${title}" was held as conflict ${cf.id}: it was based on version ${cf.baseVersion}, but the record on disk is now version ${cf.currentVersion}.\n${JSON.stringify({ current: cf.current, proposed: cf.proposed }, null, 2)}\n${conflicts.HELD_TAIL}`);
}
// The call as it was made, with only the session bookkeeping removed — that is
// attribution, not part of the change anyone is ruling on.
function strippedInput(input) {
  const out = {};
  for (const k of Object.keys(input || {})) {
    if (k === "sessionId" || k === "baseVersion") continue;
    out[k] = input[k];
  }
  return out;
}

// A record that just left the road takes its open holds with it — there is
// nothing left to contest, and a conflict pointing at a missing id is a
// validator error. Voided, never deleted, with one conflict_void event each.
// Caller holds the lock.
function voidHoldsFor(input, ids, ts) {
  const doc = readJson(FILES.conflicts, emptyConflicts);
  const voided = conflicts.voidConflictsFor(doc, ids, ts);
  if (!voided.length) return [];
  atomicWrite(FILES.conflicts, doc);
  for (const cf of voided) {
    stampHistory(input, historyEvent({
      action: "conflict_void", targetId: cf.targetId,
      summary: `A contested change was voided: ${cf.targetId} was deleted, so there is nothing left to rule on`,
      patch: { conflictId: cf.id, voidReason: cf.voidReason },
    }));
  }
  return voided;
}

// ---------------------------------------------------------------------------
// registry.json — user-level roadmap registry (Build Plan §1.1, §3)
// Reads are lock-free and tolerant; writes take the registry's own lock. The
// registry lock is NEVER nested with a .questlog lock (deadlock-free by design).
// ---------------------------------------------------------------------------
function getRegistryPath() {
  const env = process.env.QUESTLOG_REGISTRY;
  if (typeof env === "string" && env.length > 0) return env;
  return path.join(os.homedir(), ".questlog", "registry.json");
}
function sameDir(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
// Registry hygiene (pin — MIRRORED in server.mjs isRefusedRegistryPath): a path
// is refused iff, after resolving, any path SEGMENT (split on \ or /) equals
// (case-insensitive) "Temp" or "scratchpad", OR the path starts with os.tmpdir().
// Escape hatch: QUESTLOG_ALLOW_TEMP=1 (selftests only). Keeps ephemeral scratch
// dirs out of the overworld — a live road re-registers itself on next start.
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
function readRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(getRegistryPath(), "utf8"));
    if (!data || typeof data !== "object" || !Array.isArray(data.roadmaps)) return { schemaVersion: 1, roadmaps: [] };
    return data;
  } catch { return { schemaVersion: 1, roadmaps: [] }; }
}
function writeRegistry(data) {
  const p = getRegistryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, p);
}
function withRegistryLock(fn) {
  const dir = path.dirname(getRegistryPath());
  fs.mkdirSync(dir, { recursive: true });
  const lockDir = path.join(dir, ".lock");
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(lockDir); break; }
    catch (err) {
      if (err.code !== "EEXIST") fail("E_IO", err.message);
      let age = Infinity;
      try { age = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { /* vanished */ }
      if (age > 5000) { try { fs.rmdirSync(lockDir); } catch { /* raced */ } continue; }
      if (Date.now() - start > 3000) fail("E_LOCK_TIMEOUT", "could not acquire registry lock");
      const until = Date.now() + 50;
      while (Date.now() < until) { /* spin ~50ms */ }
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lockDir); } catch { /* already gone */ } }
}
function registryProjectName(resolvedDir) {
  try {
    const rm = JSON.parse(fs.readFileSync(path.join(resolvedDir, ".questlog", "roadmap.json"), "utf8"));
    if (rm && rm.project && typeof rm.project.name === "string" && rm.project.name.length > 0) return rm.project.name;
  } catch { /* unreadable => basename fallback */ }
  return path.basename(resolvedDir);
}
function registrySlug(resolvedDir) {
  let slug = path.basename(resolvedDir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) slug = crypto.randomBytes(4).toString("hex"); // 8 hex chars
  return slug;
}
// Upsert-by-resolved-dir into an ALREADY-LOADED registry object (no lock, no
// write). Returns the entry (existing, mutated; or newly created + pushed).
function upsertRegistryEntry(reg, resolvedDir) {
  reg.schemaVersion = 1;
  if (!Array.isArray(reg.roadmaps)) reg.roadmaps = [];
  const ts = nowIso();
  const existing = reg.roadmaps.find((r) => r && typeof r.dir === "string" && sameDir(path.resolve(r.dir), resolvedDir));
  if (existing) {
    existing.lastSeenAt = ts;
    existing.name = registryProjectName(resolvedDir); // refresh; keep id + addedAt + origin
    return existing;
  }
  let id = "rm-" + registrySlug(resolvedDir);
  const idTaken = reg.roadmaps.some((r) => r && r.id === id && !sameDir(path.resolve(r.dir || ""), resolvedDir));
  if (idTaken) id = id + "-" + crypto.randomBytes(2).toString("hex"); // + 4 hex chars
  const entry = { id, name: registryProjectName(resolvedDir), dir: resolvedDir, addedAt: ts, lastSeenAt: ts };
  reg.roadmaps.push(entry);
  return entry;
}
// Upsert-by-resolved-dir under the registry lock. Returns the entry.
function upsertRegistry(resolvedDir) {
  return withRegistryLock(() => {
    const reg = readRegistry();
    const entry = upsertRegistryEntry(reg, resolvedDir);
    writeRegistry(reg);
    return entry;
  });
}

// ---------------------------------------------------------------------------
// registry origin edges — the roadmap family tree (Build Plan §1.1, §1.2)
// A registry entry may carry an optional origin {roadmapId, milestoneId, ts,
// sessionId?} naming the PARENT road + portal milestone it branched from
// (absent/null = a root). All validation below runs INSIDE withRegistryLock,
// against the already-loaded reg, BEFORE any write. Deadlock-free: origin ops
// touch the registry only, never a .questlog lock.
// ---------------------------------------------------------------------------
const RM_ID_RE = /^rm-[a-z0-9][a-z0-9-]*$/;
const MS_ID_RE = /^ms-[a-z0-9][a-z0-9-]*$/;

function checkOriginRoadmapId(x) {
  if (typeof x !== "string" || !RM_ID_RE.test(x)) fail("E_VALIDATION", "originRoadmapId must match ^rm-[a-z0-9][a-z0-9-]*$");
  return x;
}
function checkOriginMilestoneId(x) {
  if (typeof x !== "string" || !MS_ID_RE.test(x)) fail("E_VALIDATION", "originMilestoneId must match ^ms-[a-z0-9][a-z0-9-]*$");
  return x;
}

// Walk the parent chain from parentId up toward a root; reject a cycle back to
// childId (E_VALIDATION: origin would create a cycle …) or a chain deeper than 8
// (E_VALIDATION: origin chain exceeds depth 8). Missing/malformed links end the
// walk (orphans are legal). Precondition: parentId !== childId (self-edge is
// rejected separately). Pure read over the already-loaded reg.
function assertOriginAcyclic(reg, childId, parentId) {
  const byId = new Map();
  for (const r of reg.roadmaps) if (r && typeof r.id === "string" && !byId.has(r.id)) byId.set(r.id, r);
  const chain = [childId];
  const visited = new Set(); // guards a pre-existing hand-edited cycle among ancestors
  let cur = parentId;
  let steps = 0;
  while (cur) {
    chain.push(cur);
    if (cur === childId) fail("E_VALIDATION", `origin would create a cycle (${chain.join(" -> ")})`);
    steps++;
    if (steps > 8) fail("E_VALIDATION", "origin chain exceeds depth 8");
    if (visited.has(cur)) break; // ancestor cycle not involving childId — end the walk
    visited.add(cur);
    const entry = byId.get(cur);
    if (!entry) break; // ancestor not in registry — orphan link ends the walk
    const o = entry.origin;
    if (!o || typeof o !== "object") break;
    const next = o.roadmapId;
    if (typeof next !== "string" || !RM_ID_RE.test(next)) break; // malformed link ends the walk
    cur = next;
  }
}

// Validate + set origin on an entry (which is already IN reg). Runs the full
// §1.2 check order: pattern → self-edge → parent-exists → cycle/depth → stamp.
// ts is always server-set. Returns the origin object it wrote onto entry.
function applyOrigin(reg, entry, rawRoadmapId, rawMilestoneId, sessionId) {
  const roadmapId = checkOriginRoadmapId(rawRoadmapId);
  const milestoneId = checkOriginMilestoneId(rawMilestoneId);
  if (roadmapId === entry.id) fail("E_VALIDATION", "a roadmap cannot be its own origin");
  if (!reg.roadmaps.some((r) => r && r.id === roadmapId)) fail("E_NOT_FOUND", `no roadmap ${roadmapId} in registry`);
  assertOriginAcyclic(reg, entry.id, roadmapId);
  const origin = { roadmapId, milestoneId, ts: nowIso() };
  if (sessionId) origin.sessionId = sessionId;
  entry.origin = origin;
  return origin;
}

// ---------------------------------------------------------------------------
// Cross-road READ reach (HARNESS-1). A portal is a link the tools must be able
// to follow. resolveRoadRoot maps an optional roadmapId to a road root:
//   absent/null -> this server's PROJECT_ROOT (unchanged behaviour)
//   otherwise   -> the registry entry's dir, resolved and checked to exist.
// It is a pure READ: no upsert, no write, and it never takes the registry lock.
// Only READ tools accept roadmapId; every write tool stays --dir-bound, so a
// cross-road call can never mutate another road.
// ---------------------------------------------------------------------------
function resolveRoadRoot(roadmapId) {
  if (roadmapId === undefined || roadmapId === null) return PROJECT_ROOT;
  if (typeof roadmapId !== "string" || !RM_ID_RE.test(roadmapId)) {
    fail("E_VALIDATION", "roadmapId must match ^rm-[a-z0-9][a-z0-9-]*$");
  }
  const reg = readRegistry(); // lock-free, tolerant
  const entry = (reg.roadmaps || []).find((r) => r && r.id === roadmapId);
  if (!entry) fail("E_NOT_FOUND", `no roadmap ${roadmapId} in registry`);
  const dir = path.resolve(typeof entry.dir === "string" ? entry.dir : "");
  if (!fs.existsSync(dir)) fail("E_NOT_FOUND", `roadmap dir missing: ${dir}`);
  return dir;
}

// The five milestone statuses, always all five keys (0 where absent) so a
// consumer never has to guess whether a missing key means zero or unknown.
function statusBreakdownOf(milestones) {
  const out = { done: 0, in_progress: 0, available: 0, locked: 0, blocked: 0 };
  for (const m of (Array.isArray(milestones) ? milestones : [])) {
    const s = m && typeof m.status === "string" ? m.status : "locked";
    if (Object.prototype.hasOwnProperty.call(out, s)) out[s]++;
  }
  return out;
}

// Tolerant per-road summary for a registry entry (mirrors server.mjs
// readRoadSummary). Never throws: an unreadable road comes back missing:true.
function readRoadSummary(entry) {
  const resolved = path.resolve(typeof entry.dir === "string" ? entry.dir : "");
  const basename = path.basename(resolved);
  let rm = null;
  if (resolved && fs.existsSync(resolved)) {
    try { rm = JSON.parse(fs.readFileSync(filesFor(resolved).roadmap, "utf8")); } catch { rm = null; }
  }
  if (!rm || typeof rm !== "object") {
    return {
      missing: true, name: entry.name || basename,
      progress: { done: 0, total: 0 },
      statusBreakdown: statusBreakdownOf([]), asOf: null,
    };
  }
  const project = rm.project || {};
  const milestones = Array.isArray(rm.milestones) ? rm.milestones : [];
  return {
    missing: false,
    name: (typeof project.name === "string" && project.name) ? project.name : (entry.name || basename),
    progress: { done: milestones.filter((m) => m && m.status === "done").length, total: milestones.length },
    statusBreakdown: statusBreakdownOf(milestones),
    asOf: (typeof project.updatedAt === "string" && project.updatedAt) ? project.updatedAt : null,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers shared by tools
// ---------------------------------------------------------------------------
function reqStr(obj, key, { allowEmpty = true } = {}) {
  if (typeof obj[key] !== "string") fail("E_VALIDATION", `${key} must be a string`);
  if (!allowEmpty && obj[key].length === 0) fail("E_VALIDATION", `${key} must be non-empty`);
  return obj[key];
}
function optStr(obj, key, def = "") {
  if (obj[key] === undefined || obj[key] === null) return def;
  if (typeof obj[key] !== "string") fail("E_VALIDATION", `${key} must be a string`);
  return obj[key];
}
function checkStatus(status) {
  if (!STATUS.has(status)) fail("E_VALIDATION", `status must be one of [${[...STATUS].join(", ")}]`);
}

// ---------------------------------------------------------------------------
// TOOLS
// Each returns the JS object to serialize into the text content.
// ---------------------------------------------------------------------------
const TOOLS = {};

// roadmap_get — read only, no history
TOOLS.roadmap_get = {
  schema: {
    description: "Read the roadmap (or a slice of it). Read-only, appends no history event. Pass roadmapId to read ANOTHER registered road (walk a portal) without leaving the tools — reads only, never writes.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["all", "project", "quests", "milestones", "items", "assets", "decisions", "pins", "glossary", "sessions", "batons", "suggestions", "conflicts", "history_tail", "derived"],
          description: "Which slice to return (default 'all'). 'history_tail' returns the newest 50 events by timestamp as a bare array — prefer the history_tail tool — this slice is windowed with no truncation signal. 'sessions' serves a DERIVED eventCount (counted from history.jsonl) alongside storedEventCount. 'conflicts' returns the colliding writes that were HELD on this road, open ones first — each carries both versions and waits on a founder ruling. 'derived' returns the read-time values that are NEVER stored: which milestones CLAIM complete (their evidence holds an unretracted, unrefuted finish claim — that is not the same as verified), which are evidence-backed at all, and which approved decisions are orphans (no milestone, no standing flag).",
        },
        roadmapId: {
          type: "string",
          description: "Optional registry id (rm-…) of ANOTHER road to read instead of this server's road. Use roadmap_list to discover ids. Read-only: this can never write to the other road.",
        },
      },
    },
  },
  run(input) {
    const section = input.section || "all";
    const files = filesFor(resolveRoadRoot(input.roadmapId));
    const roadmap = readJson(files.roadmap, emptyRoadmap);
    const decisions = readJson(files.decisions, emptyDecisions);
    const pins = readJson(files.pins, emptyPins);
    // Remember what this read handed over — but ONLY for this server's own
    // road. A cross-road read is read-only by construction, so a version from
    // over there could never be a basis for a write here.
    if (!input.roadmapId) {
      rememberAll(roadmap.milestones); rememberAll(roadmap.items); rememberAll(roadmap.quests);
      rememberAll(decisions.decisions);
    }
    // C3 — DERIVED, at read time, never stored. Served as its own key so
    // `roadmap` stays exactly what is on disk: claimsComplete cannot be written
    // back and so can never desync from the evidence it is derived from.
    // "claims complete" means the evidence array holds an unretracted,
    // unrefuted finish claim. It does NOT mean verified.
    const derived = () => ({
      claimsComplete: (roadmap.milestones || []).filter((m) => currency.claimsComplete(m)).map((m) => m.id),
      evidenced: (roadmap.milestones || []).filter((m) => currency.hasEvidence(m)).map((m) => m.id),
      orphanDecisions: (decisions.decisions || []).filter((d) => currency.isOrphanDecision(d)).map((d) => d.id),
    });
    switch (section) {
      case "all": return { roadmap, decisions, pins, derived: derived() };
      case "derived": return derived();
      case "project": return roadmap.project;
      case "quests": return roadmap.quests || [];
      case "milestones": return roadmap.milestones || [];
      case "items": return roadmap.items || [];
      case "assets": return roadmap.assets || [];
      case "decisions": return decisions.decisions || [];
      case "pins": return pins.pins || [];
      // Terms are remembered here and nowhere else — the "all" slice does not
      // carry the glossary, so this read is the only way a term basis is learned
      // short of an explicit baseVersion.
      case "glossary": return input.roadmapId
        ? ((readJson(files.glossary, emptyGlossary).terms) || [])
        : ((readJson(files.glossary, emptyGlossary).terms) || []).map(remember);
      case "sessions": return overlayDerivedSessions((readJson(files.sessions, emptySessions).sessions) || [], files.history);
      case "batons": return (readJson(files.batons, emptyBatons).batons) || [];
      case "suggestions": return (readJson(files.suggestions, emptySuggestions).suggestions) || [];
      // Open first: an argument waiting on a ruling is the one worth reading.
      case "conflicts": return ((readJson(files.conflicts, emptyConflicts).conflicts) || [])
        .slice().sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1));
      case "history_tail": return readHistoryTail(50, files.history);
      default: fail("E_VALIDATION", `unknown section ${section}`);
    }
  },
};

// milestone_upsert
TOOLS.milestone_upsert = {
  schema: {
    description: "Create a milestone (omit id) or merge fields into an existing one (provide id).",
    inputSchema: {
      type: "object",
      required: ["questId", "title"],
      properties: {
        id: { type: "string" },
        questId: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        plain: { type: "string" },
        order: { type: "integer" },
        status: { type: "string", enum: [...STATUS] },
        statusReason: { type: "string" },
        eta: { type: ["string", "null"] },
        baseVersion: BASE_VERSION_ARG,
        sessionId: { type: "string", description: "Optional AI session id to attribute this change to (see session_hello). Falls back to the cached session_hello id, then $CLAUDE_SESSION_ID." },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const rm = readJson(FILES.roadmap, emptyRoadmap);
      rm.milestones = rm.milestones || [];
      const questId = reqStr(input, "questId", { allowEmpty: false });
      if (!validId(questId, "q")) fail("E_VALIDATION", "questId must be a q- id");
      if (!(rm.quests || []).some((q) => q.id === questId)) fail("E_PARENT_NOT_FOUND", `no quest ${questId}`);
      const ts = nowIso();
      // `found` is the record on disk; `ms` is what the fields land on — the
      // same object, or a clone when this writer's basis is stale, so the held
      // version is exactly the record this call would have produced. The CREATE
      // path is exempt: there is no prior version to have been stale against.
      let found = null, ms;
      let basis = null, stale = false;
      let created = false;
      if (input.id !== undefined) {
        if (!validId(input.id, "ms")) fail("E_VALIDATION", "id must be an ms- id");
        found = rm.milestones.find((m) => m.id === input.id);
        if (!found) fail("E_NOT_FOUND", `no milestone ${input.id}`);
        basis = basisFor(input, found.id);
        stale = isStale(basis, found);
        ms = stale ? conflicts.cloneRecord(found) : found;
      } else {
        created = true;
        const maxOrder = rm.milestones.filter((m) => m.questId === questId)
          .reduce((mx, m) => Math.max(mx, m.order), -1);
        ms = {
          id: genId("ms"), questId, order: maxOrder + 1, title: "", summary: "",
          status: "locked", statusReason: "", eta: null,
          startedAt: null, completedAt: null, createdAt: ts, updatedAt: ts,
        };
        rm.milestones.push(ms);
      }
      // apply provided fields
      ms.questId = questId;
      ms.title = reqStr(input, "title", { allowEmpty: false });
      if (input.summary !== undefined) ms.summary = optStr(input, "summary");
      if (input.plain !== undefined) ms.plain = optStr(input, "plain");
      if (input.order !== undefined) {
        if (!Number.isInteger(input.order) || input.order < 0) fail("E_VALIDATION", "order must be a non-negative integer");
        // enforce unique order per quest (a held change's clone is not in the
        // list, so `found` is excluded too — a record never collides with itself)
        if (rm.milestones.some((m) => m !== ms && m !== found && m.questId === questId && m.order === input.order))
          fail("E_VALIDATION", `order ${input.order} already used in quest ${questId}`);
        ms.order = input.order;
      }
      if (input.status !== undefined) { checkStatus(input.status); ms.status = input.status; }
      if (input.statusReason !== undefined) ms.statusReason = optStr(input, "statusReason");
      if (input.eta !== undefined) {
        if (input.eta !== null && (typeof input.eta !== "string" || input.eta.length === 0))
          fail("E_VALIDATION", "eta must be null or a non-empty string");
        ms.eta = input.eta;
      }
      if (ms.status === "blocked" && (!ms.statusReason || ms.statusReason.length === 0))
        fail("E_VALIDATION", "statusReason required non-empty when status is blocked");
      ms.updatedAt = ts;
      if (stale) {
        holdChange({ input, ts, action: "milestone_upsert", targetType: "milestone", targetId: found.id,
                     title: found.title || found.id, basis, current: found, proposed: ms });
      }
      if (rm.project) rm.project.updatedAt = ts;
      atomicWrite(FILES.roadmap, rm);
      stampHistory(input, historyEvent({
        action: "milestone_upsert", targetId: ms.id,
        summary: `${created ? "Created" : "Updated"} milestone "${ms.title}"`,
        patch: { status: ms.status, order: ms.order },
      }));
      return remember(ms);
    });
  },
};

// milestone_set_status
TOOLS.milestone_set_status = {
  schema: {
    description: "Set a milestone's status; auto-manages startedAt/completedAt. reason required for 'blocked'.",
    inputSchema: {
      type: "object",
      required: ["id", "status"],
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: [...STATUS] },
        reason: { type: "string" },
        baseVersion: BASE_VERSION_ARG,
        sessionId: { type: "string", description: "Optional AI session id to attribute this change to (see session_hello). Falls back to the cached session_hello id, then $CLAUDE_SESSION_ID." },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const rm = readJson(FILES.roadmap, emptyRoadmap);
      if (!validId(input.id, "ms")) fail("E_VALIDATION", "id must be an ms- id");
      checkStatus(input.status);
      const found = (rm.milestones || []).find((m) => m.id === input.id);
      if (!found) fail("E_NOT_FOUND", `no milestone ${input.id}`);
      // Same shape as every guarded writer: apply to the record, or to a clone
      // of it when the basis is stale, then hold instead of writing.
      const basis = basisFor(input, found.id);
      const stale = isStale(basis, found);
      const ms = stale ? conflicts.cloneRecord(found) : found;
      const ts = nowIso();
      const reason = input.reason !== undefined ? optStr(input, "reason") : ms.statusReason;
      if (input.status === "blocked" && (!reason || reason.length === 0))
        fail("E_VALIDATION", "reason required non-empty when status is blocked");
      ms.status = input.status;
      ms.statusReason = input.status === "blocked" ? reason : (input.reason !== undefined ? reason : ms.statusReason);
      if (input.status === "in_progress" && !ms.startedAt) ms.startedAt = ts;
      if (input.status === "done") { ms.completedAt = ts; if (!ms.startedAt) ms.startedAt = ts; }
      else if (ms.completedAt) ms.completedAt = null; // leaving done clears completedAt
      ms.updatedAt = ts;
      if (stale) {
        holdChange({ input, ts, action: "milestone_set_status", targetType: "milestone", targetId: found.id,
                     title: found.title || found.id, basis, current: found, proposed: ms });
      }
      if (rm.project) rm.project.updatedAt = ts;
      atomicWrite(FILES.roadmap, rm);
      stampHistory(input, historyEvent({
        action: "milestone_set_status", targetId: ms.id,
        summary: `Milestone "${ms.title}" → ${ms.status}`,
        patch: { status: ms.status },
      }));
      return remember(ms);
    });
  },
};

// quest_create — side quest branching off a main-quest milestone
TOOLS.quest_create = {
  schema: {
    description: "Create a side quest branching off any milestone (a main-quest milestone or another side quest's), with optional inline milestones.",
    inputSchema: {
      type: "object",
      required: ["title", "parentMilestoneId"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        plain: { type: "string" },
        parentMilestoneId: { type: "string" },
        side: { type: "string", enum: ["left", "right"] },
        sessionId: { type: "string", description: "Optional AI session id to attribute this change to (see session_hello). Falls back to the cached session_hello id, then $CLAUDE_SESSION_ID." },
        milestones: {
          type: "array",
          items: {
            type: "object",
            required: ["title"],
            properties: {
              title: { type: "string" },
              summary: { type: "string" },
              plain: { type: "string" },
              status: { type: "string", enum: [...STATUS] },
            },
          },
        },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const rm = readJson(FILES.roadmap, emptyRoadmap);
      rm.quests = rm.quests || [];
      rm.milestones = rm.milestones || [];
      const title = reqStr(input, "title", { allowEmpty: false });
      const parentMilestoneId = reqStr(input, "parentMilestoneId", { allowEmpty: false });
      if (!validId(parentMilestoneId, "ms")) fail("E_VALIDATION", "parentMilestoneId must be an ms- id");
      const parent = rm.milestones.find((m) => m.id === parentMilestoneId);
      if (!parent) fail("E_PARENT_NOT_FOUND", `no milestone ${parentMilestoneId}`);
      // Branching off ANY milestone is allowed (dec-nested-branching): a side
      // quest may hang off a main-quest milestone OR another side quest's.
      const parentQuest = rm.quests.find((q) => q.id === parent.questId);
      if (!parentQuest) fail("E_PARENT_NOT_FOUND", `milestone ${parentMilestoneId} has no owning quest`);
      // id
      let id = input.id;
      if (id !== undefined) {
        if (!validId(id, "q")) fail("E_VALIDATION", "id must be a q- id");
        if (rm.quests.some((q) => q.id === id)) fail("E_VALIDATION", `quest id ${id} already exists`);
      } else {
        id = genId("q");
      }
      // side: default alternates by sibling count
      const siblings = rm.quests.filter((q) => q.type === "side" && q.parentMilestoneId === parentMilestoneId);
      let side = input.side;
      if (side !== undefined) {
        if (side !== "left" && side !== "right") fail("E_VALIDATION", "side must be left|right");
      } else {
        side = siblings.length % 2 === 0 ? "right" : "left";
      }
      const order = siblings.reduce((mx, q) => Math.max(mx, q.order), -1) + 1;
      const ts = nowIso();
      const quest = {
        id, type: "side", title, parentMilestoneId, side, order,
        status: "available", createdAt: ts, updatedAt: ts,
      };
      if (input.plain !== undefined) quest.plain = optStr(input, "plain");
      rm.quests.push(quest);
      // inline milestones — first available, rest locked unless given
      const createdMs = [];
      const inline = Array.isArray(input.milestones) ? input.milestones : [];
      for (let i = 0; i < inline.length; i++) {
        const spec = inline[i];
        const mtitle = reqStr(spec, "title", { allowEmpty: false });
        let status = spec.status;
        if (status !== undefined) checkStatus(status);
        else status = i === 0 ? "available" : "locked";
        const ms = {
          id: genId("ms"), questId: id, order: i, title: mtitle,
          summary: optStr(spec, "summary"), status, statusReason: "", eta: null,
          startedAt: status === "in_progress" || status === "done" ? ts : null,
          completedAt: status === "done" ? ts : null,
          createdAt: ts, updatedAt: ts,
        };
        if (spec.plain !== undefined) ms.plain = optStr(spec, "plain");
        if (status === "blocked") fail("E_VALIDATION", "inline milestone cannot be created 'blocked' without a reason; upsert it separately");
        rm.milestones.push(ms);
        createdMs.push(ms);
      }
      if (rm.project) rm.project.updatedAt = ts;
      atomicWrite(FILES.roadmap, rm);
      stampHistory(input, historyEvent({
        action: "quest_create", targetId: id,
        summary: `Created side quest "${title}" off "${parent.title}" (${createdMs.length} milestone${createdMs.length === 1 ? "" : "s"})`,
        patch: { side, parentMilestoneId },
      }));
      return { quest, milestones: createdMs };
    });
  },
};

// item_upsert
TOOLS.item_upsert = {
  schema: {
    description: "Create an item (omit id) or merge fields into an existing one. Never replaces the notes thread.",
    inputSchema: {
      type: "object",
      required: ["milestoneId", "kind", "title"],
      properties: {
        id: { type: "string" },
        milestoneId: { type: "string" },
        kind: { type: "string", enum: ["task", "explanation", "note_to_founder", "blocker"] },
        title: { type: "string" },
        body: { type: "string" },
        plain: { type: "string" },
        status: { type: "string", enum: [...ITEM_STATUS] },
        order: { type: "integer" },
        blockedReason: { type: "string" },
        baseVersion: BASE_VERSION_ARG,
        sessionId: { type: "string", description: "Optional AI session id to attribute this change to (see session_hello). Falls back to the cached session_hello id, then $CLAUDE_SESSION_ID." },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const rm = readJson(FILES.roadmap, emptyRoadmap);
      rm.items = rm.items || [];
      const milestoneId = reqStr(input, "milestoneId", { allowEmpty: false });
      if (!validId(milestoneId, "ms")) fail("E_VALIDATION", "milestoneId must be an ms- id");
      if (!(rm.milestones || []).some((m) => m.id === milestoneId)) fail("E_PARENT_NOT_FOUND", `no milestone ${milestoneId}`);
      const KIND = new Set(["task", "explanation", "note_to_founder", "blocker"]);
      if (!KIND.has(input.kind)) fail("E_VALIDATION", `kind must be one of [${[...KIND].join(", ")}]`);
      const ts = nowIso();
      // `found` is the record on disk, `it` is what the fields land on — the
      // same object, or a clone when the basis is stale. Create is exempt.
      let found = null, it;
      let basis = null, stale = false;
      let created = false;
      if (input.id !== undefined) {
        if (!validId(input.id, "it")) fail("E_VALIDATION", "id must be an it- id");
        found = rm.items.find((x) => x.id === input.id);
        if (!found) fail("E_NOT_FOUND", `no item ${input.id}`);
        basis = basisFor(input, found.id);
        stale = isStale(basis, found);
        it = stale ? conflicts.cloneRecord(found) : found;
      } else {
        created = true;
        const maxOrder = rm.items.filter((x) => x.milestoneId === milestoneId)
          .reduce((mx, x) => Math.max(mx, x.order), -1);
        it = {
          id: genId("it"), milestoneId, order: maxOrder + 1, kind: input.kind,
          title: "", body: "", status: "open", blockedReason: "", notes: [],
          createdAt: ts, updatedAt: ts,
        };
        rm.items.push(it);
      }
      it.milestoneId = milestoneId;
      it.kind = input.kind;
      it.title = reqStr(input, "title", { allowEmpty: false });
      if (input.body !== undefined) it.body = optStr(input, "body");
      if (input.plain !== undefined) it.plain = optStr(input, "plain");
      if (input.order !== undefined) {
        if (!Number.isInteger(input.order) || input.order < 0) fail("E_VALIDATION", "order must be a non-negative integer");
        it.order = input.order;
      }
      if (input.status !== undefined) {
        if (!ITEM_STATUS.has(input.status)) fail("E_VALIDATION", `status must be one of [${[...ITEM_STATUS].join(", ")}]`);
        it.status = input.status;
      }
      if (input.blockedReason !== undefined) it.blockedReason = optStr(input, "blockedReason");
      if (it.status === "blocked" && (!it.blockedReason || it.blockedReason.length === 0))
        fail("E_VALIDATION", "blockedReason required non-empty when status is blocked");
      if (!Array.isArray(it.notes)) it.notes = [];
      it.updatedAt = ts;
      if (stale) {
        holdChange({ input, ts, action: "item_upsert", targetType: "item", targetId: found.id,
                     title: found.title || found.id, basis, current: found, proposed: it });
      }
      if (rm.project) rm.project.updatedAt = ts;
      atomicWrite(FILES.roadmap, rm);
      stampHistory(input, historyEvent({
        action: "item_upsert", targetId: it.id,
        summary: `${created ? "Created" : "Updated"} ${it.kind} "${it.title}"`,
      }));
      return remember(it);
    });
  },
};

// item_note_add
TOOLS.item_note_add = {
  schema: {
    description: "Append a note to an item's threaded conversation.",
    inputSchema: {
      type: "object",
      required: ["itemId", "body"],
      properties: {
        itemId: { type: "string" },
        body: { type: "string" },
        author: { type: "string", enum: ["agent", "founder"] },
        sessionId: { type: "string", description: "Optional AI session id to attribute this change to (see session_hello). Falls back to the cached session_hello id, then $CLAUDE_SESSION_ID." },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const rm = readJson(FILES.roadmap, emptyRoadmap);
      if (!validId(input.itemId, "it")) fail("E_VALIDATION", "itemId must be an it- id");
      const body = reqStr(input, "body", { allowEmpty: false });
      const author = input.author !== undefined ? input.author : "agent";
      if (author !== "agent" && author !== "founder") fail("E_VALIDATION", "author must be agent|founder");
      const it = (rm.items || []).find((x) => x.id === input.itemId);
      if (!it) fail("E_NOT_FOUND", `no item ${input.itemId}`);
      const ts = nowIso();
      if (!Array.isArray(it.notes)) it.notes = [];
      const note = { id: genId("note"), author, body, ts };
      it.notes.push(note);
      it.updatedAt = ts;
      if (rm.project) rm.project.updatedAt = ts;
      atomicWrite(FILES.roadmap, rm);
      stampHistory(input, historyEvent({
        actor: author, action: "item_note_add", targetId: it.id,
        summary: `${author === "founder" ? "Founder" : "Agent"} noted on "${it.title || it.id}"`,
      }));
      return it;
    });
  },
};

// asset_link
TOOLS.asset_link = {
  schema: {
    description: "Link a resource (file/url/doc/command) to a milestone.",
    inputSchema: {
      type: "object",
      required: ["milestoneId", "kind", "label", "ref"],
      properties: {
        id: { type: "string" },
        milestoneId: { type: "string" },
        kind: { type: "string", enum: ["file", "url", "doc", "command"] },
        label: { type: "string" },
        ref: { type: "string" },
        sessionId: { type: "string", description: "Optional AI session id to attribute this change to (see session_hello). Falls back to the cached session_hello id, then $CLAUDE_SESSION_ID." },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const rm = readJson(FILES.roadmap, emptyRoadmap);
      rm.assets = rm.assets || [];
      const milestoneId = reqStr(input, "milestoneId", { allowEmpty: false });
      if (!validId(milestoneId, "ms")) fail("E_VALIDATION", "milestoneId must be an ms- id");
      if (!(rm.milestones || []).some((m) => m.id === milestoneId)) fail("E_PARENT_NOT_FOUND", `no milestone ${milestoneId}`);
      const KIND = new Set(["file", "url", "doc", "command"]);
      if (!KIND.has(input.kind)) fail("E_VALIDATION", `kind must be one of [${[...KIND].join(", ")}]`);
      const label = reqStr(input, "label", { allowEmpty: false });
      const ref = reqStr(input, "ref", { allowEmpty: false });
      let id = input.id;
      if (id !== undefined) {
        if (!validId(id, "as")) fail("E_VALIDATION", "id must be an as- id");
        if (rm.assets.some((a) => a.id === id)) fail("E_VALIDATION", `asset id ${id} already exists`);
      } else {
        id = genId("as");
      }
      const ts = nowIso();
      const asset = { id, milestoneId, kind: input.kind, label, ref, addedAt: ts };
      rm.assets.push(asset);
      if (rm.project) rm.project.updatedAt = ts;
      atomicWrite(FILES.roadmap, rm);
      stampHistory(input, historyEvent({
        action: "asset_link", targetId: id,
        summary: `Linked ${input.kind} asset "${label}" to milestone ${milestoneId}`,
      }));
      return asset;
    });
  },
};

// decision_log
TOOLS.decision_log = {
  schema: {
    description: "Log a decision. Agent proposes with approved:false; only the founder flips it true.",
    inputSchema: {
      type: "object",
      required: ["title", "rationale"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        rationale: { type: "string" },
        impact: { type: "string" },
        plain: { type: "string" },
        relatedMilestoneIds: { type: "array", items: { type: "string" } },
        proposedBy: { type: "string", enum: ["agent", "founder"] },
        approved: { type: "boolean" },
        sessionId: { type: "string", description: "Optional AI session id to attribute this change to (see session_hello). Falls back to the cached session_hello id, then $CLAUDE_SESSION_ID." },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const dec = readJson(FILES.decisions, emptyDecisions);
      dec.decisions = dec.decisions || [];
      const title = reqStr(input, "title", { allowEmpty: false });
      const rationale = reqStr(input, "rationale", { allowEmpty: false });
      const impact = optStr(input, "impact");
      const related = input.relatedMilestoneIds !== undefined ? input.relatedMilestoneIds : [];
      if (!Array.isArray(related)) fail("E_VALIDATION", "relatedMilestoneIds must be an array");
      for (const mid of related) if (!validId(mid, "ms")) fail("E_VALIDATION", `relatedMilestoneIds entry invalid: ${JSON.stringify(mid)}`);
      const proposedBy = input.proposedBy !== undefined ? input.proposedBy : "agent";
      if (proposedBy !== "agent" && proposedBy !== "founder") fail("E_VALIDATION", "proposedBy must be agent|founder");
      const approved = input.approved === true;
      let id = input.id;
      if (id !== undefined) {
        if (!validId(id, "dec")) fail("E_VALIDATION", "id must be a dec- id");
        if (dec.decisions.some((d) => d.id === id)) fail("E_VALIDATION", `decision id ${id} already exists`);
      } else {
        id = genId("dec");
      }
      const ts = nowIso();
      const decision = {
        id, ts, title, rationale, impact, relatedMilestoneIds: related,
        proposedBy, approved, approvedAt: approved ? ts : null,
        status: approved ? "approved" : "proposed", supersededBy: null,
      };
      if (input.plain !== undefined) decision.plain = optStr(input, "plain");
      dec.decisions.push(decision);
      atomicWrite(FILES.decisions, dec);
      stampHistory(input, historyEvent({
        actor: proposedBy, action: "decision_log", targetId: id,
        summary: `${proposedBy === "founder" ? "Founder" : "Agent"} logged decision "${title}"${approved ? " (approved)" : " (proposed)"}`,
        patch: { approved, status: decision.status },
      }));
      return decision;
    });
  },
};

// decision_set_approval
TOOLS.decision_set_approval = {
  schema: {
    description: "Set a decision's approval state. Legacy: approved:true → approved, approved:false → rejected. Or use set:\"approved\"|\"rejected\"|\"proposed\" — set:\"proposed\" REVOKES back to the proposed (un-decided) state. Provide EXACTLY ONE of approved / set.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        approved: { type: "boolean", description: "Legacy boolean flip. true → approved, false → rejected. Mutually exclusive with `set`." },
        set: { type: "string", enum: ["approved", "rejected", "proposed"], description: "Target state. \"proposed\" revokes an approval/rejection back to un-decided. Mutually exclusive with `approved`." },
        baseVersion: BASE_VERSION_ARG,
        sessionId: { type: "string", description: "Optional AI session id to attribute this change to (see session_hello). Falls back to the cached session_hello id, then $CLAUDE_SESSION_ID." },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const dec = readJson(FILES.decisions, emptyDecisions);
      if (!validId(input.id, "dec")) fail("E_VALIDATION", "id must be a dec- id");
      const hasApproved = input.approved !== undefined && input.approved !== null;
      const hasSet = input.set !== undefined && input.set !== null;
      if (hasApproved === hasSet) fail("E_VALIDATION", "provide exactly one of `approved` (boolean) or `set` (approved|rejected|proposed)");
      let target;
      if (hasApproved) {
        if (typeof input.approved !== "boolean") fail("E_VALIDATION", "approved must be a boolean");
        target = input.approved ? "approved" : "rejected";
      } else {
        if (input.set !== "approved" && input.set !== "rejected" && input.set !== "proposed")
          fail("E_VALIDATION", "set must be one of approved|rejected|proposed");
        target = input.set;
      }
      const found = (dec.decisions || []).find((x) => x.id === input.id);
      if (!found) fail("E_NOT_FOUND", `no decision ${input.id}`);
      const ts = nowIso();
      // A decision carries no updatedAt, which is exactly why the version is a
      // content hash: it is still a record two writers can argue over.
      const basis = basisFor(input, found.id);
      const stale = isStale(basis, found);
      const d = stale ? conflicts.cloneRecord(found) : found;
      if (target === "approved") { d.approved = true; d.status = "approved"; d.approvedAt = ts; }
      else if (target === "rejected") { d.approved = false; d.status = "rejected"; d.approvedAt = null; }
      else { d.approved = false; d.status = "proposed"; d.approvedAt = null; } // proposed = revoke
      if (stale) {
        holdChange({ input, ts, action: "decision_set_approval", targetType: "decision", targetId: found.id,
                     title: found.title || found.id, basis, current: found, proposed: d });
      }
      atomicWrite(FILES.decisions, dec);
      const verb = target === "approved" ? "approved" : target === "rejected" ? "rejected" : "revoked (back to proposed)";
      stampHistory(input, historyEvent({
        actor: "founder", action: "decision_set_approval", targetId: d.id,
        summary: `Founder ${verb} decision "${d.title || d.id}"`,
        patch: { approved: d.approved, status: d.status },
      }));
      return remember(d);
    });
  },
};

// pin_compaction
TOOLS.pin_compaction = {
  schema: {
    description: "Pin a compaction marker on the road, optionally with a synthesis doc path.",
    inputSchema: {
      type: "object",
      required: ["summary"],
      properties: {
        label: { type: "string" },
        afterMilestoneId: { type: ["string", "null"] },
        summary: { type: "string" },
        synthesisDocPath: { type: ["string", "null"] },
        sessionId: { type: "string", description: "Optional AI session id to attribute this change to (see session_hello). Falls back to the cached session_hello id, then $CLAUDE_SESSION_ID." },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const pins = readJson(FILES.pins, emptyPins);
      pins.pins = pins.pins || [];
      const rm = readJson(FILES.roadmap, emptyRoadmap);
      const summary = reqStr(input, "summary", { allowEmpty: false });
      // main-quest milestones (for afterMilestoneId validation + default)
      const mainQuestId = (rm.quests || []).find((q) => q.type === "main")?.id;
      const mainMs = (rm.milestones || []).filter((m) => m.questId === mainQuestId)
        .sort((a, b) => a.order - b.order);
      const mainMsIds = new Set(mainMs.map((m) => m.id));
      let afterMilestoneId;
      if (input.afterMilestoneId !== undefined) {
        if (input.afterMilestoneId !== null) {
          if (!validId(input.afterMilestoneId, "ms")) fail("E_VALIDATION", "afterMilestoneId must be an ms- id or null");
          if (!mainMsIds.has(input.afterMilestoneId)) fail("E_VALIDATION", "afterMilestoneId must be a main-quest milestone or null");
        }
        afterMilestoneId = input.afterMilestoneId;
      } else {
        // default: last non-locked main-quest milestone (or null)
        const nonLocked = mainMs.filter((m) => m.status !== "locked");
        afterMilestoneId = nonLocked.length ? nonLocked[nonLocked.length - 1].id : null;
      }
      let synthesisDocPath = null;
      if (input.synthesisDocPath !== undefined && input.synthesisDocPath !== null) {
        synthesisDocPath = reqStr(input, "synthesisDocPath", { allowEmpty: false });
      }
      const label = input.label !== undefined && input.label !== null && input.label !== ""
        ? String(input.label) : `Compaction #${pins.pins.length + 1}`;
      const ts = nowIso();
      const pin = { id: genId("pin"), ts, kind: "compaction", label, afterMilestoneId, summary, synthesisDocPath };
      pins.pins.push(pin);
      atomicWrite(FILES.pins, pins);
      stampHistory(input, historyEvent({
        action: "pin_compaction", targetId: pin.id,
        summary: `Pinned "${label}"${afterMilestoneId ? ` after ${afterMilestoneId}` : ""}`,
      }));
      return pin;
    });
  },
};

// ---------------------------------------------------------------------------
// Jargon-proofing helpers (surface-form uniqueness for the glossary)
// ---------------------------------------------------------------------------
// A surface form is case-sensitive iff it contains no lowercase letter
// (data-contract §2.1). Two forms collide when their keys are equal.
// The U+0000 separators are escapes, never raw bytes: a raw NUL makes git and
// file(1) call this whole file binary, costing the diff, blame and merge.
function surfaceKey(s) {
  return /^[^a-z]*$/.test(s) ? "\u0000cs\u0000" + s : "\u0000ci\u0000" + s.toLowerCase();
}

// list_unclear — read only, no history event.
TOOLS.list_unclear = {
  schema: {
    description: "List every milestone, item, and decision the founder flagged as unclear, oldest first (drain order), with founder context. Read-only, appends no history event. Pass roadmapId to read another registered road's unclear queue.",
    inputSchema: {
      type: "object",
      properties: {
        roadmapId: { type: "string", description: "Optional registry id (rm-…) of ANOTHER road to read instead of this server's road (see roadmap_list). Read-only." },
      },
    },
  },
  run(input) {
    const files = filesFor(resolveRoadRoot(input && input.roadmapId));
    const rm = readJson(files.roadmap, emptyRoadmap);
    const dec = readJson(files.decisions, emptyDecisions);
    const milestones = rm.milestones || [];
    const items = rm.items || [];
    // The drain queue is a read that is almost always followed by a write, so
    // it is the other place a basis is learned — own road only, same rule as
    // roadmap_get (a cross-road read can never be a basis for a write here).
    if (!(input && input.roadmapId)) {
      rememberAll(milestones); rememberAll(items); rememberAll(dec.decisions);
    }
    const msById = new Map(milestones.map((m) => [m.id, m]));
    const out = [];
    for (const m of milestones) {
      if (m.unclear === true) {
        out.push({
          targetType: "milestone", id: m.id, title: m.title || "", text: m.summary || "",
          plain: m.plain || "", unclearAt: m.unclearAt || null, questId: m.questId,
        });
      }
    }
    for (const it of items) {
      if (it.unclear === true) {
        const parent = msById.get(it.milestoneId);
        out.push({
          targetType: "item", id: it.id, title: it.title || "", text: it.body || "",
          plain: it.plain || "", unclearAt: it.unclearAt || null,
          milestoneId: it.milestoneId, milestoneTitle: parent ? (parent.title || "") : "",
          notes: Array.isArray(it.notes) ? it.notes : [],
        });
      }
    }
    for (const d of (dec.decisions || [])) {
      if (d.unclear === true) {
        out.push({
          targetType: "decision", id: d.id, title: d.title || "",
          text: `${d.rationale || ""}\n${d.impact || ""}`,
          plain: d.plain || "", unclearAt: d.unclearAt || null,
        });
      }
    }
    out.sort((a, b) => String(a.unclearAt || "").localeCompare(String(b.unclearAt || "")));
    return { count: out.length, unclear: out };
  },
};

// clear_unclear — resolve a flag by supplying a plain rewrite. targetType inferred from id prefix.
TOOLS.clear_unclear = {
  schema: {
    description: "Clear an unclear flag on a milestone, item, or decision by supplying a plain-language rewrite. targetType is inferred from the id prefix (ms-/it-/dec-).",
    inputSchema: {
      type: "object",
      required: ["id", "rewritten_plain"],
      properties: {
        id: { type: "string" },
        rewritten_plain: { type: "string" },
        baseVersion: BASE_VERSION_ARG,
        sessionId: { type: "string", description: "Optional AI session id to attribute this change to (see session_hello). Falls back to the cached session_hello id, then $CLAUDE_SESSION_ID." },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const id = reqStr(input, "id", { allowEmpty: false });
      const rewritten = reqStr(input, "rewritten_plain", { allowEmpty: false });
      const ts = nowIso();
      // `found` is what is on disk; `rec` is what the rewrite lands on — the
      // same object, or a clone when the basis is stale. `commit` is the write,
      // skipped entirely on a hold.
      // ORDER MATTERS HERE, and it is the one place in this file where it is
      // not obvious. "is it still flagged?" is a question about the CURRENT
      // state, so it only speaks for a writer whose basis IS current. Asking it
      // first would answer a stale writer E_VALIDATION and drop the rewrite it
      // spent a whole turn producing — a silent loss, which is precisely what
      // this mechanism exists to prevent. So: find, judge the basis, and hold
      // BEFORE the flag check. A held clear surfaces as an argument between two
      // rewrites, which is a thing the founder can actually rule on.
      const basis = basisFor(input, id);
      let found, rec, title, targetType, commit, stale;
      if (validId(id, "dec")) {
        const dec = readJson(FILES.decisions, emptyDecisions);
        found = (dec.decisions || []).find((d) => d.id === id);
        if (!found) fail("E_NOT_FOUND", `no decision ${id}`);
        stale = isStale(basis, found);
        if (!stale && found.unclear !== true) fail("E_VALIDATION", `decision ${id} is not flagged unclear`);
        targetType = "decision";
        rec = stale ? conflicts.cloneRecord(found) : found;
        rec.plain = rewritten;
        rec.unclear = false;
        rec.unclearAt = null;
        title = found.title || id;
        commit = () => atomicWrite(FILES.decisions, dec);
      } else if (validId(id, "ms") || validId(id, "it")) {
        const rm = readJson(FILES.roadmap, emptyRoadmap);
        const coll = validId(id, "ms") ? (rm.milestones || []) : (rm.items || []);
        found = coll.find((r) => r.id === id);
        if (!found) fail("E_NOT_FOUND", `no ${validId(id, "ms") ? "milestone" : "item"} ${id}`);
        stale = isStale(basis, found);
        if (!stale && found.unclear !== true) fail("E_VALIDATION", `${id} is not flagged unclear`);
        targetType = validId(id, "ms") ? "milestone" : "item";
        rec = stale ? conflicts.cloneRecord(found) : found;
        rec.plain = rewritten;
        rec.unclear = false;
        rec.unclearAt = null;
        rec.updatedAt = ts;
        title = found.title || id;
        commit = () => { if (rm.project) rm.project.updatedAt = ts; atomicWrite(FILES.roadmap, rm); };
      } else {
        fail("E_VALIDATION", "id must be an ms-, it-, or dec- id");
      }
      if (stale) {
        holdChange({ input, ts, action: "clear_unclear", targetType, targetId: id,
                     title, basis, current: found, proposed: rec });
      }
      commit();
      stampHistory(input, historyEvent({
        action: "clear_unclear", targetId: id,
        summary: `Cleared unclear flag on "${title}" with a plain rewrite`,
        patch: { unclear: false },
      }));
      return remember(rec);
    });
  },
};

// glossary_term_upsert — define or merge a glossary term.
TOOLS.glossary_term_upsert = {
  schema: {
    description: "Define a glossary term (omit id) or merge into an existing one (provide id). Enforces surface-form uniqueness across the whole glossary. term and plain are required non-empty.",
    inputSchema: {
      type: "object",
      required: ["term", "plain"],
      properties: {
        id: { type: "string" },
        term: { type: "string" },
        plain: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
        note: { type: "string" },
        link: { type: ["string", "null"] },
        baseVersion: BASE_VERSION_ARG,
        sessionId: { type: "string", description: "Optional AI session id to attribute this change to (see session_hello). Falls back to the cached session_hello id, then $CLAUDE_SESSION_ID." },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const gl = readJson(FILES.glossary, emptyGlossary);
      gl.terms = gl.terms || [];
      const term = reqStr(input, "term", { allowEmpty: false });
      const plain = reqStr(input, "plain", { allowEmpty: false });
      // aliases
      let aliases;
      if (input.aliases !== undefined) {
        if (!Array.isArray(input.aliases)) fail("E_VALIDATION", "aliases must be an array of strings");
        for (const a of input.aliases) {
          if (typeof a !== "string" || a.length === 0) fail("E_VALIDATION", "aliases entries must be non-empty strings");
        }
        aliases = input.aliases.slice();
      }
      // link
      let link;
      if (input.link !== undefined) {
        if (input.link !== null && (typeof input.link !== "string" || input.link.length === 0))
          fail("E_VALIDATION", "link must be null or a non-empty string");
        link = input.link;
      }
      // `found` is the term on disk, `entry` is what the fields land on — the
      // same object, or a clone when the basis is stale. Create is exempt.
      let found = null, entry;
      let basis = null, stale = false;
      let created = false;
      if (input.id !== undefined) {
        if (!validId(input.id, "term")) fail("E_VALIDATION", "id must be a term- id");
        found = gl.terms.find((t) => t.id === input.id);
        if (!found) fail("E_NOT_FOUND", `no glossary term ${input.id}`);
        basis = basisFor(input, found.id);
        stale = isStale(basis, found);
        entry = stale ? conflicts.cloneRecord(found) : found;
        entry.term = term;
        entry.plain = plain;
        if (aliases !== undefined) entry.aliases = aliases;
        if (input.note !== undefined) entry.note = optStr(input, "note");
        if (link !== undefined) entry.link = link;
      } else {
        created = true;
        entry = {
          id: genId("term"),
          term,
          aliases: aliases !== undefined ? aliases : [],
          plain,
          note: input.note !== undefined ? optStr(input, "note") : "",
          link: link !== undefined ? link : null,
        };
        gl.terms.push(entry);
      }
      // Surface-form uniqueness across the whole glossary (data-contract §1.1).
      // A held change's clone is not in gl.terms, so the entry it replaces is
      // swapped out here — the check reads the glossary this call MEANT to
      // write, whether or not that write is about to happen.
      const seen = new Map(); // key -> "surface (term-id)"
      for (const t of gl.terms.map((x) => (found && x === found) ? entry : x)) {
        const surfaces = [t.term, ...((t.aliases) || [])];
        for (const s of surfaces) {
          const k = surfaceKey(s);
          if (seen.has(k)) {
            fail("E_VALIDATION", `surface form "${s}" collides with "${seen.get(k)}" (each term/alias must be unique across the glossary)`);
          }
          seen.set(k, `${s} in ${t.id}`);
        }
      }
      if (stale) {
        holdChange({ input, ts: nowIso(), action: "glossary_term_upsert", targetType: "term", targetId: found.id,
                     title: found.term || found.id, basis, current: found, proposed: entry });
      }
      atomicWrite(FILES.glossary, gl);
      stampHistory(input, historyEvent({
        action: "glossary_term_upsert", targetId: entry.id,
        summary: `Defined glossary term "${entry.term}"`,
        patch: { term: entry.term },
      }));
      return remember(entry);
    });
  },
};

// ---------------------------------------------------------------------------
// Stability debts — delete tools (direct-effect, history-logged recovery).
// Each delete appends a history event whose patch carries a full snapshot of the
// deleted record (patch.deleted) plus any cascaded records (patch.cascaded), so
// a delete is always recoverable from the append-only log.
// ---------------------------------------------------------------------------
function checkStrArr(obj, key, { required = false } = {}) {
  const v = obj[key];
  if (v === undefined || v === null) {
    if (required) fail("E_VALIDATION", `${key} must be an array of strings`);
    return [];
  }
  if (!Array.isArray(v)) fail("E_VALIDATION", `${key} must be an array of strings`);
  for (const s of v) if (typeof s !== "string") fail("E_VALIDATION", `${key} entries must be strings`);
  return v.slice();
}

// The three delete tools share their rules with the dashboard's POST /api/delete
// through deletion.mjs — same dependent rules, same cascade, same error text.
// What lives HERE is only what a shared pure module cannot do: the lock, the
// files, the history event.
//
// scrubForDelete — the half the tools were missing. A milestone or quest id is
// referenced from THREE other files, and the validator errors on every dangling
// one (relatedMilestoneIds / afterMilestoneId / frontierMilestoneId), so a
// delete that skipped this left the road invalid. Only files that actually
// moved are written. Caller already holds the lock.
function scrubForDelete(plan) {
  const decisions = readJson(FILES.decisions, emptyDecisions);
  const pins = readJson(FILES.pins, emptyPins);
  const suggestions = readJson(FILES.suggestions, emptySuggestions);
  const { changed, scrubbed } = scrubDeletedRefs({ decisions, pins, suggestions }, plan.removedMsIds, plan.removedQuestIds);
  if (changed.decisions) atomicWrite(FILES.decisions, decisions);
  if (changed.pins) atomicWrite(FILES.pins, pins);
  if (changed.suggestions) atomicWrite(FILES.suggestions, suggestions);
  return scrubbed;
}
// True when the scrub actually touched something. The history patch carries
// `scrubbed` only then — the same "omit what is empty" idiom the cascade key
// already follows, so an uncomplicated delete's event reads as it always did.
const anyScrubbed = (s) => s.decisions.length > 0 || s.pins.length > 0 || s.suggestions.length > 0;

// milestone_delete — remove a milestone. Dependents (its items, its assets, and
// any side quests branching off it, plus those quests' milestones/items/assets)
// force a cascade: E_CONFLICT unless force:true.
TOOLS.milestone_delete = {
  schema: {
    description: "Delete a milestone. If it has dependents (items, assets, or side quests branching off it), returns E_CONFLICT listing them unless force:true, which cascades the delete. History-logged for recovery.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        force: { type: "boolean", description: "Cascade-delete dependents instead of failing with E_CONFLICT." },
        sessionId: { type: "string", description: "Optional AI session id to attribute this change to (see session_hello)." },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const rm = readJson(FILES.roadmap, emptyRoadmap);
      const plan = planDeletion(rm, "milestone", input.id, { force: input.force === true });
      if (!plan.ok) fail(plan.code, plan.message);
      const ms = plan.record, cascaded = plan.cascaded;
      const ts = nowIso();
      const scrubbed = scrubForDelete(plan);
      if (rm.project) rm.project.updatedAt = ts;
      atomicWrite(FILES.roadmap, rm);
      const patch = cascaded.length ? { deleted: ms, cascaded } : { deleted: ms };
      if (anyScrubbed(scrubbed)) patch.scrubbed = scrubbed;
      stampHistory(input, historyEvent({
        action: "milestone_delete", targetId: input.id,
        summary: `Deleted milestone "${ms.title || input.id}"${cascaded.length ? ` (+${cascaded.length} cascaded)` : ""}`,
        patch,
      }));
      // Anything that just left the road takes its open holds with it.
      const voided = voidHoldsFor(input, [ms.id, ...cascaded.map((r) => r && r.id).filter(Boolean)], ts);
      return { deleted: ms, cascaded, scrubbed, voidedConflicts: voided.map((c) => c.id) };
    });
  },
};

// item_delete — remove an item (a leaf; its notes go with it). No dependents.
TOOLS.item_delete = {
  schema: {
    description: "Delete an item (and its notes). Items are leaves — no dependents, no force needed. History-logged for recovery.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        sessionId: { type: "string", description: "Optional AI session id to attribute this change to (see session_hello)." },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const rm = readJson(FILES.roadmap, emptyRoadmap);
      const plan = planDeletion(rm, "item", input.id, {});
      if (!plan.ok) fail(plan.code, plan.message);
      // No scrub: an it- id is referenced by nothing outside the roadmap, so a
      // leaf delete has nothing to clean up after it.
      const it = plan.record;
      const ts = nowIso();
      if (rm.project) rm.project.updatedAt = ts;
      atomicWrite(FILES.roadmap, rm);
      stampHistory(input, historyEvent({
        action: "item_delete", targetId: input.id,
        summary: `Deleted ${it.kind || "item"} "${it.title || input.id}"`,
        patch: { deleted: it },
      }));
      // Anything that just left the road takes its open holds with it.
      const voided = voidHoldsFor(input, [it.id], ts);
      return { deleted: it, voidedConflicts: voided.map((c) => c.id) };
    });
  },
};

// quest_delete — remove a side quest and (cascading) its milestones/items/assets.
// The main quest can NEVER be deleted (E_VALIDATION).
TOOLS.quest_delete = {
  schema: {
    description: "Delete a side quest. The main quest can never be deleted (E_VALIDATION). If the quest has milestones, returns E_CONFLICT unless force:true, which cascades (milestones + their items/assets). History-logged for recovery.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        force: { type: "boolean", description: "Cascade-delete the quest's milestones (and their items/assets)." },
        sessionId: { type: "string", description: "Optional AI session id to attribute this change to (see session_hello)." },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const rm = readJson(FILES.roadmap, emptyRoadmap);
      const plan = planDeletion(rm, "quest", input.id, { force: input.force === true });
      if (!plan.ok) fail(plan.code, plan.message);
      const q = plan.record, cascaded = plan.cascaded;
      const ts = nowIso();
      const scrubbed = scrubForDelete(plan);
      if (rm.project) rm.project.updatedAt = ts;
      atomicWrite(FILES.roadmap, rm);
      const patch = cascaded.length ? { deleted: q, cascaded } : { deleted: q };
      if (anyScrubbed(scrubbed)) patch.scrubbed = scrubbed;
      stampHistory(input, historyEvent({
        action: "quest_delete", targetId: input.id,
        summary: `Deleted side quest "${q.title || input.id}"${cascaded.length ? ` (+${cascaded.length} cascaded)` : ""}`,
        patch,
      }));
      // Anything that just left the road takes its open holds with it.
      const voided = voidHoldsFor(input, [q.id, ...cascaded.map((r) => r && r.id).filter(Boolean)], ts);
      return { deleted: q, cascaded, scrubbed, voidedConflicts: voided.map((c) => c.id) };
    });
  },
};

// ---------------------------------------------------------------------------
// The ruling. A hold is only half the promise — "held, not applied and not
// discarded" is a lie unless there is a way to apply it or let it go, and the
// founder is the one who decides which. These two tools are that way from a
// chat session; the dashboard's conflict view is the same thing in the browser,
// over the same file.
// ---------------------------------------------------------------------------

// conflict_list — read only, no history event.
TOOLS.conflict_list = {
  schema: {
    description: "List the colliding writes HELD on this road, open ones first. A held change was never applied and never discarded: it was based on a version of the record that is no longer current, so it waits on a founder ruling. Each entry carries BOTH versions — `current` (the write that landed first and is what the board shows) and `proposed` (the held one; null for a held delete) — plus the two version hashes and the raw call. Read-only, appends no history event; rule with conflict_resolve. Pass roadmapId to read another registered road's holds.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "ruled", "void", "all"], description: "Which holds to return (default 'open'). 'void' = the record was deleted, so there was nothing left to rule on. 'all' returns every hold this road has ever recorded." },
        roadmapId: { type: "string", description: "Optional registry id (rm-…) of ANOTHER road to read instead of this server's road (see roadmap_list). Read-only." },
      },
    },
  },
  run(input) {
    const files = filesFor(resolveRoadRoot(input && input.roadmapId));
    const want = (input && input.status) ? input.status : "open";
    const all = (readJson(files.conflicts, emptyConflicts).conflicts) || [];
    const list = want === "all" ? all.slice() : all.filter((c) => c && c.status === want);
    list.sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1));
    return { count: list.length, totalHeld: all.length, conflicts: list };
  },
};

// Carry out a ruling of "keep the held version". The WHOLE record is written,
// not a field merge: what the founder chose is what they were shown side by
// side, so applying it replaces the record with exactly that. Caller holds the
// lock. Throws the tool's own E_ codes on a refusal.
function applyHeldChange(cf, ts) {
  if (cf.proposed === null || cf.proposed === undefined) {
    // A held DELETE proposes no record at all, so the ruling re-runs the
    // deletion NOW, against today's road. Dependents that appeared while the
    // hold sat open are a real refusal, honestly reported.
    const inp = (cf.input && typeof cf.input === "object") ? cf.input : {};
    const rm = readJson(FILES.roadmap, emptyRoadmap);
    const plan = planDeletion(rm, cf.targetType, cf.targetId, { force: inp.force === true });
    if (!plan.ok) fail(plan.code, plan.message);
    const scrubbed = scrubForDelete(plan);
    if (rm.project) rm.project.updatedAt = ts;
    atomicWrite(FILES.roadmap, rm);
    return { deleted: plan.record, cascaded: plan.cascaded, scrubbed };
  }
  // Terms and decisions carry no updatedAt; the road records do.
  const swap = (list, file, doc) => {
    const i = list.findIndex((r) => r && r.id === cf.targetId);
    if (i < 0) fail("E_NOT_FOUND", `no ${cf.targetType} ${cf.targetId} to apply the held change to`);
    list[i] = (cf.targetType === "decision" || cf.targetType === "term")
      ? Object.assign({}, cf.proposed)
      : Object.assign({}, cf.proposed, { updatedAt: ts });
    atomicWrite(file, doc);
    return { record: list[i] };
  };
  if (cf.targetType === "decision") {
    const dec = readJson(FILES.decisions, emptyDecisions);
    dec.decisions = dec.decisions || [];
    return swap(dec.decisions, FILES.decisions, dec);
  }
  if (cf.targetType === "term") {
    const gl = readJson(FILES.glossary, emptyGlossary);
    gl.terms = gl.terms || [];
    return swap(gl.terms, FILES.glossary, gl);
  }
  const rm = readJson(FILES.roadmap, emptyRoadmap);
  const key = cf.targetType === "milestone" ? "milestones" : cf.targetType === "item" ? "items" : "quests";
  if (!Array.isArray(rm[key])) rm[key] = [];
  if (rm.project) rm.project.updatedAt = ts;
  return swap(rm[key], FILES.roadmap, rm);
}

// conflict_resolve — the founder's ruling, recorded.
TOOLS.conflict_resolve = {
  schema: {
    description: "Record the founder's ruling on a held colliding write. keep:\"current\" lets the write that landed first stand and closes the argument; keep:\"held\" writes the held version over the record — the WHOLE record, exactly as it was shown, not a field merge. Either way the conflict becomes \"ruled\" and keeps both versions inside it. This tool records a ruling; it does not make one. Ask the founder first, showing both versions (conflict_list), and never guess which side they would take.",
    inputSchema: {
      type: "object",
      required: ["id", "keep"],
      properties: {
        id: { type: "string", description: "The conflict id (cf-…) from conflict_list." },
        keep: { type: "string", enum: ["current", "held"], description: "\"current\" = the first write stands. \"held\" = apply the held version over the record." },
        sessionId: { type: "string", description: "Optional AI session id to attribute this ruling to (see session_hello). Falls back to the cached session_hello id, then $CLAUDE_SESSION_ID." },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const id = reqStr(input, "id", { allowEmpty: false });
      if (input.keep !== "current" && input.keep !== "held") fail("E_VALIDATION", "keep must be current|held");
      const doc = readJson(FILES.conflicts, emptyConflicts);
      const cf = ((doc.conflicts) || []).find((c) => c && c.id === id);
      if (!cf) fail("E_NOT_FOUND", `no conflict ${id}`);
      if (cf.status !== "open") fail("E_VALIDATION", `conflict ${id} is already ${cf.status}`);
      const ts = nowIso();
      // Apply FIRST: if applying the held version fails (a delete that grew
      // dependents while the hold sat open), the conflict stays open rather
      // than being marked ruled on a change that never landed.
      const applied = input.keep === "held" ? applyHeldChange(cf, ts) : null;
      cf.status = "ruled";
      cf.ruling = { keep: input.keep, ts, by: "founder" };
      atomicWrite(FILES.conflicts, doc);
      const title = (cf.current && (cf.current.title || cf.current.term || cf.current.label)) || cf.targetId;
      stampHistory(input, historyEvent({
        actor: "founder", action: "conflict_ruled", targetId: cf.targetId,
        summary: input.keep === "held"
          ? `Founder ruled on "${title}": the held change is applied`
          : `Founder ruled on "${title}": the standing version keeps`,
        patch: { keep: input.keep, conflictId: cf.id },
      }));
      if (applied && applied.record) remember(applied.record);
      return { conflict: cf, applied };
    });
  },
};

// ---------------------------------------------------------------------------
// Batons — session-to-session handoff (continuity §2). Own file (batons.json).
// ---------------------------------------------------------------------------
// A baton's kind. Absent === "handoff" (every baton written before kinds
// existed). "brief" batons are FEATURE BRIEFS addressed to one session; they are
// deliberately invisible to the handoff chain.
const BATON_KINDS = ["handoff", "brief"];
function batonKind(b) {
  return (b && typeof b.kind === "string" && b.kind) ? b.kind : "handoff";
}

// freshestBaton — the newest HANDOFF baton by ts. Briefs are excluded on
// purpose: an addressed brief would otherwise shadow the real handoff baton
// (baton_read/baton_peek would hand it back) and flip the brief's author to
// derived "completed/superseded" in the roster. Briefs are drained by their
// own surface (briefsWaiting on the roster card + baton listing), never here.
function freshestBaton(list) {
  let f = null;
  for (const b of (Array.isArray(list) ? list : [])) {
    if (!b || typeof b !== "object") continue;
    if (batonKind(b) === "brief") continue;
    if (!f || String(b.ts || "") > String(f.ts || "")) f = b;
  }
  return f;
}

// baton_pass — bank the current session's work as a new open baton.
TOOLS.baton_pass = {
  schema: {
    description: "Bank this session's work into a new questlog baton (status \"open\") so the next session can pick it up. Needs a session id (sessionId arg, or session_hello / $CLAUDE_SESSION_ID). done and next are required string lists; inFlight and warnings are optional.",
    inputSchema: {
      type: "object",
      required: ["label", "done", "next"],
      properties: {
        label: { type: "string", description: "One-line handoff name." },
        done: { type: "array", items: { type: "string" }, description: "What got finished this session." },
        next: { type: "array", items: { type: "string" }, description: "Concrete next steps." },
        inFlight: { type: "array", items: { type: "string" }, description: "Half-done work (optional)." },
        warnings: { type: "array", items: { type: "string" }, description: "Gotchas for the next session (optional)." },
        docPath: { type: ["string", "null"], description: "Path to a longer write-up, or null." },
        kind: { type: "string", enum: ["handoff", "brief"], description: "\"handoff\" (default) joins the session-to-session handoff chain. \"brief\" is a feature brief addressed to one session: it stays OUT of the handoff chain, so it never shadows the real baton." },
        toSessionId: { type: ["string", "null"], description: "Address this baton to one session id (required in spirit for kind \"brief\"). null = unaddressed." },
        sessionId: { type: "string", description: "The banking session id (falls back to cached session_hello id, then $CLAUDE_SESSION_ID)." },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const fromSessionId = resolveSessionId(input);
      if (!fromSessionId) fail("E_VALIDATION", "baton_pass needs a session id — pass sessionId, or call session_hello first, or set $CLAUDE_SESSION_ID");
      const label = reqStr(input, "label", { allowEmpty: false });
      const done = checkStrArr(input, "done", { required: true });
      const next = checkStrArr(input, "next", { required: true });
      const inFlight = checkStrArr(input, "inFlight");
      const warnings = checkStrArr(input, "warnings");
      let docPath = null;
      if (input.docPath !== undefined && input.docPath !== null) docPath = reqStr(input, "docPath", { allowEmpty: false });
      // kind: absent => "handoff" (exact old behaviour, back-compat).
      let kind = "handoff";
      if (input.kind !== undefined && input.kind !== null) {
        if (typeof input.kind !== "string" || !BATON_KINDS.includes(input.kind)) {
          fail("E_VALIDATION", `kind must be one of [${BATON_KINDS.join(", ")}]`);
        }
        kind = input.kind;
      }
      let toSessionId = null;
      if (input.toSessionId !== undefined && input.toSessionId !== null) toSessionId = checkSessionId(input.toSessionId);
      const batons = readJson(FILES.batons, emptyBatons);
      batons.schemaVersion = 1;
      if (!Array.isArray(batons.batons)) batons.batons = [];
      const ts = nowIso();
      const baton = { id: genId("baton"), ts, kind, fromSessionId, toSessionId, label, done, inFlight, next, warnings, docPath, status: "open" };
      batons.batons.push(baton);
      atomicWrite(FILES.batons, batons);
      stampHistory(input, historyEvent({
        action: "baton_pass", targetId: baton.id,
        summary: kind === "brief" ? `Addressed brief "${label}" to ${toSessionId || "nobody"}` : `Banked baton "${label}"`,
        patch: { status: "open", kind },
      }));
      return baton;
    });
  },
};

// baton_read — return the freshest baton (by ts). pickUp:true claims it.
TOOLS.baton_read = {
  schema: {
    description: "Return the freshest baton (by ts), or null if none. With pickUp:true, claim it: set toSessionId to the resolved session id and status to \"picked_up\" (the banking session then becomes derived-superseded). A plain read appends no history; a pickUp appends a baton_read event.",
    inputSchema: {
      type: "object",
      properties: {
        pickUp: { type: "boolean", description: "Claim the freshest baton (marks it picked_up)." },
        sessionId: { type: "string", description: "The claiming session id (required for pickUp; falls back to session_hello / $CLAUDE_SESSION_ID)." },
      },
    },
  },
  run(input) {
    if (input.pickUp !== true) {
      const batons = readJson(FILES.batons, emptyBatons);
      return freshestBaton(batons.batons) || null;
    }
    return withLock(() => {
      const toSessionId = resolveSessionId(input);
      if (!toSessionId) fail("E_VALIDATION", "pickUp needs a session id — pass sessionId, or call session_hello first, or set $CLAUDE_SESSION_ID");
      const batons = readJson(FILES.batons, emptyBatons);
      batons.schemaVersion = 1;
      if (!Array.isArray(batons.batons)) batons.batons = [];
      const fresh = freshestBaton(batons.batons);
      if (!fresh) return null;
      fresh.toSessionId = toSessionId;
      fresh.status = "picked_up";
      atomicWrite(FILES.batons, batons);
      stampHistory(input, historyEvent({
        action: "baton_read", targetId: fresh.id,
        summary: `Picked up baton "${fresh.label || fresh.id}"`, patch: { status: "picked_up" },
      }));
      return fresh;
    });
  },
};

// baton_peek — STRICTLY read-only view of the freshest baton (Observer purity).
// No inputs, no lock, no write, no history — a pickUp is impossible by
// construction. Standard chats keep baton_read (which can claim on pickUp).
TOOLS.baton_peek = {
  schema: {
    description: "Return the freshest baton (by ts), or null if none. STRICTLY read-only: never claims, never mutates, never writes history — unlike baton_read there is no pickUp path. Use this for observer/read-only sessions. Pass roadmapId to peek another registered road's freshest baton.",
    inputSchema: {
      type: "object",
      properties: {
        roadmapId: { type: "string", description: "Optional registry id (rm-…) of ANOTHER road to peek instead of this server's road (see roadmap_list). Read-only." },
      },
    },
  },
  run(input) {
    const files = filesFor(resolveRoadRoot(input && input.roadmapId));
    const batons = readJson(files.batons, emptyBatons);
    return freshestBaton(batons.batons) || null;
  },
};

// ---------------------------------------------------------------------------
// brief_create — the ONE helper behind the brief-as-baton convention.
//
// A board-editor-or-higher chat has questlog write tools but NO file tools, so
// it cannot write briefs/<slug>.md itself. This tool does the three steps
// server-side, under a single road lock (withLock is not reentrant, so the
// asset link and the baton are written inline rather than by calling the other
// tools' run()):
//   1. write <roadRoot>/briefs/<slug>.md
//   2. link it to a milestone as a "doc" asset (optional)
//   3. bank it as an OPEN baton with kind "brief", addressed to toSessionId
// A brief RESTRICTS the executing session — it is a piece of work to do, never
// a grant of extra power. The executor runs at its own profile, unchanged.
// ---------------------------------------------------------------------------
const BRIEFS_DIR = path.join(PROJECT_ROOT, "briefs");

// Slug -> a path that provably stays inside <roadRoot>/briefs.
function briefPathFor(slug) {
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug)) {
    fail("E_VALIDATION", "slug must be lowercase letters/digits/dashes, starting with a letter or digit, <=60 chars");
  }
  const file = path.resolve(BRIEFS_DIR, `${slug}.md`);
  const base = path.resolve(BRIEFS_DIR);
  if (file !== path.join(base, `${slug}.md`)) fail("E_VALIDATION", "slug resolves outside the briefs folder");
  return file;
}

TOOLS.brief_create = {
  schema: {
    description: "Write a FEATURE BRIEF and hand it to one session. Writes briefs/<slug>.md in the road's project folder, optionally links it to a milestone as a doc asset, and banks it as an open baton with kind \"brief\" addressed to toSessionId. Brief batons stay out of the handoff chain, so this never shadows the real baton. A brief is work to do — it never widens what the receiving session is allowed to do.",
    inputSchema: {
      type: "object",
      required: ["slug", "title", "body", "toSessionId"],
      properties: {
        slug: { type: "string", description: "File name stem: lowercase letters/digits/dashes, <=60 chars. Written as briefs/<slug>.md." },
        title: { type: "string", description: "One-line brief name (becomes the markdown H1 and the baton label)." },
        body: { type: "string", description: "The brief itself, in markdown." },
        toSessionId: { type: "string", description: "The session id this brief is addressed to." },
        milestoneId: { type: ["string", "null"], description: "Optional ms- id to link the brief to as a doc asset." },
        next: { type: "array", items: { type: "string" }, description: "Concrete next steps for the executing session (optional)." },
        warnings: { type: "array", items: { type: "string" }, description: "Gotchas for the executing session (optional)." },
        sessionId: { type: "string", description: "The authoring session id (falls back to cached session_hello id, then $CLAUDE_SESSION_ID)." },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const fromSessionId = resolveSessionId(input);
      if (!fromSessionId) fail("E_VALIDATION", "brief_create needs a session id — pass sessionId, or call session_hello first, or set $CLAUDE_SESSION_ID");
      const slug = reqStr(input, "slug", { allowEmpty: false });
      const title = reqStr(input, "title", { allowEmpty: false });
      const body = reqStr(input, "body", { allowEmpty: false });
      const toSessionId = checkSessionId(input.toSessionId);
      const next = checkStrArr(input, "next");
      const warnings = checkStrArr(input, "warnings");
      let milestoneId = null;
      if (input.milestoneId !== undefined && input.milestoneId !== null) {
        milestoneId = reqStr(input, "milestoneId", { allowEmpty: false });
        if (!validId(milestoneId, "ms")) fail("E_VALIDATION", "milestoneId must be an ms- id");
      }

      const file = briefPathFor(slug);
      const ts = nowIso();

      // 1. the file.
      const md = `# ${title}\n\n_Brief from session ${fromSessionId} to session ${toSessionId} · ${ts}_\n\n${body}\n`;
      try {
        fs.mkdirSync(BRIEFS_DIR, { recursive: true });
        const tmp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, md, "utf8");
        fs.renameSync(tmp, file);
      } catch (err) {
        fail("E_IO", `could not write the brief: ${err.message}`);
      }
      const relRef = `briefs/${slug}.md`;

      // 2. the asset link (inline — withLock is already held).
      let asset = null;
      if (milestoneId) {
        const rm = readJson(FILES.roadmap, emptyRoadmap);
        rm.assets = rm.assets || [];
        if (!(rm.milestones || []).some((m) => m.id === milestoneId)) fail("E_PARENT_NOT_FOUND", `no milestone ${milestoneId}`);
        asset = { id: genId("as"), milestoneId, kind: "doc", label: title, ref: relRef, addedAt: ts };
        rm.assets.push(asset);
        if (rm.project) rm.project.updatedAt = ts;
        atomicWrite(FILES.roadmap, rm);
      }

      // 3. the addressed brief baton (inline — same lock).
      const batons = readJson(FILES.batons, emptyBatons);
      batons.schemaVersion = 1;
      if (!Array.isArray(batons.batons)) batons.batons = [];
      const baton = {
        id: genId("baton"), ts, kind: "brief", fromSessionId, toSessionId,
        label: title, done: [], inFlight: [], next, warnings,
        docPath: relRef, status: "open",
      };
      batons.batons.push(baton);
      atomicWrite(FILES.batons, batons);

      stampHistory(input, historyEvent({
        action: "brief_create", targetId: baton.id,
        summary: `Wrote brief "${title}" (${relRef}) for session ${toSessionId}`,
        patch: { kind: "brief", ref: relRef, assetId: asset ? asset.id : null },
      }));
      return { path: file, ref: relRef, baton, asset };
    });
  },
};

// ---------------------------------------------------------------------------
// Horizon suggestions — possible next milestones floated past a road-end.
// Stored in suggestions.json (NEVER roadmap.json): they are possibilities, not
// work, and are excluded from every progress tally by living outside the road.
// A road-end is the LAST (highest-order) milestone of any quest — the end of
// the main road or of any branch / sub-branch.
// ---------------------------------------------------------------------------
function isRoadEnd(rm, msId) {
  const ms = (rm.milestones || []).find((m) => m.id === msId);
  if (!ms) return false;
  const q = ms.questId;
  let maxOrder = -Infinity;
  for (const m of rm.milestones || []) if (m.questId === q) maxOrder = Math.max(maxOrder, m.order || 0);
  return (ms.order || 0) >= maxOrder;
}
// HORIZON TREES (dec-horizon-tree): the anchor rule is RELAXED — any FINISHED or
// IN-PROGRESS milestone may sprout a fan, and a road-end still qualifies whatever
// its status (that is the legacy rule, kept verbatim so old callers never break).
function isAnchorable(rm, msId) {
  const ms = (rm.milestones || []).find((m) => m.id === msId);
  if (!ms) return false;
  if (ms.status === "done" || ms.status === "in_progress") return true;
  return isRoadEnd(rm, msId);
}

TOOLS.suggestions_upsert = {
  schema: {
    description: "Create or REPLACE the HORIZON TREE (1-15 possibilities) at one ANCHOR milestone. The anchor must exist and be DONE, IN-PROGRESS, or a road-end. Think in PARALLEL DIRECTIONS first: roughly 3 genuinely different directions (up to 5 when the horizon is broad), and each direction may carry 1-3 SEQUENTIAL steps. branchIndex (0-4) picks the direction, seqIndex (0-2) the position along it — seqIndex 0 is the parallel root (an ALTERNATIVE, drawn fanning out beside the anchor), 1-2 are CONSEQUENCES trailing after it. Omit both only to write a legacy single chain. Suggestions render as faint ghost nodes and are never counted in any tally. Replaces the whole set at that anchor and clears any pending founder request there.",
    inputSchema: {
      type: "object",
      required: ["frontierMilestoneId", "suggestions"],
      properties: {
        frontierMilestoneId: { type: "string", description: "The ANCHOR milestone (ms-…) these possibilities hang off: done, in-progress, or a road-end. Name kept for back-compat." },
        suggestions: {
          type: "array",
          minItems: 1,
          maxItems: 15,
          items: {
            type: "object",
            required: ["title", "plain"],
            properties: {
              title: { type: "string", description: "Short title of the possible milestone." },
              plain: { type: "string", description: "Plain-language meaning (founder-facing; jargon-linted). REQUIRED." },
              summary: { type: "string", description: "Optional longer description." },
              branchIndex: { type: "integer", minimum: 0, maximum: 4, description: "Which PARALLEL direction (0-4). Default = the array index, so a flat list of 3 becomes 3 alternatives." },
              seqIndex: { type: "integer", minimum: 0, maximum: 2, description: "Position ALONG that direction (0-2). 0 = the parallel root; 1-2 = sequential consequences. Default 0." },
              order: { type: "integer", description: "Optional legacy chain position (default = array index). branchIndex/seqIndex are authoritative when present." },
            },
          },
        },
        sessionId: { type: "string", description: "Optional AI session id to attribute this change to (see session_hello)." },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const rm = readJson(FILES.roadmap, emptyRoadmap);
      const fm = reqStr(input, "frontierMilestoneId", { allowEmpty: false });
      if (!validId(fm, "ms")) fail("E_VALIDATION", "frontierMilestoneId must be an ms- id");
      const ms = (rm.milestones || []).find((m) => m.id === fm);
      if (!ms) fail("E_NOT_FOUND", `no milestone ${fm}`);
      if (!isAnchorable(rm, fm)) fail("E_VALIDATION", `${fm} cannot anchor a horizon (needs status done or in_progress, or to be the last milestone of its quest)`);
      const list = input.suggestions;
      if (!Array.isArray(list) || list.length < 1 || list.length > 15) fail("E_VALIDATION", "suggestions must be an array of 1 to 15 items (up to 5 parallel directions x 3 sequential steps)");
      const ts = nowIso();
      const seats = new Set();
      const branches = new Set();
      const built = list.map((s, i) => {
        if (!s || typeof s !== "object") fail("E_VALIDATION", "each suggestion must be an object");
        const title = reqStr(s, "title", { allowEmpty: false });
        const plain = reqStr(s, "plain", { allowEmpty: false });
        const rec = { id: genId("sg"), frontierMilestoneId: fm, questId: ms.questId, title, plain, order: i, createdAt: ts, updatedAt: ts };
        if (s.summary !== undefined) rec.summary = optStr(s, "summary");
        if (s.order !== undefined) {
          if (!Number.isInteger(s.order) || s.order < 0) fail("E_VALIDATION", "order must be a non-negative integer");
          rec.order = s.order;
        }
        // GROUPING: default branchIndex = the array index (a flat list of 3 reads
        // as 3 alternatives, which is what the founder asked "parallel-first" to
        // mean), default seqIndex = 0. Every new write carries both.
        let bi = (s.branchIndex === undefined) ? i : s.branchIndex;
        let si = (s.seqIndex === undefined) ? 0 : s.seqIndex;
        if (!Number.isInteger(bi) || bi < 0 || bi > 4) fail("E_VALIDATION", "branchIndex must be an integer 0-4 (at most 5 parallel directions)");
        if (!Number.isInteger(si) || si < 0 || si > 2) fail("E_VALIDATION", "seqIndex must be an integer 0-2 (at most 3 steps along a direction)");
        const seat = `${bi}:${si}`;
        if (seats.has(seat)) fail("E_VALIDATION", `two suggestions claim the same seat (branchIndex ${bi}, seqIndex ${si})`);
        seats.add(seat); branches.add(bi);
        rec.branchIndex = bi; rec.seqIndex = si;
        return rec;
      });
      if (branches.size > 5) fail("E_VALIDATION", "at most 5 parallel directions per anchor");
      const data = readJson(FILES.suggestions, emptySuggestions);
      data.schemaVersion = 1;
      if (!Array.isArray(data.suggestions)) data.suggestions = [];
      // REPLACE: drop any existing suggestions for this anchor, then add the new set.
      data.suggestions = data.suggestions.filter((s) => s && s.frontierMilestoneId !== fm).concat(built);
      // A fresh set answers any pending founder request at this anchor (F2 chip).
      let cleared = 0;
      if (Array.isArray(data.requests)) {
        const before = data.requests.length;
        data.requests = data.requests.filter((r) => !(r && r.milestoneId === fm));
        cleared = before - data.requests.length;
        if (data.requests.length === 0) delete data.requests;
      }
      atomicWrite(FILES.suggestions, data);
      stampHistory(input, historyEvent({
        action: "suggestions_upsert", targetId: fm,
        summary: `Set ${built.length} horizon possibilit${built.length === 1 ? "y" : "ies"} in ${branches.size} parallel direction${branches.size === 1 ? "" : "s"} at "${ms.title || fm}"`,
        patch: { count: built.length, directions: branches.size, requestsCleared: cleared },
      }));
      return { frontierMilestoneId: fm, suggestions: built, requestsCleared: cleared };
    });
  },
};

TOOLS.suggestion_promote = {
  schema: {
    description: "Promote a horizon suggestion into a REAL milestone (via the same milestone machinery): appended to its quest at the next order with status \"available\", plain + summary carried over. The ghost suggestion is then consumed (deleted). History: suggestion_promote (patch carries the new milestoneId).",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "The suggestion id (sg-…) to promote." },
        sessionId: { type: "string", description: "Optional AI session id to attribute this change to (see session_hello)." },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const id = reqStr(input, "id", { allowEmpty: false });
      if (!validId(id, "sg")) fail("E_VALIDATION", "id must be an sg- id");
      const data = readJson(FILES.suggestions, emptySuggestions);
      if (!Array.isArray(data.suggestions)) data.suggestions = [];
      const sug = data.suggestions.find((s) => s && s.id === id);
      if (!sug) fail("E_NOT_FOUND", `no suggestion ${id}`);
      const rm = readJson(FILES.roadmap, emptyRoadmap);
      rm.milestones = rm.milestones || [];
      const questId = sug.questId;
      if (!(rm.quests || []).some((q) => q.id === questId)) fail("E_PARENT_NOT_FOUND", `no quest ${questId}`);
      const ts = nowIso();
      const maxOrder = rm.milestones.filter((m) => m.questId === questId).reduce((mx, m) => Math.max(mx, m.order), -1);
      const ms = {
        id: genId("ms"), questId, order: maxOrder + 1, title: sug.title, summary: (sug.summary || ""),
        status: "available", statusReason: "", eta: null,
        startedAt: null, completedAt: null, createdAt: ts, updatedAt: ts,
      };
      if (sug.plain !== undefined) ms.plain = sug.plain;
      rm.milestones.push(ms);
      if (rm.project) rm.project.updatedAt = ts;
      atomicWrite(FILES.roadmap, rm);
      // consume the ghost
      data.schemaVersion = 1;
      data.suggestions = data.suggestions.filter((s) => s && s.id !== id);
      atomicWrite(FILES.suggestions, data);
      stampHistory(input, historyEvent({
        action: "suggestion_promote", targetId: ms.id,
        summary: `Promoted suggestion "${sug.title}" into a milestone`,
        patch: { milestoneId: ms.id },
      }));
      return ms;
    });
  },
};

TOOLS.suggestion_dismiss = {
  schema: {
    description: "Dismiss (delete) a horizon suggestion by id. History: suggestion_dismiss. Nothing on the road changes — a suggestion was never a milestone.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "The suggestion id (sg-…) to dismiss." },
        sessionId: { type: "string", description: "Optional AI session id to attribute this change to (see session_hello)." },
      },
    },
  },
  run(input) {
    return withLock(() => {
      const id = reqStr(input, "id", { allowEmpty: false });
      if (!validId(id, "sg")) fail("E_VALIDATION", "id must be an sg- id");
      const data = readJson(FILES.suggestions, emptySuggestions);
      if (!Array.isArray(data.suggestions)) data.suggestions = [];
      const sug = data.suggestions.find((s) => s && s.id === id);
      if (!sug) fail("E_NOT_FOUND", `no suggestion ${id}`);
      data.schemaVersion = 1;
      data.suggestions = data.suggestions.filter((s) => s && s.id !== id);
      atomicWrite(FILES.suggestions, data);
      stampHistory(input, historyEvent({
        action: "suggestion_dismiss", targetId: sug.frontierMilestoneId,
        summary: `Dismissed suggestion "${sug.title}"`,
        patch: { id },
      }));
      return { dismissed: id };
    });
  },
};

// ---------------------------------------------------------------------------
// Central-app tools (Build Plan §1.6): session tracing + registry discovery.
// ---------------------------------------------------------------------------

// session_hello — register the current AI session (call once at session start).
TOOLS.session_hello = {
  schema: {
    description: "Check in the current AI session on this roadmap (call once at session start). Caches the session id + label for this server process so every later mutation is attributed automatically. Appends a session_hello history event and creates/updates this session's row in sessions.json. Returns the full session record.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string", description: "Non-empty session id (a UUID is typical). Cached for the process lifetime; later hellos overwrite it." },
        label: { type: "string", description: "Optional human-readable label for the session (e.g. what you are working on)." },
      },
    },
  },
  run(input) {
    const sessionId = checkSessionId(input.sessionId);
    const label = input.label !== undefined ? optStr(input, "label") : "";
    SESSION_CACHE = { id: sessionId, label };
    return withLock(() => {
      const shortId = sessionId.slice(0, 8);
      const evt = historyEvent({
        actor: "agent", action: "session_hello", targetId: null,
        summary: `AI session "${label || shortId}" checked in`,
        patch: { label },
      });
      evt.sessionId = sessionId;
      appendHistory(evt);
      return upsertSession(sessionId, label, 1);
    });
  },
};

// roadmap_list — THE read-only view of the registry (HARNESS-2). Before this
// existed the registry was write-only to a read-only agent: the only registry
// tools mutated, so "observe the board" and "change the board" were the same
// call. This one takes no lock, writes nothing, appends no history, and never
// upserts. It IS registry_get — there is deliberately no second name for it.
TOOLS.roadmap_list = {
  schema: {
    description: "READ the user-level roadmap registry: every registered road with its id, folder, progress, milestone status breakdown, and how fresh that road's data is. Strictly read-only — no lock, no write, no history, and it never adds or refreshes an entry. This is how you see the whole board and how you learn the roadmapId to pass to roadmap_get / history_tail / list_unclear / baton_peek when walking a portal into a child road.",
    inputSchema: { type: "object", properties: {} },
  },
  run() {
    const reg = readRegistry(); // lock-free, tolerant, never written back
    const entries = (reg.roadmaps || []).filter((r) => r && typeof r.id === "string" && r.id);
    let currentRoadmapId = null;
    const roadmaps = entries.map((e) => {
      const resolved = path.resolve(typeof e.dir === "string" ? e.dir : "");
      const isCurrent = !!resolved && sameDir(resolved, PROJECT_ROOT);
      if (isCurrent && currentRoadmapId === null) currentRoadmapId = e.id;
      const s = readRoadSummary(e);
      return {
        id: e.id,
        name: s.name,
        dir: e.dir,
        addedAt: e.addedAt || null,
        lastSeenAt: e.lastSeenAt || null,
        origin: e.origin || null,
        isCurrent,
        missing: s.missing,
        progress: s.progress,
        statusBreakdown: s.statusBreakdown,
        asOf: s.asOf,
      };
    });
    return { currentRoadmapId, roadmaps };
  },
};

// history_tail — the whole-record history reader (HARNESS-3). The old
// roadmap_get section=history_tail was a hard 50-event window with NO
// truncation signal, so an agent could not tell "absent from the road" from
// "absent from my window" — the exact ambiguity that produced a hallucination.
// This tool ALWAYS reports totalEvents / truncated / oldestReachable, pages
// backwards with `before`, and offers an aggregate mode for whole-file counts.
// Ordering is by the `ts` field (dec-time-ordering) — file position is
// meaningless, history.jsonl is append-ordered, not time-ordered.
TOOLS.history_tail = {
  schema: {
    description: "Read the road's history with an HONEST window. events mode returns the newest `limit` events (by timestamp, ascending) plus totalEvents, returned, truncated, oldestReachable and the window's from/to — so you can always tell whether something is absent from the ROAD or merely absent from your WINDOW. Page backwards with `before` (exclusive, by event ts). aggregate mode ignores limit and counts the ENTIRE file by actor, action and session. Events are ordered by their `ts` field, never by file position (history.jsonl is append-ordered, not time-ordered). Read-only, appends no history event; pass roadmapId to read another registered road.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500, description: "How many events to return in events mode (1-500, default 50). Ignored in aggregate mode." },
        before: { type: "string", description: "ISO timestamp. Only events with ts STRICTLY BEFORE this are considered — page backwards by passing the previous window's `from`." },
        mode: { type: "string", enum: ["events", "aggregate"], description: "'events' (default) = a window of events with truncation signals. 'aggregate' = whole-file counts by actor/action/session." },
        roadmapId: { type: "string", description: "Optional registry id (rm-…) of ANOTHER road to read instead of this server's road (see roadmap_list). Read-only." },
      },
    },
  },
  run(input) {
    const files = filesFor(resolveRoadRoot(input.roadmapId));
    const mode = input.mode === undefined || input.mode === null ? "events" : input.mode;
    if (mode !== "events" && mode !== "aggregate") fail("E_VALIDATION", "mode must be \"events\" or \"aggregate\"");

    const all = sortByTs(readHistoryAll(files.history));
    const totalEvents = all.length;

    if (mode === "aggregate") {
      const byActor = {}, byAction = {}, bySession = {};
      const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
      for (const e of all) {
        bump(byActor, (e && typeof e.actor === "string" && e.actor) ? e.actor : "(unknown)");
        bump(byAction, (e && typeof e.action === "string" && e.action) ? e.action : "(unknown)");
        // Only events actually stamped with a session are counted — an unstamped
        // event belongs to no session, and inventing a bucket would be a claim.
        if (e && typeof e.sessionId === "string" && e.sessionId) bump(bySession, e.sessionId);
      }
      return {
        totalEvents, byActor, byAction, bySession,
        firstTs: totalEvents ? evtTs(all[0]) || null : null,
        lastTs: totalEvents ? evtTs(all[all.length - 1]) || null : null,
      };
    }

    let limit = 50;
    if (input.limit !== undefined && input.limit !== null) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) fail("E_VALIDATION", "limit must be a whole number between 1 and 500");
      limit = input.limit;
    }
    let matching = all;
    if (input.before !== undefined && input.before !== null) {
      if (typeof input.before !== "string" || input.before.length === 0 || Number.isNaN(Date.parse(input.before))) {
        fail("E_VALIDATION", "before must be an ISO timestamp string");
      }
      matching = all.filter((e) => evtTs(e) < input.before);
    }
    const events = matching.slice(-limit);
    return {
      totalEvents,
      returned: events.length,
      truncated: events.length < matching.length,
      oldestReachable: totalEvents ? evtTs(all[0]) || null : null,
      window: {
        from: events.length ? evtTs(events[0]) || null : null,
        to: events.length ? evtTs(events[events.length - 1]) || null : null,
      },
      events,
    };
  },
};

// roadmap_register — add this (or another) project to the user-level registry.
TOOLS.roadmap_register = {
  schema: {
    description: "Register a project directory in the user-level roadmap registry (~/.questlog/registry.json, or $QUESTLOG_REGISTRY) so the central dashboard can discover it. Upserts by resolved absolute path — no duplicates. Optionally records the roadmap's ORIGIN edge — the parent road + portal milestone it branched from — making it a child in the family tree. Origin args are both-or-neither; register only SETS an origin when the entry has none (matching origin = no-op, a different origin is refused — use roadmap_set_origin to change it). Writes no .questlog files and appends no history event. Returns the registry entry. To READ the registry, use roadmap_list — never call this tool to observe.",
    inputSchema: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Project root to register (the folder that contains .questlog/). Defaults to this server's project root." },
        originRoadmapId: { type: "string", description: "Registry id (rm-…) of the PARENT roadmap this road branched from. Give together with originMilestoneId (both or neither). Only set when the entry has no origin yet." },
        originMilestoneId: { type: "string", description: "Id (ms-…) of the portal milestone IN THE PARENT road (any quest). Give together with originRoadmapId." },
        sessionId: { type: "string", description: "Optional AI session id to stamp on the origin edge (see session_hello). Falls back to the cached session_hello id, then $CLAUDE_SESSION_ID. Only used when an origin is set." },
      },
    },
  },
  run(input) {
    let resolved;
    if (input.dir !== undefined && input.dir !== null) {
      if (typeof input.dir !== "string" || input.dir.length === 0) fail("E_VALIDATION", "dir must be a non-empty string");
      resolved = path.resolve(input.dir);
    } else {
      resolved = PROJECT_ROOT; // already path.resolve()d at startup
    }
    if (!fs.existsSync(resolved)) fail("E_NOT_FOUND", `directory not found: ${resolved}`);
    if (isRefusedRegistryPath(resolved)) fail("E_VALIDATION", `refusing to register a temp/scratch path: ${resolved} (set QUESTLOG_ALLOW_TEMP=1 to override)`);
    const hasR = input.originRoadmapId !== undefined && input.originRoadmapId !== null;
    const hasM = input.originMilestoneId !== undefined && input.originMilestoneId !== null;
    if (hasR !== hasM) fail("E_VALIDATION", "originRoadmapId and originMilestoneId must be given together (both or neither)");
    if (!hasR) return upsertRegistry(resolved); // plain register — origin untouched (existing behavior)
    const sid = resolveSessionId(input);
    return withRegistryLock(() => {
      const reg = readRegistry();
      const entry = upsertRegistryEntry(reg, resolved);
      const cur = entry.origin;
      if (cur && typeof cur === "object" && cur.roadmapId) {
        if (cur.roadmapId === input.originRoadmapId && cur.milestoneId === input.originMilestoneId) {
          writeRegistry(reg); // same origin — no-op on the edge (lastSeenAt/name refresh still persists)
          return entry;
        }
        fail("E_VALIDATION", `${entry.id} already has an origin; use roadmap_set_origin to change it`);
      }
      applyOrigin(reg, entry, input.originRoadmapId, input.originMilestoneId, sid);
      writeRegistry(reg);
      return entry;
    });
  },
};

// roadmap_set_origin — retrofit / correct / clear a roadmap's origin edge.
TOOLS.roadmap_set_origin = {
  schema: {
    description: "Set, change, or clear a registered roadmap's ORIGIN edge (the parent road + portal milestone it branched from) in the user-level registry. This is the explicit retrofit/correction tool: unlike roadmap_register it OVERWRITES an existing origin. Pass originRoadmapId:null to clear the edge (make it a root again). Cycles and self-edges are rejected; the parent must already be in the registry. Bumps lastSeenAt. Writes no .questlog files and appends no history event. Returns the full updated registry entry. To READ the registry, use roadmap_list — never call this tool to observe.",
    inputSchema: {
      type: "object",
      required: ["dirOrId", "originRoadmapId"],
      properties: {
        dirOrId: { type: "string", description: "Target roadmap: a registry id (rm-…) matched by id, otherwise a directory path matched (resolved, case-insensitive on Windows) against entry dirs." },
        originRoadmapId: { type: ["string", "null"], description: "Registry id (rm-…) of the PARENT roadmap, or null to CLEAR the origin (root). When non-null, originMilestoneId is required." },
        originMilestoneId: { type: "string", description: "Id (ms-…) of the portal milestone IN THE PARENT road (any quest). Required when originRoadmapId is non-null." },
        sessionId: { type: "string", description: "Optional AI session id to stamp on the origin edge (see session_hello). Falls back to the cached session_hello id, then $CLAUDE_SESSION_ID." },
      },
    },
  },
  run(input) {
    const dirOrId = reqStr(input, "dirOrId", { allowEmpty: false });
    if (!("originRoadmapId" in input)) fail("E_VALIDATION", "originRoadmapId is required (a string, or null to clear)");
    const clearing = input.originRoadmapId === null;
    if (!clearing && typeof input.originRoadmapId !== "string") fail("E_VALIDATION", "originRoadmapId must be a string or null");
    const sid = resolveSessionId(input);
    return withRegistryLock(() => {
      const reg = readRegistry();
      reg.schemaVersion = 1;
      if (!Array.isArray(reg.roadmaps)) reg.roadmaps = [];
      let entry;
      if (RM_ID_RE.test(dirOrId)) {
        entry = reg.roadmaps.find((r) => r && r.id === dirOrId);
      } else {
        const resolved = path.resolve(dirOrId);
        entry = reg.roadmaps.find((r) => r && typeof r.dir === "string" && sameDir(path.resolve(r.dir), resolved));
      }
      if (!entry) fail("E_NOT_FOUND", `no roadmap matching ${dirOrId} in registry`);
      if (clearing) {
        delete entry.origin;
      } else {
        const hasM = input.originMilestoneId !== undefined && input.originMilestoneId !== null;
        if (!hasM) fail("E_VALIDATION", "originMilestoneId is required when originRoadmapId is not null");
        applyOrigin(reg, entry, input.originRoadmapId, input.originMilestoneId, sid);
      }
      entry.lastSeenAt = nowIso();
      writeRegistry(reg);
      return entry;
    });
  },
};

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 over stdio (newline-delimited)
// ---------------------------------------------------------------------------
const SERVER_INFO = { name: "questlog", version: "1.6.0" };
const PROTOCOL_VERSION = "2024-11-05";

function writeMessage(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function rpcResult(id, result) { writeMessage({ jsonrpc: "2.0", id, result }); }
function rpcError(id, code, message) { writeMessage({ jsonrpc: "2.0", id, error: { code, message } }); }

function toolList() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.schema.description,
    inputSchema: t.schema.inputSchema || { type: "object", properties: {} },
  }));
}

function handleToolCall(id, params) {
  const name = params && params.name;
  const input = (params && params.arguments) || {};
  const tool = TOOLS[name];
  if (!tool) { rpcError(id, -32602, `unknown tool: ${name}`); return; }
  try {
    const result = tool.run(input);
    rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
  } catch (err) {
    if (err instanceof DomainError) {
      // Domain failure — MCP tool error, not a JSON-RPC error.
      rpcResult(id, { content: [{ type: "text", text: `${err.code}: ${err.message}` }], isError: true });
    } else {
      rpcResult(id, { content: [{ type: "text", text: `E_IO: ${err && err.message ? err.message : String(err)}` }], isError: true });
    }
  }
}

function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== "2.0") return;
  const { id, method, params } = msg;
  // Notifications (no id) — accept and ignore (e.g. notifications/initialized).
  if (id === undefined || id === null) {
    return; // nothing to reply
  }
  switch (method) {
    case "initialize":
      rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case "ping":
      rpcResult(id, {});
      return;
    case "tools/list":
      rpcResult(id, { tools: toolList() });
      return;
    case "tools/call":
      handleToolCall(id, params);
      return;
    default:
      rpcError(id, -32601, `method not found: ${method}`);
      return;
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); }
  catch { writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); return; }
  try { handleMessage(msg); }
  catch (err) {
    if (msg && msg.id !== undefined && msg.id !== null) rpcError(msg.id, -32603, String(err && err.message || err));
  }
});
rl.on("close", () => process.exit(0));

process.stderr.write(`QUESTLOG MCP server ready (project: ${PROJECT_ROOT})\n`);
