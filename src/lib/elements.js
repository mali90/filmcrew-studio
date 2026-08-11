// Element inventory: the reference images the Casting/Elements agent can choose from, scanned
// from the configured folders (all three Kling Omni input types). Also resolves a spec element's
// `image` (a repo-relative path, bare filename, or absolute path) to an absolute path at render.
import fs from 'node:fs';
import path from 'node:path';
import config, { ROOT, resolvePath } from '../../config.js';
import { slug } from './util.js';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const TYPE_DIRS = () => ([
  { type: 'reference', dir: config.elements.referencesDir },
  { type: 'first_frame', dir: config.elements.firstFrameDir },
  { type: 'last_frame', dir: config.elements.lastFrameDir },
]);

function listImages(dir) {
  const abs = resolvePath(dir);
  let names = [];
  try { names = fs.readdirSync(abs); } catch { return []; }
  return names
    .filter((n) => IMAGE_EXTS.has(path.extname(n).toLowerCase()))
    .sort()
    .map((n) => path.join(abs, n));
}

/** Optional one-line description for an element: a sidecar `<name>.txt` next to the image. */
function descriptionFor(absImage) {
  const sidecar = absImage.replace(/\.[^.]+$/, '.txt');
  try { return fs.readFileSync(sidecar, 'utf8').trim().split('\n')[0]; } catch { return ''; }
}

/**
 * Scan the element folders. Returns a flat list:
 *   [{ id, type: 'reference'|'first_frame'|'last_frame', file (repo-relative), abs, description }]
 * `id` is the slugged basename (what the Casting agent references).
 */
export function buildInventory() {
  const out = [];
  for (const { type, dir } of TYPE_DIRS()) {
    for (const abs of listImages(dir)) {
      const id = slug(path.basename(abs, path.extname(abs)));
      out.push({ id, type, file: path.relative(ROOT, abs), abs, description: descriptionFor(abs) });
    }
  }
  return out;
}

/** The filename convention that links a reference to a character — the id IS the character slug,
 *  or is prefixed "<slug>-". The same rule the web cast routes apply (refLinked), kept here so the
 *  engine and the UI can never disagree about who owns an image. */
export const refBelongsTo = (refId, castSlug) => refId === castSlug || refId.startsWith(`${castSlug}-`);

/** Every reference-type inventory entry linked to `name` (inventory order = sorted filenames). */
export function characterRefs(inv, name) {
  const c = slug(String(name ?? ''));
  if (!c) return [];
  return inv.filter((e) => e.type === 'reference' && refBelongsTo(e.id, c));
}

/**
 * A human-readable inventory listing for injection into an agent prompt. `castNames` (the starred
 * cast) groups the reference section per character, with a count — the Casting agent's STARRED-cast
 * rule needs to SEE the full set to attach the full set (a flat list undersells a character whose
 * seven views sit between other files).
 */
export function inventoryText(inv = buildInventory(), { castNames = [] } = {}) {
  if (!inv.length) return '(no element images found — add files under elements/references, elements/first-frame, elements/last-frame)';
  const byType = { reference: [], first_frame: [], last_frame: [] };
  for (const e of inv) byType[e.type]?.push(e);
  const line = (e) => `  - id: ${e.id}  file: ${e.file}${e.description ? `  — ${e.description}` : ''}`;
  const section = (label, list) => (!list.length ? '' : `\n${label}:\n` + list.map(line).join('\n'));
  const REF_LABEL = 'REFERENCE IMAGES (Elements — pin subject/object/style; the per-job cap is the Hard caps line above)';
  let refSection = section(REF_LABEL, byType.reference);
  if (castNames?.length && byType.reference.length) {
    const claimed = new Set();
    const parts = [];
    for (const name of castNames) {
      const refs = characterRefs(inv, name);
      for (const r of refs) claimed.add(r.id);
      parts.push(`  ${name} — STARRED cast, ${refs.length} reference image${refs.length === 1 ? '' : 's'}:` +
        (refs.length ? `\n${refs.map(line).join('\n')}` : ' (none on disk)'));
    }
    const rest = byType.reference.filter((e) => !claimed.has(e.id));
    if (rest.length) parts.push(`  Other references (attach by relevance only):\n${rest.map(line).join('\n')}`);
    refSection = `\n${REF_LABEL}:\n${parts.join('\n')}`;
  }
  return [
    refSection,
    section('FIRST-FRAME seeds (optional opening frame)', byType.first_frame),
    section('LAST-FRAME seeds (optional closing frame — requires a first frame)', byType.last_frame),
  ].filter(Boolean).join('\n');
}

/** Resolve a spec element image to an absolute path; throws if it doesn't exist. */
export function resolveImage(image) {
  if (!image) throw new Error('resolveImage: empty image path');
  const abs = resolvePath(image);
  if (!fs.existsSync(abs)) throw new Error(`Element image not found: ${image} (resolved ${abs})`);
  return abs;
}

export default { buildInventory, inventoryText, resolveImage, refBelongsTo, characterRefs };
