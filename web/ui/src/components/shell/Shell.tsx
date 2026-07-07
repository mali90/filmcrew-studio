// The app shell: a 56px top bar (three destinations — this is a creative tool, not an ops
// console), the now-rendering pill, the health dot, and the routed page below.
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Settings, Moon, Sun } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../api/client';
import { useGlobalEvents } from '../../hooks/useGlobalEvents';
import { useEffect, useState } from 'react';

function HealthDot() {
  const q = useQuery({ queryKey: ['doctor'], queryFn: api.doctor, staleTime: 5 * 60_000, retry: 0 });
  const hard = q.data?.hard ?? 0;
  const soft = q.data?.checks?.some((c) => !c.ok && c.soft) ?? false;
  const color = q.isError || hard > 0 ? 'bg-status-failed' : soft ? 'bg-status-warn' : 'bg-status-done';
  const title = q.isError ? 'health check failed' : hard > 0 ? `${hard} problem(s) — open Settings` : soft ? 'minor warnings — open Settings' : 'all checks pass';
  return (
    <Link to="/settings" aria-label={`system health: ${title}`} title={title} className="flex h-8 w-8 items-center justify-center rounded-r2 hover:bg-surface-2">
      <span className={clsx('h-2 w-2 rounded-full', color)} />
    </Link>
  );
}

function NowRenderingPill() {
  const { active } = useGlobalEvents();
  const navigate = useNavigate();
  const job = active.find((j) => j.lane === 'spend') ?? active[0];
  if (!job || job.runId.startsWith('voice-')) return null;
  return (
    <button
      onClick={() => navigate(`/runs/${job.runId}`)}
      className="flex h-7 items-center gap-2 rounded-full bg-[var(--accent-soft)] px-3 text-caption font-medium text-accent hover:bg-[var(--accent-soft)]"
    >
      <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-status-active" aria-hidden />
      {job.kind === 'plan' || job.kind === 'revise' ? 'Planning' : 'Rendering'}…
    </button>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('kva-theme', theme); } catch { /* private mode */ }
  }, [theme]);
  return (
    <button
      aria-label={`switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      className="flex h-8 w-8 items-center justify-center rounded-r2 text-ink-muted hover:bg-surface-2 hover:text-ink-secondary"
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
    >
      {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}

export function Shell() {
  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-r2 focus:bg-surface-3 focus:px-3 focus:py-1.5">
        Skip to content
      </a>
      <header className="sticky top-0 z-40 h-14 border-b border-line bg-surface-0/90 backdrop-blur-md">
        <div className="mx-auto flex h-full max-w-[1280px] items-center gap-1 px-6">
          <Link to="/" className="mr-4 text-label font-semibold text-ink">Filmcrew Studio</Link>
          {[{ to: '/', label: 'Create' }, { to: '/library', label: 'Library' }, { to: '/cast', label: 'Cast' }].map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === '/'}
              className={({ isActive }) => clsx(
                'relative flex h-14 items-center px-3 text-label transition-colors',
                isActive ? 'text-ink after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-accent' : 'text-ink-secondary hover:text-ink',
              )}
            >
              {l.label}
            </NavLink>
          ))}
          <div className="flex-1" />
          <NowRenderingPill />
          <HealthDot />
          <ThemeToggle />
          <NavLink to="/settings" aria-label="Settings" className={({ isActive }) => clsx('flex h-8 w-8 items-center justify-center rounded-r2 hover:bg-surface-2', isActive ? 'text-ink' : 'text-ink-muted')}>
            <Settings size={15} />
          </NavLink>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-[1280px] px-6 pb-16 pt-6">
        <Outlet />
      </main>
    </div>
  );
}
