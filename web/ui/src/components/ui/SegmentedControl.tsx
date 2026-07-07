// Radio-group segmented control (backend, aspect, spec Formatted|JSON…). Arrow keys move the
// selection; the whole control is one tab stop.
import { useRef } from 'react';
import clsx from 'clsx';

export interface Segment<T extends string> { value: T; label: string; hint?: string; count?: number }

export function SegmentedControl<T extends string>({
  value, onChange, segments, label, disabled = false, className,
}: {
  value: T;
  onChange: (v: T) => void;
  segments: Segment<T>[];
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const idx = segments.findIndex((s) => s.value === value);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = segments[(idx + (e.key === 'ArrowRight' ? 1 : segments.length - 1)) % segments.length];
    onChange(next.value);
  };

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={clsx('inline-flex h-8 items-center gap-0.5 rounded-r2 bg-surface-2 p-0.5', disabled && 'opacity-50 pointer-events-none', className)}
    >
      {segments.map((s) => (
        <button
          key={s.value}
          type="button" // inside a <form> the default is "submit" — picking a segment must never submit
          role="radio"
          aria-checked={s.value === value}
          tabIndex={s.value === value ? 0 : -1}
          title={s.hint}
          onClick={() => onChange(s.value)}
          className={clsx(
            'h-7 rounded-[5px] px-2.5 text-label transition-colors duration-[120ms]',
            s.value === value ? 'bg-surface-1 text-ink border border-line-strong' : 'text-ink-muted hover:text-ink-secondary',
          )}
        >
          {s.label}
          {s.count !== undefined && (
            <span className={clsx('tnum ml-1.5 text-caption', s.value === value ? 'text-ink-muted' : 'text-ink-faint')}>
              {s.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
