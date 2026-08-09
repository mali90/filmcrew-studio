// The prompt sheet: the exact words that will leave for the provider, shown before they leave.
//
// Surface (spec D18): an INLINE DISCLOSURE in `main`, directly beneath whatever stage the run is
// in, pushing the log down. Not a modal and not a right-side sheet — reading a prompt is neither
// destructive nor paid, and Dialog is reserved for those (Don't #2). The pattern copies
// LogViewer/AgentRail: the control carries `aria-expanded`, and because the panel is not its
// sibling (the toggles live in the plan card, the job cards and the clip strip, while the panel
// lives under the stage band) it also carries `aria-controls`.
//
// Read-only in WS2-P3: this sheet SHOWS, it never sends. Every number in it — bytes, budget, the
// bytes the system already owns — is measured by the server with the same pure builder the renderer
// composes with, and is rendered here verbatim. Recomputing a byte count in the browser would be a
// second implementation of the one thing this screen promises not to have.
import { createContext, useContext, useMemo, useState, type PropsWithChildren, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Copy, FileText, Lock, X } from 'lucide-react';
import type { PromptSegment, PromptView, RunDetail } from '../../../../../shared/api-types';
import { api } from '../../../api/client';
import { Button } from '../../ui/Button';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { useToast } from '../../ui/Toast';
import { timeAgo, usd } from '../../../lib/format';
import { jobSeconds } from './lib';

/** The one panel every `[Prompt]` control points at with `aria-controls`. */
export const PROMPT_SHEET_ID = 'prompt-sheet';

/** What the sheet is open on: one job id, or `null` for the whole plan, job by job. */
export type PromptTarget = string | null;

interface PromptSheetApi {
  /** The open target — `undefined` when the sheet is closed (`null` is a real target: the plan). */
  target: PromptTarget | undefined;
  isOpen: (target: PromptTarget) => boolean;
  toggle: (target: PromptTarget) => void;
  close: () => void;
}

/** Outside a provider — an isolated component test — a `[Prompt]` control renders and stays inert.
 *  The page wraps every stage in the provider, so nothing a user can reach depends on this. */
const INERT: PromptSheetApi = { target: undefined, isOpen: () => false, toggle: () => {}, close: () => {} };

const Ctx = createContext<PromptSheetApi | null>(null);

/**
 * Holds which prompt the sheet is showing. It lives above `main` because the control that opens the
 * sheet and the sheet itself are in different components: a tile in the clip strip, a job card, or
 * the plan card can all point at the one panel under the stage band.
 */
