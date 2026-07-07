// The engine's terminal voice, kept behind a quiet header until it matters: expands itself when a
// run needs attention, follows the tail until the user scrolls back, and never restyles more than
// error/warn lines. role="log" so screen readers treat it as an additive stream.
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { RunDetail } from '../../../../shared/api-types';
import type { RunLive } from '../../api/run-events';

// the engine colors its terminal output — the browser shows words, not escape codes
const stripAnsi = (line: string) => line.replace(/\u001b\[[0-9;]*m|\[\d+m/g, '');

function lineClass(line: string): string {
  if (/ERR|failed/i.test(line)) return 'text-status-failed';
  if (/WRN/.test(line)) return 'text-status-warn';
  return 'text-ink-secondary';
}

export function LogViewer({ run, live, defaultExpanded = false }: {
  run: RunDetail;
  live: Pick<RunLive, 'log' | 'activeKind' | 'lastError'>;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [following, setFollowing] = useState(true);
  const wellRef = useRef<HTMLDivElement>(null);

  // errors force the log open — it is where the answer lives
  const needsAttention = run.status === 'attention' || Boolean(live.lastError);
  useEffect(() => {
    if (needsAttention) setExpanded(true);
  }, [needsAttention]);

  // follow the tail unless the user scrolled up
  useEffect(() => {
    const el = wellRef.current;
    if (el && expanded && following) el.scrollTop = el.scrollHeight;
  }, [live.log.length, expanded, following]);

  const onScroll = () => {
    const el = wellRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setFollowing(fromBottom <= 24);
  };

  const jumpToLatest = () => {
    setFollowing(true);
    const el = wellRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  return (
    <section aria-label="Log" className="rounded-r3 border border-line bg-surface-1">
      <button
        className="flex h-9 w-full items-center gap-2 px-4 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-label text-ink">Log</span>
        {live.activeKind && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-status-active" aria-hidden />}
        <span className="flex-1" />
        {expanded
          ? <ChevronUp size={14} className="text-ink-muted" aria-hidden />
          : <ChevronDown size={14} className="text-ink-muted" aria-hidden />}
      </button>
      {expanded && (
        <div className="relative px-3 pb-3">
          <div
            ref={wellRef}
            role="log"
            aria-label="Engine log"
            onScroll={onScroll}
            className="well max-h-80 overflow-y-auto rounded-r2 bg-stage p-3 font-mono text-caption"
          >
            {live.log.length === 0 ? (
              <p className="text-ink-faint">Nothing logged yet.</p>
            ) : (
              live.log.map((l) => (
                <p key={l.cursor} className={clsx('whitespace-pre-wrap', lineClass(l.line))}>{stripAnsi(l.line)}</p>
              ))
            )}
          </div>
          {!following && (
            <button
              onClick={jumpToLatest}
              className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full border border-line bg-surface-3 px-3 py-1 text-caption text-ink-secondary"
              style={{ boxShadow: 'var(--shadow-2)' }}
            >
              Following paused — Jump to latest
            </button>
          )}
        </div>
      )}
    </section>
  );
}
