// UPSCALE_ENABLED cannot reach a child that can render.
//
// The flag is a CLI convenience: "act as if `--upscale` had been typed". In a terminal that is an
// honest bargain — the person typing the command is the person choosing to spend — and there it
// governs everything you FINISH from a terminal: every `npm run render`, and every `npm run assemble`
// too, because assemble reaches the same finishRender whose test is `if (upscale ||
// config.upscale.enabled)`. A stitch of clips you already paid for can therefore buy a Topaz pass.
// This app never offers that bargain. Its upscale is the one at approve: asked for explicitly, priced
// before the button is pressed, billed to the vendor approve resolved, and written into the run's
// cost ledger.
//
// Every child re-reads `.env` for itself at startup, so a box with `UPSCALE_ENABLED=true` in it used
// to run paid Topaz in two places the money was never accounted for: the auto-assemble the app labels
// lane 'free' and shows as "Finish free" — the one lane the app both calls free and writes no
// cost-ledger row for, because there was never anything to write — and every full render, whose
// estimate and whose ledger row priced the render ALONE. run-service pins the flag OFF in
// `env(runId)`, the one environment every job it enqueues is built from — plan, revise, render,
// probe, job re-render, assemble and the approve-time upscale, which is every child that can reach a
// render.
//
// That is a claim about a specific set of spawn sites, so this file holds it down from three sides:
//
//   1. the SOURCE canary, which reads web/server as TEXT and requires every place that starts a
//      child to be provably pinned or licensed by name — including a brand-new one no test below
//      ever calls. See the long note above the net itself for exactly what it holds and, more
//      importantly, what it cannot.
//   2. the LANE sweep, which drives every kind the service can enqueue and reads the env it handed
//      over — the pin is present on all of them. The two RANKING claims ride in their own tests
//      beside it, because ranking is how a pin is actually lost: one deployment childEnv that says
//      `true`, one run carrying a per-run resolution pick, each shown losing to pins written after
//      it. The sweep itself claims nothing about a `.env` — no child in it reads one.
//   3. one BEHAVIOURAL test that spawns a REAL node child against a REAL `.env` saying
//      UPSCALE_ENABLED=true and asserts the child's own config still answers false. Everything else
//      here proves the env OBJECT carries the string; only this proves the string beats the file.
//      The link is dotenv's override:false default, and it is asserted nowhere else in the repo. Its
//      neighbour then shows that dotenv has two OTHER switches that would undo the pin, that neither
//      one can be reached from here, and — structurally, not by the payload a harness happens to
//      drive — that no free text rides the argv of a child that can finish a render.
//
// Nothing spends or renders here: the run dirs are fabricated in the layout the render CLIs leave
// behind, and the job manager is a stub that records what it was handed. The one process this file
// starts is a `node -e` that imports config.js and prints a boolean.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { createRunService } = await import('../../lib/run-service.js');
const { newManifest, writeManifest } = await import('../../lib/web-manifest.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-upscale-pin-'));
const runsDir = path.join(tmpRoot, 'runs');
const outDir = path.join(tmpRoot, 'out');
const envRoot = path.join(tmpRoot, 'envroot');
const voicesDir = path.join(tmpRoot, 'voices');
const voicesFile = path.join(voicesDir, 'voices.json');
for (const d of [runsDir, outDir, envRoot, voicesDir]) fs.mkdirSync(d, { recursive: true });
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// The .env of a box whose owner turned the CLI convenience on — the whole point of this file. It is
// not decoration: the behavioural test below points a real child's dotenv at THIS file and proves,
// with a control child, that dotenv really does read it and really would have turned the flag on.
// The key rides here too because approve refuses a keyless vendor before it enqueues anything, and
// an isolated env root is what keeps a developer's own .env out of every assertion below.
const ENV_FILE = path.join(envRoot, '.env');
fs.writeFileSync(ENV_FILE, 'UPSCALE_ENABLED=true\nFAL_KEY=fake-key-for-the-guard\n');

// ── fabricating a reviewed run ──────────────────────────────────────────────────────────────────

const JOBS = ['K1', 'K2'];
const TS = '2026-08-01T00:00:00.000Z';
const clipOf = (dir, take, job) => path.join(dir, 'renders', take, job, 'clip.mp4');

/** A run in review: two rendered clips in t1, an assembled master beside them, one cut naming it.
 *  TWO jobs on purpose — render(runId, { mode: 'probe' }) is refused on a single-job plan
 *  (run-service's "a probe would be the full render" 409), and the sweep below needs the probe lane
 *  to actually enqueue something for its assertion to mean anything.
 *
 *  `resolution` is the per-run PICK, and it is optional because most runs here have not made one:
 *  a manifest without it makes resolutionOverride return {} and never exercises the spread the pins
 *  are written after. One test below asks for it precisely so that spread is not empty. */
function seedRun(runId, { resolution = null } = {}) {
  const dir = path.join(runsDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({
    spec_version: '1.0',
    render_backend: 'seedance',
    project: { title: 'Pin Drill', aspect_ratio: '9:16' },
    shots: JOBS.map((_, i) => ({ shot_id: `S${i + 1}`, duration_s: 5, description: 'a shot' })),
    kling: {
      elements: [{ id: 'subject', image: 'subject.png' }],
      jobs: JOBS.map((j, i) => ({ job_id: j, shots: [`S${i + 1}`], elements: ['subject'] })),
    },
  }, null, 2));

  const takeDir = path.join(dir, 'renders', 't1');
  const jobClips = Object.create(null);
  for (const job of JOBS) {
    fs.mkdirSync(path.join(takeDir, job), { recursive: true });
    fs.writeFileSync(clipOf(dir, 't1', job), 'FAKE-MP4');
    jobClips[job] = clipOf(dir, 't1', job);
  }
  const master = path.join(takeDir, 'pin-drill-t1.mp4');
  fs.writeFileSync(master, 'FAKE-MP4');
  fs.writeFileSync(path.join(takeDir, 'render.json'), JSON.stringify({
    backend: 'seedance',
    jobs: JOBS.map((j) => ({ jobId: j, clip: jobClips[j] })),
    master,
    masterShortSide: 720, // below 1080, so an upscale is a thing a reviewer can genuinely ask for
  }, null, 2));

  writeManifest(dir, {
    ...newManifest({ idea: 'a pin drill', backend: 'seedance', aspect: '9:16', resolution, durationS: 10 }, TS),
    takes: [{ id: 't1', mode: 'full', createdAt: TS }],
    cuts: [{ id: 'c1', take: 't1', master, shortSide: 720, createdAt: TS }],
    jobClips,
  });
  return dir;
}

