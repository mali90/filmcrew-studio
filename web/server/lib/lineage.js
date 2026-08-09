// WS2-P2 — the continuity rule, pure.
//
// THE RULE, in one sentence:
//   segment i continues from i−1 iff its recorded seam SOURCE CLIP is the clip currently at
//   position i−1 of the cut.
//
// Not "a seam frame was used". Run b1nx used one and is still broken: K1 was re-rendered into take
// t2, the cut kept t1's K2, and that K2 opens on a frame grabbed from a K1 the cut no longer
// contains. A naive "did this job get a start frame?" check calls that a continuation, hands the
// joint to the seamless stitcher (colour matching + frame dedup), and the UI promises "seamless"
// over a visible jump. So the comparison is against the clip that is actually in the cut, by
// identity, every time.
//
// Runs rendered before the seam sidecar existed carry no lineage at all. Rather than guess loudly,
// this module REPLAYS take history for them — "K2 was rendered in take t1, so its opening frame came
// from whichever K1 was current in t1" — and stamps the whole answer confidence:'derived' so the UI
// draws a dashed connector and says "join unknown" instead of claiming a link it cannot see.
//
// Pure by construction: no filesystem, no host config module, no runs service, no I/O of any kind.
// Input is a plain run record (the runs service assembles it); output is ids only — a take/job pair
// is meaningful to the UI, a host directory is a leak.

/** Joint verdicts, in the order of how much the UI is allowed to promise. */
export const JOINT_KINDS = Object.freeze(['linked', 'broken', 'isolated', 'unknown']);

/**
 * Machine tokens explaining a verdict. The UI turns these into copy — never the other way round, so
 * a wording change never becomes a behaviour change.
 *   no-prev          the first segment: there is nothing to continue from
 *   no-seam          nothing was pinned here (no source recorded, or history says it never chained)
 *   source-matches   the recorded/derived source IS the clip at the previous position
 *   source-replaced  the source clip has since been replaced in the cut — THE b1nx case
 *   mode-none        the renderer applied no boundary at all (a scene cut by design)
 *   mode-unsupported the provider rejected the anchor we sent, so nothing was pinned after all
 *   unknown-segment  this segment or its neighbour names a take/job the run never rendered
 */
export const CONTINUITY_REASONS = Object.freeze([
  'no-prev', 'no-seam', 'source-matches', 'source-replaced',
  'mode-none', 'mode-unsupported', 'unknown-segment',
]);

/**
 * @typedef {{take?:string, job?:string, jobId?:string, clip?:string|null}} SeamSource
 * @typedef {{mode?:string, frame?:string|null, from?:SeamSource|null}} SeamIn
 * @typedef {{jobId?:string, job?:string, clip?:string|null, seamIn?:SeamIn|null, startFrame?:string|null}} TakeJob
 * @typedef {{take?:string, at?:string, jobs?:TakeJob[]}} Take
 * @typedef {{jobId?:string, job?:string, take?:string}} CutEntry
 * @typedef {{runId?:string, chained?:boolean, takes?:Take[], cut?:CutEntry[]}} RunRecord
 *
 * @typedef {{index:number, jobId:string|null, take:string|null, continuesFromPrev:boolean,
 *            confidence:'recorded'|'derived', from:{take:string|null,job:string|null}|null,
 *            reason:string}} Segment
 * @typedef {{index:number, fromIndex:number, toIndex:number, fromJobId:string|null,
 *            toJobId:string|null, kind:string, linked:boolean,
 *            confidence:'recorded'|'derived', reason:string}} Joint
 */

/** A non-empty string, or null — ids and paths arrive from JSON and may be anything. */
const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Index the takes by id, keeping their record order as the chronological order (the runs service
 * appends takes; nothing reorders them). Duplicate take ids merge, last job record wins.
 */
function buildTakeIndex(run) {
  const takes = Array.isArray(run?.takes) ? run.takes : [];
  const order = new Map();  // takeId → ordinal
  const byTake = new Map(); // takeId → Map(jobId → job record)
  takes.forEach((t, i) => {
    const id = str(t?.take);
    if (!id) return;
    if (!order.has(id)) order.set(id, i);
    const jobs = byTake.get(id) ?? new Map();
    for (const j of Array.isArray(t?.jobs) ? t.jobs : []) {
      const jobId = str(j?.jobId ?? j?.job);
      if (jobId) jobs.set(jobId, j);
    }
    byTake.set(id, jobs);
  });
  return { order, byTake };
}

