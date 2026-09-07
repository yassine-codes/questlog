#!/usr/bin/env node
// launch.mjs — the Questlog launcher. Zero dependencies. Node >= 18.
// ---------------------------------------------------------------------------
// One command opens the map, on any operating system. Resolves the port,
// health-checks it, cold-starts server.mjs in central mode when nothing
// answers, detects VERSION DRIFT (a running server older than the code on
// disk → graceful restart), then opens the Overworld as an app-mode browser
// window. Windows, macOS and Linux take the same three steps.
//
// Ported function-for-function from the archived PowerShell launcher, which
// was Windows-only and preferred a packaged exe. There is no exe branch: the
// single-executable path is retired, and a server reporting packaged:true is by
// definition running code that is not on disk — so comparing source hashes
// calls that drift without ever having to name an exe.
//
// SAFETY (binding, carried over from the PowerShell header): a restart is
// ALWAYS graceful. A running server is only ever replaced by asking it to stop
// via POST /api/shutdown and then cold-starting the on-disk code. A server that
// does NOT answer /api/shutdown is opened as-is and NEVER force-killed. A
// server that does not report /api/version predates that endpoint, so it is
// maximally stale and takes that same graceful path. A foreign listener gets a
// message and exit 2 — never a kill, never a rebind.
//
// This launcher NEVER writes config.json and NEVER creates or removes Startup
// entries — the autostart toggle is owned exclusively by POST /api/config.
//
// Flags:
//   --silent     Start/check the server only; open nothing. What the
//                Startup-folder autostart entry passes.
//   --port <n>   Port override, highest precedence. --port=<n> also works.
//
// Port precedence:  --port > QUESTLOG_PORT > ~/.questlog/config.json .port > 4177
//
// Exit codes:  0 started/opened   1 the server never came up   2 foreign listener
//
// Usage:  node launch.mjs [--silent] [--port <n>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// desktop/ holds this script; the app root (server.mjs, index.html) is its parent.
const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const toPort = (s) => {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function parseArgs(argv) {
  let silent = false;
  let port = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--silent") { silent = true; continue; }
    if (a === "--port") { port = toPort(argv[++i]); continue; }
    if (a.startsWith("--port=")) { port = toPort(a.slice("--port=".length)); continue; }
  }
  return { silent, port };
}

const ARGS = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Logging. A launcher started from a shortcut or the Startup folder has no
// console to write to, so it keeps a small rolling log — the same
// ~/.questlog/launcher.log the PowerShell one appended to. Deliberately
// os.homedir() and not the server's questlogHome(): QUESTLOG_REGISTRY moves the
// registry, not the launcher's own diary. Every failure here is swallowed;
// losing a log line must never cost the founder their dashboard.
// ---------------------------------------------------------------------------
const LOG_DIR = path.join(os.homedir(), ".questlog");
const LOG_FILE = path.join(LOG_DIR, "launcher.log");

