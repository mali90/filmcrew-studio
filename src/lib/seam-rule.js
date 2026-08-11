// How a clip is pinned to its neighbours — the seam rule, in exactly ONE place.
//
// It used to live inside prompt-compose.js (which still re-exports every symbol here, so no import
// path downstream changed), with a hand-kept TypeScript mirror in web/shared/render-models.ts. Two
// copies of a rule that decides what a user is PROMISED before they pay is one copy too many, so
// this module holds the only implementation: it imports render-models.js and nothing else, reads no
// environment and touches no filesystem, which is what lets the browser bundle, web/server's
// config-free static graph and the renderers all call the same function.
//
//   'native'      the model has a real first/last-frame anchor and it is used → a true seam. ONLY
//                 this may ever be described to a user as "seamless".
//   'soft'        no anchor available, so the frame rides as an extra reference image plus a prompt
//                 pin → "near-seamless (reference-guided)". A likeness, not a guarantee.
//   'none'        no frame to pin (a first segment, a text-to-video job), or a soft pin the
//                 reference budget could not hold — a missing seam, not a broken one.
//   'unsupported' a RUNTIME downgrade: the provider rejected the anchor we sent (see the Kling
//                 end_image_url fallback). chooseSeamMode never returns it.
//
// The tail of the file holds the READING half of the same rule — given two clips' recorded seams,
// is the joint between them really pinned? — for the same reason: src/lib/seamstitch.js (what the
// stitcher does) and web/server/lib/lineage.js (what the badge says) must never disagree about a
// joint, and two copies of that rule would eventually promise "seamless" over a hard cut.
import { refLabel } from './render-models.js';

/** The closed vocabulary the sidecars, the lineage and the UI copy all share. */
export const SEAM_MODES = Object.freeze(['native', 'soft', 'none', 'unsupported']);

/** Drop order when the reference budget bites: a boundary pin is a nicety, a cast ref is identity. */
export const SEAM_PRIORITY = Object.freeze(['seamOut', 'seamIn', 'cast']);

/** Does this caps bundle actually have a usable anchor argument for that end? */
const nativeSlot = (caps, end) => Boolean(
  end === 'in'
    ? caps?.nativeFirstFrame && (caps?.argMap ? caps.argMap.firstFrame : true)
    : caps?.nativeLastFrame && (caps?.argMap ? caps.argMap.lastFrame : true),
);

/**
 * Decide, per end, HOW this job's boundary frames get applied on this backend.
 * Pure: reads `caps` and two booleans, mutates nothing.
 *
 * This answers the MODEL's question only ("can this backend anchor that end at all?"). Whether a
 * soft pin survives the reference budget is planSeamRefs' answer — `pinStrengths` below composes
 * the two, and every surface that quotes a mode to a user before they pay must use that one.
 *
 * @param {{caps:object, castRefCount?:number, hasSeamIn?:boolean, hasSeamOut?:boolean}} p
 * @returns {{in:{mode:string, reason:string}, out:{mode:string, reason:string}}}
 */
export function chooseSeamMode({ caps, castRefCount = 0, hasSeamIn = false, hasSeamOut = false }) {
  const excludesRefs = Boolean(caps?.firstFrameExcludesRefs);
  const pick = (has, end) => {
    if (!has) return { mode: 'none', reason: 'no boundary frame for this end' };
    if (!nativeSlot(caps, end)) return { mode: 'soft', reason: `${caps?.label ?? 'this model'} has no ${end === 'in' ? 'first' : 'last'}-frame anchor — the frame rides as a reference image + a prompt pin` };
    // Kling seeds a frame through its Elements set: a text-to-video job (no cast reference at all)
    // has nothing to attach it to, so there is no seam to claim.
    if (caps?.family === 'kling') {
      return castRefCount > 0
        ? { mode: 'native', reason: 'native storyboard frame anchor' }
        : { mode: 'none', reason: 'text-to-video job — no element to seed the frame from' };
    }
    // Segmind's native slots are mutually exclusive with reference_images: keep the CAST (identity)
    // and soft-pin the frame rather than render a stranger on a perfect seam.
    if (excludesRefs && castRefCount > 0) {
      return { mode: 'soft', reason: 'the native frame slot excludes cast references — keeping the cast and pinning by reference' };
    }
    return { mode: 'native', reason: 'native frame anchor' };
  };
  return { in: pick(hasSeamIn, 'in'), out: pick(hasSeamOut, 'out') };
}

/** The prompt sentence that pins a soft seam. The START wording is frozen: it is what today's
 *  renders already send, and moving it would move every existing prompt's bytes. */
export const seamPinSentence = (label, end) => (end === 'in'
  ? `Use ${label} as the literal first frame of this clip and continue its motion seamlessly forward.`
  : `Use ${label} as the literal last frame of this clip; the shot must arrive on that exact image.`);

