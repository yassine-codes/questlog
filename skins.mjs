// ---------------------------------------------------------------------------
// skins.mjs — Questlog skin registry + WCAG contrast validator (Wave 3, §1).
//
// Zero npm deps. Pure, side-effect-light helpers the server wires to the
// /api/skins endpoints. A "skin" is a JSON file `{ name, author, tokens, road? }`
// whose tokens override the built-in parchment palette; road params tune the
// three SVG road emitters. Unknown tokens are rejected; MISSING tokens fall back
// to parchment, so a partial skin always renders a complete, safe palette.
//
// Readability floors are enforced (WCAG relative-luminance contrast) at apply
// AND surfaced as a per-skin `valid` flag on the list. The validator runs on the
// EFFECTIVE (merged-over-parchment) palette so a skin can never ship an unsafe
// pair via omission.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

// --- Canonical parchment palette -------------------------------------------
// Every themable token's default value, extracted from index.html's :root plus
// the ~25 previously-hardcoded sites (header browns/inks, kind-chips, danger
// button, JS-emitted SVG fills, body dot-grid texture). B2 wires index.html to
// read these via var(--token); this map is the single source of truth for the
// "parchment" built-in AND the fallback applied to any partial skin.
export const PARCHMENT_TOKENS = Object.freeze({
  // :root originals (Wave 1)
  parch: "#e9e0c8", parch2: "#f4eeda", parch3: "#fbf7ea",
  edge: "#cbbd97", edge2: "#b7a677",
  ink: "#3a3427", "ink-soft": "#6d6450", "ink-faint": "#938a72",
  road: "#dac89e", "road-edge": "#b19662", "road-dash": "#f1e6c6",
  gold: "#cf9a30", "gold-deep": "#a97a1e",
  "st-locked": "#9a9182", "st-available": "#4f88b0", "st-in_progress": "#cf9a30",
  "st-done": "#6f9c58", "st-blocked": "#c05a3e",
  // chat access-tier badges (dec-chat-access-tiers): observer reuses
  // st-available, workspace-builder reuses gold; these two are the new ones.
  "tier-blue": "#5b5fc7", "tier-red": "#b3232a",
  // evidence / claims-complete chips (C7, dec-currency-architecture). Its own
  // hue on purpose: the evidence plane is not the status plane, and the chip
  // must never be mistaken for the done-green.
  evid: "#6b4f9e", "evid-ink": "#ffffff",
  shadow: "0 2px 0 rgba(120,104,66,.35), 0 6px 18px rgba(90,74,40,.18)",
  serif: 'Georgia,"Palatino Linotype","Book Antiqua",serif',
  sans: '"Segoe UI",system-ui,-apple-system,"Trebuchet MS",sans-serif',
  // header (was hardcoded)
  "header-bg1": "#4a4030", "header-bg2": "#3a3225", "header-border": "#2c2519",
  "header-ink": "#f3ecd7", "header-ink-soft": "#c9bfa4",
  // dark badge / pill (worldSwitch, hbtn)
  "badge-bg": "#2c2519", "badge-border": "#5a4e38", "badge-ink": "#e9dfc4",
  // dark map-control buttons
  "btn-dark-bg": "#3a3225", "btn-dark-ink": "#f0e6cc",
  // kind chips
  "chip-blocker-bg": "#f0d3ca", "chip-blocker-ink": "#8a3320", "chip-blocker-border": "#dcae9f",
  "chip-note-bg": "#e7dff0", "chip-note-ink": "#5a417f", "chip-note-border": "#cfc0e2",
  "chip-explain-bg": "#dde9de", "chip-explain-ink": "#3f6b40", "chip-explain-border": "#c2d6c3",
  "chip-built-bg": "#e3ecd9",
  // reason (blocker rationale) box
  "reason-bg": "#f6ded6", "reason-ink": "#8a3320", "reason-border": "#e2b8ab",
  // danger button gradient
  danger1: "#c86a52", danger2: "#a8452e", "danger-border": "#8f3a26",
  // session-road pill background
  "sess-road-bg": "#eadfc0",
  // compaction pin
  "pin-bg": "#efe6cc",
  // JS-emitted SVG node glyphs / pin badge
  "node-icon-ink": "#ffffff", "node-badge-bg": "#3a3427", "node-badge-ink": "#f0e6cc",
  // body dot-grid texture (two rgba layers)
  "texture-dot1": "rgba(255,255,255,.35)", "texture-dot2": "rgba(150,130,90,.10)",
});

// Numeric road-geometry params consumed by the three SVG path emitters.
export const PARCHMENT_ROAD = Object.freeze({
  roadWidthMain: 30, roadEdgeWidthMain: 40,
  roadDashArray: "2 16", roadDashOpacity: 0.8,
  roadWidthSide: 13, roadEdgeWidthSide: 20,
});

export const KNOWN_TOKENS = new Set(Object.keys(PARCHMENT_TOKENS));
export const KNOWN_ROAD_PARAMS = new Set(Object.keys(PARCHMENT_ROAD));