export function PromptSheetProvider({ children }: PropsWithChildren) {
  const [target, setTarget] = useState<PromptTarget | undefined>(undefined);
  const value = useMemo<PromptSheetApi>(() => ({
    target,
    isOpen: (t) => target !== undefined && target === t,
    toggle: (t) => setTarget((cur) => (cur === t ? undefined : t)),
    close: () => setTarget(undefined),
  }), [target]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const usePromptSheet = () => useContext(Ctx) ?? INERT;

/**
 * The `[Prompt]` disclosure control. It appears in DOM order wherever a prompt belongs to something
 * on screen — never on hover, never behind an overflow menu (Don't #10).
 */
export function PromptButton({
  target = null, label = 'Prompt', ariaLabel, variant = 'ghost', size = 'sm', className,
}: {
  target?: PromptTarget;
  label?: string;
  ariaLabel?: string;
  variant?: 'ghost' | 'quiet' | 'secondary';
  size?: 'sm' | 'md';
  className?: string;
}) {
  const sheet = usePromptSheet();
  const open = sheet.isOpen(target);
  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      aria-label={ariaLabel}
      aria-expanded={open}
      aria-controls={PROMPT_SHEET_ID}
      icon={<FileText size={13} aria-hidden />}
      onClick={() => sheet.toggle(target)}
    >
      {label}
    </Button>
  );
}

const int = (n: number) => n.toLocaleString('en-US');

/** Newest take first — t12 before t3, and a legacy unnumbered `render` dir last (mirrors the server). */
const byTakeNewestFirst = (a: string, b: string) => {
  const n = (t: string) => (t === 'render' ? -1 : Number(t.slice(1)));
  return n(b) - n(a);
};

/**
 * A prompt's size against the model's budget (spec D21). The determinate bar is honest here for one
 * reason: bytes are a MEASURED quantity, not progress (Don't #1) — and they are measured by the
 * server, not recounted here. The grey head is the part the system already owns (front matter,
 * guards, frame pins); an edit can never spend it.
 */
function ByteMeter({ bytes, maxBytes, pinBytes, testId }: {
  bytes: number;
  maxBytes: number | null;
  pinBytes: number | null;
  testId: string;
}) {
  const ratio = maxBytes ? bytes / maxBytes : 0;
  const over = maxBytes != null && bytes > maxBytes;
  const warn = !over && maxBytes != null && ratio >= 0.9;
  const pct = (n: number) => `${Math.max(0, Math.min(100, maxBytes ? (n / maxBytes) * 100 : 0))}%`;
  const pinned = Math.min(pinBytes ?? 0, bytes);

  return (
    <span className="flex shrink-0 items-center gap-2">
      {maxBytes != null && (
        <span className="flex h-[2px] w-20 overflow-hidden rounded-full bg-surface-2" aria-hidden>
          <span className="block h-full bg-line-strong" style={{ width: pct(pinned) }} />
          <span
            className={clsx('block h-full', over ? 'bg-status-failed' : warn ? 'bg-status-warn' : 'bg-accent')}
            style={{ width: pct(bytes - pinned) }}
          />
        </span>
      )}
      <span
        data-testid={testId}
        className={clsx('tnum text-caption', over ? 'text-status-failed' : warn ? 'text-status-warn' : 'text-ink-muted')}
      >
        {/* A past take's budget is not on record, so it gets a count and no denominator — quoting
            today's cap as if it had been that take's would be a guess. */}
        {maxBytes == null ? `${int(bytes)} B` : `${int(bytes)} / ${int(maxBytes)} B`}
      </span>
    </span>
  );
}

/** The reference legend and the rest of what rides along with every prompt for this job (spec D20). */
function LockedPins({ view }: { view: PromptView }) {
  if (!view.refs.length && view.pinBytes == null) return null;
  return (
    <div className="mt-2 rounded-r2 bg-stage p-3 font-mono text-caption text-ink-muted">
      <p className="flex items-center gap-1.5">
        <Lock size={12} aria-hidden />
        {view.source === 'take'
          ? `Sent with this take's ${view.jobId} prompt`
          : `Sent with every ${view.jobId} prompt — not editable`}
      </p>
      {!!view.refs.length && (
        <ul className="mt-1.5 space-y-0.5">
          {view.refs.map((r) => (
            <li key={r.ref}>
              {r.ref} = {r.character ?? r.role ?? 'a reference'}
              {r.character && r.role ? ` (${r.role})` : ''}
            </li>
          ))}
        </ul>
      )}
      {view.pinBytes != null && view.pinBytes > 0 && (
        <p className="tnum mt-1.5">{int(view.pinBytes)} B of the budget is already spoken for.</p>
      )}
    </div>
  );
}

function Body({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <pre
      data-testid={testId}
      className="well mt-2 max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-r2 bg-stage p-3 font-mono text-caption text-ink-secondary"
    >
      {children}
    </pre>
  );
}

function SegmentBlock({ jobId, segment, index }: { jobId: string; segment: PromptSegment; index: number }) {
  const facts = [segment.shotId, segment.duration != null ? `${segment.duration}s` : null, segment.speaker]
    .filter(Boolean).join(' · ');
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="tnum font-mono text-caption text-ink-muted">#{index + 1}{facts ? ` · ${facts}` : ''}</p>
        <ByteMeter
          bytes={segment.bytes}
          maxBytes={segment.maxBytes}
          pinBytes={segment.pinBytes}
          testId={`prompt-bytes-${jobId}-${index}`}
        />
      </div>
      <Body testId={`prompt-body-${jobId}-${index}`}>{segment.prompt}</Body>
    </div>
  );
}

