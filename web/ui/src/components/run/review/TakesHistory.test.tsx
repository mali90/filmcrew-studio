import { screen } from '@testing-library/react';
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
});
