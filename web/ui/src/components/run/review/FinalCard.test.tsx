import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeRun } from '../../../test/fixtures';
import { renderReview } from './test-helpers';
import { FinalCard } from './FinalCard';

describe('FinalCard', () => {
  it('shows the finished video with the facts and a Download link to the final file', () => {
    const run = makeRun('complete');
    run.manifest!.costLedger = [
      { ts: '2026-07-04T10:00:00.000Z', action: 'render', estUsd: 4.16, note: 'full render' },
      { ts: '2026-07-04T10:30:00.000Z', action: 'upscale', estUsd: 0.84, note: 'topaz' },
      { ts: '2026-07-04T10:31:00.000Z', action: 'assemble', estUsd: null, note: 'free' },
    ];

    renderReview(<FinalCard run={run} />);
    expect(screen.getByText('Ocean Lighthouse is done')).toBeInTheDocument();
    expect(screen.getByTestId('final-video')).toHaveAttribute('src', '/api/media/out/ocean-final.mp4');
    expect(screen.getByText('13s')).toBeInTheDocument(); // duration target
    expect(screen.getByText('9:16')).toBeInTheDocument();
    expect(screen.getByText('yes')).toBeInTheDocument(); // upscaled
    expect(screen.getByText('$5.00')).toBeInTheDocument(); // summed ledger

    // ONE exit for the file: a plain same-origin download anchor (no reveal, no copy-path)
    const dl = screen.getByRole('link', { name: /download/i });
    expect(dl).toHaveAttribute('href', '/api/media/out/ocean-final.mp4');
    expect(dl).toHaveAttribute('download', 'ocean-final.mp4'); // saved under the on-disk name
    expect(screen.queryByRole('button', { name: /reveal|copy path/i })).not.toBeInTheDocument();
  });

  // estUsd:null means two different things in a ledger, and only one of them is "free": an assemble
  // really costs nothing, while a Segmind render spent money at a rate nobody publishes. Summing
  // them together would print a confident "$0.00" over a real bill.
  it('a ledger with unpriced work never totals to a confident figure', () => {
    const run = makeRun('complete');
    run.manifest!.costLedger = [
      { ts: '2026-07-04T10:00:00.000Z', action: 'full', estUsd: null, unpriced: true, note: 'estimate unavailable' },
      { ts: '2026-07-04T10:31:00.000Z', action: 'assemble', estUsd: null, note: 'free' },
    ];
    renderReview(<FinalCard run={run} />);
    expect(screen.getByText('not on file')).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('a partly-unpriced ledger states the known spend as a floor', () => {
    const run = makeRun('complete');
    run.manifest!.costLedger = [
      { ts: '2026-07-04T10:00:00.000Z', action: 'full', estUsd: 4.16, note: 'estimate' },
      { ts: '2026-07-04T10:30:00.000Z', action: 'upscale', estUsd: null, unpriced: true, note: 'topaz per-clip' },
    ];
    renderReview(<FinalCard run={run} />);
    expect(screen.getByText('$4.16 + unpriced work')).toBeInTheDocument();
  });
});