/** `wiring` overrides what the service is BUILT with — the knobs a real deployment varies. */
function harness(wiring = {}) {
  const enqueued = [];
  const live = [];
  const mgr = {
    enqueue(job) {
      enqueued.push(job);
      live.push({ id: `j${enqueued.length}`, runId: job.runId, lane: job.lane, kind: job.kind, startedAt: null });
      return { id: `j${enqueued.length}`, position: live.length };
    },
    snapshot: () => ({ active: [], queued: [...live] }),
    cancel: () => false,
  };
  const svc = createRunService({
    root: HOST_ROOT, runsDir, outDir, envRoot, voicesFile, childEnv: { PATH: process.env.PATH }, mgr,
    bus: { emit() {}, subscribe: () => () => {} },
    isAlive: () => false,
    ...wiring,
  });
  return { svc, enqueued, drain: () => { live.length = 0; } };
}

let n = 0;
/** A fresh seeded run per lane: the spend guards are per run, and this file is not testing them. */
const freshRun = (opts) => {
  const runId = `web-1999010100${String(++n).padStart(4, '0')}-pin`;
  seedRun(runId, opts);
  return runId;
};

// ── the source canary ───────────────────────────────────────────────────────────────────────────
//
// Everything below this section runs the service and reads what it handed over, which can only ever
// speak for the spawn sites a test happens to call. This section speaks for the ones nobody calls.
// It is the same shape as the config-free leak canary in runs-caps.test.js: read the server's own
// source as TEXT (never import it — importing route modules is exactly what that other canary
// forbids) and assert a structural property of it.
//
// WHAT THIS IS, AND WHY IT IS SHAPED THE WAY IT IS. Three earlier versions of this guard tried to
// RECOGNISE a paid spawn — to enumerate the ways an author might spell one and match them. Each
// version was beaten by a spelling the last one had not thought of: a `path.join(root, 'src', 'cli',
// name)` instead of a literal, a `.mjs` file instead of a `.js` one, a destructured `const { enqueue
// } = mgr` instead of `mgr.enqueue`, a path assembled from two halves at runtime. That is a game a
// text scanner cannot win, because the set of ways to write a path is not finite.
//
// So this one does not try. It casts a COARSE net — anything that looks even vaguely like starting a
// child — and then demands that every single thing it catches be either PROVABLY PINNED (its options
// object is built from run-service's env(runId), and the pin survives to the closing brace) or
// EXPLICITLY LICENSED by name in the EXEMPT map below. A false positive costs a contributor one line
// in that map, written after they have thought about who pays; a false negative costs a user money
// they were never quoted. The trade is deliberately lopsided in that direction.
//
// The net trips on any of these in any non-exempt file under web/server:
//   · a call to `enqueue(`, with or without a receiver, so a destructured `enqueue` is caught;
//   · a call to `spawn(`, `spawnSync(`, `execFile(`, `execFileSync(` or `fork(`, whatever the first
//     argument names — `open`, `ffmpeg` and node itself are caught exactly like `render.js` is;
//   · a repo-CLI path in any spelling below, appearing OUTSIDE any of the above.
//
// AND WHAT IT CANNOT HOLD — this matters more than another regex would. It is a scanner over source
// TEXT. It is not a parser, it does not resolve imports, and it has no idea what any expression
// evaluates to. A determined author can still walk past it: compute the callee at runtime
// (`const f = child_process[name]; f(...)`), reach for a spawn inside a dependency, hand the work to
// a shell, or hide the whole thing behind a helper in a file this canary does not read. Nothing here
// closes those, and pretending otherwise is what made the earlier versions comfortable to defeat.
// Its job is the ORDINARY mistake — the next contributor who adds a lane and copies the wrong
// neighbour's `env:` — and for that it is worth more than it costs. The adversary's job belongs to
// review, and to the fact that every licence below has a name and a reason attached to it.
//
// Two smaller admissions, both real. Comments are blanked before the net runs (or the prose in this
// very paragraph would match), by a walker that understands strings but not regex literals — a regex
// containing a quote character would desync it. And a template literal is opaque to it: an
// interpolation containing a backtick would do the same. Both would most likely show up as MISSING
// catches, which the licensed-set equality at the end turns red rather than green, because that
// assertion fails just as loudly when a licensed spawn stops being seen as when a new one appears.

const SERVER_DIR = path.join(HOST_ROOT, 'web/server');
const RUN_SERVICE = 'web/server/lib/run-service.js';

/** The callees the net trips on. Longest first: the alternation is leftmost-first, so `spawn` listed
 *  ahead of `spawnSync` would match the prefix and then fail on the `Sync(` that follows. */
