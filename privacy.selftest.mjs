#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PRIVACY — the sweep, and the guard that stops it coming back.
//
// Questlog grew up inside a private project, and for months this repo carried
// that project around with it: the venture's name, a real roadmap serving as
// the demo seed, absolute paths off one laptop, session ids that each name a
// whole transcript. A public repo can hold none of it, and a one-off sweep
// only cleans what was there the day it ran. So this file is not a report on
// today's tree — it is the lock:
//
//   (Tracked files only: it does not read git history, commit messages or author
//   identity, so a green run is never proof of a clean repository by itself.)
//
//   every tracked text file, every line, against a table of markers that must
//   never appear again. A commit that names the venture, pastes a home path or
//   leaves a key shape behind fails this test by file and line.
//
// THE MARKER TABLE LIVES HERE, in the test, on purpose. A table kept in a file
// of its own is a table somebody forgets to ship.
//
// What is NOT a marker, and must not become one:
//   * `yassine-codes` — the public GitHub account the plugin ships from. It is
//     in the manifests, the install commands and the README by design, so the
//     name marker carries a negative lookahead that steps over it.
//   * the word "founder", and the product's own vocabulary — road, quest,
//     horizon, baton, overworld, raid, roster, distillery, chief of staff.
//   * a generic `C:/Users/…` with no account name in it. The home marker asks
//     for the name, so prose about what packaging had to strip still reads.
//
// Read-only and zero-dep: no server, no temp dir, no road. It opens files and
// looks at them.
//
// Usage: node privacy.selftest.mjs [--verbose]
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes("--verbose");
const SELF = path.basename(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail){
  if(cond){ pass++; if(VERBOSE) console.log("  ok   " + name); }
  else { fail++; failures.push(name + (detail ? " — " + detail : "")); console.log("  FAIL " + name + (detail ? " — " + detail : "")); }
}

// ---------------------------------------------------------------------------
// THE MARKERS. Each is [name, regex]. Case-insensitive where the thing itself
// is — a venture name written three ways is still the venture. Case-sensitive
// where the shape is: an AWS key id is upper-case, and an account name is not
// three letters buried inside an unrelated word.
// ---------------------------------------------------------------------------
const MARKERS = [
  ["the venture's name",       /siteforge/i],
  ["the venture's other name", /firebuild/i],
  ["the venture's site",       /welt\s*&?\s*(and)?\s*weave/i],
  ["a product of the venture", /fleetview/i],
  ["the founder's name",       /yassine(?!-codes)/i],
  ["the founder's surname",    /nahid/i],
  ["the founder's initials",   /\bYLS\b/],
  ["the founder's handle",     /yasthegeek/i],
  ["a personal mail address",  /[\w.+-]+@gmail\.com/i],
  ["a home directory",         /Users[\\/]+YLS\b/i],
  ["a posix home directory",   /\/home\/yls\b/i],
  ["a real session id",        /c96d8692-4ba0-4d45-a450-888e28e4088d/i],
  ["another real session id",  /1711f027-2cbf-4f89-bbb6-fdffa2c3ef1e/i],
  ["a venture secret's name",  /AGENT_LANE_TOKEN/],
  ["an api key",               /\bsk-[A-Za-z0-9_-]{20,}/],
  ["a github token",           /\bghp_[A-Za-z0-9]{30,}/],
  ["an aws key id",            /\bAKIA[0-9A-Z]{16}\b/],
  ["a bearer token",           /Bearer\s+[A-Za-z0-9._-]{20,}/],
  ["a long hex blob",          /\b[0-9a-f]{64,}\b/],
  ["a long base64 blob",       /(?<![\w/=+])[A-Za-z0-9+/]{80,}={0,2}(?![\w/=+])/],
  ["a phone number",           /\+\d[\d ()-]{8,}\d/],
];