// --- Color parsing + WCAG contrast -----------------------------------------
// Parse a CSS color to {r,g,b,a} 0-255 / 0-1. Supports #rgb, #rrggbb, rgb(),
// rgba(). Returns null for anything else (fonts, shadow, gradients) — the
// validator only ever asks about solid color tokens.
export function parseColor(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = s.match(/^#([0-9a-fA-F]{3})$/);
  if (m) {
    const h = m[1];
    return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16), a: 1 };
  }
  m = s.match(/^#([0-9a-fA-F]{6})$/);
  if (m) {
    const h = m[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(",").map((x) => x.trim());
    if (parts.length < 3) return null;
    const r = parseFloat(parts[0]), g = parseFloat(parts[1]), b = parseFloat(parts[2]);
    const a = parts.length >= 4 ? parseFloat(parts[3]) : 1;
    if ([r, g, b].some((n) => !Number.isFinite(n))) return null;
    return { r, g, b, a: Number.isFinite(a) ? a : 1 };
  }
  return null;
}

function srgbToLin(c) {
  const cs = c / 255;
  return cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}
// WCAG relative luminance (0..1).
export function relLuminance(col) {
  return 0.2126 * srgbToLin(col.r) + 0.7152 * srgbToLin(col.g) + 0.0722 * srgbToLin(col.b);
}
// WCAG contrast ratio (1..21) between two parsed colors.
export function contrastRatio(a, b) {
  const la = relLuminance(a), lb = relLuminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}
function ratio(tokens, k1, k2) {
  const a = parseColor(tokens[k1]); const b = parseColor(tokens[k2]);
  if (!a || !b) return null;
  return contrastRatio(a, b);
}

// Hue (0..360) for the distinct-state check.
function hueOf(col) {
  const r = col.r / 255, g = col.g / 255, b = col.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return h;
}
function hueGap(a, b) {
  const d = Math.abs(hueOf(a) - hueOf(b));
  return Math.min(d, 360 - d);
}

const STATE_KEYS = ["st-locked", "st-available", "st-in_progress", "st-done", "st-blocked"];

// Validate the readability floors on an EFFECTIVE token map. Returns
// { valid, failures:[{ pair, need, got }] }. Every floor from the contract §1.
export function validateContrast(tokens) {
  const failures = [];
  const need = (k1, k2, min, label) => {
    const r = ratio(tokens, k1, k2);
    if (r === null) { failures.push({ pair: label || `${k1}/${k2}`, need: min, got: null, reason: "unparseable color" }); return; }
    if (r + 1e-9 < min) failures.push({ pair: label || `${k1}/${k2}`, need: min, got: Math.round(r * 100) / 100 });
  };
  // Body + header text legibility.
  need("ink", "parch2", 4.5);
  need("header-ink", "header-bg2", 4.5);
  // Each state node readable on the map, and the gold accent on the lightest card.
  for (const s of STATE_KEYS) need(s, "parch", 1.6);
  need("gold-deep", "parch3", 3);
  // C7 — the evidence chip must be readable, and must NOT read as "done". The
  // claim "claims complete" is not the judgement "done"; if the two colours
  // converge, the interface starts lying about which plane it is showing.
  need("evid-ink", "evid", 4.5);
  {
    const a = parseColor(tokens.evid), b = parseColor(tokens["st-done"]);
    if (!a || !b) failures.push({ pair: "evid/st-done", need: "distinct", got: null, reason: "unparseable color" });
    else {
      const dL = Math.abs(relLuminance(a) - relLuminance(b));
      const dH = hueGap(a, b);
      if (dL < 0.05 && dH < 40) {
        failures.push({ pair: "evid/st-done", need: "distinct (ΔL≥0.05 or hue≥40°)", got: `ΔL=${dL.toFixed(3)}, Δhue=${dH.toFixed(0)}°` });
      }
    }
  }
  // Road visible against the map field. Floor is 1.2 (not the contract's est.
  // 1.3): the SHIPPING parchment road (#dac89e on #e9e0c8) measures 1.25, and
  // parchment is the frozen baseline + revert target that must stay applicable.
  // 1.2 still rejects a road within a hair of the background.
  need("road", "parch", 1.2);
  // State colors must be distinguishable pairwise (luminance OR hue separation).
  for (let i = 0; i < STATE_KEYS.length; i++) {
    for (let j = i + 1; j < STATE_KEYS.length; j++) {
      const a = parseColor(tokens[STATE_KEYS[i]]); const b = parseColor(tokens[STATE_KEYS[j]]);
      if (!a || !b) { failures.push({ pair: `${STATE_KEYS[i]}/${STATE_KEYS[j]}`, need: "distinct", got: null, reason: "unparseable color" }); continue; }
      const dL = Math.abs(relLuminance(a) - relLuminance(b));
      const dH = hueGap(a, b);
      if (dL < 0.05 && dH < 20) {
        failures.push({ pair: `${STATE_KEYS[i]}/${STATE_KEYS[j]}`, need: "distinct (ΔL≥0.05 or hue≥20°)", got: `ΔL=${dL.toFixed(3)}, Δhue=${dH.toFixed(0)}°` });
      }
    }
  }
  return { valid: failures.length === 0, failures };
}

// Merge a skin's partial token map over parchment → a complete effective map.
export function effectiveTokens(skinTokens) {
  return { ...PARCHMENT_TOKENS, ...(skinTokens && typeof skinTokens === "object" ? skinTokens : {}) };
}

// --- Skin file structural validation ---------------------------------------
// Returns an error string, or null if the parsed skin object is well-formed.
// Rejects unknown tokens / unknown road params / bad types. Does NOT check
// contrast (callers layer validateContrast on the effective map).
export function validateSkinShape(skin) {
  if (!skin || typeof skin !== "object" || Array.isArray(skin)) return "skin must be an object";
  if (typeof skin.name !== "string" || !skin.name.trim()) return "skin.name must be a non-empty string";
  if (skin.name.length > 60) return "skin.name too long";
  if ("author" in skin && typeof skin.author !== "string") return "skin.author must be a string";
  if (!skin.tokens || typeof skin.tokens !== "object" || Array.isArray(skin.tokens)) return "skin.tokens must be an object";
  for (const [k, val] of Object.entries(skin.tokens)) {
    if (!KNOWN_TOKENS.has(k)) return `unknown token: ${k}`;
    if (typeof val !== "string" || !val.trim()) return `token ${k} must be a non-empty string`;
    if (val.length > 200) return `token ${k} value too long`;
  }
  if ("road" in skin && skin.road !== null && skin.road !== undefined) {
    const r = skin.road;
    if (typeof r !== "object" || Array.isArray(r)) return "skin.road must be an object";
    for (const [k, val] of Object.entries(r)) {
      if (!KNOWN_ROAD_PARAMS.has(k)) return `unknown road param: ${k}`;
      if (k === "roadDashArray") {
        if (typeof val !== "string" || !/^[\d.\s]+$/.test(val)) return "road.roadDashArray must be a dash-array string";
      } else if (typeof val !== "number" || !Number.isFinite(val) || val < 0 || val > 200) {
        return `road.${k} must be a number 0-200`;
      }
    }
  }
  return null;
}

// Effective road params merged over parchment defaults.
export function effectiveRoad(skinRoad) {
  return { ...PARCHMENT_ROAD, ...(skinRoad && typeof skinRoad === "object" ? skinRoad : {}) };
}

// --- Registry: built-in (app skins/) + user (<questlogHome>/skins/) ---------
function readSkinFile(file) {
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch { return null; }
}

function listSkinDir(dir, source) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return out; }
  for (const nm of entries) {
    if (!nm.toLowerCase().endsWith(".json")) continue;
    const obj = readSkinFile(path.join(dir, nm));
    if (!obj) continue;
    const shapeErr = validateSkinShape(obj);
    const tokens = (obj.tokens && typeof obj.tokens === "object") ? obj.tokens : {};
    const road = (obj.road && typeof obj.road === "object") ? obj.road : undefined;
    const contrast = shapeErr ? { valid: false, failures: [{ pair: shapeErr, need: "well-formed" }] }
      : validateContrast(effectiveTokens(tokens));
    out.push({
      name: typeof obj.name === "string" ? obj.name : nm.replace(/\.json$/i, ""),
      author: typeof obj.author === "string" ? obj.author : "",
      source,
      file: path.join(dir, nm),
      tokens,
      road,
      valid: !shapeErr && contrast.valid,
      shapeError: shapeErr || null,
      contrastFailures: contrast.failures,
    });
  }
  return out;
}

// Full skin list: synthesized "parchment" built-in first, then app skins/ files,
// then user <home>/skins/ files. User files may NOT shadow a built-in name
// (built-ins are read-only and always win).
export function listSkins(appSkinsDir, userSkinsDir) {
  const parchment = {
    name: "parchment", author: "questlog", source: "builtin", file: null,
    tokens: { ...PARCHMENT_TOKENS }, road: { ...PARCHMENT_ROAD },
    valid: true, shapeError: null, contrastFailures: [],
  };
  const list = [parchment];
  const seen = new Set(["parchment"]);
  for (const s of listSkinDir(appSkinsDir, "builtin")) {
    if (seen.has(s.name)) continue;
    seen.add(s.name); list.push(s);
  }
  for (const s of listSkinDir(userSkinsDir, "user")) {
    if (seen.has(s.name)) continue; // never let a user file shadow a built-in
    seen.add(s.name); list.push(s);
  }
  return list;
}

// Resolve one skin by name from the merged list (built-in precedence).
export function resolveSkin(appSkinsDir, userSkinsDir, name) {
  return listSkins(appSkinsDir, userSkinsDir).find((s) => s.name === name) || null;
}