const STARTS_A_CHILD = /\b(spawnSync|spawn|execFileSync|execFile|fork|enqueue)\s*\(/g;

/**
 * Repo-CLI path spellings, each normalised to `src/cli/<file>` so a message names the CHILD rather
 * than the syntax that reached it. These are NOT the net — the callee regex above is. They only
 * LABEL a catch (so an offender reads `spawn(src/cli/render.js)` instead of `spawn(process.execPath)`)
 * and, on their own, trip the net for a CLI path that sits outside any call the net can see.
 */
const CLI_SPELLINGS = [
  // run-service's own helper. The directory lives inside the helper, so a call site names only a file.
  /\bCLI\(\s*root\s*,\s*(?<q>['"`])(?<cli>[A-Za-z0-9_.-]+)\k<q>/g,
  // one literal carrying the whole tail: 'src/cli/doctor.js', `${root}/src/cli/render.js`
  /(?<q>['"`])[^'"`]*\bsrc\/cli\/(?<cli>[A-Za-z0-9_.-]+)\k<q>/g,
  // path.join(root, 'src', 'cli', 'render.js') — every segment its own literal
  /(?<qs>['"`])src\k<qs>\s*,\s*(?<qc>['"`])cli\k<qc>\s*,\s*(?<q>['"`])(?<cli>[A-Za-z0-9_.-]+)\k<q>/g,
  // path.join(root, 'src/cli', 'render.js') — half joined, half not
  /(?<qd>['"`])src\/cli\k<qd>\s*,\s*(?<q>['"`])(?<cli>[A-Za-z0-9_.-]+)\k<q>/g,
];

/** Every repo CLI named in `code`, in source order, as `{ index, cli }`. Keyed by index while it
 *  collects, so a site two spellings both happen to match is reported once rather than twice. */
function cliSpawnTargets(code) {
  const found = new Map();
  for (const re of CLI_SPELLINGS) {
    for (const m of code.matchAll(re)) found.set(m.index, `src/cli/${m.groups.cli}`);
  }
  return [...found].sort((a, b) => a[0] - b[0]).map(([index, cli]) => ({ index, cli }));
}

const QUOTES = new Set(["'", '"', '`']);

/** Index just past the string that starts at `i` (which must be on its opening quote). A template
 *  literal is walked as one opaque run to its closing backtick — see the admission above. */
function endOfString(code, i) {
  const q = code[i];
  for (let j = i + 1; j < code.length; j++) {
    if (code[j] === '\\') { j++; continue; }
    if (code[j] === q) return j + 1;
  }
  return code.length;
}

/** Index just past the bracket that closes the one at `i`, or -1 if the walk desyncs. Strings are
 *  skipped whole so a `)` inside a message cannot close a call. */
function matchBracket(code, i) {
  const CLOSER = { '(': ')', '{': '}', '[': ']' };
  const want = [CLOSER[code[i]]];
  for (let j = i + 1; j < code.length; j++) {
    const c = code[j];
    if (QUOTES.has(c)) { j = endOfString(code, j) - 1; continue; }
    if (CLOSER[c]) { want.push(CLOSER[c]); continue; }
    if (c === want.at(-1)) { want.pop(); if (!want.length) return j + 1; continue; }
    if (c === ')' || c === '}' || c === ']') return -1; // a closer of the wrong kind: refuse to guess
  }
  return -1;
}

/** `text` split on its TOP-LEVEL commas — the entries of one object literal or argument list, with
 *  everything nested (including a parenthesised conditional) kept whole inside one entry. */
function topLevelParts(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let j = 0; j < text.length; j++) {
    const c = text[j];
    if (QUOTES.has(c)) { j = endOfString(text, j) - 1; continue; }
    if (c === '(' || c === '{' || c === '[') { depth++; continue; }
    if (c === ')' || c === '}' || c === ']') { depth--; continue; }
    if (c === ',' && depth === 0) { parts.push(text.slice(start, j)); start = j + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** The source text of the value that follows the `:` (or `=`) at `at`, balanced if it opens a
 *  bracket and otherwise read to the next top-level `,` `;` `}` `)` — so the answer never depends
 *  on where the author put their line breaks. The `;` matters more than it looks: this same reader
 *  is what follows `const childEnvironment = env(runId);` for the alias hop below, and without it
 *  the value ran straight past the end of the statement and swallowed the enqueue underneath. */
function valueAfter(code, at) {
  let j = at + 1;
  while (j < code.length && /\s/.test(code[j])) j++;
  if (code[j] === '{' || code[j] === '[' || code[j] === '(') {
    const end = matchBracket(code, j);
    return end === -1 ? null : code.slice(j, end);
  }
  let depth = 0;
  let k = j;
  for (; k < code.length; k++) {
    const c = code[k];
    if (QUOTES.has(c)) { k = endOfString(code, k) - 1; continue; }
    if (c === '(' || c === '{' || c === '[') { depth++; continue; }
    if (c === ')' || c === '}' || c === ']') { if (depth === 0) break; depth--; continue; }
    if ((c === ',' || c === ';') && depth === 0) break;
  }
  return code.slice(j, k).trim();
}

/** The choke point, spelled at the call site. */
const CHOKE = /^env\s*\(\s*runId\s*\)$/;
/** The keys env(runId) writes AFTER its spreads, and which therefore have to survive to the end of
 *  whatever literal quotes it. UPSCALE_ENABLED is the money one; the other two are how a child is
 *  told where the run lives, and a lane that re-points those has stopped being this run's lane.
 *
 *  The NAME alone, with no `:` after it — because JavaScript spells one key three ways and all three
 *  un-write the pin: `UPSCALE_ENABLED: 'true'`, `'UPSCALE_ENABLED': 'true'` and the shorthand
 *  `{ ...env(runId), UPSCALE_ENABLED }`. Requiring a colon caught only the first, which is the one
 *  spelling nobody has to reach for. Naming a pinned key in a value instead of a key would trip this
 *  too; that is a false positive worth having, and one line of thought to clear. */
const PINNED_KEYS = /\b(UPSCALE_ENABLED|RUNS_DIR|OUT_DIR)\b/;
const BARE_IDENT = /^[A-Za-z_$][\w$]*$/;

const short = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

/**
 * Why `name` is not a readable local alias of env(runId), or null if it is one.
 *
 * One hop, and only one, because `const childEnvironment = env(runId)` above the call is a
 * behaviour-preserving hoist and accusing it of a money bug is how a guard spends the credibility
 * it needs on the day it is right. Two hops, or two bindings of the same name, are refused — and
 * the refusal says the canary could not follow it, not that the code is wrong, because those are
 * different sentences and only one of them is true.
 *
 * A destructured `const { childEnv } = app.ctx` is deliberately NOT a binding this follows: it is
 * not a value this file decides, and the message says exactly which spelling was looked for.
 */
function aliasProblem(name, fileCode) {
  const bindings = [...fileCode.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=`, 'g'))];
  if (bindings.length === 0) return `there is no plain \`const ${name} = …\` binding in this file for the canary to follow`;
  if (bindings.length > 1) return `\`${name}\` is bound more than once here, so the canary cannot tell which binding reaches this call`;
  const init = short(valueAfter(fileCode, bindings[0].index + bindings[0][0].length - 1));
  if (CHOKE.test(init)) return null;
  if (init.startsWith('{')) {
    const p = literalProblem(init, fileCode, false);
    return p ? `\`const ${name} = …\` ${p}` : null;
  }
  return `\`const ${name} = ${init}\` is not env(runId)`;
}

/**
 * Why this `{ … }` env literal does not carry the pin to its closing brace, or null if it does.
 *
 * The head is the easy half: it must OPEN with a spread of env(runId), because anything hand-built
 * from childEnv is the shape that used to leak the flag into a paid lane. The hard half is
 * everything after it, and that is the half that was missing. `{ ...env(runId), UPSCALE_ENABLED:
 * 'true' }` opens correctly and then un-writes the very key this file is named after; `{
 * ...env(runId), ...opts.env }` opens correctly and then hands the decision back to a caller. Both
 * used to pass. So every top-level entry after the head is judged too: it may not name a pinned key
 * at any depth, may not compute its key (a computed key can BE a pinned one), and may not spread a
 * bare identifier or member expression, whose contents this canary cannot see.
 *
 * A parenthesised entry — `...(cond ? { … } : {})`, which is how the approve lane carries the vendor
 * and the price knobs its ledger row was quoted from — is allowed past that last rule and is read
 * only for pinned-key text inside it. That is a real gap, and it is the price of not failing the one
 * correct lane in the codebase that needs the shape.
 */
function literalProblem(t, fileCode, mayFollowAlias) {
  const parts = topLevelParts(t.slice(1, -1));
  const spread = /^\.\.\.\s*(.+)$/s.exec(parts[0] ?? '');
  if (!spread) return 'does not open with `...env(runId)`, so it is hand-built';
  const operand = spread[1].trim();
  if (!CHOKE.test(operand)) {
    if (!BARE_IDENT.test(operand)) return `opens with \`...${short(operand)}\` instead of \`...env(runId)\``;
    if (!mayFollowAlias) return `opens with \`...${operand}\`, an alias behind another alias — the canary follows one hop only`;
    const p = aliasProblem(operand, fileCode);
    if (p) return `opens with \`...${operand}\`, and ${p}`;
  }
  for (const part of parts.slice(1)) {
    if (PINNED_KEYS.test(part)) {
      return `re-assigns \`${PINNED_KEYS.exec(part)[1]}\` after spreading env(runId), so the pin does not survive to the closing brace`;
    }
    if (part.startsWith('[')) return 'sets a COMPUTED key after spreading env(runId), and a computed key can be a pinned one';
    if (/^\.\.\.\s*[A-Za-z_$]/.test(part)) {
      return `spreads \`${short(part.slice(3))}\` over the pin, and the canary cannot see what is in it`;
    }
  }
  return null;
}

/** Why this `env:` value does not carry the pin, or null if it does. Every answer is a predicate of
 *  "hands its child an env that …", so an offender line reads as one sentence however deep the
 *  reason was found. */
function envProblem(text, fileCode) {
  const t = (text ?? '').trim();
  if (!t) return 'the canary could not read at all';
  if (CHOKE.test(t)) return null;
  if (BARE_IDENT.test(t)) {
    const p = aliasProblem(t, fileCode);
    return p ? `is \`${t}\`, and ${p}` : null;
  }
  if (!t.startsWith('{')) return `is built from \`${short(t)}\` instead of from env(runId)`;
  return literalProblem(t, fileCode, true);
}

/** Blank out comments, preserving offsets and newlines so error messages can still cite a line.
 *  String bodies are walked, not blanked, because the CLI spellings have to see 'src/cli/doctor.js' —
 *  the walker only needs to know it is INSIDE a string so a `//` in a URL is not read as a comment.
 *  It does not understand regex literals, which is one of the two admissions in the note above. */
function blankComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && next === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      out += c; i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') { out += src[i]; i++; if (i < src.length) { out += src[i]; i++; } continue; }
        out += src[i]; i++;
      }
      if (i < src.length) { out += src[i]; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/** Every module under web/server except its own tests and node_modules — the surface the canary
 *  owns. `.mjs`/`.cjs` count: a `routes/rogue.mjs` is a route module like any other, and a canary
 *  that reads only `.js` is one file rename away from blind. Only web/server/test itself is pruned,
 *  by full path — a `lib/test/` helper directory further down is source and gets read. */
function serverSources(dir = SERVER_DIR, acc = []) {
  const TESTS = path.join(SERVER_DIR, 'test');
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name === 'node_modules' || full === TESTS) continue;
    if (entry.isDirectory()) serverSources(full, acc);
    else if (/\.[mc]?js$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/**
 * The object literal that carries the CHILD'S OPTIONS, or null if the call has none.
 *
 * The last top-level `{ … }` argument, which is where every shape in this repo keeps it:
 * `enqueue({ …job })` has exactly one, `spawn(cmd, [args], { cwd, env })` has it in third place, and
 * `spawn('open', ['-R', p])` has none at all — that last case is a real answer, not a failure, and
 * the caller turns it into "no env of its own".
 */
function optionsObject(region) {
  const objects = topLevelParts(region).filter((p) => p.startsWith('{'));
  return objects.length ? objects[objects.length - 1] : null;
}

/**
 * The child's own `env`, read as a TOP-LEVEL entry of that options object: `{ kind, text }`, or null
 * if the object does not set one.
 *
 * Top-level and nothing else, because the question is only ever "what does this child get". An
 * earlier version mapped over every `env:` ANYWHERE in the call and passed the site when they were
 * all pinned — so a call that set no env of its own (the child then inherits whatever the manager
 * hands it) but mentioned `env: env(runId)` in some other field read as provably pinned, and the
 * one env that actually reaches the child was never looked at. All three spellings of the key are
 * read for the same reason PINNED_KEYS reads three: `env:`, `'env':` and the shorthand `{ env }`.
 */
function childEnvEntry(objText) {
  for (const part of topLevelParts(objText.slice(1, -1))) {
    const keyed = /^(['"]?)env\1\s*:/.exec(part);
    if (keyed) return { kind: 'value', text: part.slice(keyed[0].length).trim() };
    if (/^env$/.test(part)) return { kind: 'shorthand', text: 'env' };
  }
  return null;
}

/**
 * Every place under web/server that starts a child, as `{ rel, line, callee, child, region }`.
 *
 * `child` is what the licence is written against, and it is chosen to stay readable and stable: the
 * repo CLI if the call's arguments name one in any spelling above, otherwise the first argument
 * exactly as the author wrote it (`process.execPath`, `'open'`, `spec.file`, `opener[0]`), or `{…}`
 * for a call whose first argument is an object. A line number is NOT part of it — a licence must not
 * rot the moment somebody adds a blank line above it — but every offender message carries one.
 */
function childStarters(rel, code) {
  const catches = [];
  const covered = [];
  for (const m of code.matchAll(STARTS_A_CHILD)) {
    const open = m.index + m[0].length - 1;
    const end = matchBracket(code, open);
    const region = end === -1 ? code.slice(open + 1) : code.slice(open + 1, end - 1);
    if (end !== -1) covered.push([open, end]);
    const cli = cliSpawnTargets(region)[0]?.cli;
    const first = topLevelParts(region)[0] ?? '';
    const arg = first.startsWith('{') ? '{…}' : first.replace(/\s+/g, ' ').slice(0, 40);
    catches.push({
      rel, line: lineOf(code, m.index), callee: m[1], child: cli ?? arg, region,
      unreadable: end === -1,
    });
  }
  // A repo-CLI path with no call around it that the net could see — a `const script = CLI(root,
  // 'render.js')` hoisted out of its enqueue, say. It cannot be pinned (there is no options object
  // to read), so it can only be licensed; that is coarse on purpose, and the message says so.
  for (const { index, cli } of cliSpawnTargets(code)) {
    if (covered.some(([a, b]) => index > a && index < b)) continue;
    catches.push({ rel, line: lineOf(code, index), callee: 'names', child: cli, region: null, unreadable: false });
  }
  return catches;
}

// ── the licences ────────────────────────────────────────────────────────────────────────────────
//
// Everything the net catches that is not provably pinned has to be named here, with the reason it
// cannot spend on an upscale. Adding a line is a decision about money, so it is spelled out rather
// than inferred — and nothing is inferred: no licence is granted by a file's name, by proximity to
// another licensed call, or by the mere fact that some CLI string appears elsewhere in the file. A
// key is `<file> → <callee>(<child>)` and it clears that one pair and nothing else, which is why
// routes/setup.js has two entries rather than one.
//
// The set is asserted EQUAL to what the net finds, not merely a superset of it. So a licence for a
// call that no longer exists is a failure too: a standing permission nobody is using is a door held
// open on an empty room, and the next spawn added to that file would walk straight through it.
const EXEMPT = new Map([
  ['web/server/routes/setup.js → spawn(src/cli/doctor.js)',
    'POST /api/doctor runs doctor on the BOX\'s own environment on purpose — doctor\'s whole job is to report '
    + 'what THIS machine\'s .env says, and a pinned doctor would contradict `npm run doctor` from a terminal on '
    + 'the same box. It renders nothing, so it has no clip to upscale.'],
  ['web/server/routes/setup.js → spawn(spec.file)',
    'the provider-CLI installer: `npm install -g <pkg>`, or Anthropic\'s native install script. It is not a repo '
    + 'CLI at all — it can no more reach finishRender than `open` can — and it needs the box\'s PATH, which is '
    + 'the whole point of the env it is handed.'],
  ['web/server/routes/cast.js → enqueue(src/cli/mint-voice.js)',
    'mint-voice mints a Kling voice_id from an uploaded clip. It never reaches finishRender, so there is no clip '
    + 'in it for the flag to upscale. Its own price is quoted as VOICE_MINT_USD.'],
  ['web/server/routes/actions.js → spawn(\'open\')',
    '"Reveal in Finder" — macOS `open -R` on a path the server already resolved. It starts no node and reads no '
    + '.env; the env it is not given is the point.'],
  ['web/server/lib/job-manager.js → enqueue({…})',
    'this IS enqueue — the manager\'s own definition of the method the net looks for. The env it receives is '
    + 'whatever the caller built, which is what every other entry here is about.'],
  ['web/server/lib/job-manager.js → spawn(process.execPath)',
    'the one spawn the whole choke point funnels into. It passes through the `env` its caller handed it, so '
    + 'pinning here would be pinning the pin; run-service is where the value is decided.'],
  ['web/server/server.js → spawn(process.execPath)',
    'Settings → Restart: the server re-launching ITSELF with its own argv, deliberately on the operator\'s full '
    + 'process.env, because the successor has to come up exactly as this one did. It renders nothing.'],
  ['web/server/server.js → spawn(opener[0])',
    '`open`/`xdg-open`/`start` on the studio URL when the server boots from a real TTY. A browser, not a CLI.'],
  ['web/server/dev/demo.js → spawn(opener[0])',
    'the same browser opener in the demo/e2e server. Dev-only, and still not a CLI.'],
  ['web/server/dev/seed-demo-run.js → spawnSync(\'ffmpeg\')',
    'the demo seeder pulling a poster frame out of a fixture clip with local ffmpeg. No network, no vendor, no '
    + 'node child — nothing here can bill anyone.'],
]);

/** Files allowed to hold the manager's `enqueue` in a local binding. Everywhere else, destructuring
 *  it is banned outright: the call is caught either way now, but a route module that has taken a
 *  reference to the queue has already moved a spend decision out of run-service, and the diff that
 *  does it should have to argue for itself here. */
const MAY_HOLD_ENQUEUE = new Set([RUN_SERVICE, 'web/server/lib/job-manager.js']);
const HOLDS_ENQUEUE = /\{[^{}]*\benqueue\b[^{}]*\}\s*=/;

test('canary: everything under web/server that starts a child is pinned to env(runId), or licensed by name', () => {
  const offenders = [];
  const seen = new Set();
  let pinnedInRunService = 0;
  let total = 0;

  for (const file of serverSources()) {
    const rel = path.relative(HOST_ROOT, file).split(path.sep).join('/');
    const code = blankComments(fs.readFileSync(file, 'utf8'));

    if (!MAY_HOLD_ENQUEUE.has(rel) && HOLDS_ENQUEUE.test(code)) {
      offenders.push(`${rel}:${lineOf(code, code.search(HOLDS_ENQUEUE))} takes the manager's enqueue into a local binding — `
        + 'queue work from run-service, where env(runId) is built');
    }

    for (const c of childStarters(rel, code)) {
      total++;
      const at = `${rel}:${c.line}`;
      const key = `${rel} → ${c.callee}(${c.child})`;
      if (c.unreadable) {
        offenders.push(`${at} ${c.callee}(…) — the canary could not find the end of this call, so it cannot read its env`);
        continue;
      }
      if (c.region !== null) {
        // The child's OWN env, and only that: the top-level `env` of the options object it is
        // started with. Reading every `env:` in the call instead was a false negative with a name —
        // a site that set no env of its own, and so inherited one, passed on the strength of an
        // `env: env(runId)` sitting in a neighbouring field that no child ever receives.
        const options = optionsObject(c.region);
        const entry = options ? childEnvEntry(options) : null;
        const problem = !entry
          ? 'hands its child no `env` of its own, so it inherits whatever the manager defaults to'
          : entry.kind === 'shorthand'
            ? ((p) => (p ? `hands its child the shorthand \`{ env }\`, and ${p}` : null))(aliasProblem('env', code))
            : ((p) => (p ? `hands its child an env that ${p}` : null))(envProblem(entry.text, code));
        if (!problem) {
          if (rel === RUN_SERVICE) pinnedInRunService++;
          continue; // provably pinned: no licence needed, and none should be written for it
        }
        if (EXEMPT.has(key)) { seen.add(key); continue; }
        offenders.push(`${at} ${c.callee}(${c.child}) ${problem} — so a box with UPSCALE_ENABLED=true would pay for a silent Topaz pass on this lane`);
        continue;
      }
      if (EXEMPT.has(key)) { seen.add(key); continue; }
      offenders.push(`${at} names ${c.child} outside any spawn or enqueue the canary can read — move it inside the call so its env can be judged`);
    }
  }

  assert.deepEqual(offenders, [],
    `these start a child that is neither pinned to run-service's env(runId) nor licensed:\n  ${offenders.join('\n  ')}\n`
    + 'Build the child\'s env from env(runId) so UPSCALE_ENABLED is pinned off in it, or add the exact key above to '
    + 'EXEMPT in this file with the reason that child cannot spend.');

  // A guard that has quietly stopped reading is worse than none, so two floors. The first is the
  // choke point itself: run-service has six enqueue sites and every one of them must have been read
  // AND judged pinned. The second is the net as a whole.
  assert.ok(pinnedInRunService >= 6,
    `the canary read only ${pinnedInRunService} pinned enqueue sites in ${RUN_SERVICE} — it has stopped reading the file it guards`);
  assert.ok(total >= 14,
    `the canary caught only ${total} child-starting sites under web/server — it has stopped reading the tree it guards`);

  // …and the licences do not rot in either direction: one that names a call its file no longer makes
  // is a standing permission nobody is using, and a missing one means the net went blind on a call it
  // used to see (the failure mode a desynced text walker produces).
  assert.deepEqual([...seen].sort(), [...EXEMPT.keys()].sort(),
    'the licensed set and what the canary actually found have drifted apart — a licence naming a call that no longer '
    + 'exists should be deleted; a licensed call the canary no longer finds means the scanner went blind on it');
});

// ── the loop the pin actually rides on: a real child, a real .env ───────────────────────────────

/** Ask a child what IT thinks config.upscale.enabled is, exactly the way every spawned CLI finds
 *  out: `import 'dotenv/config'` at the top of config.js, pointed at a real file by
 *  DOTENV_CONFIG_PATH. No network, no ffmpeg, no keys used — config.js only reads env and computes.
 *
 *  `argv` is not decoration either: dotenv reads its options out of process.argv as well as out of
 *  the environment, so a child's ARGUMENTS are a second channel into the same decision, and the test
 *  below needs to hand a child one to show that. */
const CONFIG_URL = pathToFileURL(path.join(HOST_ROOT, 'config.js')).href;
function askAChild(env, argv = []) {
  const r = spawnSync(process.execPath,
    ['-e', `import(${JSON.stringify(CONFIG_URL)}).then((m) => process.stdout.write(String(m.default.upscale.enabled)))`, ...argv],
    { cwd: HOST_ROOT, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `the child could not answer: ${r.stderr}`);
  return r.stdout.trim();
}

// The one test in this file that proves the MECHANISM rather than the payload. Everything else
// asserts that the env object carries the string 'false'; a string only wins over a .env because
// `dotenv/config` loads with override:false and leaves an already-present variable alone. Swap that
// import for dotenvx or dotenv.config({ override: true }) and every other assertion here stays green
// while paid Topaz quietly resumes — so this spawns the real thing and asks it.
//
// The control child is not ceremony: without it a broken DOTENV_CONFIG_PATH would make this test
// pass by reading no .env at all, which is the exact way the fixture used to be inert.
test('a real child, reading a real .env that says true, still comes up with the upscale OFF', () => {
  // childEnv exactly as app.js:64 builds it for an isolated env root — this is the wiring that
  // points a spawned child's dotenv at our fixture instead of the developer's own .env.
  const { svc, enqueued } = harness({ childEnv: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: ENV_FILE } });
  svc.assemble(freshRun());
  const child = enqueued.at(-1);

  const { UPSCALE_ENABLED: pin, ...unpinned } = child.env;
  assert.equal(pin, 'false', 'the pin must actually be present in the env this child was handed');
  assert.equal(child.env.DOTENV_CONFIG_PATH, ENV_FILE, 'and the child must be pointed at the fixture .env');

  assert.equal(askAChild(unpinned), 'true',
    'CONTROL: the fixture .env is live and dotenv reads it — without the pin this child upscales');
  assert.equal(askAChild(child.env), 'false',
    'and with the pin the child\'s own config says off, because dotenv never overwrites a variable it was handed');
});

// override:false is the switch everyone knows about, and it is not the only one. `dotenv/config`
// merges its options from three places: the defaults in lib/main.js, lib/env-options.js (which reads
// DOTENV_CONFIG_OVERRIDE straight out of the environment) and lib/cli-options.js (which regex-matches
// EVERY bare element of process.argv against ^dotenv_config_(encoding|path|quiet|debug|override|
// DOTENV_KEY)=…). Two of those are live wires: either one turns the pin into a suggestion.
//
// Neither is reachable, and the reasons are structural rather than careful, which is why they are
// worth pinning down. The variable has no channel: the real servers hand children a strict allowlist
// (server.js:42 — PATH/HOME/USER/LOGNAME/TERM/TMPDIR, plus the few the app pins itself), so there is
// nothing to carry a DOTENV_CONFIG_* through. The argv element has no author: on the lanes whose
// child can reach finishRender the only user-shaped argument is an --out-name, and that goes through
// slugify, which turns '=' into '-'. Free text does reach argv — a --brief, a --feedback — but never
// on those lanes: the engine children are planners (the app never passes --render), and
// render-job.js and revise.js do not call finishRender at all.
//
// The second half of this test is aimed at the day that stops being true, and it is aimed
// STRUCTURALLY. Asserting that no argv element happens to look like `dotenv_config_override=` only
// ever tests the payload the harness drove, and the harness drives benign text — so a new free-text
// argument on a finishing lane sailed through it. What is asserted instead is the SHAPE of every
// argument those lanes build: a flag from a closed list, a path inside the run's own directories, or
// a slug. Free text is none of those, whatever it happens to say today.
test('the pin has three switches, and the two that could flip it cannot be reached from here', () => {
  const base = { PATH: process.env.PATH, DOTENV_CONFIG_PATH: ENV_FILE, UPSCALE_ENABLED: 'false' };
  assert.equal(askAChild(base), 'false',
    'switch 1, the default: dotenv/config loads with override:false, which is the whole reason a pin works');
  assert.equal(askAChild({ ...base, DOTENV_CONFIG_OVERRIDE: 'true' }), 'true',
    'switch 2 is a live wire — an environment variable, so the guard has to be that no such variable is ever passed');
  assert.equal(askAChild(base, ['dotenv_config_override=true']), 'true',
    'switch 3 is a live wire — a bare argv element, so the guard has to be that no free text reaches a finishing child');

  // The whole argv vocabulary of the two CLIs that call finishRender (render.js and assemble.js).
  const FINISHING_FLAGS = /^--(spec|out|out-name|from|probe|prompt-overrides|upscale)$/;
  const SLUG = /^[a-z0-9-]+$/; // what outNameFor produces, via slugify
  const insideRun = (a) => [runsDir, outDir].some((d) => a === d || a.startsWith(d + path.sep));
  const CAN_FINISH = new Set(['render', 'probe', 'assemble', 'upscale']); // renderSpec and assembleRun, the two callers of finishRender

  const { svc, enqueued } = harness();
  svc.createRun({ idea: 'dotenv_config_override=true', backend: 'seedance', aspect: '9:16', durationS: 10 });
  svc.render(freshRun(), { mode: 'full' });
  svc.render(freshRun(), { mode: 'probe' });
  svc.rerenderJob(freshRun(), { jobId: 'K1', feedback: 'dotenv_config_override=true' });
  svc.revise(freshRun(), { feedback: 'dotenv_config_override=true', scope: 'whole' });
  svc.assemble(freshRun());
  svc.approve(freshRun(), { upscale: true, provider: 'fal' });

  for (const job of enqueued) {
    // What this can and cannot see: harness() supplies its OWN childEnv, so the strict allowlist the
    // real server.js builds is not observable from here and this is not a test of it. What it does
    // test is the half that IS local — that env(runId) itself introduces no DOTENV_CONFIG_* beyond
    // the DOTENV_CONFIG_PATH a host may legitimately hand it (app.js:64, for an isolated env root).
    assert.ok(!Object.keys(job.env).some((k) => k.startsWith('DOTENV_CONFIG_') && k !== 'DOTENV_CONFIG_PATH'),
      `the ${job.kind} child was handed a dotenv OPTION variable by env(runId) itself`);
    if (job.kind === 'plan') {
      assert.ok(!job.args.includes('--render'),
        'the plan lane carries a free-text --brief, so it must stay a planner: --render here would walk that text into finishRender');
      continue;
    }
    if (!CAN_FINISH.has(job.kind)) continue; // render-job and revise carry free text and cannot finish
    for (const raw of job.args) {
      const a = String(raw);
      assert.ok(FINISHING_FLAGS.test(a) || insideRun(a) || SLUG.test(a),
        `the ${job.kind} child can reach finishRender and carries the argv element ${JSON.stringify(a)}, which is `
        + 'neither one of its flags, nor a path inside this run, nor a slug — free text on a finishing lane is a '
        + 'second channel into dotenv (`dotenv_config_override=true` is a bare argv element), so either it does not '
        + 'belong on this lane or this list has to grow on purpose');
    }
  }
});

// ── the sweep ───────────────────────────────────────────────────────────────────────────────────

// One assertion per LANE, on top of the canary above rather than instead of it. The canary proves
// no spawn site escapes env(runId) by reading the source; this proves env(runId) actually carries
// the pin on every kind the service can produce, through the real code path that builds each job.
//
// It claims nothing about a `.env`, and its name no longer says otherwise: the job manager here is a
// stub and no child in this test is ever started, let alone allowed to read a file. What beats a
// `.env` is the one real child two sections up, and that is the only place the question is settled.
test('every kind this service enqueues is handed the flag OFF', () => {
  const { svc, enqueued } = harness();

  svc.createRun({ idea: 'a lamp goes dark', backend: 'seedance', aspect: '9:16', durationS: 10 });
  svc.plan(freshRun());
  svc.render(freshRun(), { mode: 'full' });
  svc.render(freshRun(), { mode: 'probe' }); // two jobs in the seed, so the single-job probe refusal cannot fire
  svc.rerenderJob(freshRun(), { jobId: 'K1' });
  svc.revise(freshRun(), { feedback: 'warmer ending', scope: 'whole' });
  svc.assemble(freshRun());
  svc.approve(freshRun(), { upscale: true, provider: 'fal' });

  assert.deepEqual(
    new Set(enqueued.map((j) => j.kind)),
    new Set(['plan', 'render', 'probe', 'render-job', 'revise', 'assemble', 'upscale']),
    'every kind this service can enqueue is exercised here — the canary above is what catches a NEW spawn site',
  );
  for (const job of enqueued) {
    assert.equal(job.env.UPSCALE_ENABLED, 'false',
      `the ${job.kind} child (lane ${job.lane}) must not inherit the CLI's auto-upscale flag`);
  }
});

// The half the user is shown a promise about: "Finish free (assemble)", and an approve bar that says
// "Approving is free." A silent Topaz pass on this lane is unpriced (no estimate was ever quoted),
// unrecorded (this lane writes no cost-ledger row at all) and mislabelled — three ways of saying the
// user was charged for something nobody offered them.
test('the free assemble is free: no --upscale in argv, and the flag cannot supply one', () => {
  const { svc, enqueued } = harness();
  svc.assemble(freshRun());

  const child = enqueued.at(-1);
  assert.equal(child.lane, 'free');
  assert.equal(child.kind, 'assemble');
  assert.ok(!child.args.includes('--upscale'), 'nothing in argv asks this child to spend');
  assert.equal(child.env.UPSCALE_ENABLED, 'false', 'and nothing in its environment does either');
});

// The other half, and the larger one: a full render's estimate and its cost-ledger row price the
// RENDER. Topaz on top of it is one paid job per sub-1080p clip, against a number the user already
// agreed to.
test('a full render is billed for the render alone', () => {
  const { svc, enqueued } = harness();
  svc.render(freshRun(), { mode: 'full' });

  const child = enqueued.at(-1);
  assert.equal(child.kind, 'render');
  assert.ok(!child.args.includes('--upscale'), 'the web never asks render.js to upscale');
  assert.equal(child.env.UPSCALE_ENABLED, 'false');
});

// …and the pin must not have cost the app the upscale it DOES sell. Approve spends because of argv,
// which the child tests FIRST (`if (upscale || config.upscale.enabled)`), so the flag is never even
// read there — while the vendor and the knobs that priced the ledger row still ride pinned.
test('the priced approve-time upscale is untouched: --upscale, its vendor and its price knobs all still ride', () => {
  const { svc, enqueued } = harness();
  svc.approve(freshRun(), { upscale: true, provider: 'fal' });

  const child = enqueued.at(-1);
  assert.equal(child.lane, 'spend');
  assert.equal(child.kind, 'upscale');
  assert.ok(child.args.includes('--upscale'), 'this child is asked to spend, out loud, in argv');
  assert.equal(child.env.UPSCALE_PROVIDER, 'fal', 'the vendor approve resolved, priced and key-checked');
  assert.ok('FAL_TOPAZ_MODEL' in child.env, 'the model the ledger row was priced at');
  assert.ok('FAL_TOPAZ_MAX_FACTOR' in child.env, 'and the factor cap it was priced at');
  assert.equal(child.env.UPSCALE_ENABLED, 'false',
    'the pin lands here too and changes nothing — the argument is what makes this child spend');
});

// A user who exports UPSCALE_ENABLED=true in the shell before launching the server has said the same
// thing the .env says, through a channel that outranks it — childEnv is spread into the child ahead
// of everything, exactly as dotenv leaves an already-set variable alone. The pin is written AFTER
// that spread for this reason: it is the app's own answer, not a default anyone can talk over.
test('a childEnv that turns the flag on does not win over the pin', () => {
  const { svc, enqueued } = harness({ childEnv: { PATH: process.env.PATH, UPSCALE_ENABLED: 'true' } });
  svc.assemble(freshRun());
  svc.render(freshRun(), { mode: 'full' });

  for (const job of enqueued) {
    assert.equal(job.env.UPSCALE_ENABLED, 'false', `${job.kind}: the pin is last, so it is the answer`);
  }
});

// The other direction a pin can be lost from: not a deployment talking over it, but the RUN. env(runId)
// spreads a per-run resolution pick — a real choice a user made, which genuinely must reach the child —
// and the pins are written after that spread. Nothing enforced that ordering until here: every other run
// in this file has made no pick, so resolutionOverride returns {} and the spread it is written after is
// empty. This one makes a pick, so the ordering is exercised rather than admired.
test('a per-run pick rides to the child, and still cannot occupy a pinned key', () => {
  const { svc, enqueued } = harness();
  svc.render(freshRun({ resolution: '480p' }), { mode: 'full' });

  const child = enqueued.at(-1);
  assert.equal(child.env.SEEDANCE_RESOLUTION, '480p', "the run's own pick reaches the child — that spread is not decoration");
  assert.equal(child.env.RENDER_RESOLUTION_PICK, '480p', 'and it is marked a deliberate pick, not an inherited default');
  assert.equal(child.env.UPSCALE_ENABLED, 'false', 'and the pin, written after it, is still the answer');
});

// The literal itself, read the way the child reads it. config.js is the oracle (see
// test/unit/env-file.test.js for the same check against buildConfig directly): if `false` ever
// stopped coercing to OFF, every assertion above would still pass while the money moved.
//
// The `typeof` check comes first and is load-bearing. buildConfig({ UPSCALE_ENABLED: undefined })
// is ALSO false, so without it this test is satisfied by the pin being absent — it would pass with
// the very line it is named after deleted, which is not a test, it is a decoration.
test("the pinned literal is what config.js calls off", async () => {
  const { buildConfig } = await import(path.join(HOST_ROOT, 'config.js'));
  const { svc, enqueued } = harness();
  svc.assemble(freshRun());

  const pinned = enqueued.at(-1).env.UPSCALE_ENABLED;
  assert.equal(typeof pinned, 'string', 'the pin must actually be written — an absent key would satisfy the oracle for free');
  assert.equal(buildConfig({ UPSCALE_ENABLED: pinned }).upscale.enabled, false,
    'the exact bytes the pin writes, through the exact reader the child applies');
});
