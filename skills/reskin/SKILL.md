---
name: reskin
description: Use when a founder wants Questlog re-themed after a favorite game's look and feel. Interviews for the game's mood, derives a color palette that respects Questlog's readability floors, and writes a ready-to-apply skin JSON into the user's skins folder. Triggers on "reskin questlog", "make questlog look like <game>", "theme the dashboard", "new questlog palette".
---

# Questlog Reskin

Turn a founder's favorite-game *feel* into a valid Questlog skin: interview →
derive tokens honoring the readability floors → write a skin JSON the founder
applies from the gear menu.

## Hard rules (never violate)

- **Never edit `index.html` or `server.mjs`.** Skins are pure data; the app
  already reads every color from a CSS token. You only write a JSON file.
- **Never overwrite a built-in.** Built-ins live in `${CLAUDE_PLUGIN_ROOT}/skins/`
  (`parchment`, `star-chart`). Your output goes to the USER dir only:
  `<questlogHome>/skins/<slug>.json` (`<questlogHome>` is `~/.questlog`, or the
  parent of `$QUESTLOG_REGISTRY` if set). Pick a slug that is not `parchment`
  or `star-chart`.
- **Never touch `settings.json`** or anything under `~/.claude/`.
- Skin `name` must be distinct from any built-in. If a user file with your slug
  exists, ask before replacing it.

## Step 1 — Interview (3–5 questions)

Ask, in plain language, and wait for answers:

1. **Which game?** (name it)
2. **Era / mood?** (e.g. "cozy 16-bit", "grim sci-fi", "sunlit fantasy")
3. **Light or dark** overall surface?
4. **One accent color** you associate with it (name or hex).
5. **A texture memory** — parchment grain, CRT scanlines, starfield, blueprint
   grid, etc. (drives the two faint dot-grid layers).

## Step 2 — Derive tokens

Fill the token map below. Every value is a CSS color string (`#rgb`,
`#rrggbb`, `rgb()`, or `rgba()` for the two texture layers only). Missing tokens
fall back to parchment, but a cohesive skin sets them all.

Themable tokens (unknown token names are REJECTED by the validator):

- Surfaces: `parch parch2 parch3` (lightest reading card = `parch3`), `edge edge2`
- Ink: `ink ink-soft ink-faint`
- Roads: `road road-edge road-dash`
- Accent: `gold gold-deep`
- States: `st-locked st-available st-in_progress st-done st-blocked`
- Header: `header-bg1 header-bg2 header-border header-ink header-ink-soft`
- Dark chrome: `badge-bg badge-border badge-ink btn-dark-bg btn-dark-ink`
- Chips: `chip-blocker-bg/-ink/-border chip-note-bg/-ink/-border`
  `chip-explain-bg/-ink/-border chip-built-bg`
- Reason box: `reason-bg reason-ink reason-border`
- Danger button: `danger1 danger2 danger-border`
- Misc: `sess-road-bg pin-bg node-icon-ink node-badge-bg node-badge-ink`
- Texture (rgba): `texture-dot1 texture-dot2`
- Non-color (optional): `shadow serif sans`

Optional `road` object (numbers; `roadDashArray` is a string like `"1 10"`):
`roadWidthMain roadEdgeWidthMain roadDashArray roadDashOpacity roadWidthSide
roadEdgeWidthSide`.

## Step 3 — Check the readability floors (state each numerically)

Compute WCAG contrast (relative luminance) and print each result. The apply
endpoint enforces these; a failing skin returns `E_SKIN_CONTRAST`. Floors:

- `ink` on `parch2` ≥ **4.5:1**
- `header-ink` on `header-bg2` ≥ **4.5:1**
- each `st-*` on `parch` ≥ **1.6:1**
- `st-*` colors pairwise distinct (ΔL ≥ 0.05 **or** hue gap ≥ 20°)
- `gold-deep` on `parch3` ≥ **3:1**
- `road` on `parch` ≥ **1.2:1** (matches the shipping parchment baseline)

Contrast ratio: `(L_hi + 0.05) / (L_lo + 0.05)`, where relative luminance
`L = 0.2126·R + 0.7152·G + 0.0722·B` over linearized sRGB channels
(`c/255`; if ≤ 0.03928 then `/12.92` else `((c+0.055)/1.055)^2.4`).

State each check like: `ink #eaeaea on parch2 #202430 → 12.1:1 ✓ (≥4.5)`. If any
fails, nudge lightness (not hue) until it passes, then recheck.

## Step 4 — Write the file

Write JSON `{ "name", "author", "tokens": {…}, "road"?: {…} }` to
`<questlogHome>/skins/<slug>.json`. Example shape:

```json
{
  "name": "Hollow Depths",
  "author": "<founder>",
  "tokens": { "parch": "#0e0f14", "ink": "#e8ecf4", "gold": "#7fb0d8" },
  "road": { "roadDashArray": "1 10", "roadDashOpacity": 0.9 }
}
```

## Step 5 — Tell the founder to apply

"Open Questlog → gear (Settings) → Skins → hover to preview, click **Apply**.
**Revert** restores the current skin. Nothing is saved until you press Apply."

Do not apply it yourself and do not restart the server — applying is the
founder's click.
