// Render defaults — backend, aspect and resolution every new run starts from.
// Only the values the user actually changed are posted; 'kling' goes through as-is and the
// server maps it to RENDER_BACKEND='' itself.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { api, ApiClientError } from '../../api/client';
import { Button } from '../ui/Button';
import { SegmentedControl } from '../ui/SegmentedControl';
import { useToast } from '../ui/Toast';

const ASPECTS = [
  { value: '9:16', label: 'Portrait', box: 'h-7 w-4' },
  { value: '16:9', label: 'Landscape', box: 'h-4 w-7' },
  { value: '1:1', label: 'Square', box: 'h-5 w-5' },
] as const;

export function DefaultsCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['settings-defaults'], queryFn: api.defaults });

  const [backend, setBackend] = useState('kling');
  const [aspect, setAspect] = useState('9:16');
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (seeded || !q.data) return;
    setBackend(q.data.backend);
    setAspect(q.data.aspect);
    setSeeded(true);
  }, [seeded, q.data]);

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
    if (backend !== q.data?.backend) d.backend = backend;
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
          <SegmentedControl
            label="Default render backend"
            value={backend}
            onChange={setBackend}
            segments={[
              { value: 'kling', label: 'Kling', hint: 'character elements + minted voices' },
              { value: 'seedance', label: 'Seedance', hint: 'lip-sync from reference clips' },
            ]}
          />
        </div>

        <div>
          <span className="mb-1 block text-label text-ink-secondary">Aspect</span>
          <div role="radiogroup" aria-label="Default aspect ratio" className="flex gap-2">
            {ASPECTS.map((a) => (
              <button
                key={a.value}
                role="radio"
                aria-checked={aspect === a.value}
                onClick={() => setAspect(a.value)}
                className={clsx(
                  'flex h-16 w-24 flex-col items-center justify-center gap-1.5 rounded-r2 border transition-colors',
                  aspect === a.value ? 'border-accent bg-[var(--accent-soft)] text-ink' : 'border-line bg-surface-2 text-ink-muted hover:text-ink-secondary',
                )}
              >
                <span className={clsx('rounded-[2px] border border-current', a.box)} aria-hidden />
                <span className="text-caption">{a.value} · {a.label}</span>
              </button>
            ))}
          </div>
        </div>

        <p className="text-caption text-ink-muted">
          Renders are deliberately economical: Kling outputs ~720p, Seedance 480p. Approving a
          finished video offers an optional Topaz upscale to 1080p — that&rsquo;s where full quality
          comes from, not from rendering large.
        </p>
      </div>

      <div className="mt-5">
        <Button variant="secondary" loading={save.isPending} onClick={onSave}>Save defaults</Button>
      </div>
    </section>
  );
}
