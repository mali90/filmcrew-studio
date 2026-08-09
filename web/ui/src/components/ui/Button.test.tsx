import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('renders the CostTag with the estimated price for money-bearing actions', () => {
    render(<Button costUsd={4.2}>Full render</Button>);
    expect(screen.getByRole('button', { name: /full render/i })).toBeInTheDocument();
    expect(screen.getByLabelText('estimated cost $4.20')).toHaveTextContent('≈ $4.20');
  });

  it('free actions carry no cost tag', () => {
    render(<Button>Assemble</Button>);
    expect(screen.queryByLabelText(/estimated cost/)).not.toBeInTheDocument();
  });

  // ── "The estimate hasn't loaded" vs "there is no rate" ────────────────────
  // Both arrive as costUsd === null, and confusing them is how a working backend gets locked
  // behind a spinner that never stops (Segmind publishes no per-second rate for anything we drive,
  // so its estimate never resolves to a number).
  it('a still-loading estimate disables the button and shows the ≈ $… placeholder', () => {
    render(<Button costUsd={null}>Full render</Button>);
    const btn = screen.getByRole('button', { name: /full render/i });
    expect(btn).toBeDisabled();
    expect(within(btn).getByText(/\$…/)).toBeInTheDocument();
  });

  it('an unknown RATE warns without blocking: enabled, labelled "price not set", no $ figure', async () => {
    const onClick = vi.fn();
    render(<Button costUsd={null} costUnknown onClick={onClick}>Full render</Button>);
    const btn = screen.getByRole('button', { name: /full render/i });
    expect(btn).toBeEnabled();

    const tag = screen.getByLabelText('price not set');
    expect(tag.textContent ?? '').not.toMatch(/\$/);   // no invented figure, not even "$0.00"
    expect(tag.textContent ?? '').not.toMatch(/…/);     // and it is not pretending to still be loading
    expect(btn.title).toMatch(/spends real money/i);    // unknown is not free

    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('loading disables and shows the inline spinner while keeping the label', async () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Plan it</Button>);
    const btn = screen.getByRole('button', { name: /plan it/i });
    expect(btn).toBeDisabled();
    await userEvent.click(btn).catch(() => {});
    expect(onClick).not.toHaveBeenCalled();
  });
});
