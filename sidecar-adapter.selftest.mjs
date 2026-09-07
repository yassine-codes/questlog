#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SIDECAR ADAPTER SELF-TEST (F8b).
//
// This file is the ACCEPTANCE GATE for the drift-repair loop. When
// sidecar-adapter.mjs is rewritten by a Fable repair session, the launcher runs
// `node sidecar-adapter.selftest.mjs` and the rewrite stands only if this exits
// 0. So the assertions below must be worth standing on:
//
//   * REAL transcripts. It parses actual Claude Code session files under
//     ~/.claude/projects/, not fixtures — by default the ones this very
//     checkout has accumulated. A parser that only satisfies a fixture is
//     exactly the failure this gate exists to catch. (On a fresh machine, or a
//     clone nobody has worked in yet, those groups SKIP loudly rather than
//     passing silently. Two environment variables aim them somewhere else:
//     QUESTLOG_SIDECAR_ACCEPTANCE="<project root>::<chat id>" names one
//     transcript to hold the whole gate open, and QUESTLOG_SIDECAR_CORPUS=<a
//     project root> moves the corpus sweep to another project's sessions.)
//   * The splint. enrich() must return the dock transcript unchanged on every
//     failure path.
//   * The sentinel. A deliberately mutated fixture must be FLAGGED.
//
// Read-only throughout: nothing here writes anywhere near ~/.claude.
// Run: node sidecar-adapter.selftest.mjs
// ---------------------------------------------------------------------------
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  sidecarSlug, sidecarPathFor, readSidecar, enrich, checkFingerprint,
  readFingerprint, summarizeInput, FINGERPRINT_PATH,
  TOOL_INPUT_CAP, TOOL_OUTPUT_CAP,
  // F-B — honest attribution of the things Claude Code files under `user`
  classifyInjected, splitPreamble,
} from "./sidecar-adapter.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0, skipped = 0;
const ok = (n) => { console.log("  ok -", n); passed++; };
const skip = (n, why) => { console.log("  SKIP -", n, "(" + why + ")"); skipped++; };

// A path carrying every shape the slug rule has to fold — a drive letter, a
// backslash, a space, a dot — and the slug it folds down to. The pure function is
// what is under test here, not any one machine's directory.
const ROOT = "C:\\Work\\My Projects\\demo.app";
const ROOT_SLUG = "C--Work-My-Projects-demo-app";
const SOME_ID = "0f3d9c7a-2b41-4d8e-9a56-7c1e2f4b8d30";

// THE ACCEPTANCE CASE is ONE named real transcript, held up as the gate. A
// transcript is somebody's whole session, so it is the one thing this repo can
// never carry: point QUESTLOG_SIDECAR_ACCEPTANCE at one, as
// "<project root>::<chat id>", to run it. Unset, the group skips and says so.
// Read the numbers in that group before aiming this somewhere new: they were
// MEASURED on one particular session (>=45 beats off >=150 lines, strictly
// chronological), and a session with a different shape will fail them honestly
// rather than tell you the parser broke. It is a named artifact, not a sample.
const ACCEPT = (() => {
  const raw = process.env.QUESTLOG_SIDECAR_ACCEPTANCE || "";
  const i = raw.lastIndexOf("::");
  if (i <= 0 || i + 2 >= raw.length) return null;
  return { root: raw.slice(0, i), id: raw.slice(i + 2) };
})();

// THE CORPUS defaults to THIS CHECKOUT's own Claude Code transcripts: whatever
// sessions have been run here. Real drifting data nobody wrote for a test, and
// present wherever the work is actually happening.
const CORPUS_ROOT = process.env.QUESTLOG_SIDECAR_CORPUS || __dirname;

// ===========================================================================
// 1. Slug + path derivation — against the one real mapping we confirmed.
// ===========================================================================
{
  assert.strictEqual(sidecarSlug(ROOT), ROOT_SLUG,
    "the path -> slug mapping (backslashes, colon, spaces and dots all folded to -)");
  assert.strictEqual(sidecarSlug("/home/me/proj.v2"), "-home-me-proj-v2", "posix path + a dot");
  const p = sidecarPathFor(SOME_ID, ROOT, { CLAUDE_CONFIG_DIR: "" });
  assert.ok(p && p.includes(ROOT_SLUG) && p.endsWith(SOME_ID + ".jsonl"), "path is <cfg>/projects/<slug>/<id>.jsonl");
  assert.ok(p.includes(path.join(".claude", "projects")), "defaults to ~/.claude/projects");
  // CLAUDE_CONFIG_DIR override (that is dq() in Claude Code's own source).
  const p2 = sidecarPathFor(SOME_ID, ROOT, { CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), "ccfg") });
  assert.ok(p2.startsWith(path.join(os.tmpdir(), "ccfg")), "CLAUDE_CONFIG_DIR overrides the home default");
  // Never build a path out of junk.
  assert.strictEqual(sidecarPathFor("../../etc/passwd", ROOT, {}), null, "a non-uuid-shaped id yields no path");
  assert.strictEqual(sidecarPathFor("", ROOT, {}), null, "an empty id yields no path");
  ok("path derivation: slug mapping, CLAUDE_CONFIG_DIR override, junk ids refused");
}