/**
 * Lay out a job's image references when boundary frames are soft-pinned: the cast first (so a prompt
 * that already names @Image1 keeps pointing at the same character), then up to two reserved slots
 * for the seam frames, then the prompt sentences that cite them.
 *
 * When the model's reference budget cannot hold everything, SEAM_PRIORITY decides: the END pin goes
 * first, then the START pin, and only once both are gone may a cast reference be dropped. A dropped
 * frame takes its prompt sentence with it — no reference, no claim.
 *
 * @param {{caps:object, castRefs?:string[], seamIn?:string|null, seamOut?:string|null,
 *          otherRefCount?:number}} p  `otherRefCount` = refs already spent from a COMBINED budget
 *          (fal 2.5 counts images + audio + video together)
 * @returns {{imageRefs:{kind:'cast'|'seamIn'|'seamOut', url:string, label:string}[],
 *           pins:string[], dropped:{kind:string, url:string, reason:string}[]}}
 */
export function planSeamRefs({ caps, castRefs = [], seamIn = null, seamOut = null, otherRefCount = 0 }) {
  // `Number.isFinite`, never a falsy-coalesce: a registry entry that declares a cap of 0 (an
  // image-less endpoint) means NOTHING fits, and `|| Infinity` would read that as "unlimited" and
  // ship every reference to a model that accepts none.
  const rawImages = Number(caps?.maxImages);
  const rawCombined = Number(caps?.maxCombinedRefs);
  const byImages = Number.isFinite(rawImages) ? rawImages : Infinity;
  const byCombined = Number.isFinite(rawCombined) ? rawCombined - (Number(otherRefCount) || 0) : Infinity;
  const budget = Math.max(0, Math.min(byImages, byCombined));
  const capName = () => (byCombined < byImages
    ? `the ${rawCombined}-reference combined budget`
    : `the ${rawImages}-image reference cap`);

  let wanted = [
    ...castRefs.map((url) => ({ kind: 'cast', url })),
    ...(seamIn ? [{ kind: 'seamIn', url: seamIn }] : []),
    ...(seamOut ? [{ kind: 'seamOut', url: seamOut }] : []),
  ];
  const dropped = [];
  for (const kind of SEAM_PRIORITY) {
    // Cast refs are dropped from the TAIL (the lead character is listed first).
    while (wanted.length > budget && wanted.some((r) => r.kind === kind)) {
      let i = -1;
      for (let j = wanted.length - 1; j >= 0; j--) if (wanted[j].kind === kind) { i = j; break; }
      dropped.push({ ...wanted[i], reason: `over ${capName()}` });
      wanted = wanted.filter((_, j) => j !== i);
    }
  }

  const imageRefs = wanted.map((r, i) => ({ ...r, label: refLabel(caps, 'Image', i + 1) }));
  const pins = [];
  for (const end of ['in', 'out']) {
    const hit = imageRefs.find((r) => r.kind === (end === 'in' ? 'seamIn' : 'seamOut'));
    if (hit) pins.push(seamPinSentence(hit.label, end));
  }
  return { imageRefs, pins, dropped };
}

/**
 * What was really APPLIED, given the reference layout planSeamRefs produced: a soft pin whose
 * reference lost its slot to the image budget pinned nothing, and must be reported as no seam
 * rather than as a promise the clip cannot keep. Native pins ride their own argument and are never
 * affected by the image budget.
 * @param {{in:{mode:string},out:{mode:string}}} seam  chooseSeamMode's answer
 * @param {{kind:string}[]} imageRefs  planSeamRefs().imageRefs
 * @returns {{in:string, out:string}} the applied modes
 */
export function appliedSeamModes(seam, imageRefs = []) {
  const kept = (kind) => imageRefs.some((r) => r.kind === kind);
  return {
    in: seam?.in?.mode === 'soft' && !kept('seamIn') ? 'none' : seam?.in?.mode ?? 'none',
    out: seam?.out?.mode === 'soft' && !kept('seamOut') ? 'none' : seam?.out?.mode ?? 'none',
  };
}

/**
 * How each end WOULD be pinned on this backend, budget included — the answer every surface that
 * quotes a seam to a user before they pay must use (the re-render dialog's plain-words sentence,
 * the prompt sheet's seam line, resolveBoundaries' startMode/endMode). It is chooseSeamMode
 * followed by the same SEAM_PRIORITY arithmetic the renderer runs, so a pin the image budget will
 * drop is never sold as "near-seamless (reference-guided)".
 *
 * `castRefCount` is counted the way the renderers count it: one image reference per element in the
 * job (see castRefCountFor). `otherRefCount` defaults to 0 — a caller that cannot know how many
 * voice clips a job will carry gets the model's own cap honestly, and a combined budget can then
 * only be tighter than reported, never looser.
 *
 * @param {{caps:object, castRefCount?:number, otherRefCount?:number,
 *          hasSeamIn?:boolean, hasSeamOut?:boolean}} p
 * @returns {{in:string, out:string}}
 */
