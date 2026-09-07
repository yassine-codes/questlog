#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Questlog BATCH-2 self-tests — NO live model spawn. Exercises the five items:
//   1. Horizon suggestions: suggestions_upsert / promote / dismiss round-trip
//      over stdio JSON-RPC; road-end enforcement; tallies exclude ghosts.
//   3. Registry hygiene: temp/scratch-path refusal at BOTH servers (mcp
//      roadmap_register + server.mjs dir-mode auto-register), the escape hatch,
//      and the POST /api/registry/unregister endpoint (registry-only, 404).
//   4. Observer purity: baton_peek is strictly read-only (never mutates, no
//      history); the observer whitelist swapped baton_read -> baton_peek.
// Runs REAL servers on ports 4330+ with a temp registry + temp road; never
// touches the founder :4177 or the real ~/.questlog.  Run:
//   node registry.selftest.mjs
// ---------------------------------------------------------------------------
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OBSERVER_READ_TOOLS } from "./chat.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = __dirname;
const MCP = path.join(REPO, "mcp", "server.mjs");
const SERVER = path.join(REPO, "server.mjs");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log("  ok -", n); };
const bad = (n, d) => { fail++; console.log("  FAIL -", n, "\n        ", d); };
function check(cond, n, d) { cond ? ok(n) : bad(n, d || ""); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "questlog-b2-"));
const REG = path.join(TMP, "reg", "registry.json"); // temp registry (+ config dir)
fs.mkdirSync(path.dirname(REG), { recursive: true });

// A temp "road" that owns .questlog data. It lives under os.tmpdir(), so it is
// itself a refused registry path — perfect for the hygiene tests.
const ROAD = path.join(TMP, "road");
fs.mkdirSync(path.join(ROAD, ".questlog"), { recursive: true });

// ---- stdio JSON-RPC client for mcp/server.mjs --------------------------------
function mcpClient(dir, extraEnv) {
  const env = Object.assign({}, process.env, { QUESTLOG_REGISTRY: REG }, extraEnv || {});
  delete env.QUESTLOG_DIR;
  const cp = spawn(process.execPath, [MCP, "--dir", dir], { env, stdio: ["pipe", "pipe", "pipe"] });
  cp.stderr.on("data", () => {}); // swallow the ready banner
  let buf = ""; const pending = new Map(); let idc = 1;
  cp.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  const send = (method, params) => new Promise((res) => {
    const id = idc++; pending.set(id, res);
    cp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
  });
  async function call(name, args) {
    const r = await send("tools/call", { name, arguments: args || {} });
    const c = r.result && r.result.content && r.result.content[0];
    const text = c ? c.text : "";
    let json = null; try { json = JSON.parse(text); } catch { /* error string */ }
    return { isError: !!(r.result && r.result.isError), text, json };
  }
  return { cp, send, call, close: () => cp.kill() };
}