// ===========================================================================
// 2. THE ACCEPTANCE CASE — parse one named real session, end to end.
// ===========================================================================
const realFile = ACCEPT ? sidecarPathFor(ACCEPT.id, ACCEPT.root, process.env) : null;
const haveReal = !!(realFile && fs.existsSync(realFile));
if (!haveReal) {
  skip("acceptance: one named real transcript",
       ACCEPT ? "the named transcript is not on this machine"
              : 'unset — set QUESTLOG_SIDECAR_ACCEPTANCE="<project root>::<chat id>" to run it');
} else {
  const r = readSidecar(ACCEPT.id, ACCEPT.root, process.env);
  assert.strictEqual(r.ok, true, "the real acceptance transcript parses: " + (r.reason || ""));
  assert.ok(Array.isArray(r.beats), "beats is an array");

  // The honest floor. The raw file is 180 LINES, but 87 of those are
  // bookkeeping (attachment / queue-operation / last-prompt) that carry no
  // message content, and `thinking` blocks are dropped in wave 1. What is
  // actually renderable is text + tool_use blocks off the message lines.
  // Measured on this file: 18 text + 28 tool_use + 2 prompt beats = 48.
  // The gate is set just under the measured value so a real regression trips
  // it while a benign upstream tweak does not.
  assert.ok(r.beats.length >= 45,
    `acceptance transcript yields >=45 ordered beats (got ${r.beats.length})`);
  assert.ok(r.meta.lines >= 150, `raw file still has >=150 lines (got ${r.meta.lines})`);

  // ORDER — the whole point. Timestamps must be non-decreasing.
  const stamped = r.beats.filter((b) => b.ts);
  assert.ok(stamped.length >= r.beats.length - 2, "essentially every beat carries a real per-event timestamp");
  for (let i = 1; i < stamped.length; i++) {
    assert.ok(String(stamped[i].ts) >= String(stamped[i - 1].ts),
      `beats are in chronological order (beat ${i} ${stamped[i].ts} < ${stamped[i - 1].ts})`);
  }
  // Timestamps are DISTINCT, unlike the flattened dock write path where 29 tool
  // calls across 452 seconds all carried the child-close time.
  assert.ok(new Set(stamped.map((b) => b.ts)).size > 10, "per-event timestamps are distinct, not one close-time stamp");

  // INTERLEAVING — prose and tools alternate; they are not two blocks.
  const kinds = r.beats.map((b) => b.kind);
  let flips = 0;
  for (let i = 1; i < kinds.length; i++) if (kinds[i] !== kinds[i - 1]) flips++;
  assert.ok(flips >= 8, `prose and tool beats interleave (${flips} transitions)`);

  // The tools are real and carry FULL input, not a 240-char summary.
  const tools = r.beats.filter((b) => b.kind === "tool");
  assert.ok(tools.length >= 25, `>=25 tool beats (got ${tools.length})`);
  assert.ok(tools.some((b) => b.name === "Skill"), "the chief-of-staff Skill invocation is a beat (F6 banner input)");
  const withInput = tools.filter((b) => b.input && typeof b.input === "object");
  assert.ok(withInput.length >= 20, "tool beats keep their structured input object");
  const withOutput = tools.filter((b) => typeof b.output === "string" && b.output.length);
  assert.ok(withOutput.length >= 20, `tool_result correlated back onto its tool beat (${withOutput.length} with output)`);
  for (const b of tools) {
    if (typeof b.output === "string") assert.ok(b.output.length <= TOOL_OUTPUT_CAP, "output honours the 4KB cap");
    if (typeof b.input === "string") assert.ok(b.input.length <= TOOL_INPUT_CAP, "clipped input honours the 16KB cap");
  }
  // seq is monotonic and dense.
  for (let i = 0; i < r.beats.length; i++) assert.strictEqual(r.beats[i].seq, i, "seq is monotonic from 0");
  // thinking is dropped in wave 1 — assert it really is absent.
  assert.ok(!r.beats.some((b) => b.kind === "thinking"), "thinking blocks are dropped in wave 1");
  ok(`acceptance: ${ACCEPT.id} -> ${r.beats.length} ordered beats (${tools.length} tools) from ${r.meta.lines} raw lines, chronological, full inputs + correlated outputs`);

  // The fingerprint must pass CLEAN against today's real data. A fingerprint
  // that flags the founder's own current transcripts would launch a repair
  // session on every chat open.
  const raw = fs.readFileSync(realFile, "utf8").split("\n").filter((l) => l.trim());
  const chk = checkFingerprint(raw, readFingerprint());
  assert.strictEqual(chk.ok, true, "fingerprint validates the real transcript with no drift: " + JSON.stringify(chk.drift));
  assert.deepStrictEqual(chk.drift, [], "no drift reasons on real current data");
  ok("fingerprint: validates a real current transcript with zero drift");
}

