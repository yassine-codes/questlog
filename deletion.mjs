#!/usr/bin/env node
// ---------------------------------------------------------------------------
// QUESTLOG — DELETION (the shared half of "remove this from the road").
//
// Deleting used to live in the MCP tools alone: the dashboard had no way to
// remove a milestone, a side quest or a card, so the founder edited the JSON by
// hand. Now both surfaces delete, and both must delete the SAME WAY — same
// dependent rules, same cascade, same error text — or the two paths drift and
// the file stops being one contract. So the rules live here, once, and the two
// servers wire them to their own lock / history / reply shapes.
//
// Zero dependencies and PURE-ISH: no fs, no history, no ids, no clock. The one
// impurity is deliberate — planDeletion applies its cascade to the roadmap
// object it was handed, in place, because both callers already hold the road
// lock and are about to write that same object back.
//
// What lives here:
//   planDeletion      — validate, find, compute dependents, and (given force,
//                       or nothing to cascade) carry the cascade out. Returns a
//                       plain verdict object; NEVER throws for a domain
//                       failure, because one caller wants a thrown E_CODE and
//                       the other wants an HTTP status.
//   scrubDeletedRefs  — the half the MCP tools never had. A milestone's id is
//                       referenced from THREE other files, and the validator
//                       errors on every dangling one (relatedMilestoneIds /
//                       afterMilestoneId / frontierMilestoneId). A delete that
//                       leaves those behind leaves the road invalid, so the
//                       delete owns the scrub.
//
// The dependent story, said once: an ITEM is a leaf. A MILESTONE holds items,
// assets, and any side quests branching off it. A SIDE QUEST holds milestones,
// which hold their own contents, which may hold further side quests — the
// cascade recurses (dec-nested-branching). The MAIN QUEST is never deletable.
// ---------------------------------------------------------------------------

// Same id shape the MCP server and the validator both enforce.
const ID_RE = /^[a-z]+-[a-z0-9][a-z0-9-]*$/;
function validId(id, prefix) {
  return typeof id === "string" && ID_RE.test(id) && id.startsWith(prefix + "-");
}

// The id prefix each target type answers to, and the E_VALIDATION line it fails
// with — the tools' exact wording, article and all. Also the whole list of
// things the dashboard and the tools are allowed to delete: decisions and pins
// are not deletable by design (a decision is superseded, never erased).
const TARGETS = {
  milestone: { prefix: "ms", badId: "id must be an ms- id" },
  item:      { prefix: "it", badId: "id must be an it- id" },
  quest:     { prefix: "q",  badId: "id must be a q- id" },
};

// A verdict either caller can read without knowing the other's error dialect.
// `dependents` is always an array so a caller can render it without a guard.
const no = (code, message, dependents = []) => ({ ok: false, code, message, dependents });

