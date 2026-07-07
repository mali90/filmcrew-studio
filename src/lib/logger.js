// Tiny dependency-free logger with levels + a timestamp. Writes to stderr so that
// CLIs can still emit machine-readable JSON to stdout.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const active = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function emit(level, args) {
  if (LEVELS[level] < active) return;
  const tag = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[level];
  process.stderr.write(`[${ts()}] ${tag} ${args.map(fmt).join(' ')}\n`);
}

function fmt(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
  // A visible step header.
  step: (msg) => process.stderr.write(`\n\x1b[1m\x1b[36m▶ ${msg}\x1b[0m\n`),
};

export default log;
