// The Production Spec, readable two ways: a formatted narrative that fills in block by block as
// agents finish (ghost rows name the agent we're waiting on), or the raw JSON in a well.
// Block presence drives everything — useRunEvents invalidates ['run'] so this refreshes live.
import { useState } from 'react';
import { Copy } from 'lucide-react';
import type { ProductionSpec, RunDetail } from '../../../../shared/api-types';
import { SegmentedControl } from '../ui/SegmentedControl';
import { useToast } from '../ui/Toast';
import { seconds } from '../../lib/format';

/** Total seconds of one render job = the sum of its shots' durations. */
export function jobSeconds(spec: ProductionSpec, jobId: string): number {
  const job = spec.kling?.jobs?.find((j) => j.job_id === jobId);
  if (!job) return 0;
  return job.shots.reduce((acc, sid) => {
    const shot = spec.shots?.find((s) => s.shot_id === sid);
    return acc + (shot?.duration_s ?? shot?.kling?.duration ?? 0);
  }, 0);
}

/** Total planned runtime across all shots. */
export function totalShotSeconds(spec: ProductionSpec): number {
  return (spec.shots ?? []).reduce((acc, s) => acc + (s.duration_s ?? s.kling?.duration ?? 0), 0);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function Ghost({ agent }: { agent: string }) {
  return <p className="text-dense text-ink-faint">waiting for {agent}</p>;
}

function SectionTitle({ children }: { children: string }) {
  return <h4 className="text-caption font-medium uppercase tracking-wide text-ink-muted">{children}</h4>;
}

function Chip({ children }: { children: string }) {
  return <span className="inline-flex h-5 items-center rounded-full bg-surface-2 px-2 text-caption text-ink-secondary">{children}</span>;
}

type Mode = 'formatted' | 'json';

export function SpecInspector({ run }: { run: RunDetail }) {
  const [mode, setMode] = useState<Mode>('formatted');
  const { toast } = useToast();
  const spec = run.spec;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(spec ?? {}, null, 2));
      toast({ kind: 'success', text: 'Spec JSON copied to your clipboard.' });
    } catch {
      toast({ kind: 'error', text: 'Could not copy — your browser blocked clipboard access.' });
    }
  };

  const facts: [string, string | undefined][] = spec
    ? [
        ['format', spec.project.format],
        ['duration', spec.project.duration_target_s != null ? seconds(spec.project.duration_target_s) : undefined],
        ['aspect', spec.project.aspect_ratio],
        ['hook', spec.project.hook],
        ['payoff', spec.project.payoff],
      ]
    : [];

  return (
    <section aria-label="Production spec" className="rounded-r3 border border-line bg-surface-1 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-heading text-ink">Production spec</h3>
        <div className="flex items-center gap-1.5">
          <SegmentedControl<Mode>
            label="Spec view"
            value={mode}
            onChange={setMode}
            segments={[{ value: 'formatted', label: 'Formatted' }, { value: 'json', label: 'JSON' }]}
          />
          <button
            aria-label="Copy spec JSON"
            onClick={copy}
            className="flex h-8 w-8 items-center justify-center rounded-r2 text-ink-muted hover:bg-surface-2 hover:text-ink-secondary"
          >
            <Copy size={14} />
          </button>
        </div>
      </div>

      {mode === 'json' ? (
        <pre className="well mt-3 max-h-[60vh] overflow-auto rounded-r2 bg-stage p-3 font-mono text-caption text-ink-secondary">
          {JSON.stringify(spec ?? {}, null, 2)}
        </pre>
      ) : (
        <div className="mt-3 space-y-4">
          {/* Project — Showrunner */}
          <div className="space-y-1.5">
            <SectionTitle>Project</SectionTitle>
            {spec?.project ? (
              <>
                <p className="text-heading text-ink">{spec.project.title}</p>
                {spec.project.logline && <p className="text-body text-ink-secondary">{spec.project.logline}</p>}
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                  {facts.filter(([, v]) => v).map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-caption text-ink-muted">{k}</dt>
                      <dd className="text-dense text-ink-secondary">{v}</dd>
                    </div>
                  ))}
                </dl>
                {!!spec.project.cast?.length && (
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {spec.project.cast.map((c) => <Chip key={c}>{c}</Chip>)}
                  </div>
                )}
              </>
            ) : <Ghost agent="Showrunner" />}
          </div>

          {/* Shots — Storyboard / Scene Director / Cinematographer */}
          <div className="space-y-2">
            <SectionTitle>Shots</SectionTitle>
            {spec?.shots?.length ? spec.shots.map((s, i) => (
              <div key={s.shot_id} className="space-y-1">
                <p className="tnum font-mono text-caption text-ink-muted">#{i + 1} · {s.duration_s ?? s.kling?.duration ?? 0}s</p>
                {s.kling?.content_prompt && (
                  <p className="text-dense text-ink-secondary" style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {s.kling.content_prompt}
                  </p>
                )}
                {(s.kling?.shot_size || s.kling?.perspective || s.kling?.camera_move) && (
                  <div className="flex flex-wrap gap-1">
                    {[s.kling?.shot_size, s.kling?.perspective, s.kling?.camera_move].filter(Boolean).map((c) => (
                      <Chip key={c as string}>{c as string}</Chip>
                    ))}
                  </div>
                )}
              </div>
            )) : <Ghost agent="Storyboard" />}
          </div>

          {/* Elements — Casting */}
          <div className="space-y-1.5">
            <SectionTitle>Elements</SectionTitle>
            {spec?.kling?.elements?.length ? spec.kling.elements.map((el) => (
              <p key={el.id} className="flex items-center gap-1.5 text-dense text-ink-secondary">
                <span className="font-mono text-caption">{el.id}</span>
                {el.role && <span className="inline-flex h-4 items-center rounded-full bg-surface-2 px-1.5 text-caption text-ink-muted">{el.role}</span>}
                {el.character && <span className="text-ink-muted">{el.character}</span>}
              </p>
            )) : <Ghost agent="Casting" />}
          </div>

          {/* Audio — Sound */}
          <div className="space-y-1.5">
            <SectionTitle>Audio</SectionTitle>
            {spec?.audio?.voice?.lines?.length ? spec.audio.voice.lines.map((l, i) => (
              <p key={i} className="text-dense text-ink-secondary">“{l.text}”{l.speaker ? ` — ${l.speaker}` : ''}</p>
            )) : <Ghost agent="Sound" />}
          </div>

          {/* Jobs — Job Planner */}
          <div className="space-y-1.5">
            <SectionTitle>Jobs</SectionTitle>
            {spec?.kling?.jobs?.length ? spec.kling.jobs.map((j) => (
              <p key={j.job_id} className="tnum text-dense text-ink-secondary">
                <span className="font-mono">{j.job_id}</span> · shots {j.shots.join(', ')} · {jobSeconds(spec, j.job_id)}s
              </p>
            )) : <Ghost agent="Job Planner" />}
          </div>
        </div>
      )}
    </section>
  );
}