// ===========================================================================
// 3. Every real transcript in the corpus parses too — the fingerprint is
//    checked against a whole folder of sessions, not one lucky file.
// ===========================================================================
{
  const probe = sidecarPathFor("00000000-0000-4000-8000-000000000000", CORPUS_ROOT, process.env);
  const dir = probe ? path.dirname(probe) : null;
  const files = (dir && fs.existsSync(dir)) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
  if (!files.length) {
    skip("corpus: the transcripts of the project this checkout lives in", "none found");
  } else {
    let totalBeats = 0, drifted = [];
    for (const f of files) {
      const id = f.replace(/\.jsonl$/, "");
      const r = readSidecar(id, CORPUS_ROOT, process.env);
      assert.strictEqual(r.ok, true, `real transcript ${f} parses`);
      assert.ok(Array.isArray(r.beats), `${f} yields beats`);
      totalBeats += r.beats.length;
      const raw = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => l.trim());
      const chk = checkFingerprint(raw, readFingerprint());
      if (!chk.ok) drifted.push(f + ": " + chk.drift.join("; "));

      // ORDERING INVARIANT — topological, not chronological.
      //
      // Measured finding on a real corpus: per-event `timestamp` is
      // NOT monotonic along the causal chain. Slash-command echo lines land
      // 1-300ms out of order, and a resumed session can attach a new branch to
      // an older parent (largest observed backward jump: 255s). The parentUuid
      // chain is what is actually authoritative, so THAT is what is asserted:
      // every line must appear after the parent it names.
      const order = r.meta.order || [], parents = r.meta.parents || [];
      const seenAt = new Map();
      order.forEach((u, i) => { if (u && !seenAt.has(u)) seenAt.set(u, i); });
      let violations = 0;
      for (let i = 0; i < order.length; i++) {
        const p = parents[i];
        if (p && seenAt.has(p) && seenAt.get(p) > i) violations++;
      }
      assert.strictEqual(violations, 0,
        `${f}: ${violations} lines rendered before the parent they descend from — the causal walk is broken`);
    }
    assert.deepStrictEqual(drifted, [], "no real transcript on this machine reads as drift");
    ok(`corpus: ${files.length} real transcripts parse in order, ${totalBeats} beats total, zero false drift`);
  }
}