const pad = (n) => String(n).padStart(2, "0");
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${stamp()}  ${msg}\n`, "utf8");
  } catch { /* a launcher never dies of its own logging */ }
}

// What used to be a WinForms MessageBox. A modal box was suppressed under
// -Silent because one at login is hostile; a single stderr line is not, so this
// always prints — and it is the only thing a scripted caller can read back.
function showMessage(text) {
  log(text);
  process.stderr.write(text + "\n");
}

// ---------------------------------------------------------------------------
// Port resolution — the PowerShell Resolve-Port, precedence for precedence.
// ---------------------------------------------------------------------------
function configPort() {
  const cfg = path.join(os.homedir(), ".questlog", "config.json");
  if (!fs.existsSync(cfg)) return 0;
  try {
    const j = JSON.parse(fs.readFileSync(cfg, "utf8").replace(/^\uFEFF/, ""));
    if (j && j.schemaVersion === 1 && j.port) {
      const p = parseInt(j.port, 10);
      if (p >= 1024 && p <= 65535) return p;
    }
  } catch (e) { log("config.json unreadable, ignoring: " + e.message); }
  return 0;
}

function resolvePort() {
  if (ARGS.port > 0) return ARGS.port;
  const fromEnv = toPort(process.env.QUESTLOG_PORT ?? "");
  if (fromEnv > 0) return fromEnv;
  const fromCfg = configPort();
  if (fromCfg > 0) return fromCfg;
  return 4177;
}

// ---------------------------------------------------------------------------
// Local source hash. Mirrors computeSourceHash in server.mjs (line ~592)
// EXACTLY: sha256 over the byte concatenation, in order, of server.mjs,
// bridge.mjs, index.html, chat.mjs. If that list ever changes, both ends change
// together or every launch reports drift.
//
// FINDING: the PowerShell launcher hashed only the first three. chat.mjs
// joined the server's hash after that launcher was written, so it has reported
// DRIFT on every single run since — and gracefully restarted a perfectly
// current server each time. Reading the same four files fixes that by
// construction.
// ---------------------------------------------------------------------------
function localSourceHash() {
  try {
    const h = crypto.createHash("sha256");
    for (const f of ["server.mjs", "bridge.mjs", "index.html", "chat.mjs"]) {
      h.update(fs.readFileSync(path.join(APP_ROOT, f)));
    }
    return h.digest("hex");
  } catch (e) {
    log("sourceHash: " + e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP. Node's global fetch (>= 18) plus an AbortController for the timeout.
// Returns { status, body }; status 0 means nothing is listening — connection
// refused, aborted, DNS, all of it collapses to "no server".
// ---------------------------------------------------------------------------
async function request(url, method, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const init = { method, signal: ac.signal };
    if (method === "POST") { init.body = ""; init.headers = { "Content-Type": "application/json" }; }
    const r = await fetch(url, init);
    return { status: r.status, body: await r.text() };
  } catch {
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

const probe = (url, timeoutMs = 2000) => request(url, "GET", timeoutMs);
const post = (url, timeoutMs = 5000) => request(url, "POST", timeoutMs);

function parseJsonSafe(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Cold start. central mode = no --dir = the Overworld. detached + stdio
// "ignore" + unref() is the whole trick: it lets this process exit seconds
// later while the server it started keeps serving. Forget the unref() and the
// command hangs for as long as the server lives.
// ---------------------------------------------------------------------------
function startServer(port) {
  const server = path.join(APP_ROOT, "server.mjs");
  if (!fs.existsSync(server)) throw new Error(`server.mjs not found at ${server}`);
  log(`cold start: ${process.execPath} server.mjs --port ${port} (cwd ${APP_ROOT})`);
  const child = spawn(process.execPath, [server, "--port", String(port)], {
    cwd: APP_ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

// Poll until the server answers /api/mode (present in every Questlog version).
async function waitReady(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = await probe(`http://127.0.0.1:${port}/api/mode`, 2000);
    if (m.status === 200) return true;
    await sleep(250);
  }
  return false;
}

