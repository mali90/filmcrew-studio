import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv, upsertEnv, serializeEnv, getEnvValue, dotenvValues, envBool, readEnvFileOrExample, writeEnv } from '../../src/lib/env-file.js';
import { mkTmp } from '../helpers/tmp.js';

test('parse/serialize round-trip preserves comments, blanks, and commented keys', () => {
  const src = '# header\nLLM_PROVIDER=openai\n\n# VOICES_DIR=./voices\nFAL_KEY=\n';
  const entries = parseEnv(src);
  assert.equal(serializeEnv(entries), src);
  // a `# KEY=` line is a comment, not an active KV
  assert.equal(getEnvValue(entries, 'VOICES_DIR'), undefined);
  assert.equal(getEnvValue(entries, 'LLM_PROVIDER'), 'openai');
});

// The two readers answer different questions on purpose, and the difference is load-bearing: the
// editor's entries keep every byte of a line so a rewrite can leave the rest of the file alone,
// while anything that must AGREE with a running process has to read the file the way dotenv did.
test('dotenvValues reads a .env exactly as dotenv does — and parseEnv still does not', async () => {
  const { parse } = await import('dotenv');
  const src = [
    'export A=1',
    'B=plain # trailing note',
    'C="  padded  "',
    'D=first',
    'D=last',
  ].join('\n') + '\n';
  assert.deepEqual({ ...dotenvValues(src) }, parse(src), 'dotenv itself is the oracle');
  assert.deepEqual({ ...dotenvValues(src) }, { A: '1', B: 'plain', C: '  padded  ', D: 'last' });
  // …and the wizard's editor keeps answering the question it exists for.
  const entries = parseEnv(src);
  assert.equal(getEnvValue(entries, 'D'), 'first', 'the FIRST active line is the one an upsert rewrites');
  assert.equal(getEnvValue(entries, 'B'), 'plain # trailing note', 'and it keeps the line verbatim');
  assert.equal(serializeEnv(entries), src);
});

test('upsert replaces in place, appends new, tracks changed, blanks, and rejects newlines', () => {
  const entries = parseEnv('# c\nA=1\nB=\n');
  const { entries: next, changed } = upsertEnv(entries, { A: '2', C: 'new', B: '' });
  assert.deepEqual(changed.sort(), ['A', 'C']); // B unchanged (already blank)
  assert.equal(getEnvValue(next, 'A'), '2');
  assert.equal(getEnvValue(next, 'C'), 'new');
  assert.equal(serializeEnv(next).includes('# c'), true); // comment preserved
  // identical re-upsert is a no-op
  assert.equal(upsertEnv(next, { A: '2' }).changed.length, 0);
  assert.throws(() => upsertEnv(entries, { A: 'line1\nline2' }), /newline/);
});

// The coercion half of the same promise: reading a value dotenv's way is worth nothing if the two
// sides then turn it into a flag differently. config.js is the oracle here — buildConfig is what the
// render child actually applies — and every mirror calls THIS function rather than re-testing the
// raw value, which is what a quoted, padded knob exposes.
test('envBool is config.js\'s boolean rule — a padded dotenv value included', async () => {
  const { buildConfig } = await import('../../config.js');
  assert.equal(envBool(undefined, true), true, 'unset means the caller\'s default');
  assert.equal(envBool('', false), false, 'so does empty — a blank knob is not a "false"');
  for (const on of ['1', 'true', 'TRUE', 'yes', 'On']) assert.equal(envBool(on, false), true, on);
  for (const off of ['0', 'false', 'no', 'off', 'maybe']) assert.equal(envBool(off, true), false, off);

  // dotenv keeps padding INSIDE quotes, so this is the exact string the child's process.env holds.
  assert.equal(dotenvValues('KLING_CHAIN_FRAMES=" true "\n').KLING_CHAIN_FRAMES, ' true ');
  assert.equal(envBool(' true ', false), true, 'a padded value is trimmed before it is tested');
  assert.equal(buildConfig({ KLING_CHAIN_FRAMES: ' true ' }).kling.chainFrames, true,
    'which is exactly what the render child does with it');
  assert.equal(buildConfig({ KLING_CHAIN_FRAMES: ' false ' }).kling.chainFrames, false);
});

test('readEnvFileOrExample prefers .env, falls back to .env.example, always targets <root>/.env', () => {
  const { dir, cleanup } = mkTmp('envfile');
  try {
    // no files -> source 'none', target still <root>/.env
    let r = readEnvFileOrExample(dir);
    assert.equal(r.source, 'none');
    assert.equal(r.path, path.join(dir, '.env'));
    // example present -> seeds from it
    fs.writeFileSync(path.join(dir, '.env.example'), 'X=1\n');
    r = readEnvFileOrExample(dir);
    assert.equal(r.source, '.env.example');
    // write .env then it wins
    writeEnv(path.join(dir, '.env'), parseEnv('X=2\n'));
    r = readEnvFileOrExample(dir);
    assert.equal(r.source, '.env');
    assert.equal(getEnvValue(parseEnv(r.text), 'X'), '2');
  } finally { cleanup(); }
});