// ===========================================================================
// 4. THE SENTINEL — a deliberately mutated fixture must be FLAGGED.
// ===========================================================================
{
  const fp = readFingerprint();
  assert.ok(fp, "the fingerprint file loads");
  const good = [
    JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-07-25T15:00:00.000Z", version: "2.1.220", message: { role: "user", content: "hello" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-07-25T15:00:01.000Z", version: "2.1.220", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
  ];
  assert.deepStrictEqual(checkFingerprint(good, fp).drift, [], "a clean fixture drifts on nothing");

  // (a) unknown LINE type
  const mutA = good.concat([JSON.stringify({ type: "quantum-frame", uuid: "x", parentUuid: null, timestamp: "2026-07-25T15:00:02.000Z" })]);
  const dA = checkFingerprint(mutA, fp);
  assert.strictEqual(dA.ok, false, "an unknown line type is drift");
  assert.ok(dA.drift.some((d) => /quantum-frame/.test(d)), "the drift reason names the unknown line type");

  // (b) unknown BLOCK type
  const mutB = good.concat([JSON.stringify({ type: "assistant", uuid: "a2", parentUuid: "a1", timestamp: "2026-07-25T15:00:03.000Z", message: { role: "assistant", content: [{ type: "hologram", data: 1 }] } })]);
  const dB = checkFingerprint(mutB, fp);
  assert.strictEqual(dB.ok, false, "an unknown content block type is drift");
  assert.ok(dB.drift.some((d) => /hologram/.test(d)), "the drift reason names the unknown block type");

  // (c) a required field REMOVED from a message line
  const mutC = [good[0], JSON.stringify({ type: "assistant", uuid: "a3", timestamp: "2026-07-25T15:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "x" }] } })];
  const dC = checkFingerprint(mutC, fp);
  assert.strictEqual(dC.ok, false, "a missing required field on a message line is drift");
  assert.ok(dC.drift.some((d) => /parentUuid/.test(d)), "the drift reason names the missing field");

  // (d) a MAJOR.MINOR version move
  const mutD = [JSON.stringify({ type: "assistant", uuid: "a4", parentUuid: null, timestamp: "2026-07-25T15:00:05.000Z", version: "3.0.1", message: { role: "assistant", content: [{ type: "text", text: "x" }] } })];
  const dD = checkFingerprint(mutD, fp);
  assert.strictEqual(dD.ok, false, "a major/minor Claude Code version move is drift");
  assert.ok(dD.drift.some((d) => /3\.0\.1/.test(d)), "the drift reason names the new version");
  // ...but a PATCH move is NOT drift (those churn constantly).
  const patch = [JSON.stringify({ type: "assistant", uuid: "a5", parentUuid: null, timestamp: "2026-07-25T15:00:06.000Z", version: "2.1.999", message: { role: "assistant", content: [{ type: "text", text: "x" }] } })];
  assert.strictEqual(checkFingerprint(patch, fp).ok, true, "a patch-level version move is NOT drift");

  // (e) >10% unparseable
  const mutE = good.concat(["{ this is not json", "{ nor is this", "{ or this"]);
  const dE = checkFingerprint(mutE, fp);
  assert.strictEqual(dE.ok, false, ">10% unparseable lines is drift");
  assert.ok(dE.drift.some((d) => /could not be parsed/.test(d)), "the drift reason reports the unparseable share");
  // A single bad line in a large healthy file is NOT drift.
  const mostlyGood = [];
  for (let i = 0; i < 40; i++) mostlyGood.push(JSON.stringify({ type: "assistant", uuid: "z" + i, parentUuid: null, timestamp: "2026-07-25T15:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "x" }] } }));
  mostlyGood.push("{ broken");
  assert.strictEqual(checkFingerprint(mostlyGood, fp).ok, true, "one bad line in 41 is under the 10% threshold");
  ok("sentinel: unknown line type / unknown block type / missing required field / version move / unparseable share each flagged; patch moves and one bad line are not");
}

// ===========================================================================
// 5. THE SPLINT — enrich() never breaks the dock, on any path.
// ===========================================================================
{
  const dock = [
    { ts: "2026-07-25T15:06:34.649Z", role: "user", text: "load the skill", briefed: true },
    { ts: "2026-07-25T15:16:34.821Z", role: "error", message: "chat timed out after 600000ms" },
  ];
  const same = (r) => assert.strictEqual(r, dock, "the dock transcript is returned by identity, unchanged");
  same(enrich(dock, null));
  same(enrich(dock, { ok: false, reason: "not-found" }));
  same(enrich(dock, { ok: true }));                                    // no beats array
  same(enrich(dock, { ok: true, beats: [] }));                         // fewer beats than dock
  same(enrich(dock, { ok: true, beats: [{ kind: "text", ts: "x", seq: 0, text: "a" }], drift: ["unknown line type \"x\""] }));  // drift => splint
  // A thrown-inside call still returns the dock.
  const hostile = { get ok() { throw new Error("boom"); } };
  assert.strictEqual(enrich(dock, hostile), dock, "an exploding sidecar result still yields the dock transcript");
  // A non-array dock is tolerated.
  assert.deepStrictEqual(enrich(null, null), [], "a null dock transcript yields []");
  ok("splint: every failure path (missing / empty / fewer beats / drifted / throwing) returns the dock transcript unchanged");
}

// ===========================================================================
// 6. ENRICHMENT merges correctly: sidecar beats win, dock-only lines survive.
// ===========================================================================
{
  const dock = [
    { ts: "2026-07-25T15:06:34.649Z", role: "user", text: "load the skill", briefed: true, seq: 0 },
    { ts: "2026-07-25T15:16:34.821Z", role: "error", message: "chat timed out after 600000ms" },
    { ts: "2026-07-25T15:16:00.000Z", role: "retry", attempt: 1, max: 3, reason: "connection" },
  ];
  const sc = {
    ok: true,
    drift: [],
    beats: [
      { kind: "user", ts: "2026-07-25T15:06:34.649Z", seq: 0, text: "You are the board-level chat…\n\n---\n\nload the skill" },
      { kind: "text", ts: "2026-07-25T15:06:50.000Z", seq: 1, text: "I'll load it." },
      { kind: "tool", ts: "2026-07-25T15:06:51.000Z", seq: 2, name: "Skill", detail: "Skill — skill: questlog-chief-of-staff", toolUseId: "t1", input: { skill: "questlog-chief-of-staff" }, output: "Launching skill", attributionSkill: "questlog-chief-of-staff" },
      { kind: "text", ts: "2026-07-25T15:07:00.000Z", seq: 3, text: "Loaded." },
      { kind: "tool", ts: "2026-07-25T15:15:00.000Z", seq: 4, name: "Read", detail: "Read — file_path: x", toolUseId: "t2", input: { file_path: "x" }, output: "1\tline" },
    ],
  };
  const out = enrich(dock, sc);
  assert.notStrictEqual(out, dock, "with more beats than the dock, the sidecar wins");
  assert.ok(out.length >= 7, "every sidecar beat plus the dock-only lines are present");

  // Chronological across BOTH sources.
  const ts = out.map((e) => e.ts).filter(Boolean);
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] >= ts[i - 1], "merged output is chronological");

  // The sidecar spine keeps its CAUSAL order exactly — merging dock lines in
  // must never reorder the beats around them. (A global ts-sort would, because
  // Claude Code's own timestamps have millisecond inversions along the chain.)
  const spine = out.filter((e) => e.source === "sidecar" || (e.role === "user" && e.source === "dock"));
  assert.deepStrictEqual(spine.map((e) => e.seq), [0, 1, 2, 3, 4],
    "sidecar beats keep their parsed order and seq after the merge");
  {
    const scrambled = { ok: true, drift: [], beats: [
      { kind: "text", ts: "2026-07-25T10:00:02.000Z", seq: 0, text: "first by cause, later by clock" },
      { kind: "tool", ts: "2026-07-25T10:00:01.000Z", seq: 1, name: "Read", detail: "Read", toolUseId: "t" },
      { kind: "text", ts: "2026-07-25T10:00:03.000Z", seq: 2, text: "third" },
    ] };
    const merged = enrich([{ ts: "2026-07-25T10:00:04.000Z", role: "error", message: "late" }], scrambled);
    assert.deepStrictEqual(merged.filter((e) => e.source === "sidecar").map((e) => e.seq), [0, 1, 2],
      "a ms-level timestamp inversion in the sidecar is NOT re-sorted away — the causal chain wins");
    assert.strictEqual(merged[merged.length - 1].role, "error", "the later dock line still lands after the beats it followed");
  }

  // Dock-only lines survive — they are questlog's own record of what questlog
  // did and the sidecar cannot possibly have them.
  assert.ok(out.find((e) => e.role === "error" && /timed out/.test(e.message)), "the dock's error line survives the merge");
  assert.ok(out.find((e) => e.role === "retry" && e.attempt === 1), "the dock's retry line survives the merge");
  // The error line lands AFTER the last tool beat, not before it.
  assert.ok(out.findIndex((e) => e.role === "error") > out.findIndex((e) => e.role === "tool" && e.name === "Read"),
    "the dock error is interleaved at its real time, after the work it interrupted");

  // The founder's own words + the briefed chip beat the sidecar's preamble-laden copy.
  const user = out.find((e) => e.role === "user");
  assert.strictEqual(user.text, "load the skill", "the dock's user line (founder's words only) wins over the sidecar's prompt+preamble");
  assert.strictEqual(user.briefed, true, "the briefed chip survives");

  // Tool beats keep the payload the unfurl needs.
  const skill = out.find((e) => e.role === "tool" && e.name === "Skill");
  assert.ok(skill && skill.input && skill.input.skill === "questlog-chief-of-staff", "tool input rides the merged line");
  assert.strictEqual(skill.output, "Launching skill", "tool output rides the merged line");
  assert.strictEqual(skill.source, "sidecar", "sidecar-sourced lines are labelled");
  ok("enrichment: sidecar beats win on count, dock-only error/retry lines merge back by time, founder's briefed user line preserved");
}

// ===========================================================================
// 7. readSidecar failure paths + summarizeInput bounds.
// ===========================================================================
{
  const miss = readSidecar("00000000-0000-4000-8000-000000000000", ROOT, process.env);
  assert.strictEqual(miss.ok, false, "a missing session file is a clean miss, not a throw");
  assert.strictEqual(miss.reason, "not-found");
  const junk = readSidecar("../evil", ROOT, process.env);
  assert.strictEqual(junk.ok, false, "a junk id is refused");
  // An empty file in a temp CLAUDE_CONFIG_DIR.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-selftest-"));
  const id = "11111111-1111-4111-8111-111111111111";
  const dir = path.join(tmp, "projects", sidecarSlug(ROOT));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + ".jsonl"), "", "utf8");
  const empty = readSidecar(id, ROOT, { CLAUDE_CONFIG_DIR: tmp });
  assert.strictEqual(empty.ok, false, "an empty session file is a clean miss");
  assert.strictEqual(empty.reason, "empty");
  // A file of pure garbage: parses to zero beats, still never throws.
  fs.writeFileSync(path.join(dir, id + ".jsonl"), "not json\nalso not json\n", "utf8");
  const garbage = readSidecar(id, ROOT, { CLAUDE_CONFIG_DIR: tmp });
  assert.strictEqual(garbage.ok, true, "a garbage file still returns a value");
  assert.deepStrictEqual(garbage.beats, [], "garbage yields no beats");
  assert.ok(garbage.drift.length, "garbage is reported as drift");
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }

  assert.strictEqual(summarizeInput("Read", null), "Read", "no input => bare tool name");
  assert.ok(summarizeInput("Bash", { command: "x".repeat(500) }).length <= 241, "the summary line is bounded");
  assert.ok(/file_path/.test(summarizeInput("Read", { file_path: "/a/b" })), "the summary names the discriminating argument");
  ok("failure paths: missing / junk id / empty / garbage all return values and never throw; summary bounded");
}

// ===========================================================================
// 8. This adapter is READ-ONLY and self-contained (the repair scope depends on
//    it: a repair session may edit these three files and nothing else).
// ===========================================================================
{
  const src = fs.readFileSync(path.join(__dirname, "sidecar-adapter.mjs"), "utf8");
  for (const bad of ["writeFileSync", "appendFileSync", "rmSync", "unlinkSync", "renameSync", "mkdirSync", "rmdirSync", "createWriteStream"]) {
    assert.ok(!src.includes(bad), `sidecar-adapter.mjs must never call ${bad} — it is read-only`);
  }
  assert.ok(!/from\s+["']\.\/(server|chat|bridge)\.mjs["']/.test(src), "the adapter imports no other questlog module (it must stay independently repairable)");
  assert.ok(/deliberately duplicated|DELIBERATELY DUPLICATED/i.test(src), "the duplicated slug derivation is documented as deliberate");
  assert.ok(fs.existsSync(FINGERPRINT_PATH), "the fingerprint file exists next to the adapter");
  ok("adapter is read-only, dependency-free, and documents its deliberate duplication");
}

// ===========================================================================
// 10. F-B — ATTRIBUTION. Claude Code files a lot of things under the `user`
//     role that the founder never typed: skill preambles, slash-command
//     echoes, system reminders, and questlog's own anchoring brief. Rendering
//     any of them under a "YOU" header is a lie about who said what.
//
//     A repair session rewriting readSidecar() must keep this true: it is not
//     a rendering nicety, it is the difference between a record and a forgery.
// ===========================================================================
{
  // Every injected shape is recognised…
  assert.deepStrictEqual(classifyInjected({ isMeta: true }, "Base directory for this skill: C:\\Users\\x\\.claude\\skills\\my-skill\n\n# Title"),
    { origin: "skill", skill: "my-skill" }, "skill preamble -> origin skill, named");
  assert.deepStrictEqual(classifyInjected({}, "Base directory for this skill: /home/u/.claude/skills/other\ntext"),
    { origin: "skill", skill: "other" }, "posix skill path too");
  assert.deepStrictEqual(classifyInjected({}, "<command-name>takeaway</command-name>"), { origin: "command" }, "slash-command echo");
  assert.deepStrictEqual(classifyInjected({}, "<command-message>run</command-message>"), { origin: "command" }, "command message");
  assert.deepStrictEqual(classifyInjected({}, "<local-command-stdout>ok</local-command-stdout>"), { origin: "command" }, "command stdout");
  assert.deepStrictEqual(classifyInjected({}, "<system-reminder>x</system-reminder>"), { origin: "system" }, "system reminder");
  assert.deepStrictEqual(classifyInjected({}, "Caveat: The messages below were generated by the user while running local commands. DO NOT..."),
    { origin: "system" }, "the local-command caveat");
  assert.deepStrictEqual(classifyInjected({ isMeta: true }, "some other injected thing"), { origin: "system" }, "isMeta alone suffices");
  // …and nothing the founder actually typed is ever reclassified.
  assert.strictEqual(classifyInjected({}, "load"), null, "a real prompt stays the founder's");
  assert.strictEqual(classifyInjected({ isMeta: false }, "read the skill file and tell me about <system-reminder> tags"), null,
    "merely MENTIONING an injected shape mid-sentence is not an injection (anchored at the start)");

  // questlog's own preamble is peeled off the first message.
  const brief = "You are the board-level chat for the \"X\" road (C:/x).\nInvoke the questlog-chief-of-staff skill and operate as it for this conversation.";
  assert.deepStrictEqual(splitPreamble(brief + "\n\n---\n\nload"), { brief, text: "load" }, "brief peeled, founder's words kept");
  const mile = "You are in a chat anchored to a milestone card on the \"X\" road.\nCARD: y";
  assert.deepStrictEqual(splitPreamble(mile + "\n\n---\n\ndo it"), { brief: mile, text: "do it" }, "the milestone preamble too");
  assert.strictEqual(splitPreamble("ordinary message"), null, "an ordinary message is never split");
  assert.strictEqual(splitPreamble(null), null, "null never throws");

  // End to end against the acceptance transcript, when one is named.
  const real = ACCEPT ? readSidecar(ACCEPT.id, ACCEPT.root, process.env)
                      : { ok: false, reason: "no acceptance transcript named" };
  if (!real.ok) {
    skip("F-B attribution on the acceptance transcript", real.reason);
  } else {
    const sys = real.beats.filter((b) => b.kind === "system");
    const usr = real.beats.filter((b) => b.kind === "user");
    assert.ok(sys.length >= 2, "the real chat has injected lines and they are marked as such");
    assert.ok(sys.some((b) => b.origin === "skill" && b.skill === "questlog-chief-of-staff"),
      "the chief-of-staff skill preamble is attributed to the skill, by name");
    assert.ok(sys.some((b) => b.origin === "brief"), "questlog's anchoring brief is attributed to questlog");
    for (const u of usr) {
      assert.ok(!/^Base directory for this skill:/.test(u.text), "no skill preamble is left in the founder's voice");
      assert.ok(!/^You are (the board-level|in a chat anchored)/.test(u.text), "no anchoring brief is left in the founder's voice");
      assert.ok(!/^<(command|system-reminder|local-command)/.test(u.text), "no harness echo is left in the founder's voice");
    }
    // enrich carries the attribution through to the render list.
    const dock = [{ ts: "2000-01-01T00:00:00.000Z", role: "user", text: "load", briefed: true }];
    const merged = enrich(dock, real);
    const you = merged.filter((e) => e.role === "user");
    assert.strictEqual(you.length, 1, "exactly one line renders as the founder");
    assert.strictEqual(you[0].text, "load", "and it is exactly what they typed");
    assert.strictEqual(you[0].briefed, true, "the briefed chip survives");
    const sysLines = merged.filter((e) => e.role === "system");
    assert.ok(sysLines.length >= 2 && sysLines.every((e) => typeof e.origin === "string" && e.origin),
      "every system line carries a named origin the renderer can label honestly");
    assert.ok(sysLines.some((e) => e.skill === "questlog-chief-of-staff"), "the skill name rides through enrich");
  }

  // The splint must not be released by injected text: system beats do not
  // count towards "the sidecar knows more than the dock".
  const injectedHeavy = { ok: true, drift: [], beats: [
    { kind: "system", origin: "skill", ts: "t1", seq: 0, text: "a" },
    { kind: "system", origin: "system", ts: "t2", seq: 1, text: "b" },
    { kind: "system", origin: "brief", ts: "t3", seq: 2, text: "c" },
    { kind: "user", ts: "t4", seq: 3, text: "hi" },
  ] };
  const dockThin = [{ ts: "t0", role: "user", text: "hi" }, { ts: "t1", role: "assistant", text: "yo" }];
  assert.strictEqual(enrich(dockThin, injectedHeavy), dockThin,
    "three injected beats cannot outvote two real dock lines — the splint holds");
  ok("F-B: skill preambles / command echoes / reminders / questlog's own brief become attributed SYSTEM beats; the founder's voice carries only what they typed; injected beats never release the splint");
}

// ===========================================================================
// C1 — GATE POINT 3 of 5 (dec-currency-architecture). The sidecar REPAIR
// launcher is one of the five spawners questlog itself owns, so it runs the
// launch gate before it creates a working directory. A repair fixes tooling,
// not road work, so the call site declares chore:true; a drift report that
// declares neither a resolving milestone nor a chore does not run at all.
//
// The exhaustive currency suite lives in currency.selftest.mjs. This group is
// here because the gate is part of THIS module's contract: the repair loop must
// never spawn behind the gate's back.
// ===========================================================================
{
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "ql-sidecar-gate-"));
  const ROAD = path.join(WORK, "road");
  const T0 = "2026-01-01T00:00:00.000Z";
  fs.mkdirSync(path.join(ROAD, ".questlog"), { recursive: true });
  fs.writeFileSync(path.join(ROAD, ".questlog", "roadmap.json"), JSON.stringify({
    schemaVersion: 1,
    project: { name: "Gate", tagline: "a fixture road", createdAt: T0, updatedAt: T0 },
    quests: [{ id: "q-main", type: "main", title: "Main", parentMilestoneId: null, side: null, order: 0, status: "in_progress", createdAt: T0, updatedAt: T0 }],
    milestones: [{ id: "ms-real", questId: "q-main", order: 0, title: "One", summary: "s", plain: "p", status: "available", statusReason: "", eta: null, startedAt: null, completedAt: null, createdAt: T0, updatedAt: T0, unclear: false, unclearAt: null }],
    items: [], assets: [],
  }, null, 2), "utf8");

  process.env.QUESTLOG_NO_LISTEN = "1";
  process.env.QUESTLOG_ALLOW_TEMP = "1";
  process.env.QUESTLOG_REGISTRY = path.join(WORK, "registry.json");
  process.env.QUESTLOG_DIR = ROAD;
  const SRV = await import("./server.mjs");
  const ctx = SRV.makeCtx(ROAD);

  let workDirs = 0;
  const deps = { mode: "dry", makeWorkDir: () => { workDirs++; return path.join(WORK, "wd"); } };
  const drift = [{ kind: "unknown-line-type", detail: "x" }];

  const refused = SRV.launchSidecarRepair({ ctx, drift }, deps);
  assert.strictEqual(refused.launched, false, "an unlinked repair run does not launch");
  assert.strictEqual(refused.reason, "unlinked", "and the reason names the gate, not a failure");
  assert.strictEqual(workDirs, 0, "the gate ran BEFORE any working directory was created");

  const bogus = SRV.launchSidecarRepair({ ctx, drift, milestoneId: "ms-invented" }, deps);
  assert.strictEqual(bogus.reason, "unlinked", "naming a milestone that does not resolve is not naming one");
  assert.strictEqual(workDirs, 0, "still no working directory");

  const asChore = SRV.launchSidecarRepair({ ctx, drift, chore: true }, deps);
  assert.notStrictEqual(asChore.reason, "unlinked", "a repair that declares itself a chore passes the gate");
  const ledger = fs.existsSync(ctx.files.activity) ? fs.readFileSync(ctx.files.activity, "utf8") : "";
  assert.ok(/"source":"sidecar"/.test(ledger) && /"kind":"launch"/.test(ledger),
    "the chore is COUNTED in the ledger — the escape hatch is never hidden");
  assert.ok(!fs.readFileSync(path.join(ROAD, ".questlog", "roadmap.json"), "utf8").includes("evidence"),
    "a chore never touches the road");

  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* windows handle lag */ }
  ok("C1 gate point 3: an unlinked repair does not run and creates no workdir; a chore passes and is ledgered, never written to the road");
}

console.log(`\nALL PASS — ${passed} groups${skipped ? ", " + skipped + " skipped" : ""}.`);
if (skipped && process.env.SIDECAR_SELFTEST_REQUIRE_REAL === "1") {
  console.error("FAIL: real transcripts were required but not found.");
  process.exit(1);
}
process.exit(0);
