#!/usr/bin/env node
// Zero-dep test runner for web/server — mirrors the root test/run.js: discovers test/**/*.test.js
// and hands the EXPLICIT file list to `node --test` (Node 20 lacks --test globbing). First bare arg
// filters by subdir (unit|integration); any -flag is forwarded to node.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('-'));
const filter = args.find((a) => !a.startsWith('-'));

function findTests(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && e.name !== 'fixtures' && e.name !== 'helpers') out.push(...findTests(p));
    else if (e.isFile() && e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

const files = findTests(HERE).filter((f) => !filter || path.relative(HERE, f).startsWith(filter + path.sep));
if (!files.length) { console.error(`No test files found${filter ? ` under ${filter}/` : ''}.`); process.exit(1); }

const child = spawn(process.execPath, ['--test', '--test-timeout=120000', ...flags, ...files.sort()], { stdio: 'inherit' });
child.on('close', (code) => process.exit(code ?? 1));
