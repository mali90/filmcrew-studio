// The one thing worth pinning here: the version on screen IS the root package.json's, not prose.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { version } from '../../../../../package.json';
import { AboutCard } from './AboutCard';

describe('AboutCard', () => {
  it('shows the shipped version, read from the root package.json', () => {
    render(<AboutCard />);
    // Format first (a broken import would render "vundefined"), then identity (a second,
    // hand-written source is exactly the drift this component used to have).
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(screen.getByText(`v${version}`)).toBeInTheDocument();
  });
});
