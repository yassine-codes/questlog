#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TEXT ENCODING — the sweep, and the guard that stops it coming back.
//
// This class of bug has bitten three times. Each time the fix was a one-line
// header and each time nothing stopped the NEXT reply shipping without one.
// So this file is not a report on today's code — it is the lock:
//   A1 headers      — EVERY res.writeHead( on EVERY server surface (found by
//                     scanning the source, not by a list someone maintains)
//                     declares charset=utf-8. A new reply with a bare
//                     Content-Type fails this test by file and line.
//   A2 pages        — every shipped .html declares <meta charset="utf-8">
//                     inside its first 1024 bytes (the HTML spec's pre-scan
//                     window: past that, the browser has already guessed).
//   A3 no NUL       — no shipped source holds a raw zero byte. That is the
//                     lock on the impossible-separator fix: the escapes must
//                     stay escapes, or git calls the file binary again.
//   B  dir mode     — a real server on a real (copied) road: every reply's
//                     Content-Type carries the charset, the index carries the
//                     meta tag, and a note of café / 日本語 / emoji survives
//                     the API and the disk byte for byte.
//   C  central mode — the overworld and the id-scoped API, same assertion.
//   D  MCP          — the stdio tool path round-trips the same alphabets.
//
// Selftests are excluded from the header scan: a fake `res` in a test double is
// not a response surface.
//
// TEMP EVERYTHING: temp HOME (QUESTLOG_REGISTRY), a temp copy of the demo seed
// at seeds/sample-project, two random high ports. A live :4177 and the real
// .questlog dirs are never touched — the repo's own .questlog is not even read.
//
// Usage: node encoding.selftest.mjs [--verbose]
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes("--verbose");
// NEVER 4177 — that port belongs to the founder's live server and this test
// does not so much as knock on it. Two ports: one per mode.
const randomPort = () => 45000 + Math.floor(Math.random() * 4000);
const PORT = Number(process.env.QL_TEST_PORT || randomPort());

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail){
  if(cond){ pass++; if(VERBOSE) console.log("  ok   " + name); }
  else { fail++; failures.push(name + (detail ? " — " + detail : "")); console.log("  FAIL " + name + (detail ? " — " + detail : "")); }
}

// The one pattern the whole file turns on. Case-insensitive because a header is.
const CHARSET = /charset=utf-8/i;
// The HTML pre-scan tag, tolerant of quote style — the shipped pages both write
// it exactly as <meta charset="utf-8">, but a single-quoted one is just as valid.
const META = /<meta\s+charset=["']?utf-8["']?/i;

// ---------------------------------------------------------------------------
// Source discovery — walk the repo once. The skip list is the harness scratch,
// the build output, and the two dirs retired by founder ruling (desktop/,
// dist-desktop/). .questlog is skipped ONLY at the repo root: that is the
// founder's live road data. The demo seed's seeds/sample-project/.questlog IS
// shipped fixture data and is scanned like any other source.
// ---------------------------------------------------------------------------
const SKIP_DIRS = new Set([
  ".git", "desktop", "dist-desktop", "node_modules", "output", "_verify",
  ".playwright-cli", "distillery-drafts", ".remember", ".claude",
]);
function walk(dir, out = []){
  for(const e of fs.readdirSync(dir, { withFileTypes: true })){
    const full = path.join(dir, e.name);
    const rel = path.relative(HERE, full).split(path.sep).join("/");
    if(e.isDirectory()){
      if(SKIP_DIRS.has(e.name) || e.name.startsWith("_drill") || rel === ".questlog") continue;
      walk(full, out);
    } else out.push(rel);
  }
  return out;
}
const SHIPPED = walk(HERE);
const readSrc = (rel) => fs.readFileSync(path.join(HERE, rel), "utf8");

// A response surface: any .mjs that is not a selftest.
const SURFACES = SHIPPED.filter(f => f.endsWith(".mjs"))
  .filter(f => !path.basename(f).endsWith("selftest.mjs"));

// Every `res.writeHead(` / `rq.writeHead(` in a source, with the whole call —
// scan forward from the open paren counting parens, so the multi-line header
// object literal comes along. A source that somehow refuses to balance falls
// back to the next 10 lines, which is longer than any header block here.
function writeHeadSites(src){
  const sites = [];
  const re = /\b(?:res|rq)\.writeHead\(/g;
  let m;
  while((m = re.exec(src)) !== null){
    const open = m.index + m[0].length - 1;
    let depth = 0, end = -1;
    for(let i = open; i < src.length; i++){
      if(src[i] === "(") depth++;
      else if(src[i] === ")"){ depth--; if(depth === 0){ end = i; break; } }
    }
    sites.push({
      line: src.slice(0, m.index).split("\n").length,
      text: end >= 0 ? src.slice(m.index, end + 1)
                     : src.slice(m.index).split("\n").slice(0, 10).join("\n"),
    });
  }
  return sites;
}

// ---------------------------------------------------------------------------
// temp workspace
// ---------------------------------------------------------------------------
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "ql-enc-"));
const HOME = path.join(WORK, "home");
const REGISTRY = path.join(HOME, "registry.json");
const ROAD = path.join(WORK, "road");
fs.mkdirSync(HOME, { recursive: true });
const ENV = Object.assign({}, process.env, {
  QUESTLOG_REGISTRY: REGISTRY,       // the founder's overworld is never written
  QUESTLOG_ALLOW_TEMP: "1",          // the temp-path guard's documented escape hatch
});
delete ENV.QUESTLOG_DIR;             // the mode comes from argv, never the env
delete ENV.QUESTLOG_BTW_BRIDGE;      // a note must not wake the bridge here

