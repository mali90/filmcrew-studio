// Small pure helpers shared by the review/deliver components.
import type { ContinuityEntry, Manifest, ProductionSpec } from '../../../../../shared/api-types';
import { pinStrengthFor, pinStrengthsFor, type PinStrength } from '../../../../../shared/render-models';

export type { PinStrength };

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

// ── Boundary vocabulary (WS2-P5) ─────────────────────────────────────────────────────────────────
// The re-render dialog sells a paid render on one sentence, so the sentence is a pure function of
// the plan and the pin STRENGTH the renderer would really use (pinStrengthFor, mirrored from
// chooseSeamMode). The honesty rule it exists to keep (UX spec D15, tightened by the implementer
// correction): a native first/last-frame anchor is the only thing that may be called "seamless"; a
// frame that rides as an extra reference image plus a prompt pin is "near-seamless
// (reference-guided)"; nothing pinned is a scene cut.

/** Which ends a re-render pins. `auto` = every end that HAS a neighbour, resolved by the caller. */
export type BoundaryChoice = 'auto' | 'both' | 'start' | 'end' | 'none';

/** The strength of a pin, in words. Reused verbatim wherever a joint is described. */
export function seamStrengthWords(strength: PinStrength): string {
  switch (strength) {
    case 'native': return 'seamless';
    case 'soft': return 'near-seamless (reference-guided)';
    default: return 'a scene cut — the picture may jump';
  }
}

/**
 * What a re-render will do to this segment's two joins, in plain words — the D14 sentence, live.
 *
 * A neighbour that does not exist is never named (an end of the cut cannot be pinned to anything),
 * and a pin strength of 'none' is described as a scene cut rather than as a weak seam.
 *
 * The two ends are answered SEPARATELY. They really can land differently — a model with a native
 * first-frame slot and no last-frame one, or a reference budget that keeps the opening pin and drops
 * the closing one — and reporting a single collapsed strength lies in both directions at once: it
 * hides the surviving pin's reference-guided caveat, and it calls a reference-guided opening a
 * scene cut. `pinStrength` therefore takes either one strength for both ends or the pair.
 */
export function boundaryPlanSentence({ jobId, prev, next, boundaries, pinStrength }: {
  jobId: string;
  prev?: { jobId: string } | null;
  next?: { jobId: string } | null;
  boundaries: BoundaryChoice;
  pinStrength: PinStrength | { in: PinStrength; out: PinStrength };
}): string {
  const prevId = prev?.jobId ?? null;
  const nextId = next?.jobId ?? null;
  if (!prevId && !nextId) return `${jobId} is the only segment in this cut — there's nothing to join.`;

  const strength = typeof pinStrength === 'string' ? { in: pinStrength, out: pinStrength } : pinStrength;
  const asked = (end: 'start' | 'end') =>
    boundaries === 'auto' || boundaries === 'both' || boundaries === end;
  // An end is only described as pinned when it was asked for AND the renderer would really pin it.
  const wantStart = Boolean(prevId) && strength.in !== 'none' && asked('start');
  const wantEnd = Boolean(nextId) && strength.out !== 'none' && asked('end');
  const startWords = seamStrengthWords(strength.in);
  const endWords = seamStrengthWords(strength.out);
  const opens = strength.in === 'native' ? 'will start from' : 'will aim to start on';
  const closes = strength.out === 'native' ? 'end on' : 'aim to end on';

  // Nothing pinned at either end: say which joins become scene cuts, naming only real neighbours.
  if (!wantStart && !wantEnd) {
    const sides = prevId && nextId
      ? 'The joins on both sides become scene cuts.'
      : prevId
        ? `The join from ${prevId} becomes a scene cut.`
        : `The cut into ${nextId} becomes a scene cut.`;
    return `${jobId} will be rendered on its own. ${sides}`;
  }

  if (wantStart && wantEnd) {
    if (strength.in === strength.out) {
      return strength.in === 'native'
        ? `${jobId} will start from ${prevId}'s last frame and end on ${nextId}'s opening frame — both joins stay ${startWords}.`
        : `${jobId} will aim to start on ${prevId}'s last frame and end on ${nextId}'s opening frame — ${startWords}.`;
    }
    // Pinned differently at each end — one sentence each, so neither join borrows the other's promise.
    return `${jobId} ${opens} ${prevId}'s last frame — that join is ${startWords}.`
      + ` It will ${closes} ${nextId}'s opening frame — that join is ${endWords}.`;
  }

  if (wantStart) {
    const tail = nextId
      ? ` Nothing pins its ending, so the cut into ${nextId} stays a scene cut.`
      : ' Nothing pins its ending — it is the last segment in the cut.';
    return `${jobId} ${opens} ${prevId}'s last frame — that join is ${startWords}.${tail}`;
  }

  // Only the ending is pinned: either the head of the cut, or an explicit end-only plan.
  const head = prevId
    ? `Nothing pins its start, so the join from ${prevId} stays a scene cut.`
    : `${jobId} opens the cut, so nothing pins its start.`;
  return `${head} It will ${closes} ${nextId}'s opening frame — that join is ${endWords}.`;
}