// planDeletion(rm, targetType, id, {force})
//
// On refusal returns {ok:false, code, message, dependents}. Codes are the MCP
// server's own: E_VALIDATION (bad type/id, or the main quest), E_NOT_FOUND
// (no such record), E_CONFLICT (dependents and no force). The E_CONFLICT
// message text is the tools' original wording, byte for byte, because agents
// have been reading it since the tools shipped.
//
// On success returns {ok:true, record, cascaded, removedMsIds, removedQuestIds}
// and `rm` HAS BEEN MUTATED: the record and everything cascaded is already out
// of rm.milestones / rm.items / rm.assets / rm.quests. `cascaded` is every
// record that went with it, in the order it was removed, so a history patch can
// carry the whole subtree back. The two Sets are what the scrub needs — the id
// that died is in removedMsIds/removedQuestIds too, not just its children.
export function planDeletion(rm, targetType, id, { force = false } = {}) {
  if (!rm || typeof rm !== "object") return no("E_VALIDATION", "no roadmap to delete from");
  const target = TARGETS[targetType];
  if (!target) return no("E_VALIDATION", "targetType must be milestone|item|quest");
  rm.milestones = rm.milestones || []; rm.items = rm.items || [];
  rm.assets = rm.assets || []; rm.quests = rm.quests || [];
  if (!validId(id, target.prefix)) return no("E_VALIDATION", target.badId);

  if (targetType === "item") {
    // A leaf. Its notes are stored on the item itself, so they go with it and
    // nothing else in the road points at an it- id.
    const it = rm.items.find((x) => x.id === id);
    if (!it) return no("E_NOT_FOUND", `no item ${id}`);
    rm.items = rm.items.filter((x) => x.id !== id);
    return { ok: true, record: it, cascaded: [], removedMsIds: new Set(), removedQuestIds: new Set() };
  }

  if (targetType === "milestone") {
    const ms = rm.milestones.find((m) => m.id === id);
    if (!ms) return no("E_NOT_FOUND", `no milestone ${id}`);
    const depItems = rm.items.filter((it) => it.milestoneId === id);
    const depAssets = rm.assets.filter((a) => a.milestoneId === id);
    const depQuests = rm.quests.filter((q) => q.type === "side" && q.parentMilestoneId === id);
    const deps = [...depItems, ...depAssets, ...depQuests];
    const depIds = deps.map((x) => x.id);
    if (depIds.length && !force)
      return no("E_CONFLICT", `milestone ${id} has dependents: ${depIds.join(", ")} — pass force:true to cascade`, describe(deps));
    const cascaded = [];
    const stripMilestoneContents = (mid) => {
      rm.items = rm.items.filter((it) => { if (it.milestoneId === mid) { cascaded.push(it); return false; } return true; });
      rm.assets = rm.assets.filter((a) => { if (a.milestoneId === mid) { cascaded.push(a); return false; } return true; });
    };
    // Cascade must RECURSE (dec-nested-branching): a deleted side quest's
    // milestones can themselves carry further side quests. Collect the whole
    // subtree so no orphaned nested quest is left to fail the validator.
    const removeQuestIds = new Set();
    const removeMsIds = new Set();
    const cascadeQuest = (q) => {
      if (removeQuestIds.has(q.id)) return; // guard against bad-data cycles
      removeQuestIds.add(q.id);
      for (const qm of rm.milestones.filter((m) => m.questId === q.id)) {
        stripMilestoneContents(qm.id);
        removeMsIds.add(qm.id);
        cascaded.push(qm);
        for (const child of rm.quests.filter((cq) => cq.type === "side" && cq.parentMilestoneId === qm.id)) cascadeQuest(child);
      }
      cascaded.push(q);
    };
    for (const q of depQuests) cascadeQuest(q);
    rm.milestones = rm.milestones.filter((m) => !removeMsIds.has(m.id));
    rm.quests = rm.quests.filter((q) => !removeQuestIds.has(q.id));
    // Own items + assets, then the milestone itself.
    stripMilestoneContents(id);
    rm.milestones = rm.milestones.filter((m) => m.id !== id);
    // The target's OWN id belongs in the removed set: the scrub has to strip
    // references to it, not only to the ones it dragged down with it.
    removeMsIds.add(id);
    return { ok: true, record: ms, cascaded, removedMsIds: removeMsIds, removedQuestIds: removeQuestIds };
  }

  // quest
  const q = rm.quests.find((x) => x.id === id);
  if (!q) return no("E_NOT_FOUND", `no quest ${id}`);
  if (q.type === "main") return no("E_VALIDATION", "the main quest cannot be deleted");
  const depMs = rm.milestones.filter((m) => m.questId === id);
  if (depMs.length && !force)
    return no("E_CONFLICT", `quest ${id} has milestones: ${depMs.map((m) => m.id).join(", ")} — pass force:true to cascade`, describe(depMs));
  const cascaded = [];
  const stripMilestoneContents = (mid) => {
    rm.items = rm.items.filter((it) => { if (it.milestoneId === mid) { cascaded.push(it); return false; } return true; });
    rm.assets = rm.assets.filter((a) => { if (a.milestoneId === mid) { cascaded.push(a); return false; } return true; });
  };
  // Recurse (dec-nested-branching): a milestone under this quest can itself
  // carry further side quests; collect the whole subtree so none is orphaned.
  const removeQuestIds = new Set();
  const removeMsIds = new Set();
  const cascadeQuest = (q2, isRoot) => {
    if (removeQuestIds.has(q2.id)) return; // guard against bad-data cycles
    removeQuestIds.add(q2.id);
    if (!isRoot) cascaded.push(q2);
    for (const qm of rm.milestones.filter((m) => m.questId === q2.id)) {
      stripMilestoneContents(qm.id);
      removeMsIds.add(qm.id);
      cascaded.push(qm);
      for (const child of rm.quests.filter((cq) => cq.type === "side" && cq.parentMilestoneId === qm.id)) cascadeQuest(child, false);
    }
  };
  cascadeQuest(q, true);
  rm.milestones = rm.milestones.filter((m) => !removeMsIds.has(m.id));
  rm.quests = rm.quests.filter((x) => !removeQuestIds.has(x.id));
  return { ok: true, record: q, cascaded, removedMsIds: removeMsIds, removedQuestIds: removeQuestIds };
}

