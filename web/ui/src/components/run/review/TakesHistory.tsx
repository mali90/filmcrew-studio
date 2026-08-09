// The quiet lineage list: revisions, takes and cuts interleaved chronologically, so the user can
// read how the current cut came to be. Dense, mono ids, timeAgo on the right.
import { useMemo } from 'react';
import type { RunDetail } from '../../../../../shared/api-types';
import { AGENTS } from '../../../../../shared/api-types';
import { usd, timeAgo } from '../../../lib/format';
import { truncate } from './lib';

interface HistoryItem { key: string; text: string; at: string }

type Cut = NonNullable<RunDetail['manifest']>['cuts'][number];

/** How a cut's seams were joined. "(local, free)" is literal: both paths are pure local ffmpeg, no
 *  API call and no spend. Cuts recorded before the stitcher existed say plain "stitched". */
function stitchLabel(cut: Cut) {
  if (cut.stitcher === 'seamless') {
    return `Seamless stitch — colour-matched, ${cut.matched ?? 0}/${cut.joints ?? 0} joints (local, free)`;
  }
  if (cut.stitcher === 'concat') return 'stitched — hard cut at each seam (local, free)';
  return 'stitched';
}

export function TakesHistory({ run }: { run: RunDetail }) {
  const items = useMemo<HistoryItem[]>(() => {
    const m = run.manifest;
    if (!m) return [];
    const all: HistoryItem[] = [
      ...m.revisions.map((r) => ({
        key: `rev-${r.id}`,
        text: `${r.id} · "${truncate(r.feedback ?? '', 60)}" → agents [${r.owners.map((i) => AGENTS[i]?.name ?? `#${i}`).join(', ')}]`,
        at: r.createdAt,
      })),
      ...m.takes.map((t) => ({
        key: `take-${t.id}`,
        // estUsd is null when the provider publishes no rate — say so rather than print "≈—",
        // which reads like the take was free.
        text: `${t.id} · ${t.mode}${t.jobId ? ` ${t.jobId}` : ''} · ${t.estUsd == null ? 'price not on file' : `≈${usd(t.estUsd)}`}`,
        at: t.createdAt,
      })),
      ...m.cuts.map((c) => ({
        key: `cut-${c.id}`,
        text: `${c.id} · ${stitchLabel(c)}`,
        at: c.createdAt,
      })),
    ];
    return all.sort((a, b) => a.at.localeCompare(b.at));
  }, [run.manifest]);

  return (
    <section className="rounded-r3 border border-line bg-surface-1 p-4">
      <h2 className="text-heading text-ink">History</h2>
      {items.length === 0 ? (
        <p className="mt-2 text-caption text-ink-muted">No takes yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {items.map((item) => (
            <li key={item.key} className="flex items-baseline justify-between gap-3 text-dense text-ink-secondary">
              <span className="min-w-0 truncate font-mono">{item.text}</span>
              <span className="tnum shrink-0 text-caption text-ink-muted">{timeAgo(item.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
