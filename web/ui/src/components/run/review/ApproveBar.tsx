// The rail's bottom card: an optional Topaz upscale toggle (priced) and the approve action.
// Approving without upscale is free — assembly already happened; approve only finalizes.
import { useId, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { RunDetail } from '../../../../../shared/api-types';
import { api, ApiClientError } from '../../../api/client';
import { Button } from '../../ui/Button';
import { useToast } from '../../ui/Toast';
import { usd } from '../../../lib/format';
import { PaidButton } from './PaidButton';

export function ApproveBar({ run, cutId = null }: { run: RunDetail; cutId?: string | null }) {
  const { toast } = useToast();
  const [upscale, setUpscale] = useState(false);
  const checkboxId = useId();

  // the cut being finalized: the reviewer's selection, else the latest (manifest cuts are oldest-first)
  const cuts = run.manifest?.cuts ?? [];
  const selectedCut = (cutId && cuts.find((c) => c.id === cutId)) || cuts.at(-1) || null;

  // the delivered master's short side: the selected cut's record, else the take's render.json.
  // ≥1080 means Topaz has nothing to lift — offering a paid no-op would be a lie.
  const shortSide = selectedCut?.shortSide ?? run.latestRender?.masterShortSide ?? null;
  const alreadyHD = shortSide != null && shortSide >= 1080;

  const upscaleEstimate = useQuery({
    queryKey: ['estimate', run.id, 'upscale'],
    queryFn: () => api.estimate(run.id, { mode: 'upscale' }),
    enabled: !alreadyHD,
  });

  const approve = useMutation({
    mutationFn: () => api.approve(run.id, upscale, cutId ?? undefined),
    onSuccess: () => toast({ kind: 'success', text: upscale ? 'Approved — upscaling now.' : 'Approved — finalizing now.' }),
    onError: (e) => toast({ kind: 'error', text: e instanceof ApiClientError ? `${e.message} — ${e.hint}` : e.message }),
  });

  const label = `Approve${upscale ? ' & upscale' : ''}`;

  return (
    <section className="rounded-r3 border border-line border-t-line-strong bg-surface-1 p-4">
      <div className="flex items-start gap-2.5">
        <input
          id={checkboxId}
          type="checkbox"
          checked={upscale && !alreadyHD}
          disabled={alreadyHD}
          onChange={(e) => setUpscale(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[var(--accent)] disabled:opacity-50"
        />
        <label htmlFor={checkboxId} className={alreadyHD ? 'flex-1 opacity-60' : 'flex-1 cursor-pointer'}>
          <span className="flex items-center gap-2 text-label text-ink">
            Upscale to ~1080p with Topaz
            {!alreadyHD && <span className="tnum text-caption text-ink-muted">≈ {usd(upscaleEstimate.data?.totalUsd)}</span>}
          </span>
          <span className="mt-0.5 block text-caption text-ink-muted">
            {alreadyHD
              ? `This video is already ${shortSide}p — there's nothing to upscale.`
              : 'One Topaz job per clip — skip it if the render is already 1080p.'}
          </span>
        </label>
      </div>

      <div className="mt-3">
        {upscale ? (
          <PaidButton
            variant="primary"
            size="lg"
            className="w-full justify-center"
            costUsd={upscaleEstimate.data?.totalUsd ?? null}
            loading={approve.isPending}
            onPaidClick={() => approve.mutate()}
          >
            {label}
          </PaidButton>
        ) : (
          <Button
            variant="primary"
            size="lg"
            className="w-full justify-center"
            loading={approve.isPending}
            onClick={() => approve.mutate()}
          >
            {label}
          </Button>
        )}
      </div>

      <p className="mt-2 text-caption text-ink-muted">
        {upscale ? '' : 'Approving is free. '}Assembly already happened — approve only finalizes
        (and optionally upscales).
      </p>
    </section>
  );
}