// ── What a segment re-render does to its joins (WS2-P5) ──────────────────────────────────────────
// Two surfaces can start one — the strip's dialog and the rail's "the plan changed" block — and
// they post to the SAME endpoint, so an offer one makes and the other withholds is the same bug
// twice. The decision therefore lives here, once, and both call it.

/** What `boundaries:'auto'` resolves to, how each pin would really land, and whether a downstream
 *  cascade repairs anything at all. */
export interface SegmentJoins {
  /** What auto pins at each end — mirrored from `resolveBoundaries` in web/server/lib/lineage.js. */
  autoStart: boolean;
  autoEnd: boolean;
  /** What THIS request asks for (auto's answer unless the caller overrides an end). */
  wantStart: boolean;
  wantEnd: boolean;
  /** How each asked-for pin would really land — budget included, so a pin the reference budget
   *  drops reads as no pin rather than as a promise the clip cannot keep. */
  startStrength: PinStrength;
  endStrength: PinStrength;
  /** The next clip really starts on this one's last frame AND this backend can end a segment on a
   *  given frame at all — otherwise the downstream join is nobody's choice and nothing is said. */
  showSeamWarning: boolean;
  /** …and nothing is going to pin that ending. An APPLIED ending pin renders this segment against
   *  the unchanged next clip and records the joint as intact, so re-rendering everything downstream
   *  would replace footage nothing touched — for a chain no stronger than the pin already bought. */
  offerCascade: boolean;
}

/**
 * @param p.pinStart/pinEnd  an explicit choice for that end (the dialog's Custom plan); omitted
 *   leaves auto's answer, which is all the rail ever posts.
 */
export function segmentJoins({ backend, castRefCount, hasPrev, hasNext, entry, nextEntry, pinStart, pinEnd }: {
  backend: string;
  castRefCount: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** this segment's own continuity entry — does it start on the previous clip? */
  entry: ContinuityEntry | null | undefined;
  /** the NEXT segment's entry — does that clip start on this one? */
  nextEntry: ContinuityEntry | null | undefined;
  pinStart?: boolean;
  pinEnd?: boolean;
}): SegmentJoins {
  // A RECORDED verdict decides; anything reconstructed keeps the historical default (chain the
  // opening frame, pin no ending) rather than acting on a guess — resolveBoundaries' own rule.
  const recorded = (e: ContinuityEntry | null | undefined) => e?.confidence === 'recorded';
  const autoStart = hasPrev && (recorded(entry) ? Boolean(entry?.continuesFromPrev) : true);
  const autoEnd = hasNext && (recorded(nextEntry) ? Boolean(nextEntry?.continuesFromPrev) : false);
  const wantStart = hasPrev && (pinStart ?? autoStart);
  const wantEnd = hasNext && (pinEnd ?? autoEnd);

  // Both ends at once, and through the BUDGET-aware helper: the two pins compete for the same image
  // slots, and at a full cast SEAM_PRIORITY drops the closing one (then the opening one) before it
  // drops a paid identity reference. Each end keeps its own answer all the way to the copy — the
  // budget can preserve one pin and drop the other.
  const strengths = pinStrengthsFor(backend, { castRefCount, hasSeamIn: wantStart, hasSeamOut: wantEnd });
  const startStrength: PinStrength = wantStart ? strengths.in : 'none';
  const endStrength: PinStrength = wantEnd ? strengths.out : 'none';

  // Can this backend end a segment on a given frame at all? A model with no closing anchor and no
  // reference slot for one (Kling text-to-video) cannot, and then the downstream join is nobody's
  // choice (plan P5: supportsEndFrame && feedsNext). `autoEnd` IS "the join is on record": auto
  // pins an ending exactly where the successor recorded that it opened on this clip.
  const showSeamWarning = pinStrengthFor(backend, { castRefCount, end: 'out' }) !== 'none' && autoEnd;
  return {
    autoStart, autoEnd, wantStart, wantEnd, startStrength, endStrength,
    showSeamWarning,
    offerCascade: showSeamWarning && endStrength === 'none',
  };
}