// The dependent list a UI can actually render: id, what it is, what it is
// called. The MCP layer only ever needed the ids (it joins them into its
// message), but a founder deciding whether to cascade needs the titles.
function describe(records) {
  return records.map((r) => ({
    id: r.id,
    type: r.id.startsWith("ms-") ? "milestone"
        : r.id.startsWith("it-") ? "item"
        : r.id.startsWith("as-") ? "asset"
        : r.id.startsWith("q-") ? "quest" : "record",
    title: r.title || r.label || r.id,
  }));
}

// scrubDeletedRefs(files, removedMsIds, removedQuestIds)
//
// The other three files point INTO the roadmap by id, and the validator errors
// on every pointer that no longer resolves:
//   decisions.json    relatedMilestoneIds <id> references no milestone
//   pins.json         afterMilestoneId <id> must be a main-quest milestone or null
//   suggestions.json  frontierMilestoneId/questId <id> not found in roadmap
// So a delete that skipped this would hand back a road its own validator
// rejects. Each file is treated differently on purpose: a decision LOSES the
// dead link but survives (it is a record of a judgement, and the judgement was
// still made); a pin loses its anchor and floats to the road start (null is a
// legal anchor); a suggestion anchored to something that no longer exists is
// meaningless and goes.
//
// `files` takes the already-parsed contents ({decisions, pins, suggestions});
// any of them may be an empty-file default. Mutates them in place and returns
// {changed:{...booleans}, scrubbed:{...id arrays}} so the caller writes only the
// files that actually moved and can put the receipt in the history event.
export function scrubDeletedRefs({ decisions, pins, suggestions } = {}, removedMsIds = new Set(), removedQuestIds = new Set()) {
  const changed = { decisions: false, pins: false, suggestions: false };
  const scrubbed = { decisions: [], pins: [], suggestions: [] };
  if (!removedMsIds.size && !removedQuestIds.size) return { changed, scrubbed };

  const decs = (decisions && Array.isArray(decisions.decisions)) ? decisions.decisions : null;
  if (decs) {
    for (const d of decs) {
      if (!d || !Array.isArray(d.relatedMilestoneIds)) continue;
      const kept = d.relatedMilestoneIds.filter((mid) => !removedMsIds.has(mid));
      if (kept.length === d.relatedMilestoneIds.length) continue;
      d.relatedMilestoneIds = kept;
      changed.decisions = true;
      scrubbed.decisions.push(d.id);
    }
  }

  const pinList = (pins && Array.isArray(pins.pins)) ? pins.pins : null;
  if (pinList) {
    for (const p of pinList) {
      if (!p || typeof p.afterMilestoneId !== "string" || !removedMsIds.has(p.afterMilestoneId)) continue;
      p.afterMilestoneId = null;
      changed.pins = true;
      scrubbed.pins.push(p.id);
    }
  }

  const sugs = (suggestions && Array.isArray(suggestions.suggestions)) ? suggestions.suggestions : null;
  if (sugs) {
    const kept = sugs.filter((s) => {
      if (!s) return true;
      const dead = removedMsIds.has(s.frontierMilestoneId) || removedQuestIds.has(s.questId);
      if (dead) scrubbed.suggestions.push(s.id);
      return !dead;
    });
    if (kept.length !== sugs.length) { suggestions.suggestions = kept; changed.suggestions = true; }
  }

  return { changed, scrubbed };
}
