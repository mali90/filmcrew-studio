#!/usr/bin/env node
// Zero-dep test entry. Discovers test/**/*.test.js and runs them with the built-in node:test runner
// by passing the files EXPLICITLY — so it works on Node 20 (whose `node --test` has no glob support;
// glob patterns were only added in Node 21) as well as newer Node, and on any OS (no shell globbing).
// It also excludes test/helpers/* (they don't end in .test.js), which a bare `node --test` would run.
//
//   node test/run.js                              # whole suite (test/**/*.test.js)
//   node test/run.js unit                         # only test/unit/*.test.js  (subdir filter)
//   node test/run.js --experimental-test-coverage # extra tokens starting with `-` pass to node
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Split args: anything starting with `-` is a node flag to forward; the first bare word is a subdir.
const argv = process.argv.slice(2);
const nodeFlags = argv.filter((a) => a.startsWith('-'));
const subdir = argv.find((a) => !a.startsWith('-')) ?? '';

const testDir = path.join(ROOT, 'test', subdir);
if (!existsSync(testDir)) { console.error(`No such test directory: ${path.relative(ROOT, testDir)}`); process.exit(1); }

function findTests(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findTests(p));
    else if (e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

const files = findTests(testDir).sort();
if (!files.length) { console.error(`No *.test.js files found under ${path.relative(ROOT, testDir)}`); process.exit(1); }

// `node --test <files…>` runs each file in its own child process (per-file env isolation preserved).
const res = spawnSync(process.execPath, ['--test', ...nodeFlags, ...files], { stdio: 'inherit', cwd: ROOT });
if (res.error) { console.error(res.error.message); process.exit(1); }
process.exit(res.status ?? 1);