const recordFor = (idx, take, jobId) => (take && jobId ? idx.byTake.get(take)?.get(jobId) ?? null : null);

/** Did this job record come back from a renderer that writes seam lineage (schema:2)? */
const hasRecordedSeam = (rec) => Boolean(rec) && typeof rec.seamIn === 'object' && rec.seamIn !== null;

/** Ids only — the clip in a recorded source is for comparison, never for the caller. */
function sourceIds(src) {
  const take = str(src?.take);
  const job = str(src?.job ?? src?.jobId);
  return take || job ? { take, job } : null;
}

/**
 * Is `src` the clip sitting at the previous position? Clip identity is the authoritative test; when
 * either side has no clip on record (an errored job, a partially written take) fall back to the
 * take+job pair, which addresses the same slot.
 */
function sourceIsCurrent(src, prev) {
  const a = str(src?.clip);
  const b = str(prev.record?.clip);
  if (a && b) return a === b;
  return str(src?.take) === prev.take && str(src?.job ?? src?.jobId) === prev.jobId;
}

/**
 * Legacy replay: which take supplied `jobId` at the moment take ordinal `at` was rendered — the most
 * recent take at or before it that contains the job.
 */
function sourceTakeAt(idx, jobId, at) {
  let best = null;
  let bestOrd = -1;
  for (const [takeId, ord] of idx.order) {
    if (ord > at || ord <= bestOrd) continue;
    if (!idx.byTake.get(takeId)?.has(jobId)) continue;
    bestOrd = ord;
    best = takeId;
  }
  return best;
}

/**
 * Legacy runs record no seam at all, so the only evidence a joint was ever pinned is the old
 * `startFrame` field (and the run-level `chained` flag). Absent both, assume the historical default
 * — every job after the first opened on its predecessor's closing frame — and let confidence
 * 'derived' carry the doubt.
 */
function legacyChained(run, rec) {
  if (run?.chained === false) return false;
  if (rec && Object.hasOwn(rec, 'startFrame')) return Boolean(rec.startFrame);
  return true;
}

/** The verdict for one cut position. `prev` is null for the head of the cut. */
function verdictFor(run, idx, cur, prev) {
  const confidence = hasRecordedSeam(cur.record) ? 'recorded' : 'derived';
  if (!prev) return { continuesFromPrev: false, confidence, from: null, reason: 'no-prev' };

  // A cut naming a take/job the run never rendered: we cannot compare, and the joint AFTER such a
  // segment is equally unanswerable — both degrade to 'unknown' rather than throwing on the way to
  // a review page.
  if (!cur.record || !prev.record) {
    return { continuesFromPrev: false, confidence: 'derived', from: null, reason: 'unknown-segment' };
  }

  if (confidence === 'recorded') {
    const seam = cur.record.seamIn;
    const mode = str(seam.mode) ?? 'none';
    if (mode === 'none') return { continuesFromPrev: false, confidence, from: null, reason: 'mode-none' };
    if (mode === 'unsupported') {
      return { continuesFromPrev: false, confidence, from: sourceIds(seam.from), reason: 'mode-unsupported' };
    }
    if (!seam.from) return { continuesFromPrev: false, confidence, from: null, reason: 'no-seam' };
    const matches = sourceIsCurrent(seam.from, prev);
    return {
      continuesFromPrev: matches,
      confidence,
      from: sourceIds(seam.from),
      reason: matches ? 'source-matches' : 'source-replaced',
    };
  }

  if (!legacyChained(run, cur.record)) {
    return { continuesFromPrev: false, confidence, from: null, reason: 'no-seam' };
  }
  const at = idx.order.get(cur.take);
  const srcTake = at === undefined ? null : sourceTakeAt(idx, prev.jobId, at);
  if (!srcTake) return { continuesFromPrev: false, confidence, from: null, reason: 'no-seam' };
  const matches = srcTake === prev.take;
  return {
    continuesFromPrev: matches,
    confidence,
    from: { take: srcTake, job: prev.jobId },
    reason: matches ? 'source-matches' : 'source-replaced',
  };
}

