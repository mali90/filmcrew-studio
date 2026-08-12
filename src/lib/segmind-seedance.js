// THE Segmind × Seedance BINDING — the sibling of fal-seedance.js, and the whole of what a second
// render provider costs: this file plus one line in pipeline.js's SEEDANCE_ADAPTERS map. The
// renderer (render-seedance.js) and the argument builder (seedance-args.js) are shared and stay
// provider-blind; everything Segmind-specific is either a cap in the registry or the transport below.
//
// It imports ONLY ./segmind.js — never fal — so a Segmind-only install (SEGMIND_UPLOAD_MODE=data-uri,
// no FAL_KEY anywhere) never pulls fal's client into the graph. test/unit/pipeline-backends.test.js
// pins that in both directions.
import { generateSegmind, segmindAssetUrl } from './segmind.js';

/**
 * Segmind's provider transport.
 *
 * `assetUrl` deliberately IGNORES the mode the renderer passes: that argument carries the shared
 * Seedance knob (SEEDANCE_UPLOAD_MODE: 'storage' | 'data-uri'), whose vocabulary is fal's. How a
 * reference reaches Segmind is its own setting (SEGMIND_UPLOAD_MODE: 'data-uri' | 'fal-storage'),
 * which segmindAssetUrl defaults to. `cache: false` still travels through — every seam frame is
 * named last_frame.png, so caching by basename would hand job 3 job 2's frame.
 *
 * `generate` maps the renderer's neutral `endpoint` onto Segmind's model SLUG (the registry stores
 * it as `slugKey`), and forwards both callbacks: `onSubmit` when Segmind ACCEPTS the request (what
 * makes the sidecar's "sent" honest — the poll after it can run for twenty minutes) and `onMeta`
 * with the completion receipt — request id, what the job cost, credits left.
 */
export const segmindAdapter = {
  assetUrl: (absPath, _mode, { cache = true } = {}) => segmindAssetUrl(absPath, undefined, { cache }),
  generate: (args, { endpoint, destDir, timeoutMs, onMeta, onSubmit }) =>
    generateSegmind(args, { slug: endpoint, destDir, timeoutMs, onMeta, onSubmit }),
};

export default { segmindAdapter };
