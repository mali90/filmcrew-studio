// Editing the prompt: the user owns the WORDS, the system owns the CONTRACT.
//
// So what a textarea holds is the authored scene body — never the composed prompt. The style
// directive, the identity clause, the text/speech rules and the frame pins are re-composed on top at
// render time (a pin names an `@Image3` label that only exists once THAT render has laid its
// references out), which is why the meter's denominator is `maxBytes − pinBytes`: the room left for
// your words, not the whole budget. The server hands both numbers over, and `view.draft` is the
// exact text that — saved back untouched — re-composes to the same bytes.
//
// Where a model declares NO cap (Seedance's whole-prompt clamp ships off), there is no denominator
// to meter against: the readout falls back to the byte count and the editor stops standing in the
// way. Refusing a save the renderer would accept is the cap again, just moved into the browser.
//
// Two rules are load-bearing here (spec D21, Don't #7):
// · nothing is ever auto-truncated. Over budget, Save refuses and SAYS by how much. Text cut behind
//   your back is text you cannot fix, and the bytes that go are the ones you cared about most.
// · the byte count is UTF-8 BYTES, not characters — an em dash costs 3, an emoji 4. Counting
//   characters would let a 480-character edit sail past a 500-byte cap and fail at the provider.
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle } from 'lucide-react';
import type { PromptView } from '../../../../../shared/api-types';
import { api, ApiClientError } from '../../../api/client';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { useToast } from '../../ui/Toast';

/** The model's cap is in UTF-8 bytes, so the meter is too. */
export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

const int = (n: number) => n.toLocaleString('en-US');

/**
 * The room a job's own words may spend, per textarea: the cap minus what the system already owns.
 * `null` where the model has NO cap (Seedance ships uncapped) — subtracting the pins from a missing
 * denominator gave room 0, which painted every draft red and disabled Save on a prompt the renderer
 * would have sent whole. A missing limit is not a limit of zero.
 */
export function roomFor(view: PromptView): (number | null)[] {
  const room = (maxBytes: number | null, pinBytes: number | null) =>
    (maxBytes == null ? null : Math.max(0, maxBytes - (pinBytes ?? 0)));
  if (view.segments) return view.segments.map((s) => room(s.maxBytes, s.pinBytes));
  return [room(view.maxBytes, view.pinBytes)];
}

/**
 * The bodies the editor opens on. `draft`/`draftSegments` come from the server's composer, so they
 * are the authored words — falling back to the composed text only for a view too old to carry them,
 * which would at least be visible rather than blank.
 */
export function draftOf(view: PromptView): string[] {
  if (view.segments) return view.draftSegments ?? view.segments.map((s) => s.prompt);
  return [view.draft ?? view.prompt];
}

/** The agents' current words, in the same editable form — what `Refresh from plan` loads. */
function planDraftOf(view: PromptView): string[] | null {
  if (view.segments) return view.planDraftSegments ?? null;
  return view.planDraft != null ? [view.planDraft] : null;
}

/**
 * The plan moved under a saved edit (spec D22 *stale*). It changes NOTHING about what gets sent —
 * a stale override is still used word for word — so the banner states that first and offers the two
 * ways out second. Saying "your edit may be out of date" and leaving it at that would imply the
 * render does something other than what the sheet shows.
 */
export function StalePromptBanner({ jobId, canRefresh = true, onRefresh, onDiscard }: {
  jobId: string;
  /** False when the server sent no plan text to load — a button that would do nothing says so. */
  canRefresh?: boolean;
  onRefresh: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      role="status"
      data-testid={`prompt-stale-${jobId}`}
      className="mt-3 flex flex-wrap items-start gap-2 rounded-r2 bg-[var(--status-warn-soft)] p-3"
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-status-warn" aria-hidden />
      <p className="min-w-[16rem] flex-1 text-dense text-ink">
        {`The agents revised the plan after you edited ${jobId}'s prompt. Your edit is still what we'll send, word for word.`}
      </p>
      <Button
        variant="secondary"
        size="sm"
        disabled={!canRefresh}
        title={canRefresh ? undefined : 'The server sent no new plan text for this job.'}
        onClick={onRefresh}
      >
        Refresh from plan
      </Button>
      <Button variant="destructive" size="sm" onClick={onDiscard}>Discard edit</Button>
    </div>
  );
}

