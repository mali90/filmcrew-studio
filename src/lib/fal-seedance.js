// COMPAT SHIM. The Seedance renderer and its argument builder now live in provider-neutral
// modules — src/lib/render-seedance.js and src/lib/seedance-args.js — driven by the caps bundle
// from the provider/model registry. This file survives so nothing downstream changes an import
// path, and so the byte-compat gates (test/unit/seedance-args.test.js,
// test/integration/seedance-render.test.js) keep exercising the fal Seedance 2.0 payload through
// exactly the call signatures they always used.
//
// Adding `seedance-2.0@segmind` or `seedance-2.5@*` means binding different caps and a different
// adapter next to these two lines — no fork of the renderer.
import { capsFor } from './render-models.js';
import { renderSeedanceJob, falAdapter } from './render-seedance.js';
import { buildSeedanceArgs as buildArgs } from './seedance-args.js';

const CAPS = capsFor('seedance-2.0@fal');

/** The one-argument builder the fal Seedance 2.0 callers (and the byte-compat gate) still use. */
export const buildSeedanceArgs = (intent) => buildArgs(intent, CAPS);

/** fal Seedance 2.0: the generalized renderer pre-bound to this model's caps and fal's transport. */
export const renderSeedanceJobFal = (params) => renderSeedanceJob(params, { caps: CAPS, adapter: falAdapter });

export default { renderSeedanceJobFal, buildSeedanceArgs };
