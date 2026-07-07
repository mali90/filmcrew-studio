import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../helpers/cli.js';
import { ROOT } from '../helpers/fixtures.js';

// The wizard uses config ROOT (the repo), not cwd — so we can't isolate via cwd. Instead we handle
// both realities safely: if a .env already exists (dev), it must be left byte-untouched; if not (CI),
// init seeds one from .env.example and we clean it up.
test('init non-interactive: existing .env untouched, or seeded-then-cleaned', async () => {
  const envPath = path.join(ROOT, '.env');
  const existedBefore = fs.existsSync(envPath);
  const before = existedBefore ? fs.readFileSync(envPath) : null;
  const { code, stdout, stderr } = await runCli('src/cli/init.js', ['--yes', '--no-ai'], {
    input: '',
    env: { FAL_KEY: 'fake', LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli' },
  });
  const out = stdout + stderr;
  try {
    assert.equal(code, 0, out);
    // stdout markers are written directly (not via the logger, so LOG_LEVEL can't suppress them).
    assert.match(stdout, /interactive|health check/i);
    // The real behavioral assertion is the file state:
    if (existedBefore) {
      assert.deepEqual(fs.readFileSync(envPath), before, '.env must be byte-unchanged');
    } else {
      assert.ok(fs.existsSync(envPath), 'seeded a .env from .env.example');
    }
  } finally {
    if (!existedBefore && fs.existsSync(envPath)) fs.rmSync(envPath); // clean the CI-seeded .env
  }
});