// ---------------------------------------------------------------------------
// The file list. `git ls-files` is the authority: what git tracks is exactly
// what a clone receives. Without git — a tarball, a machine that has none —
// fall back to walking the tree, skipping what encoding.selftest skips plus
// .questlog AT THE REPO ROOT ONLY. That one is live road data and never ships;
// the demo seed's seeds/sample-project/.questlog does ship, and is scanned.
// ---------------------------------------------------------------------------
const SKIP_DIRS = new Set([
  ".git", "dist-desktop", "node_modules", "output", "_verify",
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
function listFiles(){
  const r = spawnSync("git", ["ls-files", "-z"], { cwd: HERE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if(r.status === 0 && typeof r.stdout === "string" && r.stdout.length){
    return { how: "git ls-files", files: r.stdout.split("\u0000").filter(Boolean) };
  }
  return { how: "tree walk — no git here", files: walk(HERE) };
}

// Binaries carry no prose, and their bytes look like every shape at once.
const BINARY = /\.(ico|png|jpe?g|gif|webp|bmp|exe|dll|zip|gz|pdf|woff2?|ttf|otf|mp4|wav)$/i;

// ---------------------------------------------------------------------------
// The scan. One pass over the tree; every (marker, file) pair that hits comes
// back as one failing assertion naming the line and what matched.
// ---------------------------------------------------------------------------
function scan(files){
  const hits = new Map();   // marker name -> [{ file, line, text }]
  let scanned = 0;
  for(const rel of files){
    if(BINARY.test(rel)) continue;
    if(path.basename(rel) === SELF) continue;
    let src;
    try { src = fs.readFileSync(path.join(HERE, rel), "utf8"); } catch { continue; }
    if(src.includes("\u0000")) continue;   // binary after all
    scanned++;
    const lines = src.split("\n");
    for(let i = 0; i < lines.length; i++){
      for(const [name, re] of MARKERS){
        const m = re.exec(lines[i]);
        if(!m) continue;
        if(!hits.has(name)) hits.set(name, []);
        hits.get(name).push({ file: rel, line: i + 1, text: m[0] });
      }
    }
  }
  return { hits, scanned };
}

const { how, files } = listFiles();
console.log("== privacy sweep (" + how + ") ==");

const { hits, scanned } = scan(files);

// A hit is reported once per (marker, file): the first line, and a count of
// however many more are waiting behind it in the same file.
for(const [name] of MARKERS){
  const found = hits.get(name) || [];
  if(!found.length){ ok("no " + name + " in any tracked file", true); continue; }
  const byFile = new Map();
  for(const h of found){
    if(!byFile.has(h.file)) byFile.set(h.file, { first: h, more: 0 });
    else byFile.get(h.file).more++;
  }
  for(const [file, { first, more }] of byFile){
    ok("no " + name + " in " + file, false,
      file + ":" + first.line + "  matched " + JSON.stringify(first.text)
      + (more ? "  (+" + more + " more in this file)" : ""));
  }
}

// ---------------------------------------------------------------------------
// The scan has to have actually happened. An empty file list, a walk that
// found nothing, a `git ls-files` that returned one path — every one of those
// sails through the table above with nothing to report and calls it clean.
// ---------------------------------------------------------------------------
console.log("\n== the scan itself — " + scanned + " text files read ==");
ok("the sweep read the whole repo, not a corner of it", scanned >= 60,
  "only " + scanned + " text files scanned; the floor is 60");
ok("the marker table is intact",
  MARKERS.length >= 20 && MARKERS.every(([n, re]) => n && re instanceof RegExp),
  MARKERS.length + " markers");

// THE SENTINEL. A table of regexes that quietly matches nothing passes every
// run there will ever be. So hand the machinery a line it MUST flag — a home
// path with the account name still in it, the shape this sweep pulled out more
// often than any other — and fail if it shrugs.
{
  const canary = "see C:/Users/YLS/Downloads/notes.md for the rest";
  const flagged = MARKERS.filter(([, re]) => re.test(canary)).map(([n]) => n);
  ok("a planted home path is still caught", flagged.includes("a home directory"),
    "flagged: " + (flagged.join(", ") || "nothing"));
}

console.log("\n---------------------------------------------");
console.log(fail === 0 ? ("ALL GREEN — " + pass + " assertions passed")
                       : (fail + " FAILED of " + (pass + fail) + "\n" + failures.map(f => "  - " + f).join("\n")));
process.exit(fail === 0 ? 0 : 1);
