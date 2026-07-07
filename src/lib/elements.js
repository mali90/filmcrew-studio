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

/** A human-readable inventory listing for injection into an agent prompt. */
export function inventoryText(inv = buildInventory()) {
  if (!inv.length) return '(no element images found — add files under elements/references, elements/first-frame, elements/last-frame)';
  const byType = { reference: [], first_frame: [], last_frame: [] };
  for (const e of inv) byType[e.type]?.push(e);
  const section = (label, list) =>
    !list.length ? '' : `\n${label}:\n` + list.map((e) => `  - id: ${e.id}  file: ${e.file}${e.description ? `  — ${e.description}` : ''}`).join('\n');
  return [
    section('REFERENCE IMAGES (Elements — pin subject/object/style; up to 7 per generation)', byType.reference),
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

export default { buildInventory, inventoryText, resolveImage };