/** The downstream join, in plain words: what re-rendering `jobId` does to the clip after it. One
 *  wording for both surfaces — the fact is the same on either. */
export function downstreamSeamSentence({ jobId, nextId, endStrength }: {
  jobId: string; nextId: string; endStrength: PinStrength;
}): string {
  const opener = `${nextId} starts on ${jobId}’s current last frame.`;
  // Asked-for is not delivered: an ending pin the reference budget drops leaves the downstream join
  // exactly as broken as never asking for one.
  return endStrength !== 'none'
    ? `${opener} Ending ${jobId} on ${nextId}'s opening frame keeps that join ${seamStrengthWords(endStrength)}, so ${nextId} and everything after it can stay exactly as they are.`
    : `${opener} Re-rendering ${jobId} changes that frame, so ${nextId}'s join will break.`;
}

// ── Delivery lifecycle (WS2-P6) ──────────────────────────────────────────────────────────────────
// Reopening a delivered run deletes nothing and unlinks nothing: `approved` and the file it points
// at stay exactly where they are until a NEWER approval supersedes them. So "is this run back in
// review?" is a question about two timestamps, and the answer must be drawn the same way here as
// `finalizedFinal()` draws it in web/server/lib/run-scan.js — one rule, two sides.

/** The final a reopened run still holds on disk, or null when the run was never reopened (or has
 *  already been delivered again since). `fileName` is what the copy names, never a host path. */
export function reopenedFinal(manifest: Manifest | null | undefined): { path: string; fileName: string; at: string } | null {
  const reopenedAt = manifest?.reopenedAt;
  const approved = manifest?.approved;
  if (!reopenedAt || !approved?.final) return null;
  // `>=`: an approval cannot precede the reopen that enabled it, so an equal stamp is the newer
  // fact — exactly how `finalizedFinal()` reads it server-side.
  if (String(approved.at ?? '') >= String(reopenedAt)) return null; // delivered again since the reopen
  return { path: approved.final, fileName: basename(approved.final), at: reopenedAt };
}

/** One delivery, ready to list: the id the manifest gave it, its on-disk name and a media URL that
 *  still resolves — an older final is never deleted, so it stays downloadable forever. */
export interface DeliveredFinal {
  id: string; fileName: string; url: string; upscaled: boolean; at: string; replacedBy?: string;
  /** The delivered file's own measured short side, when the server recorded one. */
  shortSide?: number | null;
}

/** This run's deliveries, oldest first, with the current one last. Empty for a run delivered before
 *  `finals` existed — absence means "no history recorded", never "nothing was delivered". */
export function deliveredFinals(manifest: Manifest | null | undefined): DeliveredFinal[] {
  return (manifest?.finals ?? [])
    .filter((f) => f?.final)
    .map((f) => ({ id: f.id, fileName: basename(f.final), url: outMediaUrl(f.final), upscaled: !!f.upscaled, at: f.at, replacedBy: f.replacedBy, shortSide: f.shortSide ?? null }));
}
