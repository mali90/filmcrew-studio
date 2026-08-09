// Render defaults — backend, aspect and resolution every new run starts from.
// Only the values the user actually changed are posted; the legacy 'kling' spelling still goes
// through as-is when it is what the server already has, and the server maps it to RENDER_BACKEND=''.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { api, ApiClientError } from '../../api/client';
import {
  MODEL_IDS, aspectsFor, backendIdFor, canonicalBackendFor, modelLabelFor, providersFor,
} from '../../../../shared/render-models';
import { Button } from '../ui/Button';
import { useToast } from '../ui/Toast';

// Every pair this build can render, straight from the registry: a saved default is a per-run default,
// so the list here must be the same list the create page offers.
const BACKEND_OPTIONS = MODEL_IDS.flatMap((model) =>
  providersFor(model).map((p) => ({
    value: backendIdFor(model, p.id),
    model: modelLabelFor(model),
    provider: p.label,
  })));

// A saved default may be canonical ('seedance-2.0@fal') or a legacy one-word id ('seedance') — map
// both onto the canonical pair the options are keyed by, or nothing is selected and the radiogroup
// loses its tab stop.
const optionFor = (value: string): string => {
  try { return canonicalBackendFor(value); } catch { return value; }
};

// Silhouette + plain-word name per ratio; WHICH ratios are offered comes from the chosen model.
const ASPECT_SHAPE: Record<string, { label: string; box: string }> = {
  '9:16': { label: 'Portrait', box: 'h-7 w-4' },
  '16:9': { label: 'Landscape', box: 'h-4 w-7' },
  '1:1': { label: 'Square', box: 'h-5 w-5' },
  '4:3': { label: 'Classic', box: 'h-5 w-7' },
  '3:4': { label: 'Tall', box: 'h-7 w-5' },
  '21:9': { label: 'Wide', box: 'h-3 w-8' },
};

export function DefaultsCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['settings-defaults'], queryFn: api.defaults });

  const [backend, setBackend] = useState(BACKEND_OPTIONS[0]!.value as string);
  const [aspect, setAspect] = useState('9:16');
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (seeded || !q.data) return;
    setBackend(optionFor(q.data.backend));
    setAspect(q.data.aspect);
    setSeeded(true);
  }, [seeded, q.data]);

  const offeredAspects = aspectsFor(backend) as string[];
  // Saving a pair the create page would refuse helps nobody: switching model trims an unrenderable
  // ratio to that model's first, exactly as the create page does.
  const chooseBackend = (next: string) => {
    setBackend(next);
    const offered = aspectsFor(next) as string[];
    if (!offered.includes(aspect)) setAspect(offered[0]!);
  };

  const save = useMutation({
    mutationFn: (d: { backend?: string; aspect?: string; resolution?: string; seedanceResolution?: string }) => api.saveDefaults(d),
    onSuccess: () => {
      toast({ kind: 'success', text: 'Defaults saved — new runs start from these.' });
      qc.invalidateQueries({ queryKey: ['settings-defaults'] });
      qc.invalidateQueries({ queryKey: ['doctor'] }); // the health card re-verifies the fix
      qc.invalidateQueries({ queryKey: ['setup-status'] });
    },
    onError: (e) =>
      toast({ kind: 'error', text: e instanceof ApiClientError ? `${e.message} — ${e.hint}` : 'Saving defaults failed.' }),
  });

  const onSave = () => {
    const d: { backend?: string; aspect?: string; resolution?: string; seedanceResolution?: string } = {};
    // Compare canonically: a legacy saved value that means the selected pair is unchanged.
    if (backend !== (q.data ? optionFor(q.data.backend) : backend)) d.backend = backend;
    if (aspect !== q.data?.aspect) d.aspect = aspect;
    if (!Object.keys(d).length) {
      toast({ kind: 'info', text: 'Nothing changed — there is nothing to save.' });
      return;
    }
    save.mutate(d);
  };

  return (
    <section aria-labelledby="defaults-heading" className="rounded-r3 border border-line bg-surface-1 p-5">
      <h2 id="defaults-heading" className="text-heading text-ink">Defaults</h2>
      <p className="mt-1 text-dense text-ink-muted">Every new run starts from these; you can still change them per run.</p>

      <div className="mt-4 space-y-4">
        <div>
          <span className="mb-1 block text-label text-ink-secondary">Backend</span>
          <div role="radiogroup" aria-label="Default render backend" className="flex flex-wrap gap-1.5">
            {BACKEND_OPTIONS.map((b) => {
              const selected = backend === b.value;
              return (
                <button
                  key={b.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => chooseBackend(b.value)}
                  className={clsx(
                    'inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-label transition-colors duration-[120ms]',
                    selected
                      ? 'border-accent bg-[var(--accent-soft)] text-ink'
                      : 'border-line bg-surface-2 text-ink-secondary hover:border-line-strong',
                  )}
                >
                  {b.model}
                  <span className="text-caption text-ink-muted">{b.provider}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <span className="mb-1 block text-label text-ink-secondary">Aspect</span>
          <div role="radiogroup" aria-label="Default aspect ratio" className="flex flex-wrap gap-2">
            {offeredAspects.map((value) => {
              const shape = ASPECT_SHAPE[value] ?? { label: '', box: 'h-5 w-5' };
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={aspect === value}
                  onClick={() => setAspect(value)}
                  className={clsx(
                    'flex h-16 w-24 flex-col items-center justify-center gap-1.5 rounded-r2 border transition-colors',
                    aspect === value ? 'border-accent bg-[var(--accent-soft)] text-ink' : 'border-line bg-surface-2 text-ink-muted hover:text-ink-secondary',
                  )}
                >
                  <span className={clsx('rounded-[2px] border border-current', shape.box)} aria-hidden />
                  <span className="text-caption">{value} · {shape.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <p className="text-caption text-ink-muted">
          Renders are deliberately economical: Kling outputs ~720p, Seedance 2.0 480p, Seedance 2.5
          480p or 720p. Approving a finished video offers an optional Topaz upscale to 1080p —
          that&rsquo;s where full quality comes from, not from rendering large.
        </p>
        <p className="text-caption text-ink-muted">
          Segmind publishes no per-second rate for its Seedance models, so those runs show &ldquo;price
          not set&rdquo; instead of a figure — they still cost money.
        </p>
      </div>

      <div className="mt-5">
        <Button variant="secondary" loading={save.isPending} onClick={onSave}>Save defaults</Button>
      </div>
    </section>
  );
}
