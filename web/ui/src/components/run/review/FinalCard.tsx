// The deliver card: the finished video, the facts, and three exits — download the file, start
// another run, or go back in and change something. The download is a plain same-origin anchor (the
// media route range-serves the mp4), so it works like any browser download: no JS tricks,
// middle-click and save-as included.
//
// "Make changes" is deliberately IN the card, not behind an overflow menu (spec Don't #10): a run
// that came out almost right is the common case, and hiding the way back makes people re-run the
// whole thing. It asks once before reopening, and the question's whole job is to say what does NOT
// happen — the delivered file is never deleted, moved or overwritten. That reassurance is inline,
// not a modal: reopening spends nothing and destroys nothing, and a Dialog here would dress a free,
// reversible action up as a dangerous one (spec D23).
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Download, PenLine, Plus } from 'lucide-react';
import type { RunDetail } from '../../../../../shared/api-types';
import { api, ApiClientError } from '../../../api/client';
import { Button } from '../../ui/Button';
import { useToast } from '../../ui/Toast';
import { seconds, spendLabel, timeAgo } from '../../../lib/format';
import { deliveredFinals } from './lib';

export function FinalCard({ run }: { run: RunDetail }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [earlierOpen, setEarlierOpen] = useState(false);

  const spendText = spendLabel(run.manifest?.costLedger ?? []);
  const title = run.title ?? 'Your video';
  // Every delivery this run has made. One entry is the normal case and says nothing worth a line;
  // more than one means an earlier final was replaced, and the card owes the user proof that it is
  // still there (spec D24).
  const finals = deliveredFinals(run.manifest);
  const current = finals.at(-1) ?? null;
  const earlier = finals.slice(0, -1);
  const replaced = current ? finals.find((f) => f.replacedBy === current.id) ?? null : null;

  // The DELIVERED resolution (U2c) — measured off the file on screen, never a target or a source.
  // An approve WITH an upscale writes a bigger file than the cut it came from, so the approved cut's
  // shortSide is the pre-upscale size and would report a delivered 1080p master as its 480p source;
  // the delivery record carries the master's own measured short side. The cut (and then the latest
  // render) stand in only for a run delivered before that was recorded, and the run's resolution
  // PICK only when nothing was ever measured.
  const approvedCut = run.manifest?.cuts.find((c) => c.id === run.manifest?.approved?.cut);
  const shortSide = current?.shortSide ?? run.manifest?.approved?.shortSide
    ?? approvedCut?.shortSide ?? run.latestRender?.masterShortSide;
  // the on-disk basename ("<slug>-<id>-final.mp4") is the download's filename
  const fileName = run.finalFsPath?.split('/').pop() ?? `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.mp4`;

  // The status event the server emits on reopen refreshes the page through useRunEvents; invalidating
  // here as well means the card also turns over when the socket is closed (or never opened).
  const reopen = useMutation({
    mutationFn: () => api.reopen(run.id),
    onSuccess: () => {
      setConfirming(false);
      qc.invalidateQueries({ queryKey: ['run', run.id] });
      qc.invalidateQueries({ queryKey: ['runs'] });
    },
    onError: (e) => toast({ kind: 'error', text: e instanceof ApiClientError ? `${e.message} — ${e.hint}` : e.message }),
  });

  return (
    <section className="mx-auto w-full max-w-[560px] rounded-r3 border border-line bg-surface-1 p-5">
      <div className="flex justify-center rounded-r2 bg-stage p-4">
        <video
          controls
          playsInline
          src={run.finalUrl ?? undefined}
          poster={run.coverUrl ?? undefined}
          data-testid="final-video"
          className="h-auto max-h-[60vh] w-auto max-w-full rounded-r3 border border-line bg-black"
        />
      </div>

      <h2 className="mt-4 text-title text-ink">{title} is done</h2>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2">
        <div>
          <dt className="text-caption text-ink-muted">Duration target</dt>
          <dd className="tnum text-dense text-ink">{seconds(run.spec?.project.duration_target_s ?? run.durationS)}</dd>
        </div>
        <div>
          <dt className="text-caption text-ink-muted">Aspect</dt>
          <dd className="tnum text-dense text-ink">{run.aspect ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-caption text-ink-muted">Upscaled</dt>
          <dd className="text-dense text-ink">{run.manifest?.approved?.upscaled ? 'yes' : 'no'}</dd>
        </div>
        <div>
          <dt className="text-caption text-ink-muted">Resolution</dt>
          <dd className="tnum text-dense text-ink">{shortSide ? `${shortSide}p` : run.manifest?.resolution ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-caption text-ink-muted">Total estimated cost</dt>
          <dd className="tnum text-dense text-ink">{spendText}</dd>
        </div>
      </dl>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <a
          href={run.finalUrl ?? undefined}
          download={fileName}
          className="inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-r2 bg-accent px-3 text-label font-medium text-onaccent transition-colors duration-[120ms] hover:bg-accent-hover"
        >
          <Download size={14} aria-hidden /> Download
        </a>
        <Button variant="quiet" icon={<Plus size={14} aria-hidden />} onClick={() => navigate('/')}>
          Create another
        </Button>
      </div>

      {/* Spec D24 — this run has delivered more than once, so say which final is on screen, what it
          replaced, and where the replaced ones went (nowhere: they are still downloadable). */}
      {finals.length > 1 && current && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-caption text-ink-muted" data-testid="finals-lineage">
            <span className="font-mono text-ink-secondary">{current.id}</span>
            {replaced && <> · replaced <span className="font-mono">{replaced.id}</span></>}
            {' · '}{timeAgo(current.at)}
          </p>
          <button
            type="button"
            aria-expanded={earlierOpen}
            onClick={() => setEarlierOpen((o) => !o)}
            className="mt-1.5 inline-flex items-center gap-1 text-caption text-accent hover:text-accent-hover"
          >
            Earlier finals
            <ChevronDown size={12} aria-hidden className={earlierOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
          </button>
          {earlierOpen && (
            <ul className="mt-1.5 flex flex-col gap-1">
              {earlier.map((f) => (
                <li key={f.id} className="flex items-baseline justify-between gap-3 text-caption text-ink-muted">
                  <a href={f.url} download={f.fileName} className="min-w-0 truncate font-mono text-accent hover:text-accent-hover">
                    {f.id} · {f.fileName}
                  </a>
                  <span className="tnum shrink-0">{timeAgo(f.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Spec D23 — a footer sentence, not a fourth button: the way back in, weighted as the small
          thing it is, with the reassurance attached to it rather than saved for the confirm. */}
      <div className="mt-4 border-t border-line pt-3">
        {confirming ? (
          <div className="rounded-r2 border border-line bg-surface-2 p-3">
            <p className="text-dense text-ink">Reopen this run to make changes?</p>
            <p className="mt-1 text-caption text-ink-muted">
              Nothing is lost — <span className="font-mono">{fileName}</span> stays on disk and stays downloadable.
              Approving again writes a new final beside it.
            </p>
            <div className="mt-2.5 flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon={<PenLine size={14} aria-hidden />}
                loading={reopen.isPending}
                onClick={() => reopen.mutate()}
              >
                Make changes
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Keep it as is</Button>
            </div>
          </div>
        ) : (
          <p className="flex flex-wrap items-center gap-1.5 text-caption text-ink-muted">
            Not quite right?
            <Button variant="quiet" size="sm" icon={<PenLine size={14} aria-hidden />} onClick={() => setConfirming(true)}>
              Make changes
            </Button>
            — your final file stays on disk either way.
          </p>
        )}
      </div>
    </section>
  );
}
