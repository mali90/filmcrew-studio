// Shared fixtures: repo root, the golden spec, and small binary blobs for tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The render-ready golden spec (deep-cloned so callers can mutate it freely). */
export function loadGoldenSpec() {
  const raw = fs.readFileSync(path.join(ROOT, 'examples/ocean-lighthouse/spec.json'), 'utf8');
  return JSON.parse(raw);
}

export const SUBJECT_PNG = path.join(ROOT, 'elements/references/subject.png');

/** A minimal valid 1x1 PNG (used where any image file is needed). */
export const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
