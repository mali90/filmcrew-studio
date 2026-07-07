import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv, upsertEnv, serializeEnv, getEnvValue, readEnvFileOrExample, writeEnv } from '../../src/lib/env-file.js';
import { mkTmp } from '../helpers/tmp.js';

test('parse/serialize round-trip preserves comments, blanks, and commented keys', () => {
  const src = '# header\nLLM_PROVIDER=openai\n\n# VOICES_DIR=./voices\nFAL_KEY=\n';
  const entries = parseEnv(src);
  assert.equal(serializeEnv(entries), src);
  // a `# KEY=` line is a comment, not an active KV
  assert.equal(getEnvValue(entries, 'VOICES_DIR'), undefined);
  assert.equal(getEnvValue(entries, 'LLM_PROVIDER'), 'openai');
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