/** One job's prompt: what it is, how big it is, what rides along with it, and the words themselves. */
function JobPrompt({ run, view }: { run: RunDetail; view: PromptView }) {
  const { toast } = useToast();
  const asSent = view.source === 'take';
  const take = asSent && view.take ? run.manifest?.takes.find((t) => t.id === view.take) ?? null : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(view.prompt);
      toast({ kind: 'success', text: `${view.jobId}'s prompt copied to your clipboard.` });
    } catch {
      toast({ kind: 'error', text: 'Could not copy — your browser blocked clipboard access.' });
    }
  };

  const meta = [
    run.aspect,
    `${jobSeconds(run.spec, view.jobId)}s`,
    view.refs.length ? `${view.refs.length} reference${view.refs.length === 1 ? '' : 's'}` : null,
    view.endpointLabel,
  ].filter(Boolean).join(' · ');

  return (
    <article className="mt-4 first:mt-3" aria-label={`Prompt for ${view.jobId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-label text-ink">{view.jobId}</span>
        {asSent && (
          // Says WHEN these words were sent, in WHICH take, and what that take was estimated at —
          // the take's price, never this sheet's (reading costs nothing).
          <span
            className="tnum inline-flex h-5 items-center rounded-full bg-surface-2 px-2 text-caption text-ink-muted"
            data-testid={`prompt-sent-chip-${view.jobId}`}
          >
            sent {timeAgo(view.sentAt)} · take {view.take}
            {take?.estUsd != null ? ` · ≈${usd(take.estUsd)}` : ''}
          </span>
        )}
        <span className="flex-1" />
        <ByteMeter bytes={view.bytes} maxBytes={view.maxBytes} pinBytes={view.pinBytes} testId={`prompt-bytes-${view.jobId}`} />
        <button
          type="button"
          aria-label={`Copy ${view.jobId}'s prompt`}
          onClick={() => void copy()}
          className="flex h-7 w-7 items-center justify-center rounded-r2 text-ink-muted hover:bg-surface-2 hover:text-ink-secondary"
        >
          <Copy size={14} aria-hidden />
        </button>
      </div>
      <p className="text-caption text-ink-muted">{meta}</p>

      {view.error ? (
        <p className="mt-2 text-dense text-status-failed">
          This job cannot be composed — the render would fail on the same message: {view.error}
        </p>
      ) : view.segments ? (
        <>
          <LockedPins view={view} />
          <p className="tnum mt-3 text-caption text-ink-muted">
            {view.segments.length} segment{view.segments.length === 1 ? '' : 's'}
            {view.maxBytes != null ? ` · ${int(view.bytes)} / ${int(view.maxBytes)} B` : ` · ${int(view.bytes)} B`}
          </p>
          {view.segments.map((s, i) => <SegmentBlock key={s.shotId ?? i} jobId={view.jobId} segment={s} index={i} />)}
          {view.segmentMaxBytes != null && (
            <p className="mt-2 text-caption text-ink-muted">
              {view.segmentMaxBytes} B per segment — Kling rejects at 512, so we keep a margin.
            </p>
          )}
        </>
      ) : (
        <>
          <LockedPins view={view} />
          <Body testId={`prompt-body-${view.jobId}`}>{view.prompt}</Body>
        </>
      )}
    </article>
  );
}

