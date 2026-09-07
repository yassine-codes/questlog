#!/usr/bin/env node
// ---------------------------------------------------------------------------
// QUESTLOG — CONFLICTS (a colliding write is HELD, never applied, never dropped)
//
// THE FOUNDER'S RULING, 2026-08-27, which this file exists to carry out: when
// two writers change the same record, the app must NOT keep whichever landed
// last. The second change is HELD — applied to nothing and discarded by
// nothing. Both versions surface as a decision and the founder makes the call.
// A warning shown after the loss is explicitly not acceptable: in the founder's
// words, that "is not a decision, it is a receipt."
//
// This follows the project's standing governing principle, quoted from its own
// decision log: "automate observation and absence-detection, instruct
// interpretation". The machinery here DETECTS the collision. It never resolves
// one. Judgement does that, in the drawer or in chat.
//
// THE DETECTION, which is the one real design decision in this feature:
// a write is stale when the version it was BASED ON is no longer the version on
// disk. `recordVersion` derives that version from the record's own bytes at
// READ time and stores it nowhere. Two reasons it beats `updatedAt`:
//   - it catches a hand edit that forgot to bump updatedAt, and hand edits are
//     a first-class way to use this app (the files are the source of truth);
//   - decisions carry no updatedAt at all, and a decision is exactly the kind
//     of record two writers argue over.
// Both servers parse the same file bytes and JSON.stringify preserves key
// order, so the same record hashes identically in every process. NOTHING is
// added to roadmap.json: the version is a derived key served beside the road
// (C3's rule — `roadmap` must stay exactly what is on disk), and the conflicts
// themselves live in their own file, conflicts.json.
//
// Zero dependencies and PURE: no fs, no clock beyond what a caller hands in.
// The two servers wire these shapes to their own lock / history / reply
// dialects, the same division of labour deletion.mjs already uses.
//
// What lives here:
//   recordVersion     — the version of one record, derived, never stored.
//   versionsOf        — the whole map /api/state serves so the dashboard can
//                       send a basis with every write it makes.
//   emptyConflicts    — the skeleton for an absent conflicts.json.
//   newConflict       — one held change, with BOTH versions inside it.
//   differingFields   — which fields the two versions actually disagree on,
//                       so the ruling view shows an argument, not a diff dump.
//   openConflictsFor  — the open holds sitting on one record.
//   voidConflictsFor  — a deleted record's holds have nothing left to contest.
//   HELD_TAIL         — the sentence every held MCP call ends with, once, so
//                       both servers say the same thing to an agent.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";

// The version of a record: a short content hash of exactly what was parsed.
// No key sorting, no field stripping — the moment this function starts being
// clever the two servers stop agreeing and every dashboard write looks stale.
export function recordVersion(rec) {
  return crypto.createHash("sha1").update(JSON.stringify(rec)).digest("hex").slice(0, 12);
}

// Every record a writer can collide on, keyed by id. Milestones, items and
// quests come off the roadmap; decisions come off decisions.json (they have no
// updatedAt of their own, which is half the reason the version is a hash).
export function versionsOf(roadmap, decisions) {
  const out = {};
  const rm = (roadmap && typeof roadmap === "object") ? roadmap : {};
  for (const key of ["milestones", "items", "quests"]) {
    for (const rec of (Array.isArray(rm[key]) ? rm[key] : [])) {
      if (rec && typeof rec.id === "string") out[rec.id] = recordVersion(rec);
    }
  }
  const decs = (decisions && Array.isArray(decisions.decisions)) ? decisions.decisions : [];
  for (const d of decs) {
    if (d && typeof d.id === "string") out[d.id] = recordVersion(d);
  }
  return out;
}

// conflicts.json is OPTIONAL per road, exactly like batons.json: absent is
// normal and means nothing has ever collided here.
export const emptyConflicts = () => ({ schemaVersion: 1, conflicts: [] });

// A deep clone through JSON, which is the only shape these records ever have.
// The hold applies the writer's change to THIS instead of the live record, so
// the second version is captured in full without ever touching the road.
export const cloneRecord = (rec) => JSON.parse(JSON.stringify(rec));

// The tail every held MCP call ends with. One sentence, in one place, so the
// tool path and the board path cannot drift into two different promises.
export const HELD_TAIL = "Held, not applied and not discarded. Raise it with the founder as a decision showing both versions, then call conflict_resolve with the ruling.";

// One held change. `current` is the version that stands (the FIRST write, which
// keeps rendering so the board is readable rather than frozen); `proposed` is
// the version that was held — null for a held delete, which proposes no record
// at all. `input` is the raw call that was held, so a ruling of "keep the held
// version" can be carried out later without asking the writer to try again.
export function newConflict({ id, ts, source, actor, sessionId, action, targetType, targetId,
                              baseVersion, currentVersion, current, proposed, input }) {
  const cf = {
    id, ts, status: "open",
    targetType, targetId,
    source, actor,
    action,
    baseVersion: String(baseVersion),
    currentVersion: String(currentVersion),
    current,
    proposed: proposed === undefined ? null : proposed,
    input: input === undefined ? null : input,
  };
  if (sessionId) cf.sessionId = sessionId;
  return cf;
}

// Which fields the two versions actually disagree on. The ruling view shows
// only these: a founder deciding between two versions of a card needs the
// argument, not a re-print of everything that never moved.
export function differingFields(current, proposed) {
  if (!current || typeof current !== "object") return [];
  if (!proposed || typeof proposed !== "object") return [];
  const keys = new Set([...Object.keys(current), ...Object.keys(proposed)]);
  const out = [];
  for (const k of keys) {
    if (JSON.stringify(current[k]) !== JSON.stringify(proposed[k])) out.push(k);
  }
  out.sort();
  return out;
}

// The open holds sitting on one record. Order is file order, which is the order
// they were held in — the first hold on a card is the first one shown.
export function openConflictsFor(doc, targetId) {
  const list = (doc && Array.isArray(doc.conflicts)) ? doc.conflicts : [];
  return list.filter((c) => c && c.status === "open" && c.targetId === targetId);
}

// A deleted record's holds have nothing left to contest, and an open conflict
// pointing at an id that no longer exists is a validator error. So a delete
// VOIDS them rather than leaving them dangling or silently dropping them —
// voidReason says why, and the caller writes one conflict_void event each.
// Mutates `doc` in place (the caller already holds the lock and is about to
// write that same object back) and returns what it voided.
export function voidConflictsFor(doc, ids, ts) {
  const gone = new Set(Array.isArray(ids) ? ids : [ids]);
  const list = (doc && Array.isArray(doc.conflicts)) ? doc.conflicts : [];
  const voided = [];
  for (const c of list) {
    if (!c || c.status !== "open" || !gone.has(c.targetId)) continue;
    c.status = "void";
    c.voidReason = "target deleted";
    c.voidedAt = ts;
    // No `ruling` — nobody ruled on this one. The record left the road and took
    // the argument with it, and saying otherwise would put words in the
    // founder's mouth.
    voided.push(c);
  }
  return voided;
}
