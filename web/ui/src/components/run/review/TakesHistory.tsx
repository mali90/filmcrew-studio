// The quiet lineage list: revisions, takes, cuts, deliveries and the lifecycle markers between them,
// interleaved chronologically, so the user can read how the current cut came to be. Dense, mono ids,
// timeAgo on the right.
//
// A leading glyph column marks the rows that are not routine work (spec D27): a delivery, a reopen,
// a prompt edit. The ordinary take/cut/revision rows keep the column's width and stay blank — the
// marked rows are the ones a reader scans for, and giving every row an icon would hide them again.
import { useMemo, useState, type ReactNode } from 'react';
import { BadgeCheck, PenLine } from 'lucide-react';
import type { RunDetail } from '../../../../../shared/api-types';
import { AGENTS } from '../../../../../shared/api-types';
import { usd, spendLabel, timeAgo } from '../../../lib/format';
import { truncate } from './lib';

/** How many rows the rail shows before the list folds behind "Show all" (U13). */
const VISIBLE_ROWS = 8;

interface HistoryItem { key: string; text: string; at: string; glyph?: ReactNode }

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

/** The row for one lifecycle marker, or null for a kind this build does not draw yet — a manifest
 *  written by a newer server must never break the panel that reads it. */
function markerRow(h: NonNullable<NonNullable<RunDetail['manifest']>['history']>[number]): HistoryItem | null {
  if (h.kind === 'reopen') {
    return { key: `hist-${h.id}`, text: 'reopened for changes', at: h.at, glyph: <PenLine size={11} className="text-status-warn" aria-hidden /> };
  }
  // A prompt edit changes the words the NEXT render will send — free to save, and no clip moved.
  if (h.kind === 'prompt-edit' || h.kind === 'prompt-discard') {
    const what = h.kind === 'prompt-edit' ? 'prompt edited' : 'prompt edit discarded';
    return {
      key: `hist-${h.id}`,
      text: h.job ? `${h.job} ${what}` : what,
      at: h.at,
      glyph: <PenLine size={11} className="text-accent" aria-hidden />,
    };
  }
  return null;
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
      // Deliveries (WS2-P6). Absent on runs delivered before `finals` existed, which is why nothing
      // is derived from `approved` here: a missing history is "not recorded", not "never delivered".
      ...(m.finals ?? []).map((f) => ({
        key: `final-${f.id}`,
        text: `${f.id} · delivered${f.upscaled ? ' · upscaled' : ''}`,
        at: f.at,
        glyph: <BadgeCheck size={11} className="text-status-done" aria-hidden />,
      })),
      ...(m.history ?? []).map(markerRow).filter((x): x is HistoryItem => x !== null),
    ];
    return all.sort((a, b) => a.at.localeCompare(b.at));
  }, [run.manifest]);

  // Long runs fold to the newest rows (U13): the rail stays scannable, the lineage stays one
  // quiet click away. Items are chronological, so the newest live at the tail.
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(-VISIBLE_ROWS);

  const ledger = run.manifest?.costLedger ?? [];

  return (
    <section className="rounded-r3 border border-line bg-surface-1 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-heading text-ink">History</h2>
        {/* the cumulative spend must not vanish at the stage that offers more paid actions (U6) —
            spendLabel already words an unpriced ledger honestly */}
        {ledger.length > 0 && (
          <span className="tnum text-caption text-ink-muted">≈{spendLabel(ledger)} so far</span>
        )}
      </div>
      {items.length === 0 ? (
        <p className="mt-2 text-caption text-ink-muted">No takes yet.</p>
      ) : (
        <>
          <ul className="mt-2 flex flex-col gap-1.5">
            {visible.map((item) => (
              <li key={item.key} className="flex items-baseline justify-between gap-3 text-dense text-ink-secondary">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="flex w-[11px] shrink-0 justify-center self-center">{item.glyph}</span>
                  <span className="min-w-0 truncate font-mono">{item.text}</span>
                </span>
                <span className="tnum shrink-0 text-caption text-ink-muted">{timeAgo(item.at)}</span>
              </li>
            ))}
          </ul>
          {items.length > VISIBLE_ROWS && (
            <button
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll((v) => !v)}
              className="mt-1.5 text-caption text-accent hover:text-accent-hover"
            >
              {showAll ? `Show newest ${VISIBLE_ROWS}` : `Show all (${items.length})`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
