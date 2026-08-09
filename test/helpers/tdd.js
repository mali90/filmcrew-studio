// Red-spec arming for the WS2 phases.
//
// The WS2 specs are written BEFORE the code (TDD), but every phase of this branch has to stay
// independently green — a P6 spec must not paint the suite red while P1 is being implemented. So a
// spec whose module (or export) does not exist yet reports its tests as `todo`/`skip` with the
// phase id in the reason, and ARMS ITSELF the moment the implementation lands. Nothing to
// uncomment, nothing to remember.
//
// To see the red — the whole point of a TDD gate — run the suite with WS2_STRICT=1: `armed()` then
// rethrows the resolution error instead of parking the file, so `WS2_STRICT=1 node test/run.js`
// reports exactly what is still missing.
//
//   const mod = await armed(() => import('../../src/lib/prompt-compose.js'), ['chooseSeamMode']);
//   const PENDING = pending(mod, 'WS2-04: src/lib/prompt-compose.js#chooseSeamMode');
//   test('…', PENDING, () => { … });

export const STRICT = /^(1|true|yes|on)$/i.test(process.env.WS2_STRICT ?? '');

/**
 * Import a module that may not exist yet.
 * @param {() => Promise<object>} load  a thunk, so the specifier resolves against the CALLER's file
 * @param {string[]} [need]  exports that must be present for the module to count as implemented
 * @returns {Promise<object|null>} the module, or null when it (or a needed export) is missing
 */
export async function armed(load, need = []) {
  let mod;
  try {
    mod = await load();
  } catch (e) {
    if (STRICT || (e?.code !== 'ERR_MODULE_NOT_FOUND' && e?.code !== 'MODULE_NOT_FOUND')) throw e;
    return null;
  }
  const missing = need.filter((n) => mod?.[n] === undefined);
  if (!missing.length) return mod;
  if (STRICT) throw new Error(`module is present but does not export: ${missing.join(', ')}`);
  return null;
}

/**
 * node:test options for a spec that is still waiting on its implementation.
 * @param {object|null|boolean} ready  the armed module (or any truthy readiness check)
 * @param {string} what  what is missing — always lead with the plan id, e.g. 'WS2-04: chooseSeamMode'
 */
export function pending(ready, what) {
  if (ready) return {};
  if (STRICT) return {}; // WS2_STRICT=1: run it anyway and let it fail — that IS the red gate
  const reason = `pending — ${what}`;
  return { todo: reason, skip: reason };
}
