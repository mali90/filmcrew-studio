// Minimal CLI arg parser: supports `--key value`, `--flag`, and positionals.
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** Read all of stdin (for piping a brief into the engine). Returns '' if a TTY.
 *  `timeoutMs` (optional) rejects if NO data has arrived in that window — guards against a
 *  non-TTY pipe left open with nothing piped in. Once the first byte arrives the timer is
 *  cleared, so a legitimately slow/large stream is never cut off. */
export async function readStdin({ timeoutMs } = {}) {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  let timer;
  const collect = (async () => {
    for await (const c of process.stdin) {
      if (timer) { clearTimeout(timer); timer = undefined; }
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString('utf8');
  })();
  if (!timeoutMs) return collect;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No stdin received within ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([collect, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default { parseArgs, readStdin };
