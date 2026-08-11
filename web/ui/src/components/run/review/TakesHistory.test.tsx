import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeRun } from '../../../test/fixtures';
import { renderReview } from './test-helpers';
import { TakesHistory } from './TakesHistory';

describe('TakesHistory', () => {
  it('renders revisions, takes and cuts as one chronological lineage', () => {
    const run = makeRun('review');
    run.manifest!.revisions = [
      {
        id: 'r1',
        feedback: 'the keeper should look much older, weathered by forty years of salt wind and lamplight',
        scope: 'K2',
        owners: [2, 7],
        createdAt: '2026-07-04T11:00:00.000Z',
      },
    ];
    run.manifest!.takes = [
      { id: 't1', mode: 'full', revision: null, createdAt: '2026-07-04T10:00:00.000Z', estUsd: 4.2 },
      { id: 't2', mode: 'job', jobId: 'K2', revision: 'r1', createdAt: '2026-07-04T12:00:00.000Z', estUsd: 1.28 },
    ];
    run.manifest!.cuts = [
      { id: 'c1', take: 't1', master: '/abs/out/ocean.mp4', createdAt: '2026-07-04T10:05:00.000Z' },
      { id: 'c2', take: 't2', master: '/abs/out/ocean-2.mp4', createdAt: '2026-07-04T12:05:00.000Z' },
    ];

    renderReview(<TakesHistory run={run} />);

    const rows = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(rows).toHaveLength(5);
    // chronological: t1 → c1 → r1 → t2 → c2
    expect(rows[0]).toContain('t1 · full · ≈$4.20');
    expect(rows[1]).toContain('c1 · stitched');
    expect(rows[2]).toContain('r1 · "the keeper should look much older, weathered by forty years…" → agents [Scene Director, QC]');
    expect(rows[3]).toContain('t2 · job K2 · ≈$1.28');
    expect(rows[4]).toContain('c2 · stitched');
  });

  it('shows a single quiet caption when there is no lineage yet', () => {
    const run = makeRun('plan-ready');
    renderReview(<TakesHistory run={run} />);
    expect(screen.getByText('No takes yet.')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  // U6 — the cumulative spend stays visible at the stage that offers more paid actions.
  it('the header carries the running spend when the ledger has lines', () => {
    const run = makeRun('review');
    run.manifest!.costLedger = [
      { ts: '2026-07-04T10:00:00.000Z', action: 'render', estUsd: 1.46, note: 'full render' },
    ];
    renderReview(<TakesHistory run={run} />);
    expect(screen.getByText('≈$1.46 so far')).toBeInTheDocument();
  });

  it('no spend line while the ledger is empty', () => {
    renderReview(<TakesHistory run={makeRun('review')} />);
    expect(screen.queryByText(/so far/)).not.toBeInTheDocument();
  });

  // U13 — beyond 8 rows the list folds to the newest 8; the lineage stays one quiet click away.
  it('collapses a long history to the newest 8 rows behind a Show all toggle', () => {
    const run = makeRun('review');
    run.manifest!.cuts = [];
    run.manifest!.takes = Array.from({ length: 10 }, (_, i) => ({
      id: `t${i + 1}`,
      mode: 'full' as const,
      revision: null,
      createdAt: `2026-07-04T10:${String(i).padStart(2, '0')}:00.000Z`,
      estUsd: 1,
    }));
    renderReview(<TakesHistory run={run} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(8);
    expect(screen.queryByText(/t1 · full/)).not.toBeInTheDocument(); // the OLDEST rows fold away
    expect(screen.getByText(/t10 · full/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all (10)' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText(/t1 · full/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show newest 8' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(8);
  });

  it('a history of 8 rows or fewer shows no toggle', () => {
    renderReview(<TakesHistory run={makeRun('review')} />);
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
  });

  // ── Deliveries, reopens and prompt edits (WS2-P6, spec D27) ───────────────
  // The panel is the run's honest record, so the events that are NOT renders belong in it too: what
  // was delivered, when the user came back in, and when the words we send were changed.
  it('files deliveries, reopens and prompt edits in the same chronology, each with its glyph', () => {
    const run = makeRun('review');
    run.manifest!.takes = [{ id: 't1', mode: 'full', revision: null, createdAt: '2026-07-04T10:00:00.000Z', estUsd: 4.2 }];
    run.manifest!.cuts = [];
    run.manifest!.finals = [
      { id: 'final-1', cut: 'c1', final: '/abs/out/ocean-final.mp4', upscaled: true, at: '2026-07-04T11:00:00.000Z' },
    ];
    run.manifest!.history = [
      { id: 'reopen-1', kind: 'reopen', final: '/abs/out/ocean-final.mp4', at: '2026-07-04T12:00:00.000Z' },
      { id: 'prompt-edit-1', kind: 'prompt-edit', job: 'K2', at: '2026-07-04T13:00:00.000Z' },
      { id: 'prompt-discard-1', kind: 'prompt-discard', job: 'K2', at: '2026-07-04T14:00:00.000Z' },
    ];

    renderReview(<TakesHistory run={run} />);
    const rows = screen.getAllByRole('listitem');
    const text = rows.map((li) => li.textContent ?? '');

    expect(text[0]).toContain('t1 · full · ≈$4.20');
    expect(text[1]).toContain('final-1 · delivered · upscaled');
    expect(text[2]).toContain('reopened for changes');
    expect(text[3]).toContain('K2 prompt edited');
    expect(text[4]).toContain('K2 prompt edit discarded');

    // The glyph column tells the three kinds apart at a glance: a delivery is done, a reopen is a
    // state the run is still in, an edit is the accent colour every prompt affordance wears.
    const glyph = (row: HTMLElement) => row.querySelector('svg');
    expect(glyph(rows[1])).toHaveClass('text-status-done');
    expect(glyph(rows[1])?.getAttribute('width')).toBe('11');
    expect(glyph(rows[2])).toHaveClass('text-status-warn');
    expect(glyph(rows[3])).toHaveClass('text-accent');
    expect(glyph(rows[4])).toHaveClass('text-accent');
    // routine work keeps the column's width and stays unmarked, so the marked rows still stand out
    expect(glyph(rows[0])).toBeNull();
  });

  it('a delivery that was not upscaled says only that it was delivered', () => {
    const run = makeRun('review');
    run.manifest!.takes = [];
    run.manifest!.cuts = [];
    run.manifest!.finals = [{ id: 'final-1', cut: 'c1', final: '/abs/out/a.mp4', upscaled: false, at: '2026-07-04T11:00:00.000Z' }];
    renderReview(<TakesHistory run={run} />);
    expect(screen.getByRole('listitem')).toHaveTextContent('final-1 · delivered');
    expect(screen.queryByText(/upscaled/)).not.toBeInTheDocument();
  });

  // A manifest written by a newer server must never break the panel that reads it.
  it('ignores a lifecycle marker kind it does not draw yet', () => {
    const run = makeRun('review');
    run.manifest!.takes = [];
    run.manifest!.cuts = [];
    run.manifest!.history = [
      { id: 'x-1', kind: 'archived' as unknown as 'reopen', at: '2026-07-04T11:00:00.000Z' },
    ];
    renderReview(<TakesHistory run={run} />);
    expect(screen.getByText('No takes yet.')).toBeInTheDocument();
  });
});
