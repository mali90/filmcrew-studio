// The version floor row (ffmpeg-version): an ffmpeg that RUNS but predates the crossfade the
// seamless stitcher needs. It is soft on purpose — the render still finishes, it just joins with a
// hard cut at every seam — and it must not borrow the missing-binary row's install disclosure:
// that panel says "Install ffmpeg", which is exactly the thing this person already did.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { DoctorReport } from '../../../../shared/api-types';
import { CheckRow } from './CheckRow';

type Check = DoctorReport['checks'][number];

const OLD_FFMPEG: Check = {
  id: 'ffmpeg-version', ok: false, label: 'ffmpeg 4.3+ for seamless stitching (4.2.7)', hint: 'cli hint', soft: true,
};

const row = (check: Check, allChecks: Check[] = [check]) => render(
  <MemoryRouter>
    <ul>
      <CheckRow check={check} context="settings" platform="darwin" refetching={false} failedRechecks={0} allChecks={allChecks} onRecheck={() => {}} />
    </ul>
  </MemoryRouter>,
);

describe('health copy — the ffmpeg version floor', () => {
  it('names what an old ffmpeg costs and who does the updating', () => {
    row(OLD_FFMPEG);
    const hint = screen.getByText(/hard cut at every seam/i);
    expect(hint).toHaveTextContent(/never installs or updates ffmpeg/i);
    expect(screen.queryByText('cli hint')).not.toBeInTheDocument();
  });

  it('offers no install panel and no Cast detour — the binary is already there', () => {
    row(OLD_FFMPEG, [OLD_FFMPEG, { id: 'ffmpeg', ok: true, label: 'ffmpeg present (ffmpeg)', hint: '', soft: false }]);
    expect(screen.queryByRole('button', { name: /install/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Cast' })).not.toBeInTheDocument();
  });
});
