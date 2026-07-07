// A slim "what the studio is doing right now" card — visible only while work is active or waiting.
// Voice mints show as plain text (they have no run page to link to).
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import type { ActionKind } from '../../../../shared/api-types';
import { api } from '../../api/client';
import { useGlobalEvents } from '../../hooks/useGlobalEvents';
import { Button } from '../ui/Button';

const KIND_LABEL: Record<ActionKind, string> = {
  plan: 'Planning',
  revise: 'Revising the plan',
  render: 'Rendering',
  probe: 'Probe render',
  'render-job': 'Re-rendering a job',
  assemble: 'Assembling the cut',
  upscale: 'Upscaling',
  'mint-voice': 'Minting a voice',
};

function RunRef({ runId }: { runId: string }) {
  if (runId.startsWith('voice-')) return <span className="font-mono text-caption text-ink-muted">{runId}</span>;
  return (
    <Link to={`/runs/${runId}`} className="truncate font-mono text-caption text-accent hover:text-accent-hover">
      {runId}
    </Link>
  );
}

export function QueueStrip() {
  const { active, queued } = useGlobalEvents();
  const cancel = useMutation({ mutationFn: (runId: string) => api.cancel(runId) });

  if (active.length === 0 && queued.length === 0) return null;

  return (
    <section aria-label="Queue" className="mx-auto w-full max-w-[720px] rounded-r3 border border-line bg-surface-1 px-4 py-3">
      <ul className="flex flex-col gap-2">
        {active.map((item) => (
          <li key={item.id} className="flex items-center gap-2.5">
            <span className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-status-active" aria-hidden />
            <span className="text-label text-ink">{KIND_LABEL[item.kind]}</span>
            <RunRef runId={item.runId} />
          </li>
        ))}
        {queued.map((item, i) => (
          <li key={item.id} className="flex items-center gap-2.5">
            <span className="tnum w-1.5 shrink-0 text-center text-caption text-ink-faint" aria-hidden>{i + 1}</span>
            <span className="text-label text-ink-secondary">{KIND_LABEL[item.kind]}</span>
            <RunRef runId={item.runId} />
            <span className="flex-1" />
            <Button
              variant="destructive"
              size="sm"
              aria-label={`Cancel queued ${KIND_LABEL[item.kind].toLowerCase()} for ${item.runId}`}
              loading={cancel.isPending && cancel.variables === item.runId}
              onClick={() => cancel.mutate(item.runId)}
            >
              Cancel
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