function SheetPanel({ run, target, onClose }: { run: RunDetail; target: PromptTarget; onClose: () => void }) {
  // 'plan' = the words the agents wrote (what the next render sends); a take id = what that take
  // really sent, immutable (spec D19).
  const [version, setVersion] = useState<string>('plan');
  const jobIds = target === null ? (run.spec?.kling.jobs ?? []).map((j) => j.job_id) : [target];

  const planQ = useQuery({
    queryKey: ['prompts', run.id, target ?? '*'],
    queryFn: () => (target === null
      ? api.prompts(run.id).then((r) => r.prompts)
      : api.prompt(run.id, { job: target }).then((v) => [v])),
  });
  const takeQ = useQuery({
    queryKey: ['prompts', run.id, target ?? '*', version],
    // A take that never sent one of these jobs simply has no page here — one miss must not blank
    // the whole sheet.
    queryFn: () => Promise.all(jobIds.map((job) => api.prompt(run.id, { job, take: version }).catch(() => null)))
      .then((views) => views.filter((v): v is PromptView => v !== null)),
    enabled: version !== 'plan',
  });

  const active = version === 'plan' ? planQ : takeQ;
  const views = active.data ?? [];

  // The picker offers exactly the takes the server says kept a sidecar for these jobs — no option
  // opens onto a 404. Zero takes ⇒ a static label, not a one-segment control (spec D19).
  const takes = useMemo(() => {
    const seen = new Set<string>();
    for (const v of planQ.data ?? []) for (const t of v.availableTakes ?? []) seen.add(t);
    return [...seen].sort(byTakeNewestFirst);
  }, [planQ.data]);

  const endpointLabel = views[0]?.endpointLabel ?? 'the render provider';

  return (
    <section
      id={PROMPT_SHEET_ID}
      data-testid="prompt-sheet"
      aria-label={target === null ? 'Prompts for this plan' : `Prompt for ${target}`}
      className="rounded-r3 border border-line bg-surface-1 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-heading text-ink">
          {target === null ? 'What each segment will be sent' : `What ${target} will be sent`}
        </h3>
        <span className="flex-1" />
        {takes.length === 0 ? (
          <span className="text-caption text-ink-muted">Current plan</span>
        ) : (
          <SegmentedControl
            label="Prompt version"
            value={version}
            onChange={setVersion}
            segments={[
              { value: 'plan', label: 'Current plan' },
              ...takes.map((t) => ({ value: t, label: `take ${t}` })),
            ]}
          />
        )}
        <Button variant="ghost" size="sm" icon={<X size={14} aria-hidden />} onClick={onClose}>Close</Button>
      </div>

      {active.isPending ? (
        <p className="mt-3 text-dense text-ink-muted">Composing this prompt…</p>
      ) : active.error ? (
        <p className="mt-3 text-dense text-status-failed">
          {active.error instanceof Error ? active.error.message : 'The prompt could not be read.'}
        </p>
      ) : views.length === 0 ? (
        <p className="mt-3 text-dense text-ink-muted">
          {version === 'plan' ? 'This plan has no jobs yet.' : `take ${version} sent nothing for this segment.`}
        </p>
      ) : (
        views.map((v) => <JobPrompt key={v.jobId} run={run} view={v} />)
      )}

      {/* D22 read-only states: what this text IS, and what changing it would and would not do. */}
      <p className="mt-3 text-caption text-ink-muted">
        {version === 'plan'
          ? "Editing changes only the words we send to the model. It doesn't re-run the agents."
          : `Exactly what we sent to ${endpointLabel} for this take. Past takes can't be edited.`}
      </p>
    </section>
  );
}

/**
 * The panel itself. Renders nothing until a `[Prompt]` control opens it, and remounts per target so
 * a new segment always opens on its current plan rather than a previous segment's take.
 */
export function PromptSheet({ run }: { run: RunDetail }) {
  const sheet = usePromptSheet();
  if (sheet.target === undefined) return null;
  return <SheetPanel key={String(sheet.target)} run={run} target={sheet.target} onClose={sheet.close} />;
}
