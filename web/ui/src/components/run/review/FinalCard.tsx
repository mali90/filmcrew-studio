// The deliver card: the finished video, the facts, and two exits — download the file, or start
// another run. The download is a plain same-origin anchor (the media route range-serves the mp4),
// so it works like any browser download: no JS tricks, middle-click and save-as included.
import { useNavigate } from 'react-router-dom';
import { Download, Plus } from 'lucide-react';
import type { RunDetail } from '../../../../../shared/api-types';
import { Button } from '../../ui/Button';
import { seconds, usd } from '../../../lib/format';

export function FinalCard({ run }: { run: RunDetail }) {
  const navigate = useNavigate();

  const totalEstUsd = (run.manifest?.costLedger ?? []).reduce((sum, e) => sum + (e.estUsd ?? 0), 0);
  const title = run.title ?? 'Your video';
  // the on-disk basename ("<slug>-<id>-final.mp4") is the download's filename
  const fileName = run.finalFsPath?.split('/').pop() ?? `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.mp4`;

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
          <dt className="text-caption text-ink-muted">Total estimated cost</dt>
          <dd className="tnum text-dense text-ink">{usd(totalEstUsd)}</dd>
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
    </section>
  );
}
