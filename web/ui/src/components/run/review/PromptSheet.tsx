// The prompt sheet: the exact words that will leave for the provider, shown before they leave.
//
// Surface (spec D18): an INLINE DISCLOSURE in `main`, directly beneath whatever stage the run is
// in, pushing the log down. Not a modal and not a right-side sheet — reading a prompt is neither
// destructive nor paid, and Dialog is reserved for those (Don't #2). The pattern copies
// LogViewer/AgentRail: the control carries `aria-expanded`, and because the panel is not its
// sibling (the toggles live in the plan card, the job cards and the clip strip, while the panel
// lives under the stage band) it also carries `aria-controls`.
//
// Every number in it — bytes, budget, the bytes the system already owns — is measured by the server
// with the same pure builder the renderer composes with, and is rendered here verbatim. Recomputing
// a byte count in the browser would be a second implementation of the one thing this screen promises
// not to have. (The editor is the one exception, and only for text that has not been saved yet: the
// server cannot count words that are still being typed. See PromptEditor.)
import { createContext, useContext, useMemo, useState, type PropsWithChildren, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, Copy, FileText, Lock, PenLine, X } from 'lucide-react';
import type { PromptRef, PromptSegment, PromptView, PromptsResponse, RunDetail } from '../../../../../shared/api-types';
import { api } from '../../../api/client';
import { Button } from '../../ui/Button';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { useToast } from '../../ui/Toast';
import { timeAgo, usd } from '../../../lib/format';
import { jobSeconds } from './lib';
import { PromptEditor, StalePromptBanner } from './PromptEditor';

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
 * Every job's prompt for the CURRENT plan. One cache entry shared by the sheet and by whatever else
 * needs to know which prompts carry an edit (the clip strip's pen overlay) — two keys would mean two
 * requests and, worse, two answers.
 */
export function usePlanPrompts(runId: string, enabled = true) {
  return useQuery<PromptsResponse>({
    queryKey: ['prompts', runId, '*'],
    queryFn: () => api.prompts(runId),
    enabled,
  });
}

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

/** A character's reference SET is the fact worth a glance (spec D20 / U11), not one line per file —
 *  so consecutive refs naming the same character collapse into a single counted range. Only
 *  consecutive runs collapse: a range label like `@Image1–@Image3` would lie about any ref
 *  another character holds between them. */
function groupRefs(refs: PromptRef[]): { character: string | null; refs: PromptRef[] }[] {
  const groups: { character: string | null; refs: PromptRef[] }[] = [];
  for (const r of refs) {
    const last = groups.at(-1);
    if (last && last.character != null && last.character === r.character) last.refs.push(r);
    else groups.push({ character: r.character ?? null, refs: [r] });
  }
  return groups;
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
          {groupRefs(view.refs).map((g) => {
            const [first, last] = [g.refs[0], g.refs.at(-1)!];
            return g.refs.length > 1 ? (
              <li key={first.ref}>
                {first.ref}–{last.ref} — {g.character} ({g.refs.length} refs)
              </li>
            ) : (
              <li key={first.ref}>
                {first.ref} = {first.character ?? first.role ?? 'a reference'}
                {first.character && first.role ? ` (${first.role})` : ''}
              </li>
            );
          })}
        </ul>
      )}
      {view.pinBytes != null && view.pinBytes > 0 && (
        // With no budget there is nothing to be "spoken for" — the number is still worth showing
        // (it is what an edit cannot change), but calling it a share of a budget would invent one.
        <p className="tnum mt-1.5">
          {view.maxBytes == null
            ? `${int(view.pinBytes)} B of this prompt is ours, not yours to edit.`
            : `${int(view.pinBytes)} B of the budget is already spoken for.`}
        </p>
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
  // A past take is a record, not a draft (spec D22 *as-sent*) — and a job the plan cannot compose
  // has no words to hand an editor. Everything else is the user's to change.
  const editable = !asSent && !view.error;
  // An edit the plan has moved under opens IN the editor: the banner, the two ways out and the words
  // themselves are the whole point of that state, and burying them behind a button hides the news.
  const [editing, setEditing] = useState<null | 'plan' | 'discard' | 'edit'>(
    editable && view.source === 'override' && view.stale ? 'edit' : null,
  );

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
        {view.source === 'override' && (
          // Spec D22 *saved*: the words on this screen are the user's, and the tile in the strip
          // wears the same pen so the fact is visible without opening anything.
          <span
            className="inline-flex h-5 items-center gap-1 rounded-full bg-[var(--accent-soft)] px-2 text-caption text-accent"
            data-testid={`prompt-edited-chip-${view.jobId}`}
          >
            <PenLine size={11} aria-hidden /> edited
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
        {editable && !editing && (
          <Button
            variant="quiet"
            size="sm"
            icon={<PenLine size={13} aria-hidden />}
            onClick={() => setEditing('edit')}
          >
            Edit prompt
          </Button>
        )}
      </div>
      <p className="text-caption text-ink-muted">{meta}</p>

      {!editing && editable && view.stale && (
        // Reachable by cancelling out of the editor — the news must not disappear with it.
        <StalePromptBanner
          jobId={view.jobId}
          canRefresh={Boolean(view.planDraftSegments ?? view.planDraft)}
          onRefresh={() => setEditing('plan')}
          onDiscard={() => setEditing('discard')}
        />
      )}

      {editing ? (
        <>
          <LockedPins view={view} />
          <PromptEditor
            runId={run.id}
            view={view}
            openWith={editing === 'edit' ? null : editing}
            onClose={() => setEditing(null)}
          />
        </>
      ) : view.error ? (
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

      {!editing && view.source === 'override' && (
        <p className="mt-2 text-caption text-ink-muted">
          {`Your edit is what ${view.jobId}'s next render sends.`}
        </p>
      )}
    </article>
  );
}

/**
 * Edits the plan no longer has a segment for (spec D22 *orphaned*). Collapsed, because it is news
 * about text that will not be sent — but present, because the alternative is deleting a user's
 * words on the agents' say-so and never mentioning it.
 */
function OrphanedEdits({ runId, orphaned }: { runId: string; orphaned: PromptsResponse['orphaned'] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const discard = useMutation({
    mutationFn: (jobId: string) => api.deletePrompt(runId, jobId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['prompts', runId] }),
    onError: (e: Error) => toast({ kind: 'error', text: e.message }),
  });
  const textOf = (o: PromptsResponse['orphaned'][number]) => o.prompt ?? (o.segments ?? []).join('\n\n');

  return (
    <div className="mt-4 rounded-r2 border border-line bg-stage p-3" data-testid="prompt-orphaned">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 text-left text-caption text-ink-muted hover:text-ink-secondary"
      >
        <AlertTriangle size={12} className="text-status-warn" aria-hidden />
        {`${orphaned.length} edited prompt${orphaned.length === 1 ? '' : 's'} ${orphaned.length === 1 ? 'has' : 'have'} no segment any more.`}
      </button>
      {open && orphaned.map((o) => (
        <div key={o.jobId} className="mt-2.5">
          <p className="text-dense text-ink-secondary">
            {`${o.jobId} no longer exists in this plan — the agents re-cut the segments. Your text is kept, but nothing will send it.`}
          </p>
          <pre className="well mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-r2 bg-surface-1 p-2 font-mono text-caption text-ink-secondary">
            {textOf(o)}
          </pre>
          <div className="mt-1.5 flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(textOf(o)).then(
                  () => toast({ kind: 'success', text: `${o.jobId}'s text copied to your clipboard.` }),
                  () => toast({ kind: 'error', text: 'Could not copy — your browser blocked clipboard access.' }),
                );
              }}
            >
              Copy the text
            </Button>
            <Button variant="destructive" size="sm" loading={discard.isPending} onClick={() => discard.mutate(o.jobId)}>
              Discard it
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function SheetPanel({ run, target, onClose }: { run: RunDetail; target: PromptTarget; onClose: () => void }) {
  // 'plan' = the words the agents wrote (what the next render sends); a take id = what that take
  // really sent, immutable (spec D19).
  const [version, setVersion] = useState<string>('plan');
  const jobIds = target === null ? (run.spec?.kling.jobs ?? []).map((j) => j.job_id) : [target];

  // Whole-plan and single-job reads are separate cache entries on purpose: the plan-wide one is
  // shared with the clip strip (usePlanPrompts), and it is the only one that carries `orphaned`.
  const allQ = usePlanPrompts(run.id, target === null);
  const oneQ = useQuery({
    queryKey: ['prompts', run.id, target],
    queryFn: () => api.prompt(run.id, { job: target! }),
    enabled: target !== null,
  });
  const takeQ = useQuery({
    queryKey: ['prompts', run.id, target ?? '*', version],
    // A take that never sent one of these jobs simply has no page here — one miss must not blank
    // the whole sheet.
    queryFn: () => Promise.all(jobIds.map((job) => api.prompt(run.id, { job, take: version }).catch(() => null)))
      .then((views) => views.filter((v): v is PromptView => v !== null)),
    enabled: version !== 'plan',
  });

  const planQ = target === null ? allQ : oneQ;
  const planViews = useMemo<PromptView[]>(
    () => (target === null ? allQ.data?.prompts ?? [] : oneQ.data ? [oneQ.data] : []),
    [target, allQ.data, oneQ.data],
  );
  const active = version === 'plan' ? planQ : takeQ;
  const views = version === 'plan' ? planViews : takeQ.data ?? [];
  // Edits whose job the agents have since re-cut away. Kept with their text, and said out loud —
  // silently dropping words a user typed is the one thing this sheet must never do (spec D22).
  const orphaned = target === null ? allQ.data?.orphaned ?? [] : [];

  // The picker offers exactly the takes the server says kept a sidecar for these jobs — no option
  // opens onto a 404. Zero takes ⇒ a static label, not a one-segment control (spec D19).
  const takes = useMemo(() => {
    const seen = new Set<string>();
    for (const v of planViews) for (const t of v.availableTakes ?? []) seen.add(t);
    return [...seen].sort(byTakeNewestFirst);
  }, [planViews]);

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
          {target === null ? 'What we send, segment by segment' : `What we send for ${target}`}
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
        // Keyed by VERSION as well as job: a take already in the cache resolves synchronously, so a
        // key of job id alone let React reuse the mounted JobPrompt and carry its open editor across
        // the switch — draft textareas and a zero-byte budget on a page whose own footer says past
        // takes cannot be edited. Switching versions is a different document, so it remounts.
        views.map((v) => <JobPrompt key={`${version}:${v.jobId}`} run={run} view={v} />)
      )}

      {version === 'plan' && orphaned.length > 0 && (
        <OrphanedEdits runId={run.id} orphaned={orphaned} />
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
