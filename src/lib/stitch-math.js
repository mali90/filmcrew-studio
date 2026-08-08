// Offset math for the seamless stitcher — an INDEPENDENT JS re-derivation of tools/seamstitch/graph.py
// (§7.5 of tools/seamstitch/SEAMLESS_STITCH_SPEC.md). Nothing in the render path calls it: it exists so
// the tests can check the Python tool's reported offsets/duration against a second implementation
// rather than against themselves. Keep it pure and keep it a mirror — if graph.py's math changes,
// this changes with it, and the integration test catches any drift between the two.
//
//   fd  = 1/fps                       one frame
//   L_0 = nframes_0 * fd
//   L_j = (nframes_j - 1) * fd        when segment j's first frame duplicates its predecessor's last
//       = nframes_j * fd              at a scene cut (nothing is duplicated, so nothing is dropped)
//   OFF_k = Σ_{j<k} L_j − Σ_{i<k} xf_i, snapped to the frame grid
//   expected = Σ L_j − Σ xf_i

/** Python's round() — half-to-EVEN. JS's Math.round() is half-UP, which would disagree with graph.py
 *  whenever an offset lands exactly on a half frame (e.g. a half-frame xfade). */
function roundHalfToEven(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Left-to-right float sum, matching Python's builtin sum() bit for bit. */
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/**
 * Per-segment effective lengths in seconds.
 * `dropFirst[j]` is true when segment j's first frame duplicates segment j-1's last one (entry 0 is
 * unused). Omit it and every joint is treated as a chained continuation, graph.py's default.
 */
export function segmentLengths(nframes, fps, dropFirst = null) {
  if (!Array.isArray(nframes) || !nframes.length) throw new Error('segmentLengths: nframes must be a non-empty array');
  if (!(fps > 0)) throw new Error('segmentLengths: fps must be > 0');
  const fd = 1.0 / fps;
  const drop = dropFirst ?? [false, ...Array(nframes.length - 1).fill(true)];
  if (drop.length !== nframes.length) {
    throw new Error(`segmentLengths: dropFirst needs ${nframes.length} entries (one per segment), got ${drop.length}`);
  }
  return nframes.map((nf, j) => (j > 0 && drop[j] ? nf - 1 : nf) * fd);
}

/**
 * Joint offsets + expected output duration.
 * `xfades` is either one value used at every joint or a per-joint list (N-1 entries).
 * Returns { lengths, offsets, expectedDuration } — the same triple graph.py's compute_offsets returns.
 */
export function computeOffsets(nframes, fps, xfades, dropFirst = null) {
  const lengths = segmentLengths(nframes, fps, dropFirst);
  const n = lengths.length;
  const xf = Array.isArray(xfades) ? xfades.map(Number) : Array(n - 1).fill(Number(xfades));
  if (xf.length !== n - 1) {
    throw new Error(`computeOffsets: need ${n - 1} xfade value(s) for ${n} segments, got ${xf.length}`);
  }
  const offsets = [];
  for (let k = 1; k < n; k++) {
    const off = sum(lengths.slice(0, k)) - sum(xf.slice(0, k));
    offsets.push(roundHalfToEven(off * fps) / fps); // snap to the frame grid (§7.5/§12.5)
  }
  return { lengths, offsets, expectedDuration: sum(lengths) - sum(xf) };
}

export default { segmentLengths, computeOffsets };