function copyDir(src, dst){
  fs.mkdirSync(dst, { recursive: true });
  for(const e of fs.readdirSync(src, { withFileTypes: true })){
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if(e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}
function writeJson(f, v){ fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2), "utf8"); }
copyDir(path.join(HERE, "seeds", "sample-project"), ROAD);
const ROADMAP_FILE = path.join(ROAD, ".questlog", "roadmap.json");

// ---------------------------------------------------------------------------
// MCP driver — one short-lived stdio server per call (real tool path).
// ---------------------------------------------------------------------------
function mcpCall(dir, name, args){
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, "mcp", "server.mjs"), "--dir", dir],
                    { env: ENV, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (b) => { out += b.toString(); });
    p.on("close", () => {
      let result = null;
      for(const line of out.split("\n")){
        const t = line.trim(); if(!t) continue;
        let m; try { m = JSON.parse(t); } catch { continue; }
        if(m.id === 2) result = m;
      }
      if(!result) return resolve({ error: "no response", raw: out });
      const r = result.result || {};
      const text = (r.content && r.content[0] && r.content[0].text) || "";
      if(r.isError) return resolve({ error: text });
      let value = null; try { value = JSON.parse(text); } catch { value = text; }
      resolve({ value });
    });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) + "\n");
    p.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// HTTP servers — spawned here, killed here, nothing else on the box is touched.
// The boot banner is not a contract (features.selftest resolves on a timer too),
// so a port is proved live by a real GET. A collision on a random high port is
// retried exactly once, on a fresh port.
// ---------------------------------------------------------------------------
const SERVERS = [];
function spawnServer(args, port){
  return new Promise((resolve) => {
    const env = Object.assign({}, ENV, { QUESTLOG_PORT: String(port) });
    const p = spawn(process.execPath, [path.join(HERE, "server.mjs"), ...args], { env, cwd: WORK, stdio: ["ignore", "pipe", "pipe"] });
    SERVERS.push(p);
    let buf = "";
    const onData = (b) => { buf += b.toString(); if(/listening|http:\/\/127\.0\.0\.1/i.test(buf)) resolve(p); };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("error", () => resolve(p));
    setTimeout(() => resolve(p), 2500);
  });
}
async function alive(port){
  try { const r = await fetch("http://127.0.0.1:" + port + "/api/mode"); await r.text(); return r.status === 200; }
  catch { return false; }
}
async function startServer(argsFor, firstPort){
  for(let attempt = 0; attempt < 2; attempt++){
    const port = attempt === 0 ? firstPort : randomPort();
    const p = await spawnServer(argsFor(port), port);
    if(await alive(port)) return port;
    try { p.kill(); } catch { /* already gone */ }
  }
  return 0;
}
function stopServers(){
  for(const p of SERVERS){ if(p && !p.killed){ try { p.kill(); } catch { /* already gone */ } } }
  SERVERS.length = 0;
}
async function get(port, p){
  const r = await fetch("http://127.0.0.1:" + port + p);
  const text = await r.text();
  return { status: r.status, ctype: r.headers.get("content-type") || "", text };
}
async function post(port, p, rawBody){
  const r = await fetch("http://127.0.0.1:" + port + p, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: rawBody,
  });
  const text = await r.text();
  return { status: r.status, ctype: r.headers.get("content-type") || "", text };
}
// Headers only, then hang up — for a stream that would otherwise never end.
async function headersOf(port, p){
  const r = await fetch("http://127.0.0.1:" + port + p);
  const out = { status: r.status, ctype: r.headers.get("content-type") || "" };
  try { if(r.body) await r.body.cancel(); } catch { /* already closed */ }
  return out;
}

