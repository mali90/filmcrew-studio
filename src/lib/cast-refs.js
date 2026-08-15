// Who owns a reference image. A reference is linked to a character by FILENAME — the convention
// both the CLI (`elements/references/<slug>-01.png`) and the web cast page produce — so every layer
// that reads a character back out of a filename has to read it the SAME way: the engine's top-up,
// the inventory the Casting agent reads, and the cast API's link/unlink/list. This module is that
// one rule; there is no second implementation of it.
//
// Zero imports on purpose: the engine loads it beside config.js and the web server loads it (via
// app.ctx paths) beside its own, and neither may drag the other's world in.

/**
 * The character that owns `refId`, or null when no known slug claims it.
 *
 * A slug owns a file when the id IS the slug or is prefixed "<slug>-"; among the slugs that match,
 * the LONGEST one wins. Asking one slug at a time is what made this dangerous: real casts have
 * slugs that prefix one another (ann / ann-marie, jack / jack-jr), so "ann-marie-01" answered yes
 * for "ann" as well — and the engine's starred-cast top-up would attach it, stamp `character: 'Ann'`
 * on it and upload it, spending money on a render conditioned on the wrong person's face with
 * nothing on screen to say so. Longest-match awards the file to the most specific character named
 * in it, which is the only reading that cannot hand one character's image to another.
 *
 * @param {string} refId  a reference id (the slugged basename of the image file)
 * @param {Iterable<string>} knownSlugs  EVERY character slug in play — the profiles on disk plus
 *   whatever else the caller knows about. Leaving one out is exactly what lets a longer slug's
 *   image be read as a shorter slug's, so callers pass their whole roster, not one name.
 * @returns {string|null}
 */
export function refOwner(refId, knownSlugs = []) {
  const id = String(refId ?? '');
  let owner = null;
  for (const s of knownSlugs) {
    const cslug = String(s ?? '');
    if (!cslug || (id !== cslug && !id.startsWith(`${cslug}-`))) continue;
    if (owner === null || cslug.length > owner.length) owner = cslug;
  }
  return owner;
}

/**
 * Does `refId` belong to `castSlug`? `castSlug` itself counts as known even when `knownSlugs` omits
 * it (a character owns its images before it owns a profile file, and a profile can be deleted while
 * its files stay) — but every OTHER slug the caller knows has to be passed: the answer is only as
 * safe as the roster it is asked against.
 */
export function refBelongsTo(refId, castSlug, knownSlugs = []) {
  const cslug = String(castSlug ?? '');
  if (!cslug) return false;
  return refOwner(refId, [cslug, ...knownSlugs]) === cslug;
}

export default { refOwner, refBelongsTo };
