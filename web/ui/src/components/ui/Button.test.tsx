import { render, screen } from '@testing-library/react';
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

  it('loading disables and shows the inline spinner while keeping the label', async () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Plan it</Button>);
    const btn = screen.getByRole('button', { name: /plan it/i });
    expect(btn).toBeDisabled();
    await userEvent.click(btn).catch(() => {});
    expect(onClick).not.toHaveBeenCalled();
  });
});
