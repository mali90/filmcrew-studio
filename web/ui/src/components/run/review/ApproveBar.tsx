// The rail's bottom card: an optional Topaz upscale toggle (priced) and the approve action.
// Approving without upscale is free — assembly already happened; approve only finalizes.
//
// Topaz runs on either vendor now, and the margin between them is thin (fal's per-output-second
// rate usually lands under Segmind's flat $0.125/input-second — usually) — so the toggle opens a
// provider pick showing BOTH real figures rather than asking anyone to trust the default.
//
// On a REOPENED run the same action delivers a second time, so it says so: "Replace final" is a
// truthful promise only because replacing costs nothing and destroys nothing — the file the user
// already has stays on disk, named in the caption (spec D26).
import { useId, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { RunDetail, UpscaleProvider } from '../../../../../shared/api-types';
import { api, ApiClientError } from '../../../api/client';
import { Button } from '../../ui/Button';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { useToast } from '../../ui/Toast';
import { usd } from '../../../lib/format';
import { PaidButton } from './PaidButton';
import { UnknownPriceNote } from '../../ui/UnknownPriceNote';
import { reopenedFinal } from './lib';

const PROVIDER_NAMES: Record<UpscaleProvider, string> = { fal: 'fal.ai', segmind: 'Segmind' };
const PROVIDER_KEY_NAMES: Record<UpscaleProvider, string> = { fal: 'FAL_KEY', segmind: 'SEGMIND_API_KEY' };
/** fal first — the default when it can serve the cut; the order both the picker and the fallbacks read. */
const PROVIDERS: UpscaleProvider[] = ['fal', 'segmind'];

/** A short side as the card says it out loud: 2160 is "4K" to everyone, everything else is "720p". */
const sizeLabel = (shortSide: number) => (shortSide >= 2160 ? '4K' : `${shortSide}p`);

/** fal prices Topaz by the OUTPUT frame, not by the short side the card promises — and a vertical
 *  clip lifted to a 1080 short side comes back 1920 tall, which fal bills at its dearest tier. Said
 *  out loud, because "~1080p" beside a top-tier price otherwise reads as a mistake. Only the tiers
 *  worth explaining get a line; the rest quote exactly what the label implies. */
const TIER_NOTES: Record<string, string> = {
  above1080p: 'fal.ai bills the taller frame at its above-1080p rate.',
};

export function ApproveBar({ run, cutId = null }: { run: RunDetail; cutId?: string | null }) {
  const { toast } = useToast();
  const [upscale, setUpscale] = useState(false);
  // null = no explicit pick yet — the DEFAULT (fal, unless only Segmind has a key) applies
  const [provider, setProvider] = useState<UpscaleProvider | null>(null);
  const checkboxId = useId();

  // Which vendors this install can actually reach — the same setup-status the app gate already
  // fetched (shared queryKey ⇒ cache hit, no extra call). A keyless option renders disabled with
  // the reason, and is never submitted: approval must not fail on a missing key after the click.
  const setup = useQuery({ queryKey: ['setup-status'], queryFn: api.setupStatus, staleTime: 5_000 });
  const keys = setup.data ? { fal: setup.data.fal.hasKey, segmind: setup.data.segmind.hasKey } : null;
  const hasKey = (p: UpscaleProvider) => keys?.[p] ?? true; // keys unknown ⇒ disable nothing yet

  // the cut being finalized: the reviewer's selection, else the latest (manifest cuts are oldest-first)
  const cuts = run.manifest?.cuts ?? [];
  const selectedCut = (cutId && cuts.find((c) => c.id === cutId)) || cuts.at(-1) || null;
  // "the latest render" when no explicit cut is chosen (incl. a recovery run with a master but no
  // cut record yet), or the chosen cut is the newest one
  const isLatestSelection = !cutId || selectedCut?.id === cuts.at(-1)?.id;

  // the delivered master's short side: the selected cut's own record. Only borrow the latest
  // render's dimension for the latest selection — never bleed one cut's size onto an older cut
  // (an HD latest must not disable upscaling an older SD cut). Unknown ⇒ offer the upscale.
  const shortSide = selectedCut?.shortSide ?? (isLatestSelection ? run.latestRender?.masterShortSide ?? null : null);

  // What ReviewStage previews for the latest selection is run.latestRender (which, after an
  // interruption, may be a completed render with no cut record yet) — so target it implicitly
  // (null) rather than a recorded cut id that a recovery render could have superseded. Preview and
  // finalize/price then always act on the same master; an explicit OLDER cut still rides through.
  const submitCut = isLatestSelection ? undefined : cutId ?? undefined;

  // Fetched regardless of the current size: the estimate also says what short side the upscale
  // would DELIVER (Segmind takes an explicit target; fal lifts toward ~1080p), and the
  // "already HD" gate below must judge against THAT — a 4k target keeps offering the upscale on a
  // 1080p cut, a 720p target never advertises 1080. BOTH providers are quoted (the picker shows
  // the two real figures side by side); each vendor is then gated on its OWN target, while the
  // label, price and paid button follow the PICKED one.
  const falEstimate = useQuery({
    queryKey: ['estimate', run.id, 'upscale', submitCut ?? null, 'fal'],
    queryFn: () => api.estimate(run.id, { mode: 'upscale', cut: submitCut, provider: 'fal' }),
  });
  const segmindEstimate = useQuery({
    queryKey: ['estimate', run.id, 'upscale', submitCut ?? null, 'segmind'],
    queryFn: () => api.estimate(run.id, { mode: 'upscale', cut: submitCut, provider: 'segmind' }),
  });
  // Each vendor is judged by ITS OWN delivered target, never by the picked one's: Segmind honors
  // UPSCALE_TARGET_RESOLUTION (a 4k one clears a 1080p cut by a mile) while fal's factor plan stops
  // near ~1080p, so "already at target" is a fact about ONE vendor. Reading it off the pick alone
  // made a real 4K job unreachable — it disabled the toggle, and the picker that could have
  // switched vendors only renders once the toggle is on.
  const targetOf = (p: UpscaleProvider) =>
    (p === 'segmind' ? segmindEstimate : falEstimate).data?.targetShortSide ?? 1080;
  const liftsCut = (p: UpscaleProvider) => shortSide == null || shortSide < targetOf(p);
  /** Could this vendor really run this upscale — reachable, and aiming above what the cut already is? */
  const offerable = (p: UpscaleProvider) => hasKey(p) && liftsCut(p);

  // fal by default, and the first vendor that can actually do the job: a default whose only possible
  // outcome is handing back the file it was given is a dead end, not a default. When none can lift
  // the cut the pick falls to a vendor we can at least reach, so the caption quotes a real target.
  const defaultProvider: UpscaleProvider =
    PROVIDERS.find(offerable) ?? PROVIDERS.find(hasKey) ?? 'fal';
  // An explicit pick rides only while it stays offerable — a vendor kept selected past the cut that
  // outgrew it would put the checkbox and the paid button back into disagreement.
  const pickedProvider: UpscaleProvider = provider && offerable(provider) ? provider : defaultProvider;

  const upscaleEstimate = pickedProvider === 'segmind' ? segmindEstimate : falEstimate;
  const targetShort = targetOf(pickedProvider);
  const targetLabel = sizeLabel(targetShort);
  const alreadyHD = shortSide != null && shortSide >= targetShort;
  // The toggle is pointless only when NO reachable vendor could lift this cut — one vendor being at
  // its target says nothing about the other's.
  const noVendorLifts = !PROVIDERS.some(offerable);
  // switching to an already-at-target cut disables the toggle but leaves `upscale` stale — derive
  // the real intent so the button, label, price and payload never disagree with the checkbox.
  const effectiveUpscale = upscale && !alreadyHD;

  // The delivered file this run reopened from — null on a run that was never delivered, and null
  // again the moment a newer approval supersedes it. It is what turns "Approve" into "Replace
  // final", and the only thing allowed to name a filename in this card.
  const reopened = reopenedFinal(run.manifest);

  const approve = useMutation({
    // the provider rides only with a real upscale — a free finalize names no vendor
    mutationFn: () => api.approve(run.id, effectiveUpscale, submitCut, effectiveUpscale ? pickedProvider : undefined),
    onSuccess: () => toast({
      kind: 'success',
      text: effectiveUpscale
        ? (reopened ? 'Replacing the final — upscaling now.' : 'Approved — upscaling now.')
        : (reopened ? 'Replacing the final — the old one stays on disk.' : 'Approved — finalizing now.'),
    }),
    onError: (e) => toast({ kind: 'error', text: e instanceof ApiClientError ? `${e.message} — ${e.hint}` : e.message }),
  });

  // Topaz runs on the PICKED provider, and the two bill differently — so the toggle may be
  // priceable, unknown (a provider with no published rate), or (already HD) irrelevant.
  const unknownPrice = upscaleEstimate.data?.unknownPrice ?? null;
  // …and when the picked vendor's tier is not the one the target label implies, the caption says
  // which rate the figure came from — the label and the price must never look like two answers.
  const tierNote = (unknownPrice ? null : TIER_NOTES[upscaleEstimate.data?.tier ?? '']) ?? null;

  const label = `${reopened ? 'Replace final' : 'Approve'}${effectiveUpscale ? ' & upscale' : ''}`;

  return (
    <section className="rounded-r3 border border-line border-t-line-strong bg-surface-1 p-4">
      <div className="flex items-start gap-2.5">
        <input
          id={checkboxId}
          type="checkbox"
          checked={upscale && !alreadyHD}
          disabled={noVendorLifts}
          onChange={(e) => setUpscale(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[var(--accent)] disabled:opacity-50"
        />
        <label htmlFor={checkboxId} className={noVendorLifts ? 'flex-1 opacity-60' : 'flex-1 cursor-pointer'}>
          <span className="flex items-center gap-2 text-label text-ink">
            Upscale to ~{targetLabel} with Topaz
            {!noVendorLifts && !alreadyHD && !unknownPrice && <span className="tnum text-caption text-ink-muted">≈ {usd(upscaleEstimate.data?.totalUsd)}</span>}
          </span>
          <span className="mt-0.5 block text-caption text-ink-muted">
            {!PROVIDERS.some(hasKey)
              // a toggle nobody can honour says which key would bring it back, rather than going quietly grey
              ? `No upscale vendor on file — add ${PROVIDER_KEY_NAMES.fal} or ${PROVIDER_KEY_NAMES.segmind} in Settings → Keys.`
              : alreadyHD
                ? `This video is already ${shortSide}p — at or above the ${targetLabel} target.`
                : shortSide != null
                  // the cut's actual resolution, stated where the upscale decision is made (U2d)
                  ? `This cut is ${shortSide}p — one Topaz job per clip lifts it toward ~${targetLabel}.`
                  : `One Topaz job per clip — skip it if the render is already ${targetLabel}.`}
            {!noVendorLifts && !alreadyHD && tierNote ? ` ${tierNote}` : ''}
          </span>
        </label>
      </div>

      {/* Who runs it — shown while the toggle is on (kept up even if the current pick's target
          gates the cut as already-HD, so there is always a way to switch back off that pick).
          Both vendors' real figures sit in the options: the margin is thin and the default is
          not to be trusted blind. An option this cut cannot use — no key, or a target the cut has
          already reached — is disabled with the reason, in plain words. */}
      {upscale && (
        <div className="mt-2 pl-[26px]">
          <SegmentedControl
            label="Upscale provider"
            value={pickedProvider}
            onChange={setProvider}
            segments={([['fal', falEstimate], ['segmind', segmindEstimate]] as const).map(([p, est]) => ({
              value: p,
              label: hasKey(p) && est.data?.totalUsd != null ? `${PROVIDER_NAMES[p]} · ${usd(est.data.totalUsd)}` : PROVIDER_NAMES[p],
              hint: !hasKey(p)
                ? `No ${PROVIDER_KEY_NAMES[p]} on file`
                : liftsCut(p)
                  ? `Topaz runs on ${PROVIDER_NAMES[p]}, toward ~${sizeLabel(targetOf(p))}`
                  : `${PROVIDER_NAMES[p]} targets ~${sizeLabel(targetOf(p))} — this cut is already there`,
              disabled: !offerable(p),
            }))}
          />
          {keys && PROVIDERS.filter((p) => !offerable(p)).map((p) => (
            <p key={p} className="mt-1 text-caption text-ink-muted">
              {hasKey(p)
                ? `${PROVIDER_NAMES[p]} would deliver ~${sizeLabel(targetOf(p))} — this cut is already ${shortSide}p.`
                : `${PROVIDER_NAMES[p]} is unavailable — no ${PROVIDER_KEY_NAMES[p]} on file (add it in Settings → Keys).`}
            </p>
          ))}
        </div>
      )}

      <div className="mt-3">
        {effectiveUpscale ? (
          <PaidButton
            variant="primary"
            size="lg"
            className="w-full justify-center"
            costUsd={upscaleEstimate.data?.totalUsd ?? null}
            costUnknown={Boolean(unknownPrice)}
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

      {effectiveUpscale && unknownPrice && <UnknownPriceNote hint={unknownPrice.hint} />}

      {/* "Approving is free" is dropped the moment the upscale is on — that variant bills Topaz.
          The reopened wording names the file so "replace" can never be read as "delete". */}
      <p className="mt-2 text-caption text-ink-muted">
        {effectiveUpscale ? '' : 'Approving is free. '}
        {reopened ? (
          <>This writes a new final; <span className="font-mono">{reopened.fileName}</span> stays on disk.</>
        ) : (
          'Assembly already happened — approve only finalizes (and optionally upscales).'
        )}
      </p>
    </section>
  );
}