/**
 * One draft's size against the room left for it. Determinate because bytes are MEASURED (Don't #1).
 * With no room to measure against (`room == null`) there is nothing to fill and nothing to be near:
 * the bar goes away and the readout degrades to the count, rather than inventing a denominator.
 */
function DraftMeter({ used, room, dirty, testId }: {
  used: number;
  room: number | null;
  /** Untouched drafts rest in grey; the accent says "these are your words now". */
  dirty: boolean;
  testId: string;
}) {
  const over = room != null && used > room;
  const warn = !over && room != null && room > 0 && used / room >= 0.9;
  const pct = room != null && room > 0 ? Math.max(0, Math.min(100, (used / room) * 100)) : 0;
  return (
    <span className="flex shrink-0 items-center gap-2">
      {room != null && (
        <span className="flex h-[2px] w-20 overflow-hidden rounded-full bg-surface-2" aria-hidden>
          {/* Whole class names, never interpolated — Tailwind only ships what it can read here. */}
          <span
            className={clsx('block h-full',
              over ? 'bg-status-failed' : warn ? 'bg-status-warn' : dirty ? 'bg-accent' : 'bg-line-strong')}
            style={{ width: `${pct}%` }}
          />
        </span>
      )}
      <span
        data-testid={testId}
        className={clsx('tnum text-caption', over ? 'text-status-failed' : warn ? 'text-status-warn' : 'text-ink-muted')}
      >
        {room == null ? `${int(used)} B` : `${int(used)} / ${int(room)} B`}
      </span>
    </span>
  );
}

function DraftArea({ value, label, onChange }: {
  value: string;
  label: string;
  onChange: (next: string) => void;
}) {
  return (
    <textarea
      rows={4}
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      onInput={(e) => {
        const el = e.currentTarget;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
      }}
      className="mt-1.5 w-full resize-none rounded-r2 border border-line bg-surface-0 px-3 py-2 font-mono text-caption text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    />
  );
}

/**
 * The editing surface for one job (spec D22 *editing* / *saved* / *stale*).
 *
 * Kling gets one textarea per shot because its cap is per shot — fal rejects a 512-byte segment, so
 * a single blob could only be guessed apart and a wrong guess is a paid render of the wrong words.
 * Seedance renders one document per job, so it gets one textarea.
 */