export function pinStrengths({ caps, castRefCount = 0, otherRefCount = 0, hasSeamIn = false, hasSeamOut = false }) {
  const seam = chooseSeamMode({ caps, castRefCount, hasSeamIn, hasSeamOut });
  const plan = planSeamRefs({
    caps,
    castRefs: Array.from({ length: Math.max(0, Number(castRefCount) || 0) }, (_, i) => `cast:${i}`),
    seamIn: seam.in.mode === 'soft' ? 'seam:in' : null,
    seamOut: seam.out.mode === 'soft' ? 'seam:out' : null,
    otherRefCount: caps?.maxCombinedRefs != null ? otherRefCount : 0,
  });
  return appliedSeamModes(seam, plan.imageRefs);
}

/**
 * How many cast image references a job carries — the one input the seam rule asks about the cast,
 * and a rule subtle enough to be worth having once: a job that names NO elements inherits the whole
 * roster (N paid uploads), not zero. Mirrors what characterGroups() resolves, counted the way
 * planSeamRefs budgets it.
 * @param {object} spec  the render spec
 * @param {string} jobId
 * @returns {number}
 */
export function castRefCountFor(spec, jobId) {
  const job = (spec?.kling?.jobs ?? []).find((j) => j?.job_id === jobId);
  return job?.elements?.length || (spec?.kling?.elements?.length ?? 0);
}

// ── Reading a recorded joint ─────────────────────────────────────────────────────────────────────
// A joint has TWO records, one per side: the successor's `seamIn` (the frame it opened on) and the
// predecessor's `seamOut` (the frame it was made to arrive on). Either one, when it was really
// applied and names the clip sitting on the other side, is evidence the two clips share a boundary
// frame. Judging by the successor alone hard-cuts the joint a nonterminal re-render just paid to
// pin: the new predecessor records the join in `seamOut.to`, while the untouched successor still
// carries the `seamIn.from` of the clip it was rendered against takes ago.

/** A non-empty string, or null — ids and paths arrive from JSON and may be anything. */
const str = (v) => (typeof v === 'string' && v.length ? v : null);

/** Seam modes that pinned NOTHING: no frame was shared, so a joint resting on one is a real cut.
 *  'unsupported' is the provider having rejected the anchor we sent. */
export const UNPINNED_SEAM_MODES = Object.freeze(['none', 'unsupported']);

/** Did this recorded seam apply a pin at all? A missing record is an unpinned end, never a pin. */
export function seamApplied(seam) {
  if (!seam || typeof seam !== 'object') return false;
  return !UNPINNED_SEAM_MODES.includes(str(seam.mode) ?? 'none');
}

/** The default identity test: the clip a lineage pointer names IS the clip sitting at that
 *  position. Callers holding richer records (lineage.js knows each side's take+job too) pass their
 *  own — the RULE is which record is consulted, not how a position is addressed. */
const sameClip = (pointer, side) => {
  const a = str(pointer?.clip);
  const b = str(side?.clip);
  return Boolean(a && b && a === b);
};

/**
 * Did `next` open on `prev`'s closing frame, by its own record? Clip identity is the authoritative
 * test: a seam recorded against a clip that is no longer in this cut is exactly the false
 * continuation claim the check exists to catch (run b1nx — K1 re-rendered into a new take, the cut
 * still using the old take's K2, which opens on a frame nothing here contains).
 * @param {{seamIn?:object}} next  the record at the later position
 * @param {object} prev            the record (or entry) at the earlier position
 * @param {(pointer:object, side:object)=>boolean} [same]
 */
export function openedOnPrev(next, prev, same = sameClip) {
  const seam = next?.seamIn;
  return seamApplied(seam) && Boolean(seam.from) && same(seam.from, prev);
}

/**
 * Was `prev` rendered to ARRIVE on `next`'s opening frame, by its own record? The mirror image, and
 * the only evidence there is when the successor was never re-rendered: an applied end pin records
 * where it was headed (pipeline.js seamDestFor), and a pin the reference budget dropped records
 * mode 'none' — so a destination alone never counts, it has to have been applied.
 * @param {{seamOut?:object}} prev  the record at the earlier position
 * @param {object} next             the record (or entry) at the later position
 * @param {(pointer:object, side:object)=>boolean} [same]
 */
export function closesOnNext(prev, next, same = sameClip) {
  const seam = prev?.seamOut;
  return seamApplied(seam) && Boolean(seam.to) && same(seam.to, next);
}

/** Is this joint really pinned? Evidence from EITHER side counts — the one rule both judges ask. */
export const jointPinned = (prev, next, same = sameClip) => (
  openedOnPrev(next, prev, same) || closesOnNext(prev, next, same)
);

export default {
  SEAM_MODES,
  SEAM_PRIORITY,
  UNPINNED_SEAM_MODES,
  chooseSeamMode,
  seamPinSentence,
  planSeamRefs,
  appliedSeamModes,
  pinStrengths,
  castRefCountFor,
  seamApplied,
  openedOnPrev,
  closesOnNext,
  jointPinned,
};