// ---- tiny http helper --------------------------------------------------------
function req(base, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(base + p, {
      method, headers: Object.assign({ "Content-Type": "application/json" }, data ? { "Content-Length": data.length } : {}),
    }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
async function waitUp(base, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try { const r = await req(base, "GET", "/api/mode"); if (r.status) return true; }
    catch { await new Promise((res) => setTimeout(res, 50)); }
  }
  throw new Error("server did not come up: " + base);
}

async function main() {
  // =========================================================================
  // ITEM-4 (static): observer whitelist swap
  // =========================================================================
  check(OBSERVER_READ_TOOLS.includes("mcp__questlog__baton_peek"),
    "observer whitelist includes baton_peek", OBSERVER_READ_TOOLS.join(","));
  check(!OBSERVER_READ_TOOLS.includes("mcp__questlog__baton_read"),
    "observer whitelist NO LONGER includes baton_read (write-capable)");

  // =========================================================================
  // ITEM-1 + ITEM-4 (runtime): mcp suggestion tools + baton_peek purity
  // =========================================================================
  const cli = mcpClient(ROAD);
  try {
    await cli.send("initialize", {});
    await cli.call("session_hello", { sessionId: "sess-b2" });

    const m1 = await cli.call("milestone_upsert", { questId: "q-main", title: "First" });
    check(!m1.isError && m1.json && m1.json.id, "milestone_upsert created a milestone", m1.text);
    const msId = m1.json.id;

    // upsert 1-3 suggestions on a road-end (First is the only milestone => road-end)
    const up = await cli.call("suggestions_upsert", {
      frontierMilestoneId: msId,
      suggestions: [
        { title: "Next A", plain: "do the next thing" },
        { title: "Next B", plain: "or do this one instead", order: 0 },
      ],
    });
    check(!up.isError && up.json.suggestions.length === 2, "suggestions_upsert set 2 ghosts at the road-end", up.text);

    // round-trip read
    const got = await cli.call("roadmap_get", { section: "suggestions" });
    check(!got.isError && got.json.length === 2, "roadmap_get suggestions round-trips (2)", got.text);

    // TALLIES EXCLUDE GHOSTS: milestones section is still exactly 1
    const mss = await cli.call("roadmap_get", { section: "milestones" });
    check(mss.json.length === 1, "tally source (milestones) excludes ghosts (still 1)", String(mss.json.length));

    // ANCHOR RULE (dec-horizon-tree). The road-end rule is RELAXED, not dropped:
    // ANY done / in-progress milestone may anchor a fan, a road-end still may
    // whatever its status, and anything else is still refused. Add a 2nd
    // milestone so First is no longer a road-end, then check BOTH halves.
    await cli.call("milestone_upsert", { questId: "q-main", title: "Second" });
    const upStale = await cli.call("suggestions_upsert", { frontierMilestoneId: msId, suggestions: [{ title: "x", plain: "y" }] });
    check(upStale.isError && /anchor a horizon/i.test(upStale.text),
      "suggestions_upsert on a LOCKED non-road-end is refused", upStale.text);
    await cli.call("milestone_set_status", { id: msId, status: "in_progress" });
    const upMid = await cli.call("suggestions_upsert", {
      frontierMilestoneId: msId,
      suggestions: [
        { title: "Next A", plain: "do the next thing", branchIndex: 0, seqIndex: 0 },
        { title: "Next B", plain: "or do this one instead", branchIndex: 1, seqIndex: 0 },
      ],
    });
    check(!upMid.isError && upMid.json.suggestions.length === 2 &&
      upMid.json.suggestions.every((s) => Number.isInteger(s.branchIndex) && Number.isInteger(s.seqIndex)),
      "an IN-PROGRESS mid-road milestone anchors a horizon tree (relaxed rule), and every write carries branchIndex+seqIndex", upMid.text);
    // 15 is the ceiling (5 parallel directions x 3 sequential steps); 16 is not.
    const fan16 = [];
    for (let b = 0; b < 5; b++) for (let s = 0; s < 3; s++) fan16.push({ title: `d${b}s${s}`, plain: "a possibility", branchIndex: b, seqIndex: s });
    const up15 = await cli.call("suggestions_upsert", { frontierMilestoneId: msId, suggestions: fan16.slice() });
    check(!up15.isError && up15.json.suggestions.length === 15, "suggestions_upsert accepts a full 15-item fan", up15.text);
    const up16 = await cli.call("suggestions_upsert", { frontierMilestoneId: msId, suggestions: fan16.concat([{ title: "x", plain: "y" }]) });
    check(up16.isError, "suggestions_upsert refuses a 16th item", up16.text);
    // put the original two-ghost set back so the promote/dismiss flow below is unchanged
    const upRestore = await cli.call("suggestions_upsert", {
      frontierMilestoneId: msId,
      suggestions: [
        { title: "Next A", plain: "do the next thing" },
        { title: "Next B", plain: "or do this one instead", order: 0 },
      ],
    });
    up.json = upRestore.json;

    // promote a ghost -> real milestone, ghost consumed
    const sgId = up.json.suggestions[0].id;
    const prom = await cli.call("suggestion_promote", { id: sgId });
    check(!prom.isError && prom.json.status === "available", "suggestion_promote created an available milestone", prom.text);
    const afterProm = await cli.call("roadmap_get", { section: "suggestions" });
    check(afterProm.json.length === 1, "promoted ghost was consumed (2 -> 1)", String(afterProm.json.length));
    const mssP = await cli.call("roadmap_get", { section: "milestones" });
    check(mssP.json.length === 3, "promotion added a real milestone (1+1 upsert +1 promote = 3)", String(mssP.json.length));

    // dismiss the remaining ghost
    const remId = afterProm.json[0].id;
    const dis = await cli.call("suggestion_dismiss", { id: remId });
    check(!dis.isError, "suggestion_dismiss ok", dis.text);
    const afterDis = await cli.call("roadmap_get", { section: "suggestions" });
    check(afterDis.json.length === 0, "dismissed ghost is gone (1 -> 0)", String(afterDis.json.length));

    // history logged all three
    const hist = await cli.call("roadmap_get", { section: "history_tail" });
    const actions = hist.json.map((e) => e.action);
    check(actions.includes("suggestions_upsert") && actions.includes("suggestion_promote") && actions.includes("suggestion_dismiss"),
      "history carries suggestions_upsert + suggestion_promote + suggestion_dismiss", actions.join(","));

    // ---- baton_peek read-purity ----
    const p0 = await cli.call("baton_peek", {});
    check(p0.json === null, "baton_peek returns null when there is no baton", p0.text);
    await cli.call("baton_pass", { label: "handoff", done: ["a"], next: ["b"] });
    const batonsBefore = (await cli.call("roadmap_get", { section: "batons" })).json;
    const histLenBefore = (await cli.call("roadmap_get", { section: "history_tail" })).json.length;
    const p1 = await cli.call("baton_peek", {});
    check(p1.json && p1.json.status === "open", "baton_peek returns the freshest baton content", p1.text);
    const batonsAfter = (await cli.call("roadmap_get", { section: "batons" })).json;
    check(JSON.stringify(batonsAfter) === JSON.stringify(batonsBefore), "baton_peek did NOT mutate the baton (status still open, no claim)");
    const histLenAfter = (await cli.call("roadmap_get", { section: "history_tail" })).json.length;
    check(histLenAfter === histLenBefore, "baton_peek appended NO history event", `${histLenBefore} -> ${histLenAfter}`);

    // ---- BRIEF-AS-BATON: brief_create writes file + asset + addressed baton --
    const msForBrief = (await cli.call("roadmap_get", { section: "milestones" })).json[0].id;
    const handoffBefore = (await cli.call("baton_peek", {})).json;
    const br = await cli.call("brief_create", {
      slug: "dark-mode", title: "Ship dark mode", body: "## Why\nBecause.\n",
      toSessionId: "sess-executor", milestoneId: msForBrief,
      next: ["add the token set"], warnings: ["do not touch the parchment baseline"],
    });
    check(!br.isError && br.json && br.json.baton, "brief_create returned a brief", br.text);
    // 1. the file
    const briefFile = path.join(ROAD, "briefs", "dark-mode.md");
    check(fs.existsSync(briefFile), "brief_create wrote <roadRoot>/briefs/<slug>.md", briefFile);
    const briefMd = fs.existsSync(briefFile) ? fs.readFileSync(briefFile, "utf8") : "";
    check(/# Ship dark mode/.test(briefMd) && /Because\./.test(briefMd), "the brief file carries the title + body", briefMd.slice(0, 80));
    // 2. the asset
    const assets = (await cli.call("roadmap_get", { section: "assets" })).json;
    const asset = (assets || []).find((a) => a && a.ref === "briefs/dark-mode.md");
    check(asset && asset.kind === "doc" && asset.milestoneId === msForBrief, "the brief is linked to the milestone as a doc asset", JSON.stringify(asset));
    // 3. the addressed baton with kind "brief"
    const bt = br.json.baton;
    check(bt.kind === "brief" && bt.toSessionId === "sess-executor" && bt.status === "open",
      "the brief was banked as an OPEN baton of kind \"brief\", addressed to the target", JSON.stringify(bt));
    check(bt.docPath === "briefs/dark-mode.md", "the baton points at the brief file", bt.docPath);
    // 4. FRESHEST-BATON BLINDNESS: the brief must NOT shadow the real handoff
    const handoffAfter = (await cli.call("baton_peek", {})).json;
    check(JSON.stringify(handoffAfter) === JSON.stringify(handoffBefore),
      "baton_peek still returns the HANDOFF baton — a brief never shadows it", JSON.stringify(handoffAfter));
    const readBack = await cli.call("baton_read", {});
    check(readBack.json && readBack.json.kind !== "brief", "baton_read also skips briefs", JSON.stringify(readBack.json));
    // 5. path sanitation
    const evil = await cli.call("brief_create", { slug: "../../escape", title: "t", body: "b", toSessionId: "s" });
    check(evil.isError && /E_VALIDATION/.test(evil.text), "brief_create refuses a traversal slug", evil.text);
    const evil2 = await cli.call("brief_create", { slug: "Bad Slug", title: "t", body: "b", toSessionId: "s" });
    check(evil2.isError, "brief_create refuses a slug with spaces/caps", evil2.text);
    // 6. baton_pass gained kind + toSessionId, back-compat intact
    const legacy = await cli.call("baton_pass", { label: "legacy", done: ["x"], next: ["y"] });
    check(!legacy.isError && legacy.json.kind === "handoff", "baton_pass without kind still banks a handoff (back-compat)", legacy.text);
    const kinded = await cli.call("baton_pass", { label: "second brief", done: [], next: ["z"], kind: "brief", toSessionId: "sess-executor" });
    check(!kinded.isError && kinded.json.kind === "brief" && kinded.json.toSessionId === "sess-executor", "baton_pass can bank a brief directly", kinded.text);
    const badKind = await cli.call("baton_pass", { label: "x", done: [], next: [], kind: "whatever" });
    check(badKind.isError, "baton_pass rejects an unknown kind", badKind.text);
    const peekAfterTwo = (await cli.call("baton_peek", {})).json;
    check(peekAfterTwo && peekAfterTwo.label === "legacy", "the freshest HANDOFF is the legacy one — two briefs later, still unshadowed", JSON.stringify(peekAfterTwo));

    // ---- registry hygiene at the MCP server (roadmap_register) ----
    const scratch = path.join(TMP, "a", "scratchpad", "proj");
    fs.mkdirSync(scratch, { recursive: true });
    const regRef = await cli.call("roadmap_register", { dir: scratch });
    check(regRef.isError && /E_VALIDATION/.test(regRef.text), "roadmap_register refuses a \\scratchpad\\ path", regRef.text);
    const regTmp = await cli.call("roadmap_register", { dir: ROAD }); // ROAD is under os.tmpdir()
    check(regTmp.isError && /E_VALIDATION/.test(regTmp.text), "roadmap_register refuses an os.tmpdir() path", regTmp.text);
  } finally {
    cli.close();
  }

  // escape hatch: QUESTLOG_ALLOW_TEMP=1 lets a temp path register
  const cliAllow = mcpClient(ROAD, { QUESTLOG_ALLOW_TEMP: "1" });
  try {
    await cliAllow.send("initialize", {});
    const okReg = await cliAllow.call("roadmap_register", { dir: ROAD });
    check(!okReg.isError && okReg.json && okReg.json.id, "QUESTLOG_ALLOW_TEMP=1 lets a temp path register (escape hatch)", okReg.text);
  } finally {
    cliAllow.close();
  }

  // =========================================================================
  // ITEM-3 (server.mjs): dir-mode auto-register SKIPS a temp path
  // =========================================================================
  const REG2 = path.join(TMP, "reg2", "registry.json");
  fs.mkdirSync(path.dirname(REG2), { recursive: true });
  {
    const port = 4332;
    const env = Object.assign({}, process.env, { QUESTLOG_REGISTRY: REG2 });
    delete env.QUESTLOG_DIR;
    let stderr = "";
    const cp = spawn(process.execPath, [SERVER, "--dir", ROAD, "--port", String(port)], { env, stdio: ["ignore", "ignore", "pipe"] });
    cp.stderr.on("data", (d) => (stderr += d.toString()));
    try {
      await waitUp(`http://127.0.0.1:${port}`);
      // give the listen-callback auto-register a beat to log
      for (let i = 0; i < 40 && !/skipped: temp path|registered/.test(stderr); i++) await new Promise((r) => setTimeout(r, 25));
      check(/skipped: temp path/.test(stderr), "server.mjs dir-mode auto-register SKIPS a temp path (logged)", stderr.trim());
      const reg2 = fs.existsSync(REG2) ? JSON.parse(fs.readFileSync(REG2, "utf8")) : { roadmaps: [] };
      check((reg2.roadmaps || []).length === 0, "temp road was NOT added to the registry", JSON.stringify(reg2.roadmaps || []));
    } finally { cp.kill(); }
  }

  // =========================================================================
  // ITEM-3 (server.mjs): POST /api/registry/unregister — registry only
  // =========================================================================
  {
    // Pre-seed a registry with one entry pointing at a road whose .questlog we
    // will prove is byte-untouched. Hand-written file bypasses the refusal path.
    const REG3dir = path.join(TMP, "reg3"); fs.mkdirSync(REG3dir, { recursive: true });
    const REG3 = path.join(REG3dir, "registry.json");
    const keepRoadData = path.join(ROAD, ".questlog", "roadmap.json");
    fs.writeFileSync(keepRoadData, JSON.stringify({ schemaVersion: 1, project: { name: "Keep" }, quests: [], milestones: [] }, null, 2));
    const beforeBytes = fs.readFileSync(keepRoadData);
    fs.writeFileSync(REG3, JSON.stringify({ schemaVersion: 1, roadmaps: [{ id: "rm-keep", name: "Keep", dir: ROAD, addedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" }] }, null, 2));

    const port = 4333;
    const env = Object.assign({}, process.env, { QUESTLOG_REGISTRY: REG3 });
    delete env.QUESTLOG_DIR; // central mode
    const cp = spawn(process.execPath, [SERVER, "--port", String(port)], { env, stdio: ["ignore", "ignore", "ignore"] });
    const base = `http://127.0.0.1:${port}`;
    try {
      await waitUp(base);
      const unknown = await req(base, "POST", "/api/registry/unregister", { id: "rm-nope" });
      check(unknown.status === 404, "unregister unknown id -> 404", JSON.stringify(unknown));
      const rem = await req(base, "POST", "/api/registry/unregister", { id: "rm-keep" });
      check(rem.status === 200 && rem.json && rem.json.removed && rem.json.removed.id === "rm-keep", "unregister removes the entry and returns it", JSON.stringify(rem));
      const reg3 = JSON.parse(fs.readFileSync(REG3, "utf8"));
      check((reg3.roadmaps || []).length === 0, "registry entry is gone after unregister", JSON.stringify(reg3.roadmaps));
      const afterBytes = fs.readFileSync(keepRoadData);
      check(Buffer.compare(beforeBytes, afterBytes) === 0, "the road's .questlog bytes are UNTOUCHED on disk", "roadmap.json changed!");
    } finally { cp.kill(); }
  }

  // =========================================================================
  // ROSTER (server.mjs): lineage + "N briefs waiting" survive the whitelist map
  // =========================================================================
  {
    const RDIR = path.join(TMP, "roster-road");
    fs.mkdirSync(path.join(RDIR, ".questlog"), { recursive: true });
    const D = (f) => path.join(RDIR, ".questlog", f);
    fs.writeFileSync(D("roadmap.json"), JSON.stringify({ schemaVersion: 1, project: { name: "Lineage Road" }, quests: [], milestones: [], items: [], assets: [] }));
    fs.writeFileSync(D("sessions.json"), JSON.stringify({ schemaVersion: 1, sessions: [
      { id: "sess-parent", label: "parent", firstSeenAt: "2026-07-01T00:00:00.000Z", lastSeenAt: "2026-07-05T00:00:00.000Z", eventCount: 4 },
      { id: "sess-child", label: "branch of parent", parentSessionId: "sess-parent", firstSeenAt: "2026-07-02T00:00:00.000Z", lastSeenAt: "2026-07-04T00:00:00.000Z", eventCount: 2 },
      { id: "sess-grandchild", label: "branch of branch", parentSessionId: "sess-child", firstSeenAt: "2026-07-03T00:00:00.000Z", lastSeenAt: "2026-07-03T00:00:00.000Z", eventCount: 1 },
      { id: "sess-loner", label: "no lineage", firstSeenAt: "2026-07-06T00:00:00.000Z", lastSeenAt: "2026-07-06T00:00:00.000Z", eventCount: 1 },
    ] }));
    // sess-parent banked a BRIEF for sess-loner. A brief must NOT make
    // sess-parent look "completed", and it must show as 1 brief waiting on the
    // target's card.
    fs.writeFileSync(D("batons.json"), JSON.stringify({ schemaVersion: 1, batons: [
      { id: "baton-b1", ts: "2026-07-07T00:00:00.000Z", kind: "brief", fromSessionId: "sess-parent", toSessionId: "sess-loner", label: "a brief", done: [], inFlight: [], next: [], warnings: [], docPath: "briefs/x.md", status: "open" },
      { id: "baton-b2", ts: "2026-07-07T01:00:00.000Z", kind: "brief", fromSessionId: "sess-child", toSessionId: "sess-loner", label: "another brief", done: [], inFlight: [], next: [], warnings: [], docPath: "briefs/y.md", status: "open" },
    ] }));
    const REG4dir = path.join(TMP, "reg4"); fs.mkdirSync(REG4dir, { recursive: true });
    const REG4 = path.join(REG4dir, "registry.json");
    fs.writeFileSync(REG4, JSON.stringify({ schemaVersion: 1, roadmaps: [{ id: "rm-lineage", name: "Lineage Road", dir: RDIR, addedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" }] }));

    const port = 4334;
    const env = Object.assign({}, process.env, { QUESTLOG_REGISTRY: REG4 });
    delete env.QUESTLOG_DIR; // central mode: /api/sessions is central-only
    const cp = spawn(process.execPath, [SERVER, "--port", String(port)], { env, stdio: ["ignore", "ignore", "ignore"] });
    const base = `http://127.0.0.1:${port}`;
    try {
      await waitUp(base);
      const r = await req(base, "GET", "/api/sessions");
      check(r.status === 200, "GET /api/sessions 200", JSON.stringify(r).slice(0, 200));
      const ss = ((r.json.projects || [])[0] || {}).sessions || [];
      const by = Object.fromEntries(ss.map((s) => [s.id, s]));
      // the whitelist-mapped output keeps the new fields
      check(by["sess-child"] && by["sess-child"].parentSessionId === "sess-parent",
        "parentSessionId survives the roster's whitelist mapping", JSON.stringify(by["sess-child"]));
      check(by["sess-loner"] && by["sess-loner"].briefsWaiting === 2,
        "the target card reports 2 briefs waiting", JSON.stringify(by["sess-loner"]));
      check(by["sess-parent"] && by["sess-parent"].briefsWaiting === 0, "a session with no incoming brief reports 0");
      // lineage: children immediately follow their parent, indented by depth
      const order = ss.map((s) => s.id);
      check(order.indexOf("sess-child") === order.indexOf("sess-parent") + 1, "child renders directly under its parent", order.join(","));
      check(order.indexOf("sess-grandchild") === order.indexOf("sess-child") + 1, "grandchild renders under the child", order.join(","));
      check(by["sess-parent"].depth === 0 && by["sess-child"].depth === 1 && by["sess-grandchild"].depth === 2,
        "depth drives the indent (0/1/2)", order.join(","));
      check(by["sess-loner"].depth === 0, "an unbranched session stays at top level");
      // BRIEFS ARE INVISIBLE TO STATUS: sess-parent banked only a brief, so it
      // must NOT be derived "completed" (which is what an open handoff means).
      check(by["sess-parent"].status !== "completed" && by["sess-parent"].status !== "superseded",
        "an addressed brief does NOT flip its author to completed/superseded", by["sess-parent"].status);
      check(by["sess-parent"].batonId === null, "a brief is not reported as the session's baton", String(by["sess-parent"].batonId));
    } finally { cp.kill(); }
  }

  // =========================================================================
  // REACH LAYER (scorecard battery-A remediation) — HARNESS-1/2/3/5 + CONTEXT-1
  // A two-road temp registry: road A is the server's --dir, road B is only
  // reachable through the registry. QUESTLOG_ALLOW_TEMP=1 lets temp paths in.
  // =========================================================================
  {
    const RA = path.join(TMP, "reach-a");
    const RB = path.join(TMP, "reach-b");
    fs.mkdirSync(path.join(RA, ".questlog"), { recursive: true });
    fs.mkdirSync(path.join(RB, ".questlog"), { recursive: true });
    const DA = (f) => path.join(RA, ".questlog", f);
    const DB = (f) => path.join(RB, ".questlog", f);

    fs.writeFileSync(DA("roadmap.json"), JSON.stringify({
      schemaVersion: 1, project: { name: "Road A", tagline: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" },
      quests: [{ id: "q-main", type: "main", title: "Main", parentMilestoneId: null, side: null, order: 0, status: "in_progress" }],
      milestones: [
        { id: "ms-a1", questId: "q-main", title: "A one", status: "done", order: 0 },
        { id: "ms-a2", questId: "q-main", title: "A two", status: "in_progress", order: 1 },
      ], items: [], assets: [],
    }, null, 2));
    fs.writeFileSync(DB("roadmap.json"), JSON.stringify({
      schemaVersion: 1, project: { name: "Road B", tagline: "the child road", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-07-09T12:00:00.000Z" },
      quests: [{ id: "q-main", type: "main", title: "Main", parentMilestoneId: null, side: null, order: 0, status: "in_progress" }],
      milestones: [
        { id: "ms-b1", questId: "q-main", title: "B one", status: "done", order: 0 },
        { id: "ms-b2", questId: "q-main", title: "B two", status: "done", order: 1 },
        { id: "ms-b3", questId: "q-main", title: "B three", status: "blocked", order: 2, statusReason: "waiting" },
        { id: "ms-b4", questId: "q-main", title: "B four", status: "available", order: 3 },
        { id: "ms-b5", questId: "q-main", title: "B five", status: "locked", order: 4 },
      ], items: [], assets: [],
    }, null, 2));
    fs.writeFileSync(DB("batons.json"), JSON.stringify({ schemaVersion: 1, batons: [
      { id: "baton-bb", ts: "2026-07-08T00:00:00.000Z", kind: "handoff", label: "B handoff", done: [], inFlight: [], next: [], warnings: [], status: "open" },
    ] }));
    // Road B has a founder-flagged unclear card too.
    {
      const rmb = JSON.parse(fs.readFileSync(DB("roadmap.json"), "utf8"));
      rmb.milestones[2].unclear = true;
      rmb.milestones[2].unclearAt = "2026-07-08T09:00:00.000Z";
      fs.writeFileSync(DB("roadmap.json"), JSON.stringify(rmb, null, 2));
    }

    // ---- 60 seeded history events on road A, with ONE ts inversion ----------
    // Deliberately written OUT of ts order at one position: history.jsonl is
    // append-ordered, not time-ordered (dec-time-ordering).
    const seeded = [];
    for (let i = 0; i < 60; i++) {
      const mm = String(i).padStart(2, "0");
      seeded.push({
        id: `evt-seed-${mm}`, ts: `2026-06-01T00:${mm}:00.000Z`,
        actor: i % 3 === 0 ? "founder" : "agent", source: "mcp",
        action: i % 2 === 0 ? "milestone_upsert" : "item_upsert",
        targetId: null, summary: `seed ${i}`, sessionId: i < 15 ? "sess-derived" : "sess-other",
      });
    }
    // The inversion: swap the file position of two events so line order != ts order.
    const wire = seeded.slice();
    const tmpEvt = wire[10]; wire[10] = wire[40]; wire[40] = tmpEvt;
    fs.writeFileSync(DA("history.jsonl"), wire.map((e) => JSON.stringify(e)).join("\n") + "\n");
    check(JSON.parse(fs.readFileSync(DA("history.jsonl"), "utf8").split("\n")[10]).ts >
          JSON.parse(fs.readFileSync(DA("history.jsonl"), "utf8").split("\n")[11]).ts,
      "the seeded history file is provably NOT in ts order (dec-time-ordering)");
    // sessions.json UNDER-records: stored eventCount 1 vs 15 real stamped events.
    fs.writeFileSync(DA("sessions.json"), JSON.stringify({ schemaVersion: 1, sessions: [
      { id: "sess-derived", label: "undercounted", firstSeenAt: "2026-06-01T00:00:00.000Z", lastSeenAt: "2026-06-01T00:14:00.000Z", eventCount: 1 },
    ] }, null, 2));

    const REGR = path.join(TMP, "reg-reach", "registry.json");
    fs.mkdirSync(path.dirname(REGR), { recursive: true });
    fs.writeFileSync(REGR, JSON.stringify({ schemaVersion: 1, roadmaps: [
      { id: "rm-reach-a", name: "Road A", dir: RA, addedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-06-01T00:00:00.000Z" },
      { id: "rm-reach-b", name: "Road B", dir: RB, addedAt: "2026-02-01T00:00:00.000Z", lastSeenAt: "2026-07-09T00:00:00.000Z", origin: { roadmapId: "rm-reach-a", milestoneId: "ms-a2", ts: "2026-02-01T00:00:00.000Z" } },
    ] }, null, 2));

    // A server bound to ROAD A ONLY.
    const env = Object.assign({}, process.env, { QUESTLOG_REGISTRY: REGR, QUESTLOG_ALLOW_TEMP: "1" });
    delete env.QUESTLOG_DIR;
    const cp = spawn(process.execPath, [MCP, "--dir", RA], { env, stdio: ["pipe", "pipe", "pipe"] });
    cp.stderr.on("data", () => {});
    let buf = ""; const pending = new Map(); let idc = 1;
    cp.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      }
    });
    const send = (method, params) => new Promise((res) => {
      const id = idc++; pending.set(id, res);
      cp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
    });
    const call = async (name, argsv) => {
      const r = await send("tools/call", { name, arguments: argsv || {} });
      const c = r.result && r.result.content && r.result.content[0];
      const text = c ? c.text : "";
      let json = null; try { json = JSON.parse(text); } catch {}
      return { isError: !!(r.result && r.result.isError), text, json };
    };

    try {
      const init = await send("initialize", {});
      // The version is read out of mcp/server.mjs rather than pinned here: a
      // pinned number goes stale the moment the server is bumped, and a stale
      // selftest is worse than none. What is asserted is that the handshake
      // reports the version the source declares.
      const SRC_VERSION = (fs.readFileSync(path.join(REPO, "mcp", "server.mjs"), "utf8")
        .match(/SERVER_INFO = \{ name: "questlog", version: "([^"]+)"/) || [])[1];
      check(!!SRC_VERSION, "mcp/server.mjs declares a SERVER_INFO version", String(SRC_VERSION));
      check(init.result && init.result.serverInfo && init.result.serverInfo.version === SRC_VERSION,
        `MCP SERVER_INFO is ${SRC_VERSION}, the version mcp/server.mjs declares`, JSON.stringify(init.result && init.result.serverInfo));
      const tools = (await send("tools/list", {})).result.tools.map((t) => t.name);
      check(tools.includes("roadmap_list") && tools.includes("history_tail"),
        "tools/list advertises roadmap_list + history_tail", tools.join(","));
      check(!tools.includes("registry_get"), "there is exactly ONE registry read name (no registry_get)");

      // ---- HARNESS-2: roadmap_list is a READ. Registry bytes must not change --
      const regBefore = fs.readFileSync(REGR);
      const list = await call("roadmap_list", {});
      check(!list.isError && list.json && list.json.roadmaps.length === 2,
        "roadmap_list returns BOTH registered roads", list.text.slice(0, 200));
      const regAfter = fs.readFileSync(REGR);
      check(Buffer.compare(regBefore, regAfter) === 0,
        "the registry file is BYTE-IDENTICAL after roadmap_list (no upsert, no lock, no write)");
      check(list.json.currentRoadmapId === "rm-reach-a",
        "roadmap_list names the server's own road as currentRoadmapId", String(list.json.currentRoadmapId));
      const rowB = list.json.roadmaps.find((r) => r.id === "rm-reach-b");
      check(rowB && rowB.isCurrent === false && rowB.missing === false, "the other road is present, not current, not missing", JSON.stringify(rowB));
      check(rowB && rowB.progress.done === 2 && rowB.progress.total === 5, "roadmap_list carries road B's progress (2/5)", JSON.stringify(rowB && rowB.progress));
      check(rowB && rowB.statusBreakdown.done === 2 && rowB.statusBreakdown.blocked === 1 &&
            rowB.statusBreakdown.available === 1 && rowB.statusBreakdown.locked === 1 && rowB.statusBreakdown.in_progress === 0,
        "roadmap_list carries road B's full status breakdown", JSON.stringify(rowB && rowB.statusBreakdown));
      check(rowB && rowB.asOf === "2026-07-09T12:00:00.000Z", "roadmap_list stamps asOf from the child's project.updatedAt", String(rowB && rowB.asOf));
      check(rowB && rowB.origin && rowB.origin.milestoneId === "ms-a2", "roadmap_list echoes the origin edge (the portal)", JSON.stringify(rowB && rowB.origin));
      // A missing/unregistered road dir is reported, never thrown.
      check(list.json.roadmaps.every((r) => typeof r.dir === "string" && r.dir), "every row names its folder");

      // ---- HARNESS-1: cross-road READ through the portal --------------------
      const bProj = await call("roadmap_get", { section: "project", roadmapId: "rm-reach-b" });
      check(!bProj.isError && bProj.json && bProj.json.name === "Road B",
        "roadmap_get{roadmapId} reads ROAD B through a ROAD A server (the portal is now a tool call)", bProj.text);
      const bMs = await call("roadmap_get", { section: "milestones", roadmapId: "rm-reach-b" });
      check(bMs.json.length === 5 && bMs.json[0].id === "ms-b1", "cross-road milestones come from road B", String(bMs.json.length));
      const aMs = await call("roadmap_get", { section: "milestones" });
      check(aMs.json.length === 2, "omitting roadmapId still reads the server's OWN road (no behaviour change)", String(aMs.json.length));
      const bUnclear = await call("list_unclear", { roadmapId: "rm-reach-b" });
      check(!bUnclear.isError && bUnclear.json.count === 1 && bUnclear.json.unclear[0].id === "ms-b3",
        "list_unclear{roadmapId} reads road B's unclear queue", bUnclear.text.slice(0, 160));
      const bBaton = await call("baton_peek", { roadmapId: "rm-reach-b" });
      check(!bBaton.isError && bBaton.json && bBaton.json.label === "B handoff", "baton_peek{roadmapId} peeks road B's baton", bBaton.text.slice(0, 160));
      const unknown = await call("roadmap_get", { section: "project", roadmapId: "rm-x" });
      check(unknown.isError && /E_NOT_FOUND/.test(unknown.text) && /rm-x/.test(unknown.text),
        "an unknown roadmapId is E_NOT_FOUND (never an upsert)", unknown.text);
      const badId = await call("roadmap_get", { section: "project", roadmapId: "NOT AN ID" });
      check(badId.isError && /E_VALIDATION/.test(badId.text), "a malformed roadmapId is E_VALIDATION", badId.text);
      const regAfterReads = fs.readFileSync(REGR);
      check(Buffer.compare(regBefore, regAfterReads) === 0, "the registry is STILL byte-identical after every cross-road read");
      // ---- HARNESS-3: history_tail --------------------------------------
      const h = await call("history_tail", {});
      check(!h.isError && h.json.totalEvents === 60, "history_tail reports totalEvents 60 (the WHOLE file)", h.text.slice(0, 200));
      check(h.json.returned === 50 && h.json.truncated === true,
        "default limit 50 over 60 events => returned 50, truncated TRUE", `${h.json.returned}/${h.json.truncated}`);
      check(h.json.oldestReachable === "2026-06-01T00:00:00.000Z", "oldestReachable is the oldest event in the whole file", String(h.json.oldestReachable));
      const tsList = h.json.events.map((e) => e.ts);
      check(tsList.every((t, i) => i === 0 || tsList[i - 1] <= t), "the window is sorted by ts ASCENDING despite the file inversion");
      check(h.json.events[0].ts === "2026-06-01T00:10:00.000Z" && h.json.events[49].ts === "2026-06-01T00:59:00.000Z",
        "the window is the newest 50 BY TIMESTAMP (00:10..00:59), not the last 50 lines", tsList[0] + ".." + tsList[49]);
      check(h.json.window.from === h.json.events[0].ts && h.json.window.to === h.json.events[49].ts, "window.from/to bound the returned events");
      const h20 = await call("history_tail", { limit: 20 });
      check(h20.json.returned === 20 && h20.json.truncated === true && h20.json.totalEvents === 60, "limit 20 => 20 returned, still truncated");
      // page backwards with `before` until oldestReachable is reached
      let cursor = h.json.window.from, seenOldest = false, pages = 0;
      while (pages < 10) {
        const pg = await call("history_tail", { limit: 50, before: cursor });
        pages++;
        if (pg.json.returned === 0) break;
        check(pg.json.events.every((e) => e.ts < cursor), `page ${pages}: every event is strictly before the cursor`);
        if (pg.json.events[0].ts === pg.json.oldestReachable) seenOldest = true;
        if (!pg.json.truncated) break;
        cursor = pg.json.window.from;
      }
      check(seenOldest, "`before` pagination reaches oldestReachable", `pages=${pages}`);
      const pgEnd = await call("history_tail", { limit: 50, before: "2026-06-01T00:00:00.000Z" });
      check(pgEnd.json.returned === 0 && pgEnd.json.truncated === false && pgEnd.json.totalEvents === 60,
        "paging past the oldest event returns an EMPTY, non-truncated window that still reports totalEvents 60", pgEnd.text.slice(0, 160));
      const agg = await call("history_tail", { mode: "aggregate" });
      check(agg.json.totalEvents === 60 && agg.json.events === undefined, "aggregate mode covers the whole file and returns no event list");
      check(agg.json.byActor.founder === 20 && agg.json.byActor.agent === 40, "aggregate byActor is exact (20 founder / 40 agent)", JSON.stringify(agg.json.byActor));
      check(agg.json.byAction.milestone_upsert === 30 && agg.json.byAction.item_upsert === 30, "aggregate byAction is exact (30/30)", JSON.stringify(agg.json.byAction));
      check(agg.json.bySession["sess-derived"] === 15 && agg.json.bySession["sess-other"] === 45, "aggregate bySession is exact (15/45)", JSON.stringify(agg.json.bySession));
      check(agg.json.firstTs === "2026-06-01T00:00:00.000Z" && agg.json.lastTs === "2026-06-01T00:59:00.000Z", "aggregate firstTs/lastTs come from ts order, not file order");
      const aggLimit = await call("history_tail", { mode: "aggregate", limit: 3 });
      check(aggLimit.json.totalEvents === 60, "aggregate mode IGNORES limit");
      check((await call("history_tail", { limit: 0 })).isError, "limit 0 is rejected");
      check((await call("history_tail", { limit: 501 })).isError, "limit 501 is rejected");
      check((await call("history_tail", { mode: "sideways" })).isError, "an unknown mode is rejected");
      check((await call("history_tail", { before: "not-a-date" })).isError, "a non-ISO `before` is rejected");
      const hB = await call("history_tail", { roadmapId: "rm-reach-b" });
      check(!hB.isError && hB.json.totalEvents === 0, "history_tail{roadmapId} reads road B (which has no history yet)", hB.text.slice(0, 120));
      // BACK-COMPAT: the legacy slice is still a bare array, now ts-sorted.
      const legacy = await call("roadmap_get", { section: "history_tail" });
      check(Array.isArray(legacy.json), "roadmap_get section=history_tail is STILL a bare array (back-compat)", typeof legacy.json);
      const lts = legacy.json.map((e) => e.ts);
      check(lts.every((t, i) => i === 0 || lts[i - 1] <= t), "the legacy slice is ts-sorted too");

      // ---- HARNESS-5: derived eventCount ------------------------------------
      const sess = await call("roadmap_get", { section: "sessions" });
      const sd = sess.json.find((s) => s.id === "sess-derived");
      check(sd && sd.eventCount === 15, "sessions serves a DERIVED eventCount (15 real stamped events)", JSON.stringify(sd));
      check(sd && sd.storedEventCount === 1, "the stored (undercounting) value is kept as storedEventCount", JSON.stringify(sd));
      const onDisk = JSON.parse(fs.readFileSync(DA("sessions.json"), "utf8"));
      check(onDisk.sessions[0].eventCount === 1 && onDisk.sessions[0].storedEventCount === undefined,
        "the DISK shape is unchanged — deriving is a read-time overlay, never a write", JSON.stringify(onDisk.sessions[0]));

      // ---- CONSENT INVARIANT: no WRITE tool takes roadmapId (runs LAST, it
      // mutates road A's roadmap.json + history). An unexpected key is simply
      // not in the schema: extra keys were already ignored, so nothing breaks —
      // and the write lands on the --dir road, never on the named one.
      const wrote = await call("milestone_upsert", { questId: "q-main", title: "should land on A", roadmapId: "rm-reach-b" });
      check(!wrote.isError, "a write tool ignores an unexpected roadmapId key (no back-compat break)", wrote.text.slice(0, 120));
      const bAfterWrite = JSON.parse(fs.readFileSync(DB("roadmap.json"), "utf8"));
      check(bAfterWrite.milestones.length === 5, "the write landed on road A, NEVER on road B — cross-road reach is READ-only", String(bAfterWrite.milestones.length));
      const aAfterWrite = JSON.parse(fs.readFileSync(DA("roadmap.json"), "utf8"));
      check(aAfterWrite.milestones.length === 3, "road A (the --dir road) is where the write actually landed", String(aAfterWrite.milestones.length));
    } finally { cp.kill(); }

    // ---- CONTEXT-1: the central server stamps portal roll-ups ---------------
    {
      const port = 4331;
      const senv = Object.assign({}, process.env, { QUESTLOG_REGISTRY: REGR, QUESTLOG_ALLOW_TEMP: "1" });
      delete senv.QUESTLOG_DIR; // central mode
      const sp = spawn(process.execPath, [SERVER, "--port", String(port)], { env: senv, stdio: ["ignore", "ignore", "ignore"] });
      const base = `http://127.0.0.1:${port}`;
      try {
        await waitUp(base);
        const st = await req(base, "GET", "/api/r/rm-reach-a/state");
        check(st.status === 200, "GET /api/r/rm-reach-a/state 200", JSON.stringify(st).slice(0, 160));
        const portal = (st.json.portals || [])[0];
        const childDisk = JSON.parse(fs.readFileSync(DB("roadmap.json"), "utf8"));
        const expect = { done: 2, in_progress: 0, available: 1, locked: 1, blocked: 1 };
        check(portal && JSON.stringify(portal.statusBreakdown) === JSON.stringify(expect),
          "the portal carries a statusBreakdown matching the CHILD FILE on disk", JSON.stringify(portal && portal.statusBreakdown));
        check(portal && portal.asOf === childDisk.project.updatedAt,
          "the portal carries asOf = the child's project.updatedAt", String(portal && portal.asOf));
        check(portal && portal.sourceRoadId === "rm-reach-b", "the portal names its source road", String(portal && portal.sourceRoadId));
        check(portal && portal.milestoneId === "ms-a2" && portal.milestoneMissing === false, "the portal still points at the parent's doorway milestone");
        const kid = ((st.json.lineage || {}).children || [])[0];
        check(kid && JSON.stringify(kid.statusBreakdown) === JSON.stringify(expect) && kid.asOf === childDisk.project.updatedAt && kid.sourceRoadId === "rm-reach-b",
          "lineage.children carry the same stamped roll-up", JSON.stringify(kid));
        // HARNESS-5 across the HTTP surface: roster + state + fullStory.
        const ros = await req(base, "GET", "/api/sessions");
        const proj = (ros.json.projects || []).find((p) => p.roadmapId === "rm-reach-a");
        const rs = proj && proj.sessions.find((s) => s.id === "sess-derived");
        check(rs && rs.eventCount === 15 && rs.storedEventCount === 1, "the roster serves the DERIVED eventCount (15, stored 1)", JSON.stringify(rs));
        const ss = ((st.json.sessions || {}).sessions || []).find((s) => s.id === "sess-derived");
        check(ss && ss.eventCount === 15 && ss.storedEventCount === 1, "/state sessions serve the derived count too", JSON.stringify(ss));
        const fs1 = (st.json.fullStory.sessions || []).find((s) => s.id === "sess-derived");
        check(fs1 && fs1.eventCount === 15, "fullStory aggregates DERIVED per-road counts", JSON.stringify(fs1));
        const diskAfter = JSON.parse(fs.readFileSync(DA("sessions.json"), "utf8"));
        check(diskAfter.sessions[0].eventCount === 1, "serving derived counts never wrote them back to disk");
      } finally { sp.kill(); }
    }
  }

  console.log(`\nbatch-2 selftest: ${pass} passed, ${fail} failed`);
  // cleanup best-effort
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