export function PromptEditor({ runId, view, openWith = null, onClose }: {
  runId: string;
  view: PromptView;
  /** How the editor was entered from the read view's stale banner: on the plan's text, or straight
   *  on the discard confirm — so those two actions take one click there as they do in here. */
  openWith?: 'plan' | 'discard' | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const initial = useMemo(() => draftOf(view), [view]);
  const plan = planDraftOf(view);
  // Seeded once: a background refetch (another tab saved, the run refreshed) must not overwrite
  // words that are being typed right now.
  const [bodies, setBodies] = useState<string[]>(() => (openWith === 'plan' && plan ? plan : initial));
  const [confirmDiscard, setConfirmDiscard] = useState(openWith === 'discard');

  const perSegment = Boolean(view.segments);
  const room = roomFor(view);
  const used = bodies.map(utf8Bytes);
  // A textarea with no cap is never over: `?? 0` here would make "no limit" mean "no room" and
  // refuse the save (Seedance ships uncapped, so that is the ordinary case, not an edge one).
  const over = used.map((u, i) => (room[i] == null ? 0 : u - (room[i] as number)));
  const firstOver = over.findIndex((o) => o > 0);
  const blank = !bodies.some((b) => b.trim());

  const onError = (e: Error) =>
    toast({ kind: 'error', text: e instanceof ApiClientError ? `${e.message} — ${e.hint}` : e.message });

  const save = useMutation({
    mutationFn: () => api.putPrompt(runId, perSegment
      ? { job: view.jobId, segments: bodies }
      : { job: view.jobId, prompt: bodies[0] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prompts', runId] });
      toast({ kind: 'success', text: `${view.jobId}'s prompt saved — nothing was sent.` });
      onClose();
    },
    onError,
  });
  const discard = useMutation({
    mutationFn: () => api.deletePrompt(runId, view.jobId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prompts', runId] });
      setConfirmDiscard(false);
      toast({ kind: 'success', text: `${view.jobId} is back on the prompt the agents wrote.` });
      onClose();
    },
    onError,
  });

  const setBody = (i: number, next: string) => setBodies((cur) => cur.map((b, j) => (j === i ? next : b)));
  const usedTotal = used.reduce((a, b) => a + b, 0);
  // One unmetered segment makes the TOTAL unmetered too — summing the rest would quote a budget the
  // job does not have.
  const roomTotal = room.some((r) => r == null) ? null : (room as number[]).reduce((a, b) => a + b, 0);

  return (
    <div className="mt-2" data-testid={`prompt-editor-${view.jobId}`}>
      {view.stale && (
        <StalePromptBanner
          jobId={view.jobId}
          canRefresh={Boolean(plan)}
          // "Unsaved" is the whole point: the new plan text lands in the editor and the user decides.
          // Loading it straight over the saved override would be the silent overwrite the banner
          // exists to prevent.
          onRefresh={() => { if (plan) setBodies(plan); }}
          onDiscard={() => setConfirmDiscard(true)}
        />
      )}

      {perSegment ? (
        <>
          <p className="tnum mt-3 text-caption text-ink-muted" data-testid={`prompt-editor-total-${view.jobId}`}>
            {bodies.length} segment{bodies.length === 1 ? '' : 's'} · {roomTotal == null ? `${int(usedTotal)} B` : `${int(usedTotal)} / ${int(roomTotal)} B`}
          </p>
          {view.segmentMaxBytes != null && (
            <p className="text-caption text-ink-muted">
              {view.segmentMaxBytes} B per segment — Kling rejects at 512, so we keep a margin.
            </p>
          )}
          {bodies.map((body, i) => {
            const shotId = view.segments?.[i]?.shotId ?? null;
            return (
              <div className="mt-3" key={shotId ?? i}>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="tnum font-mono text-caption text-ink-muted">#{i + 1}{shotId ? ` · ${shotId}` : ''}</p>
                  <DraftMeter
                    used={used[i]}
                    room={room[i] ?? null}
                    dirty={body !== initial[i]}
                    testId={`prompt-editor-bytes-${view.jobId}-${i}`}
                  />
                </div>
                <DraftArea
                  value={body}
                  label={`Prompt for ${view.jobId}${shotId ? `, shot ${shotId}` : `, segment ${i + 1}`}`}
                  onChange={(next) => setBody(i, next)}
                />
              </div>
            );
          })}
        </>
      ) : (
        <div className="mt-3">
          <div className="flex items-baseline justify-between gap-3">
            <p className="font-mono text-caption text-ink-muted">Your words</p>
            <DraftMeter
              used={used[0]}
              room={room[0] ?? null}
              dirty={bodies[0] !== initial[0]}
              testId={`prompt-editor-bytes-${view.jobId}`}
            />
          </div>
          <DraftArea
            value={bodies[0]}
            label={`Prompt for ${view.jobId}`}
            onChange={(next) => setBody(0, next)}
          />
        </div>
      )}

      {firstOver >= 0 && (
        // The numbers, not a shrug: a user who can see the overage can fix it in one edit.
        <p role="alert" data-testid={`prompt-editor-over-${view.jobId}`} className="mt-2 text-dense text-status-failed">
          {perSegment && bodies.length > 1
            ? `Shot ${firstOver + 1} is over by ${int(over[firstOver])} B — trim to save.`
            : `Over by ${int(over[firstOver])} B — trim to save.`}
          {bodies[firstOver] === initial[firstOver] && (
            // Over budget before a single keystroke: the agents wrote more than fits, and the
            // composer quietly drops framing and camera to make it. Saying so is the difference
            // between "the editor is broken" and "here is a choice the render is making for you".
            <> The agents wrote it that way, and the render trims it to fit — trimming it here is how
              you choose what goes.</>
          )}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={firstOver >= 0 || blank}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        {view.source === 'override' && !view.stale && (
          <Button variant="destructive" size="sm" onClick={() => setConfirmDiscard(true)}>Discard edit</Button>
        )}
        <span className="text-caption text-ink-muted">
          {/* Genuinely free: one local file write. Nothing is submitted and nothing is billed until
              the words are actually rendered — which is a separate, priced click. */}
          {`Saving is free — nothing renders until you re-render ${view.jobId}.`}
        </span>
      </div>

      <Dialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title={`Discard your edit to ${view.jobId}?`}
        actions={(
          <>
            <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
            <Button variant="destructive" loading={discard.isPending} onClick={() => discard.mutate()}>
              Discard edit
            </Button>
          </>
        )}
      >
        <p>{view.jobId} goes back to the prompt the agents wrote. Your edited text is not kept.</p>
      </Dialog>
    </div>
  );
}
