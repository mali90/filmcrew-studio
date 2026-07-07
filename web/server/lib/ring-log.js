// Bounded in-memory log with monotone cursors — the per-run buffer behind the SSE `log` events
// and GET /api/runs/:id/log. Cursors never rewind, so a reconnecting client resumes with
// `since(lastSeenCursor)` and can never receive a duplicate line.
export function createRingLog(maxLines = 4000) {
  const lines = []; // [{cursor, line}]
  let next = 1;
  return {
    /** Append one line; returns its cursor. */
    append(line) {
      const cursor = next++;
      lines.push({ cursor, line });
      if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
      return cursor;
    },
    /** Lines with cursor > `cursor` (oldest evicted lines are simply gone — never duplicated). */
    since(cursor = 0) {
      return lines.filter((e) => e.cursor > cursor);
    },
    get size() { return lines.length; },
    get lastCursor() { return next - 1; },
  };
}

export default { createRingLog };
