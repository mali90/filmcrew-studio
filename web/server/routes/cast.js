// Cast: character profiles (profiles/<slug>.md), reference images (elements/references/), and
// voices (list + mint). Characters are DISK conventions the engine already understands — a ref is
// linked by filename prefix (<slug>-*.png), a voice by its slug key — so the web UI and CLI users
// produce identical artifacts. All paths come from app.ctx (profilesDir/elementsRoot/voicesFile),
// so the demo server and tests isolate their cast workspace completely. Guidance copy (frontal
// face, 5–30s clips) lives in the UI.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { VOICE_MINT_USD } from '../lib/estimator.js';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
// Kling's model hard cap is 7 reference images per job — a character carrying more can never use
// them in one render, so 7 is the honest per-character ceiling (guidance stays 1–4 clean images).
const MAX_CHAR_REFS = 7;
const SLUG_FILE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const CLIP_EXT = /\.(mp3|wav|mp4|mov)$/i;

export async function registerCastRoutes(app) {
  const { root, childEnv, profilesDir, elementsRoot, voicesFile, mgr } = app.ctx;
  const host = async (rel) => import(path.join(root, 'src/lib', rel));
  const refsDir = path.join(elementsRoot, 'references');

  // ——— shared local scans (ctx paths, no host-config coupling) ———

  /** Reference images under <elementsRoot>/references, shaped like the host inventory. */
  const scanRefs = async () => {
    const { slug } = await host('util.js');
    let files = [];
    try { files = fs.readdirSync(refsDir).filter((f) => IMAGE_EXT.test(f)).sort(); } catch { /* none */ }
    return files.map((f) => {
      const abs = path.join(refsDir, f);
      let description = '';
      try { description = fs.readFileSync(abs.replace(IMAGE_EXT, '.txt'), 'utf8').trim().split('\n')[0]; } catch { /* optional */ }
      const rel = path.relative(elementsRoot, abs);
      return {
        id: slug(path.basename(f, path.extname(f))),
        type: 'reference',
        file: path.relative(root, abs),
        abs,
        description,
        url: `/api/media/elements/${rel.split(path.sep).map(encodeURIComponent).join('/')}`,
      };
    });
  };

  const readVoicesMap = () => { try { return JSON.parse(fs.readFileSync(voicesFile, 'utf8')); } catch { return {}; } };
  const writeVoicesMap = (map) => {
    fs.mkdirSync(path.dirname(voicesFile), { recursive: true });
    fs.writeFileSync(voicesFile, JSON.stringify(map, null, 2) + '\n');
  };
  const voiceRows = (map) => Object.entries(map).map(([key, v]) => ({
    key,
    name: v?.name ?? key,
    voiceId: v?.voice_id ?? null,
    mintedAt: v?.minted_at ?? null,
    refClipAvailable: !!(v?.ref_clip && fs.existsSync(path.resolve(root, v.ref_clip))), // Seedance lip-sync needs the clip itself
    clipName: v?.ref_clip ? path.basename(v.ref_clip) : null,
  }));

  const listProfiles = () => {
    let files = [];
    try { files = fs.readdirSync(profilesDir).filter((f) => f.endsWith('.md')).sort(); } catch { /* none */ }
    return files;
  };
  const displayName = (content, fallback) => content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallback;
  /** The stored file is "# Name\n\n<body>" — never let a body that already starts with the
   *  heading double it (the editor once did; CLI callers may too). */
  const stripLeadingHeading = (body, name) => {
    const lines = String(body).split('\n');
    if ((lines[0] ?? '').trim() === `# ${name}`) {
      lines.shift();
      while ((lines[0] ?? '').trim() === '') lines.shift();
    }
    return lines.join('\n');
  };
  const profilePath = (slugName) => {
    if (!SLUG_FILE.test(slugName)) throw Object.assign(new Error('not a character id'), { statusCode: 400, hint: 'lowercase letters, digits and dashes' });
    return path.join(profilesDir, `${slugName}.md`);
  };
  /** A reference belongs to a character when its id is the slug or is prefixed "<slug>-". */
  const refLinked = (refId, cslug) => refId === cslug || refId.startsWith(`${cslug}-`);

  // ——— references ———

  app.get('/api/cast/references', async () => ({ references: await scanRefs() }));

  app.post('/api/cast/references', async (req, reply) => {
    const part = await req.file();
    if (!part) throw Object.assign(new Error('no file uploaded'), { statusCode: 400, hint: 'send multipart form data with an image file' });
    const { slug } = await host('util.js');
    let name = path.basename(part.filename ?? 'reference.png');
    if (!IMAGE_EXT.test(name) || !SAFE_NAME.test(name.replace(IMAGE_EXT, ''))) {
      throw Object.assign(new Error('not an acceptable image name'), { statusCode: 400, hint: 'png/jpg/webp with a simple filename' });
    }
    fs.mkdirSync(refsDir, { recursive: true });
    // uploaded from a character card: name the file <slug>-NN.ext so the engine's filename
    // matching links it — exactly what a CLI user would have done by hand
    const character = part.fields?.character?.value;
    if (character) {
      const cslug = slug(String(character));
      const linked = (await scanRefs()).filter((r) => refLinked(r.id, cslug)).length;
      if (linked >= MAX_CHAR_REFS) {
        throw Object.assign(new Error(`${character} already has ${MAX_CHAR_REFS} reference images`), { statusCode: 400, hint: `a render can use at most ${MAX_CHAR_REFS} per job — unlink one first (1–4 clean images work best)` });
      }
      const ext = name.match(IMAGE_EXT)[0].toLowerCase();
      let n = 1;
      while (fs.existsSync(path.join(refsDir, `${cslug}-${String(n).padStart(2, '0')}${ext}`))) n++;
      name = `${cslug}-${String(n).padStart(2, '0')}${ext}`;
    }
    const dest = path.join(refsDir, name);
    if (fs.existsSync(dest)) throw Object.assign(new Error(`"${name}" already exists`), { statusCode: 409, hint: 'rename the file or delete the existing reference first' });
    await pipeline(part.file, fs.createWriteStream(dest));
    return reply.code(201).send({ added: name });
  });

  app.delete('/api/cast/references/:id', async (req, reply) => {
    const hit = (await scanRefs()).find((e) => e.id === req.params.id);
    if (!hit) return reply.code(404).send({ error: 'no such reference', hint: 'ids come from GET /api/cast/references' });
    fs.rmSync(hit.abs, { force: true });
    return { deleted: hit.id };
  });

  // Link/unlink an existing reference by RENAMING it — the engine matches by filename, so the
  // disk artifact stays exactly what a CLI user would have produced.
  app.post('/api/cast/references/:id/assign', async (req) => {
    const { slug } = await host('util.js');
    const hit = (await scanRefs()).find((e) => e.id === req.params.id);
    if (!hit) throw Object.assign(new Error('no such reference'), { statusCode: 404, hint: 'GET /api/cast/references lists ids' });
    const character = req.body?.character ? slug(String(req.body.character)) : null;
    const ext = path.extname(hit.abs).toLowerCase();
    const charSlugs = listProfiles().map((f) => slug(f.replace(/\.md$/, '')));
    const owner = charSlugs.find((c) => refLinked(hit.id, c));
    let base;
    if (character) {
      if (!fs.existsSync(profilePath(character))) throw Object.assign(new Error('no such character'), { statusCode: 404, hint: 'create the character first' });
      if (refLinked(hit.id, character)) return { id: hit.id }; // already theirs
      const linked = (await scanRefs()).filter((r) => refLinked(r.id, character)).length;
      if (linked >= MAX_CHAR_REFS) {
        throw Object.assign(new Error(`that character already has ${MAX_CHAR_REFS} reference images`), { statusCode: 400, hint: `a render can use at most ${MAX_CHAR_REFS} per job — unlink one first (1–4 clean images work best)` });
      }
      const stripped = owner ? hit.id.slice(owner.length + 1) || 'ref' : hit.id;
      base = `${character}-${stripped}`;
    } else {
      if (!owner) return { id: hit.id }; // already unassigned
      base = hit.id.slice(owner.length + 1) || `ref-${hit.id}`;
    }
    let dest = path.join(refsDir, `${base}${ext}`);
    for (let n = 2; fs.existsSync(dest); n++) dest = path.join(refsDir, `${base}-${n}${ext}`);
    fs.renameSync(hit.abs, dest);
    // the sidecar description travels with its image
    const sidecar = hit.abs.replace(IMAGE_EXT, '.txt');
    if (fs.existsSync(sidecar)) fs.renameSync(sidecar, dest.replace(IMAGE_EXT, '.txt'));
    return { id: path.basename(dest, ext) };
  });

  // ——— voices ———

  app.get('/api/cast/voices', async () => ({ mintUsd: VOICE_MINT_USD, voices: voiceRows(readVoicesMap()) }));

  // Stage a voice clip WITHOUT minting (free): the clip is saved next to voices.json and the
  // registry gets an entry with voice_id null. Seedance lip-sync only needs the clip, so a staged
  // voice already works there; minting later locks a Kling voice_id from the SAME clip.
  app.post('/api/cast/voices/stage', async (req, reply) => {
    const { slug } = await host('util.js');
    let name = null; let tmpClip = null; let ext = null;
    for await (const part of req.parts()) {
      if (part.type === 'field' && part.fieldname === 'character') name = String(part.value).trim();
      if (part.type === 'file' && part.fieldname === 'clip') {
        const base = path.basename(part.filename ?? 'clip.wav');
        if (!CLIP_EXT.test(base)) throw Object.assign(new Error('not an acceptable clip'), { statusCode: 400, hint: 'MP3, WAV, MP4 or MOV — 5–30s, one clean speaker' });
        ext = base.match(CLIP_EXT)[0].toLowerCase();
        tmpClip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kva-voice-')), base);
        await pipeline(part.file, fs.createWriteStream(tmpClip));
      }
    }
    if (!name || !SAFE_NAME.test(name)) throw Object.assign(new Error('a character name is required'), { statusCode: 400, hint: 'letters/numbers/spaces, e.g. "keeper"' });
    if (!tmpClip) throw Object.assign(new Error('a voice clip is required'), { statusCode: 400, hint: 'attach the clip as the "clip" file field' });
    const cslug = slug(name);
    const dest = path.join(path.dirname(voicesFile), `${cslug}${ext}`);
    fs.mkdirSync(path.dirname(voicesFile), { recursive: true });
    fs.copyFileSync(tmpClip, dest);
    const map = readVoicesMap();
    const prior = map[cslug] ?? {};
    // a re-staged clip replaces the lip-sync source but never touches an already-paid voice_id
    map[cslug] = { name, voice_id: prior.voice_id ?? null, ref_clip: path.relative(root, dest), minted_at: prior.minted_at ?? null, staged_at: new Date().toISOString() };
    writeVoicesMap(map);
    return reply.code(201).send({ key: cslug, clipName: path.basename(dest), minted: !!prior.voice_id });
  });

  app.post('/api/cast/voices', async (req, reply) => {
    const { slug } = await host('util.js');
    let name = null; let clipPath = null;
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === 'field' && part.fieldname === 'name') name = String(part.value).trim();
        if (part.type === 'file' && part.fieldname === 'clip') {
          const base = path.basename(part.filename ?? 'clip.wav');
          if (!CLIP_EXT.test(base)) throw Object.assign(new Error('not an acceptable clip'), { statusCode: 400, hint: 'mp3/wav/mp4/mov, 5–30s, one clean speaker' });
          clipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kva-voice-')), base);
          await pipeline(part.file, fs.createWriteStream(clipPath));
        }
      }
    } else {
      // JSON {name}: mint from the character's STAGED clip (uploaded earlier via /voices/stage)
      name = String(req.body?.name ?? '').trim();
      const entry = readVoicesMap()[slug(name)];
      if (entry?.ref_clip) {
        const abs = path.resolve(root, entry.ref_clip);
        if (fs.existsSync(abs)) clipPath = abs;
      }
      if (!clipPath) throw Object.assign(new Error('no staged clip for that character'), { statusCode: 400, hint: 'upload a clip first (it is saved before minting)' });
    }
    if (!name || !SAFE_NAME.test(name)) throw Object.assign(new Error('a character name is required'), { statusCode: 400, hint: 'letters/numbers/spaces, e.g. "keeper"' });
    if (!clipPath) throw Object.assign(new Error('a voice clip is required'), { statusCode: 400, hint: 'attach the clip as the "clip" file field' });
    const queued = mgr.enqueue({
      runId: `voice-${name}`, lane: 'spend', kind: 'mint-voice',
      script: path.join(root, 'src/cli/mint-voice.js'),
      args: [name, clipPath],
      env: { ...childEnv }, cwd: root,
    });
    return reply.code(202).send({ queued, estUsd: VOICE_MINT_USD });
  });

  // Re-key a minted voice to (or away from) a character. The paid voice_id is NEVER destroyed.
  app.post('/api/cast/voices/:key/assign', async (req) => {
    const { slug } = await host('util.js');
    const map = readVoicesMap();
    const entry = map[req.params.key];
    if (!entry) throw Object.assign(new Error('no such voice'), { statusCode: 404, hint: 'GET /api/cast/voices lists them' });
    let newKey;
    if (req.body?.character) {
      const name = String(req.body.character).trim();
      newKey = slug(name);
      if (!fs.existsSync(profilePath(newKey))) throw Object.assign(new Error('no such character'), { statusCode: 404, hint: 'create the character first' });
      if (newKey !== req.params.key && map[newKey]) {
        throw Object.assign(new Error(`${name} already has a voice`), { statusCode: 409, hint: 'unlink their current voice first — minted voices are never overwritten' });
      }
      entry.name = name;
    } else {
      newKey = `unassigned-${req.params.key}`;
      for (let n = 2; map[newKey]; n++) newKey = `unassigned-${req.params.key}-${n}`;
    }
    if (newKey !== req.params.key) { map[newKey] = entry; delete map[req.params.key]; }
    writeVoicesMap(map);
    return { key: newKey };
  });

  // ——— characters: the assembled, character-first view of profiles + refs + voices ———

  app.get('/api/cast/characters', async () => {
    const { slug } = await host('util.js');
    const refs = await scanRefs();
    const voices = voiceRows(readVoicesMap());
    const claimedRefs = new Set();
    const claimedVoices = new Set();
    const characters = listProfiles().map((f) => {
      const cslug = slug(f.replace(/\.md$/, ''));
      const content = fs.readFileSync(path.join(profilesDir, f), 'utf8');
      const linkedRefs = refs.filter((r) => refLinked(r.id, cslug));
      for (const r of linkedRefs) claimedRefs.add(r.id);
      const voice = voices.find((v) => v.key === cslug) ?? null;
      if (voice) claimedVoices.add(voice.key);
      return { slug: cslug, name: displayName(content, cslug), description: content, refs: linkedRefs, voice };
    });
    return {
      characters,
      unassigned: {
        references: refs.filter((r) => !claimedRefs.has(r.id)),
        voices: voices.filter((v) => !claimedVoices.has(v.key)),
      },
    };
  });

  app.post('/api/cast/profiles', async (req, reply) => {
    const { slug } = await host('util.js');
    const name = String(req.body?.name ?? '').trim();
    const description = String(req.body?.description ?? '').trim();
    if (!name || !SAFE_NAME.test(name)) {
      throw Object.assign(new Error('a character name is required'), { statusCode: 400, hint: 'letters/numbers/spaces, up to 64 characters — e.g. "keeper"' });
    }
    const cslug = slug(name);
    if (!cslug) throw Object.assign(new Error('that name has no usable characters'), { statusCode: 400, hint: 'use letters or numbers' });
    const file = profilePath(cslug);
    if (fs.existsSync(file)) throw Object.assign(new Error(`"${name}" already exists`), { statusCode: 409, hint: 'edit the existing character, or pick another name' });
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(file, `# ${name}\n\n${stripLeadingHeading(description, name)}\n`.replace(/\n+$/, '\n'));
    return reply.code(201).send({ slug: cslug });
  });

  app.put('/api/cast/profiles/:slug', async (req) => {
    const file = profilePath(req.params.slug);
    if (!fs.existsSync(file)) throw Object.assign(new Error('no such character'), { statusCode: 404, hint: 'GET /api/cast/characters lists them' });
    const current = fs.readFileSync(file, 'utf8');
    const name = String(req.body?.name ?? '').trim() || displayName(current, req.params.slug);
    const description = String(req.body?.description ?? '').trim();
    fs.writeFileSync(file, `# ${name}\n\n${stripLeadingHeading(description, name)}\n`.replace(/\n+$/, '\n'));
    return { slug: req.params.slug };
  });

  app.delete('/api/cast/profiles/:slug', async (req) => {
    const file = profilePath(req.params.slug);
    if (!fs.existsSync(file)) throw Object.assign(new Error('no such character'), { statusCode: 404, hint: 'GET /api/cast/characters lists them' });
    fs.rmSync(file);
    // refs/voice are UNLINKED (they fall back to the Unassigned pool), never deleted — unless asked.
    let refsDeleted = 0;
    if (req.query?.deleteRefs === '1') {
      for (const e of await scanRefs()) {
        if (refLinked(e.id, req.params.slug)) {
          fs.rmSync(e.abs, { force: true });
          fs.rmSync(e.abs.replace(IMAGE_EXT, '.txt'), { force: true });
          refsDeleted++;
        }
      }
    }
    return { deleted: req.params.slug, refsDeleted };
  });

  // Legacy read-only profiles listing (kept for API compatibility; the UI now uses /characters).
  app.get('/api/cast/profiles', async () => {
    return { profiles: listProfiles().map((f) => ({ name: f.replace(/\.md$/, ''), content: fs.readFileSync(path.join(profilesDir, f), 'utf8') })) };
  });
}

export default { registerCastRoutes };
