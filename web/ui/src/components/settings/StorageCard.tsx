// Storage — how much disk runs/ and out/ hold. Read-only: deletion happens per run on Home.
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { bytes } from '../../lib/format';
import { Spinner } from '../ui/Spinner';

const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

export function StorageCard() {
  const q = useQuery({ queryKey: ['storage'], queryFn: api.storage });

  return (
    <section aria-labelledby="storage-heading" className="rounded-r3 border border-line bg-surface-1 p-5">
      <h2 id="storage-heading" className="text-heading text-ink">Storage</h2>
      {q.isLoading ? (
        <p className="mt-3 flex items-center gap-2 text-caption text-ink-muted" aria-live="polite"><Spinner size={12} /> Measuring…</p>
      ) : (
        <dl className="mt-3 space-y-1.5 text-dense text-ink-secondary">
          <div className="flex items-baseline gap-2">
            <dt className="font-mono">runs/</dt>
            <dd className="tnum">— {files(q.data?.runs.count ?? 0)} · {bytes(q.data?.runs.bytes)}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="font-mono">out/</dt>
            <dd className="tnum">— {files(q.data?.out.count ?? 0)} · {bytes(q.data?.out.bytes)}</dd>
          </div>
        </dl>
      )}
      <p className="mt-3 text-caption text-ink-muted">Delete runs from their cards on Home.</p>
    </section>
  );
}