// Wait for the port to stop answering (used after POST /api/shutdown).
async function waitDown(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = await probe(`http://127.0.0.1:${port}/api/mode`, 1000);
    if (m.status === 0) return true;
    await sleep(200);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Drift check. True when the running server is serving the code on disk.
// ---------------------------------------------------------------------------
function noDrift(version) {
  if (!version) return false;
  const local = localSourceHash();
  if (!local) { log("drift: cannot compute local hash; treating as matched"); return true; }
  const running = typeof version.sourceHash === "string" ? version.sourceHash : "";
  const eq = local === running;
  log(`drift: disk hash=${local.slice(0, 12)} running=${running ? running.slice(0, 12) : "<none>"} -> ${eq ? "match" : "DRIFT"}`);
  return eq;
}

// ---------------------------------------------------------------------------
// Graceful drift restart. Replaces the running server with the on-disk code by
// asking it to stop, waiting for the port to free, then cold-starting. We NEVER
// force-kill: a server that will not answer /api/shutdown is opened as-is
// instead. Used for BOTH a version-reporting server whose code drifted and an
// older server that does not report /api/version at all. Exits in every branch.
// ---------------------------------------------------------------------------
async function driftRestart(port, reason) {
  log(`${reason} -> POST /api/shutdown`);
  const sd = await post(`http://127.0.0.1:${port}/api/shutdown`, 5000);
  if (sd.status !== 200) {
    log(`shutdown returned status=${sd.status}; server will not restart gracefully, opening current server as-is`);
    if (!ARGS.silent) openDashboard(port);
    process.exit(0);
  }
  if (!(await waitDown(port, 5000))) {
    showMessage(`Questlog on port ${port} did not shut down for the update. See ${LOG_FILE}.`);
    process.exit(1);
  }
  startServer(port);
  if (!(await waitReady(port, 15000))) {
    showMessage(`Questlog did not restart on port ${port} within 15 seconds. See ${LOG_FILE}.`);
    process.exit(1);
  }
  // re-verify (best-effort)
  const v2 = await probe(`http://127.0.0.1:${port}/api/version`, 2000);
  if (noDrift(parseJsonSafe(v2.body))) log("drift restart: verified match");
  else log("drift restart: WARNING still differs");
  if (!ARGS.silent) openDashboard(port);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Open the dashboard. A Chromium browser gets an app-mode window (no tab strip,
// no address bar — it reads as the app it is); anything else gets a plain tab
// through the platform's own opener. Detection order is pinned per platform.
// ---------------------------------------------------------------------------
function regDefault(exe) {
  // reg query prints "    (Default)    REG_SZ    C:\path\to\exe". The value name
  // is localised, the whitespace is not stable — so key off REG_SZ and take the
  // rest of the line. A miss falls through to the literal paths, exactly as the
  // PowerShell one did.
  try {
    const r = spawnSync("reg", [
      "query", `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, "/ve",
    ], { encoding: "utf8", windowsHide: true });
    if (r.status !== 0 || !r.stdout) return null;
    for (const line of r.stdout.split(/\r?\n/)) {
      const i = line.indexOf("REG_SZ");
      if (i === -1) continue;
      const val = line.slice(i + "REG_SZ".length).trim().replace(/^"|"$/g, "");
      if (val && fs.existsSync(val)) return val;
    }
  } catch { /* no reg.exe, or a locale we cannot read: fall through */ }
  return null;
}

function onPath(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, name);
    try { if (fs.existsSync(p)) return p; } catch { /* unreadable dir */ }
  }
  return null;
}

function findBrowser() {
  if (process.platform === "win32") {
    for (const exe of ["msedge.exe", "chrome.exe"]) {
      const v = regDefault(exe);
      if (v) return v;
    }
    const candidates = [
      path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    ];
    for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
    return null;
  }
  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
    for (const c of candidates) { if (fs.existsSync(c)) return c; }
    return null;
  }
  for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) {
    const p = onPath(n);
    if (p) return p;
  }
  return null;
}

// Every spawn here is detached + unref'd for the same reason the server's is:
// the launcher must be free to exit the moment the window is on its way.
//
// windowsHide is set for the shell openers and NEVER for the browser: libuv's
// hide flag is not console-only, it puts SW_HIDE in the child's STARTUPINFO, and
// Chromium honours that — so a "hidden" browser opens the app window invisibly
// and the founder is told a URL that nothing is showing. The console flash we
// actually want to suppress belongs to `cmd /c start`, which is exactly where
// the flag stays.
function openDetached(cmd, args, hide) {
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: !!hide }).unref();
}

function openDashboard(port) {
  const url = `http://127.0.0.1:${port}/`;
  const browser = findBrowser();
  if (browser) {
    log(`open: ${browser} --app=${url}`);
    openDetached(browser, [`--app=${url}`], false);
  } else {
    log(`open: default browser ${url}`);
    if (process.platform === "win32") openDetached("cmd", ["/c", "start", "", url], true);
    else if (process.platform === "darwin") openDetached("open", [url], false);
    else openDetached("xdg-open", [url], false);
  }
  // Last stdout line, always — the open command quotes it back to the founder.
  console.log(url);
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------
async function main() {
  const port = resolvePort();
  log(`launcher start (silent=${ARGS.silent}) port=${port} appRoot=${APP_ROOT}`);

  const v = await probe(`http://127.0.0.1:${port}/api/version`, 2000);

  if (v.status === 0) {
    // ---- Server absent -> start the on-disk code ---------------------------
    log(`no server on :${port}`);
    startServer(port);
    if (!(await waitReady(port, 15000))) {
      showMessage(`Questlog did not come up on port ${port} within 15 seconds. See ${LOG_FILE}.`);
      process.exit(1);
    }
    log(`server ready on :${port}`);
    if (!ARGS.silent) openDashboard(port);
    process.exit(0);
  }

  if (v.status === 200) {
    const ver = parseJsonSafe(v.body);
    const isVersion = !!(ver && ver.app === "questlog" && ver.sourceHash);
    if (isVersion) {
      if (noDrift(ver)) {
        log("running server matches on-disk code");
        if (!ARGS.silent) openDashboard(port);
        process.exit(0);
      }
      // ---- Drift restart (graceful; shared with the no-version path below) --
      await driftRestart(port, "version drift");
    }
    // 200 but not a version document -> foreign or older; fall to the mode probe.
    log("200 on /api/version but not a version document; probing /api/mode");
  }

  // ---- Non-200 (e.g. 404 from an older Questlog) or 200-non-version --------
  const m = await probe(`http://127.0.0.1:${port}/api/mode`, 2000);
  const mode = parseJsonSafe(m.body);
  if (m.status === 200 && mode && mode.mode) {
    // An older Questlog that does not report /api/version is running code from
    // before that endpoint existed — by definition stale, not healthy. It goes
    // through the same graceful restart: back on current code if it answers
    // shutdown, opened as-is (never force-killed) if it does not.
    await driftRestart(port, `older Questlog without /api/version on :${port} (mode=${mode.mode}; maximally stale)`);
  }

  // Foreign listener / garbage. Touch nothing.
  log(`port ${port} answered by a non-Questlog listener (version status=${v.status}, mode status=${m.status}); refusing to touch it`);
  showMessage(`Port ${port} is in use by something else — change the port in Questlog settings or ~/.questlog/config.json.`);
  process.exit(2);
}

main().catch((e) => {
  showMessage(`Questlog launcher failed: ${e && e.message ? e.message : e}. See ${LOG_FILE}.`);
  process.exit(1);
});
