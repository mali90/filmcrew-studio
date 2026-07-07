// Small pure helpers shared by the review/deliver components.
import type { ProductionSpec } from '../../../../../shared/api-types';

/** Client-side basename of an absolute fs path. */
export const basename = (p: string) => p.split('/').pop() ?? p;

/** Media URL for a stitched master that lives in out/ (older cuts only expose fs paths). */
export const outMediaUrl = (absPath: string) => `/api/media/out/${encodeURIComponent(basename(absPath))}`;

/** Planned seconds for one render job = sum of its shots' durations from the spec. */
export function jobSeconds(spec: ProductionSpec | null, jobId: string): number {
  const job = spec?.kling.jobs.find((j) => j.job_id === jobId);
  if (!job || !spec) return 0;
  return job.shots.reduce((sum, sid) => {
    const shot = spec.shots.find((s) => s.shot_id === sid);
    return sum + (shot?.duration_s ?? shot?.kling?.duration ?? 0);
  }, 0);
}

export const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
