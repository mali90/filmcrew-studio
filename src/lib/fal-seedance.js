// THE fal × Seedance BINDING (and a compat shim). The renderer and its argument builder now live in
// provider-neutral modules — src/lib/render-seedance.js and src/lib/seedance-args.js — driven by the
// caps bundle from the provider/model registry. This file is where the fal TRANSPORT is bolted to
// fal's Seedance caps, and it survives under its old name so nothing downstream changes an import
// path, and so the byte-compat gates (test/unit/seedance-args.test.js,
// test/integration/seedance-render.test.js) keep exercising the fal Seedance 2.0 payload through
// exactly the call signatures they always used.
//
// Adding `seedance-2.0@segmind` or `seedance-2.5@*` means a sibling file with different caps and a
// different adapter — no fork of the renderer, and no fal import in that file's graph.
import { capsFor } from './render-models.js';
import { renderSeedanceJob } from './render-seedance.js';
import { buildSeedanceArgs as buildArgs } from './seedance-args.js';
import { generateSeedance, falRef, toFalInputAs } from './fal.js';

const CAPS = capsFor('seedance-2.0@fal');

/**
 * fal's provider transport. `cache: false` bypasses the basename-keyed cloud-refs cache — seam
 * frames are per-run files that all share the basename last_frame.png, so caching them would
 * churn/collide. This lives with the provider binding, never in the generalized renderer.
 */
export const falAdapter = {
  assetUrl: (absPath, mode, { cache = true } = {}) => (cache ? falRef(absPath, mode) : toFalInputAs(absPath, mode)),
  generate: (args, { endpoint, destDir, timeoutMs, onSubmit }) => generateSeedance(args, { endpoint, destDir, timeoutMs, onSubmit }),
};

/** The one-argument builder the fal Seedance 2.0 callers (and the byte-compat gate) still use. */
export const buildSeedanceArgs = (intent) => buildArgs(intent, CAPS);

/** fal Seedance 2.0: the generalized renderer pre-bound to this model's caps and fal's transport. */
export const renderSeedanceJobFal = (params) => renderSeedanceJob(params, { caps: CAPS, adapter: falAdapter });

export default { renderSeedanceJobFal, buildSeedanceArgs };
