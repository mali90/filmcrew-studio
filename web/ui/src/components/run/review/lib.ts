// Small pure helpers shared by the review/deliver components.
import type { ContinuityEntry, ProductionSpec } from '../../../../../shared/api-types';

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

// ── Continuity vocabulary (WS2-P2) ───────────────────────────────────────────────────────────────
// Everything the strip SAYS about a join comes from here, so the one rule that must not drift lives
// in one testable place: we may only promise what the renderer actually wrote down.

/** The four verdicts `web/server/lib/lineage.js` draws between two segments. */
export type JointKind = 'linked' | 'broken' | 'isolated' | 'unknown';
/** Colour role, not a colour: isolated/unknown deliberately are NOT a fifth status (spec D5). */
export type JointTone = 'done' | 'warn' | 'muted' | 'faint';

/**
 * The joint kind for one segment's incoming join, from the entry the server serialized. Mirrors
 * `jointKindOf` in lib/lineage.js — the server sends per-segment facts, the UI draws the joint —
 * so a reason token added there degrades to "unknown" here rather than inventing a link.
 */
export function jointKindOf(entry: ContinuityEntry | null | undefined): JointKind {
  if (!entry) return 'unknown';
  // The head of the cut has no join at all — the strip draws nothing there, and anything that asks
  // anyway must not hear "broken" about a joint that does not exist.
  if (entry.reason === 'no-prev') return 'unknown';
  if (entry.reason === 'unknown-segment' || entry.confidence === 'derived') return 'unknown';
  if (entry.reason === 'mode-none' || entry.reason === 'mode-unsupported' || entry.reason === 'no-seam') return 'isolated';
  return entry.continuesFromPrev ? 'linked' : 'broken';
}

/**
 * The badge's word, icon and tone for a joint. Confidence outranks the verdict: a continuation that
 * was RECONSTRUCTED from take history (`confidence:'derived'`) may only ever read "join unknown",
 * because we did not see it happen (UX spec D7, Don't #8).
 */
export function jointFor(joint: { kind: string; confidence: string }): {
  label: string; icon: 'Link2' | 'Unlink' | 'Scissors' | 'HelpCircle'; tone: JointTone;
} {
  const kind = joint?.confidence === 'derived' ? 'unknown' : joint?.kind;
  switch (kind) {
    case 'linked': return { label: 'joined', icon: 'Link2', tone: 'done' };
    case 'broken': return { label: 'join broken', icon: 'Unlink', tone: 'warn' };
    case 'isolated': return { label: 'scene cut', icon: 'Scissors', tone: 'muted' };
    default: return { label: 'join unknown', icon: 'HelpCircle', tone: 'faint' };
  }
}

/**
 * One join, in plain words: what `jobId` does or does not start on. These are the sentences the
 * strip's single explanation line shows and each tile carries as its description (spec D9) — no
 * per-tile popovers, one vocabulary.
 */
export function jointSentence(prevJobId: string, jobId: string, kind: JointKind): string {
  switch (kind) {
    case 'linked': return `${jobId} starts on ${prevJobId}'s last frame.`;
    case 'broken': return `${jobId} does not start on this cut's ${prevJobId} — the clip it was joined to was replaced.`;
    case 'isolated': return `${jobId} starts on a scene cut — nothing pins it to ${prevJobId}.`;
    default: return `We can't tell whether ${jobId} starts on ${prevJobId}'s last frame.`;
  }
}