/**
 * The joint's drawing verdict. Confidence outranks the answer: a DERIVED continuation is still
 * 'unknown' (dashed), because the stitcher and the "seamless" copy may only act on lineage that was
 * actually written down.
 */
function jointKindOf(seg) {
  if (seg.reason === 'unknown-segment' || seg.confidence === 'derived') return 'unknown';
  if (seg.reason === 'mode-none' || seg.reason === 'mode-unsupported' || seg.reason === 'no-seam') return 'isolated';
  return seg.continuesFromPrev ? 'linked' : 'broken';
}

/**
 * Per-segment continuity for the cut currently assembled from `run`.
 *
 * @param {RunRecord} run  takes (oldest first, each with its jobs' recorded seams) + the cut
 * @returns {{segments:Segment[], joints:Joint[]}}  N segments, N−1 joints; the caller's run record
 *   is never mutated and no filesystem path appears in the result.
 */
export function computeLineage(run) {
  const idx = buildTakeIndex(run);
  const cut = Array.isArray(run?.cut) ? run.cut : [];

  const entries = cut.map((c) => {
    const jobId = str(c?.jobId ?? c?.job);
    const take = str(c?.take);
    return { jobId, take, record: recordFor(idx, take, jobId) };
  });

  const segments = entries.map((e, i) => {
    const v = verdictFor(run, idx, e, i > 0 ? entries[i - 1] : null);
    return {
      index: i,
      jobId: e.jobId,
      take: e.take,
      continuesFromPrev: v.continuesFromPrev,
      confidence: v.confidence,
      from: v.from,
      reason: v.reason,
    };
  });

  const joints = segments.slice(1).map((seg, i) => {
    const kind = jointKindOf(seg);
    return {
      index: i,
      fromIndex: i,
      toIndex: i + 1,
      fromJobId: segments[i].jobId,
      toJobId: seg.jobId,
      kind,
      // The strong claim, and the ONLY one WS3's stitcher may act on: a continuation that was
      // recorded, not reconstructed.
      linked: kind === 'linked',
      confidence: seg.confidence,
      reason: seg.reason,
    };
  });

  return { segments, joints };
}

/**
 * The wire shape behind the run payload's `continuity`. An explicit allowlist, not a strip: a field
 * added to the internal shape later cannot leak a host path by accident.
 * @param {{segments:Segment[], joints:Joint[]}} lineage
 */
export function serializeContinuity(lineage) {
  const segments = (Array.isArray(lineage?.segments) ? lineage.segments : []).map((s) => ({
    index: s.index,
    jobId: s.jobId ?? null,
    take: s.take ?? null,
    continuesFromPrev: Boolean(s.continuesFromPrev),
    confidence: s.confidence,
    reason: s.reason,
    from: s.from ? { take: s.from.take ?? null, job: s.from.job ?? null } : null,
  }));
  const joints = (Array.isArray(lineage?.joints) ? lineage.joints : []).map((j) => ({
    index: j.index,
    fromIndex: j.fromIndex,
    toIndex: j.toIndex,
    fromJobId: j.fromJobId ?? null,
    toJobId: j.toJobId ?? null,
    kind: j.kind,
    linked: Boolean(j.linked),
    confidence: j.confidence,
    reason: j.reason,
  }));
  return { segments, joints };
}

/**
 * The neighbours a re-render of segment `index` may be pinned to: `first` is the segment before it
 * (whose closing frame becomes this one's opening frame) and `last` the segment after it (whose
 * opening frame becomes this one's closing frame). Either is null at the ends of the cut — the P5
 * dialog then says "opens on a cut" / "ends on a cut" rather than naming a neighbour that does not
 * exist.
 * @param {{segments:Segment[]}} lineage
 * @param {number} index
 * @returns {{first:{index:number,jobId:string|null,take:string|null}|null, last:{index:number,jobId:string|null,take:string|null}|null}}
 */
export function resolveBoundaries(lineage, index) {
  const segments = Array.isArray(lineage?.segments) ? lineage.segments : [];
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= segments.length) return { first: null, last: null };
  const neighbour = (s) => (s ? { index: s.index, jobId: s.jobId ?? null, take: s.take ?? null } : null);
  return { first: neighbour(segments[i - 1]), last: neighbour(segments[i + 1]) };
}

export default { JOINT_KINDS, CONTINUITY_REASONS, computeLineage, serializeContinuity, resolveBoundaries };
