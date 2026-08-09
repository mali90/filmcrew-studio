// Red-spec arming for the WS2 phases — now DISARMED, because every phase has landed.
//
// The WS2 specs were written BEFORE the code (TDD), and each phase of this branch had to stay
// independently green: a P6 spec must not paint the suite red while P1 is being implemented. So a
// spec whose module (or export) did not exist yet reported its tests as `todo`/`skip` with the
// phase id in the reason, and armed itself the moment the implementation landed.
//
// That parking is a HOLE once the code exists: delete `src/lib/prompt-compose.js` today and 18
// seam-mode tests would report "pending" and the suite would still exit 0 — the regression makes
// its own test disappear. So the default is now inverted: a missing module or export THROWS, which
// fails the spec file loudly. `pending()` never parks.
//
// WS2_TDD=1 restores the old parking behaviour for anyone writing the next round of red specs
// before their implementation exists.
//
//   const mod = await armed(() => import('../../src/lib/prompt-compose.js'), ['chooseSeamMode']);
//   const PENDING = pending(mod, 'WS2-04: src/lib/prompt-compose.js#chooseSeamMode');
//   test('…', PENDING, () => { … });

/** Opt back INTO parking (red-spec authoring). Default: missing code is a hard failure. */
export const PARK = /^(1|true|yes|on)$/i.test(process.env.WS2_TDD ?? '');
/** Kept for the specs that still read it: strict is now simply "not parking". */
export const STRICT = !PARK;

/**
 * Import a module that must exist (or, under WS2_TDD=1, may not exist yet).
 * @param {() => Promise<object>} load  a thunk, so the specifier resolves against the CALLER's file
 * @param {string[]} [need]  exports that must be present for the module to count as implemented
 * @returns {Promise<object|null>} the module; null only when parking is explicitly enabled
 */
export async function armed(load, need = []) {
  let mod;
  try {
    mod = await load();
  } catch (e) {
    if (!PARK || (e?.code !== 'ERR_MODULE_NOT_FOUND' && e?.code !== 'MODULE_NOT_FOUND')) throw e;
    return null;
  }
  const missing = need.filter((n) => mod?.[n] === undefined);
  if (!missing.length) return mod;
  if (!PARK) throw new Error(`module is present but does not export: ${missing.join(', ')}`);
  return null;
}

/**
 * node:test options for a spec whose implementation has landed — i.e. `{}`, run it.
 * Only WS2_TDD=1 turns a falsy `ready` back into a parked todo/skip.
 * @param {object|null|boolean} ready  the armed module (or any truthy readiness check)
 * @param {string} what  what is missing — always lead with the plan id, e.g. 'WS2-04: chooseSeamMode'
 */
export function pending(ready, what) {
  if (ready) return {};
  if (!PARK) throw new Error(`${what} — implementation missing, and this spec no longer parks (WS2_TDD=1 to park)`);
  const reason = `pending — ${what}`;
  return { todo: reason, skip: reason };
}