// ===========================================================================
async function main(){

// ---------------------------------------------------------------------------
// A1 — every response header, found by reading the source
// ---------------------------------------------------------------------------
console.log("\n== A1: every writeHead on every server surface declares utf-8 ==");
{
  let total = 0;
  for(const f of SURFACES){
    for(const s of writeHeadSites(readSrc(f))){
      total++;
      ok("charset on " + f + ":" + s.line, CHARSET.test(s.text),
         s.text.split("\n")[0].trim());
    }
  }
  // The scan proving it can still SEE the sites matters as much as the sites
  // passing: a regex that quietly matches nothing would be a green light on an
  // empty room. Today there are 5 (server.mjs 3, chat.mjs 2).
  ok("the scan found the response surfaces at all", total >= 5, "found " + total);
}

// ---------------------------------------------------------------------------
// A2 — every shipped page declares its charset in the pre-scan window
// ---------------------------------------------------------------------------
console.log("\n== A2: every shipped page declares its charset in the first 1024 bytes ==");
{
  const pages = SHIPPED.filter(f => f.endsWith(".html"));
  ok("there are pages to check", pages.length >= 1, "found " + pages.length);
  for(const f of pages){
    const head = fs.readFileSync(path.join(HERE, f)).subarray(0, 1024).toString("utf8");
    ok("meta charset in the first 1024 bytes of " + f, META.test(head));
  }
}

// ---------------------------------------------------------------------------
// A3 — no shipped source holds a raw zero byte (the lock on the escapes)
// ---------------------------------------------------------------------------
console.log("\n== A3: no raw NUL byte in any shipped source ==");
{
  const sources = SHIPPED.filter(f => /\.(mjs|json|jsonl|html)$/.test(f));
  ok("there are sources to check", sources.length >= 20, "found " + sources.length);
  for(const f of sources){
    const buf = fs.readFileSync(path.join(HERE, f));
    ok("no raw NUL in " + f, !buf.includes(0),
       "first at byte " + buf.indexOf(0));
  }
}

// ---------------------------------------------------------------------------
// B — dir mode, live: every reply, and a real round trip through the alphabets
// ---------------------------------------------------------------------------
console.log("\n== B: dir mode — every reply declares utf-8 ==");
const dirPort = await startServer((port) => ["--dir", ROAD, "--port", String(port)], PORT);
ok("the dir-mode server came up", dirPort > 0);
if(dirPort > 0){
  for(const p of ["/", "/index.html", "/api/state", "/api/mode", "/api/version", "/api/config",
                  "/api/skins", "/api/taskboard", "/api/raids", "/api/chats", "/api/chat/nope",
                  "/api/chat/nope/stream", "/api/archaeology/x/ms-x", "/definitely-not"]){
    const r = await get(dirPort, p);
    ok("GET " + p + " declares utf-8", CHARSET.test(r.ctype), r.status + " " + (r.ctype || "(no content-type)"));
  }
  ok("GET /definitely-not is a 404 that still declares utf-8", (await get(dirPort, "/definitely-not")).status === 404);

  const idx = await get(dirPort, "/");
  ok("the served index carries the meta charset in its first 1024 bytes", META.test(idx.text.slice(0, 1024)));

  const bad = await post(dirPort, "/api/note", "{not json");
  ok("POST /api/note with a broken body is a 400 that declares utf-8",
     bad.status === 400 && CHARSET.test(bad.ctype), bad.status + " " + bad.ctype);
  const empty = await post(dirPort, "/api/note", "{}");
  ok("POST /api/note with an empty body is a 400 that declares utf-8",
     empty.status === 400 && CHARSET.test(empty.ctype), empty.status + " " + empty.ctype);

  // The SSE header, live. The dashboard's chat dock opens this with an
  // EventSource; `; charset=utf-8` is spec-legal on text/event-stream and the
  // browsers accept it — but the point is that the beats are utf-8 and now the
  // reply says so instead of leaving the client to guess.
  const made = await post(dirPort, "/api/chats", JSON.stringify({ profile: "observer" }));
  ok("a chat can be opened to test the stream header", made.status === 200, made.status + " " + made.text.slice(0, 120));
  if(made.status === 200){
    const chatId = JSON.parse(made.text).chat.id;
    const sse = await headersOf(dirPort, "/api/chat/" + chatId + "/stream");
    ok("the live event stream declares utf-8", sse.status === 200 && CHARSET.test(sse.ctype), sse.status + " " + sse.ctype);
    ok("...and is still an event stream", /text\/event-stream/i.test(sse.ctype), sse.ctype);
  }

  // Round trip: four alphabets, an accent, a dash and an emoji, through the
  // API, onto the disk, and back out again — unchanged at every step.
  const UNICODE = "café ✓ — 日本語 🙂";
  const before = JSON.parse((await get(dirPort, "/api/state")).text);
  const target = (before.roadmap.items || [])[0];
  ok("the seed road has an item to write a note on", !!target);
  if(target){
    const wrote = await post(dirPort, "/api/note", JSON.stringify({ itemId: target.id, body: UNICODE }));
    ok("POST /api/note accepts the note", wrote.status === 200, wrote.status + " " + wrote.text.slice(0, 120));
    const after = JSON.parse((await get(dirPort, "/api/state")).text);
    const item = (after.roadmap.items || []).find(i => i.id === target.id);
    const note = ((item && item.notes) || []).find(n => n.body === UNICODE);
    ok("the note comes back out of the API byte for byte", !!note,
       JSON.stringify(((item && item.notes) || []).map(n => n.body)).slice(0, 160));
    ok("the note is on disk as utf-8", fs.readFileSync(ROADMAP_FILE, "utf8").includes(UNICODE));
  }
}
stopServers();

// ---------------------------------------------------------------------------
// C — central mode, live: the overworld and the id-scoped API
// ---------------------------------------------------------------------------
console.log("\n== C: central mode — every reply declares utf-8 ==");
// Written AFTER the dir-mode server stopped: that server auto-registers itself
// here at boot, and this rewrite is what pins the id the road answers to.
writeJson(REGISTRY, {
  schemaVersion: 1,
  roadmaps: [
    { id: "rm-x", name: "encoding road", dir: ROAD, addedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" },
  ],
});
const cenPort = await startServer((port) => ["--port", String(port)], randomPort());
ok("the central-mode server came up", cenPort > 0);
if(cenPort > 0){
  for(const p of ["/", "/r/rm-x", "/api/registry", "/api/sessions", "/api/r/rm-x/state", "/api/r/nope/state"]){
    const r = await get(cenPort, p);
    ok("GET " + p + " declares utf-8", CHARSET.test(r.ctype), r.status + " " + (r.ctype || "(no content-type)"));
  }
  ok("GET /api/r/nope/state is a 404 that still declares utf-8", (await get(cenPort, "/api/r/nope/state")).status === 404);
}
stopServers();

// ---------------------------------------------------------------------------
// D — the MCP tool path speaks the same alphabets
// ---------------------------------------------------------------------------
console.log("\n== D: MCP stdio round trip ==");
{
  const TITLE = "Ünïcödé ✓ 日本語";
  const made = await mcpCall(ROAD, "item_upsert", { milestoneId: "ms-setup", kind: "task", title: TITLE });
  ok("item_upsert accepts a title in four alphabets", !made.error && made.value && made.value.id, made.error || "");
  const items = await mcpCall(ROAD, "roadmap_get", { section: "items" });
  const back = !items.error && Array.isArray(items.value) ? items.value.find(i => made.value && i.id === made.value.id) : null;
  ok("roadmap_get hands the title back unchanged", !!back && back.title === TITLE, back ? back.title : (items.error || "no item"));
  ok("the title is on disk as utf-8", fs.readFileSync(ROADMAP_FILE, "utf8").includes(TITLE));
}

// ---------------------------------------------------------------------------
// schema validator agrees with everything written above
// ---------------------------------------------------------------------------
console.log("\n== schema validator on the road this test wrote ==");
{
  const { validateDir } = await import("./schema/validate.mjs");
  const errs = validateDir(ROAD);
  ok("validate.mjs is clean on the road", errs.length === 0, errs.slice(0, 3).join(" | "));
}

stopServers();
console.log("\n---------------------------------------------");
console.log(fail === 0 ? ("ALL GREEN — " + pass + " assertions passed")
                       : (fail + " FAILED of " + (pass + fail) + "\n" + failures.map(f => "  - " + f).join("\n")));
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { stopServers(); console.error("SELFTEST CRASHED:", err); process.exit(1); });
