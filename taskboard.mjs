// ---------------------------------------------------------------------------
// taskboard.mjs — Questlog task-board queue + trigger logic (Wave 3, §4).
//
// Queue file: <questlogHome>/taskboard.json. Items:
//   { id, title, brief, approvedAt (ISO|null), estTokens, status }
//   status ∈ "queued" | "running" | "done" | "abandoned"
//
// HARD CONSENT RULE (contract §4 + founder consent lines): this module exports
// FUNCTIONS ONLY. There is NO setInterval / cron / scheduler registered here or
// anywhere in the codebase. `taskboard.enabled` defaults to false; when false,
// triggerTaskboard() no-ops and returns []. Eligibility REQUIRES a non-null
// approvedAt — an item an agent added (approvedAt:null) is never picked until a
// founder approves it. The shipped queue is empty.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

export const STATUSES = ["queued", "running", "done", "abandoned"];

export function boardPath(questlogHome) {
  return path.join(questlogHome, "taskboard.json");
}

export function emptyBoard() {
  return { schemaVersion: 1, items: [] };
}

// Tolerant read — missing / unparseable / wrong-schema all collapse to empty.
export function readBoard(file) {
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data) || data.schemaVersion !== 1) return emptyBoard();
    if (!Array.isArray(data.items)) return emptyBoard();
    return { schemaVersion: 1, items: data.items.filter((it) => it && typeof it === "object") };
  } catch {
    return emptyBoard();
  }
}

// Atomic write (tmp + rename), mirroring server.mjs atomicWrite protocol.
export function writeBoard(file, board) {
  const clean = { schemaVersion: 1, items: Array.isArray(board.items) ? board.items : [] };
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return clean;
}

// Validate one item's shape. Returns an error string or null.
export function validateItem(it) {
  if (!it || typeof it !== "object" || Array.isArray(it)) return "item must be an object";
  if (typeof it.title !== "string" || !it.title.trim()) return "title must be a non-empty string";
  if (it.title.length > 200) return "title too long";
  if ("brief" in it && typeof it.brief !== "string") return "brief must be a string";
  if ("estTokens" in it && it.estTokens !== null) {
    if (typeof it.estTokens !== "number" || !Number.isFinite(it.estTokens) || it.estTokens < 0) return "estTokens must be a non-negative number";
  }
  if ("approvedAt" in it && it.approvedAt !== null) {
    if (typeof it.approvedAt !== "string" || Number.isNaN(Date.parse(it.approvedAt))) return "approvedAt must be an ISO date string or null";
  }
  if ("status" in it && !STATUSES.includes(it.status)) return `status must be one of ${STATUSES.join("|")}`;
  return null;
}

function genId() {
  return "task-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

// Normalize a raw item into a full stored record. `approvedByFounder` controls
// whether approvedAt is stamped now (founder add) or left null (agent add).
export function makeItem(raw, { approvedByFounder = false, now = new Date() } = {}) {
  const approvedAt = raw.approvedAt !== undefined
    ? raw.approvedAt
    : (approvedByFounder ? now.toISOString() : null);
  return {
    id: (typeof raw.id === "string" && raw.id) ? raw.id : genId(),
    title: String(raw.title || "").trim(),
    brief: typeof raw.brief === "string" ? raw.brief : "",
    approvedAt,
    estTokens: (typeof raw.estTokens === "number" && Number.isFinite(raw.estTokens)) ? raw.estTokens : 0,
    status: STATUSES.includes(raw.status) ? raw.status : "queued",
  };
}

// The capacity window from config: { startHour, endHour, maxTokens }.
export function normalizeWindow(win) {
  const w = (win && typeof win === "object" && !Array.isArray(win)) ? win : {};
  const startHour = Number.isInteger(w.startHour) ? w.startHour : 0;
  const endHour = Number.isInteger(w.endHour) ? w.endHour : 24;
  const maxTokens = (typeof w.maxTokens === "number" && Number.isFinite(w.maxTokens) && w.maxTokens >= 0) ? w.maxTokens : 0;
  return { startHour, endHour, maxTokens };
}

function withinHours(startHour, endHour, hour) {
  if (startHour === endHour) return true;            // full-day window
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;        // window wraps past midnight
}

// The core eligibility filter. An item is eligible iff:
//   * approvedAt is non-null (founder-approved) — REQUIRED,
//   * status === "queued",
//   * estTokens fits the window's maxTokens (0 maxTokens ⇒ nothing fits),
//   * the current hour falls inside [startHour, endHour).
// Returns the eligible items, oldest-approved first. Pure; no side effects.
export function pickEligible(board, capacityWindow, now = new Date()) {
  const win = normalizeWindow(capacityWindow);
  const hour = now.getHours();
  if (!withinHours(win.startHour, win.endHour, hour)) return [];
  const items = Array.isArray(board.items) ? board.items : [];
  const eligible = items.filter((it) => {
    if (!it || it.status !== "queued") return false;
    if (!it.approvedAt || typeof it.approvedAt !== "string") return false; // unapproved never picked
    if (Number.isNaN(Date.parse(it.approvedAt))) return false;
    const est = (typeof it.estTokens === "number" && Number.isFinite(it.estTokens)) ? it.estTokens : 0;
    if (win.maxTokens <= 0) return false;
    if (est > win.maxTokens) return false;
    return true;
  });
  eligible.sort((a, b) => String(a.approvedAt).localeCompare(String(b.approvedAt)));
  return eligible;
}

// The trigger entry point. When taskboard.enabled is false (the DEFAULT), this
// is a no-op returning []. It NEVER schedules, spawns, or mutates anything — it
// only reports which items a hypothetical runner could pick right now. There is
// deliberately no caller that runs this on a timer.
export function triggerTaskboard(config, questlogHome, now = new Date(), deps = {}) {
  const tb = (config && config.taskboard && typeof config.taskboard === "object") ? config.taskboard : {};
  if (tb.enabled !== true) return { enabled: false, picked: [] };
  const read = deps.readBoard || readBoard;
  const board = read(boardPath(questlogHome));
  return { enabled: true, picked: pickEligible(board, tb.capacityWindow, now) };
}
