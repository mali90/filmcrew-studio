// The two provider checks the doctor grew when Segmind arrived, seen through the health UI.
//
// Both are the same shape of trap and both are settings problems, not cast problems:
//   * segmind-key is SOFT for a fal user and HARD for someone whose backend renders on Segmind, and
//     the row has to read as optional in the first case — a red "missing key" for a provider you
//     never chose teaches people to ignore the health list;
//   * render-assets is the one that actually loses money: SEGMIND_UPLOAD_MODE=fal-storage with no
//     FAL_KEY passes every other check and then dies on the first upload of every render, so its
//     hint must name BOTH ways out rather than just "add a fal key".
// Neither offers the Cast affordance the other soft rows do — there is nothing to fix in Cast.
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { DoctorReport } from '../../../../shared/api-types';
import { CheckRow } from './CheckRow';
import { webHint } from './copy';

type Check = DoctorReport['checks'][number];

const row = (check: Check, context: 'wizard' | 'settings' = 'settings') => render(
  <MemoryRouter>
    <ul>
      <CheckRow check={check} context={context} refetching={false} failedRechecks={0} allChecks={[check]} onRecheck={() => {}} />
    </ul>
  </MemoryRouter>,
);

const SEGMIND_KEY: Check = { id: 'segmind-key', ok: false, label: 'SEGMIND_API_KEY set', hint: 'cli hint', soft: true };
const ASSETS: Check = {
  id: 'render-assets', ok: false, label: 'render assets reachable (segmind · fal-storage)', hint: 'cli hint', soft: false,
};

describe('health copy — the provider checks', () => {
  it('a soft Segmind key reads as optional and offers no Cast detour', () => {
    row(SEGMIND_KEY);
    expect(screen.getByText(/only if you switch a run to a Segmind backend/i)).toBeInTheDocument();
    expect(screen.queryByText('cli hint')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Cast' })).not.toBeInTheDocument();
  });

  it('a hard Segmind key names the variable and where a key comes from', () => {
    row({ ...SEGMIND_KEY, soft: false });
    const hint = screen.getByText(/Add SEGMIND_API_KEY to \.env/);
    expect(hint).toHaveTextContent(/segmind\.com/i);
  });

  // Both destinations grew a Segmind field, so the row may finally offer the jump — but only when
  // it is HARD. Sending a fal user to a key form for a provider they never chose is noise, and the
  // soft row's hint already says what the key would buy.
  it('only a HARD Segmind key offers the jump to the Keys card', () => {
    const onAnchor = vi.fn();
    render(
      <MemoryRouter>
        <ul>
          <CheckRow
            check={{ ...SEGMIND_KEY, soft: false }} context="settings" refetching={false}
            failedRechecks={0} allChecks={[SEGMIND_KEY]} onRecheck={() => {}} onAnchor={onAnchor}
          />
        </ul>
      </MemoryRouter>,
    );
    screen.getByRole('button', { name: 'Fix in Keys' }).click();
    expect(onAnchor).toHaveBeenCalledWith('keys-heading');
  });

  it('a soft Segmind key offers no fix button at all', () => {
    row(SEGMIND_KEY);
    expect(screen.queryByRole('button', { name: 'Fix in Keys' })).not.toBeInTheDocument();
  });

  it('render-assets offers BOTH remedies — a fal key or data-uri uploads', () => {
    row(ASSETS);
    const hint = screen.getByText(/SEGMIND_UPLOAD_MODE=data-uri/);
    expect(hint).toHaveTextContent(/fal key/i);
  });

  it('a fal key that nothing in the setup needs is described as optional, not broken', () => {
    const falOptional: Check = { id: 'fal-key', ok: false, label: 'FAL_KEY set', hint: 'cli hint', soft: true };
    expect(webHint(falOptional, 'settings')).toMatch(/Optional here/);
    expect(webHint({ ...falOptional, soft: false }, 'settings')).toBe('The render key is missing or invalid.');
  });

  it('the wizard shows the same rows without a Cast deferral note', () => {
    row(SEGMIND_KEY, 'wizard');
    expect(screen.queryByText('later, on the Cast page')).not.toBeInTheDocument();
  });
});
