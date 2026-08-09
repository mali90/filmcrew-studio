// The server-side prompt PREVIEW — the thing the UI promises is "exactly what we send".
//
// That promise is only true if the preview is composed by the SAME pure builder the renderer uses
// (src/lib/prompt-compose.js), from the same spec, with the same settings. So this module composes
// nothing of its own: it resolves a run's effective settings and hands them to prompt-settings.js →
// prompt-compose.js, byte for byte. web/server/test/integration/prompt-read.test.js pins that by
// composing the same job directly and comparing BUFFERS.
//
// Two rules shape every line below:
//
//   · web/server's STATIC import graph must stay config-free (the runs-caps/environments canaries
//     walk it transitively). routes/runs.js therefore lazy-imports THIS file inside its handlers,
//     and this file lazy-imports everything it needs from the host repo (`root`) — the
//     env-settings.js idiom.
//   · the run's .env is read as DATA (src/lib/env-file.js), never sourced. Importing config.js here
//     would run `import 'dotenv/config'` INSIDE the server process: a request would gain the power
//     to reconfigure the server, and the demo/e2e mock wiring (which lives in childEnv) would be
//     silently overridden by the developer's real keys.
import fs from 'node:fs';
import path from 'node:path';

/**
 * The prompt-relevant knobs, mirrored from config.js (the `kling`, `seedance` and `seedance25`
 * blocks). The child renderer reads them through dotenv + config.js; this server may not, so the
 * DEFAULTS are duplicated here — deliberately, and nowhere else. Keep them in step with config.js:
 * a drifted default shows up as a preview that differs from the render, which the byte-parity test
 * in prompt-read.test.js catches.
 */
function promptDefaults(get) {
  const num = (key, dflt) => { const v = get(key); return v === '' ? dflt : Number(v); };
  const bool = (key, dflt) => { const v = get(key); return v === '' ? dflt : /^(1|true|yes|on)$/i.test(v); };
  const kling = {
    model: get('KLING_MODEL') || 'kling-v3-omni',
    aspectRatio: get('KLING_ASPECT') || '9:16',
    resolution: get('KLING_RESOLUTION') || '1080p',
    nativeAudio: bool('KLING_GENERATE_AUDIO', true),
    maxStoryboards: 6, // model hard cap (not user-tunable)
    maxJobSeconds: 15, // model hard cap (not user-tunable)
    segmentMaxBytes: num('KLING_SEGMENT_MAX_BYTES', 500),
    defaultShotSeconds: num('KLING_DEFAULT_SHOT_SECONDS', 5),
    chainFrames: bool('KLING_CHAIN_FRAMES', true),
  };
  const seedance = {
    resolution: get('SEEDANCE_RESOLUTION') || '480p',
    generateAudio: bool('SEEDANCE_GENERATE_AUDIO', true),
    voiceMode: get('SEEDANCE_VOICE_MODE') || 'reference',
    promptMaxBytes: num('SEEDANCE_PROMPT_MAX_BYTES', 5000),
    style: get('SEEDANCE_STYLE') || '',
    avoid: get('SEEDANCE_AVOID') || '',
    textRule: get('SEEDANCE_TEXT_RULE') || '',
    // The renderer takes the aspect + shot length from the KLING block (one set of preferences
    // covers both backends) — seedancePromptSettings() only reads defaultShotSeconds for prompts.
    aspectRatio: kling.aspectRatio,
    defaultShotSeconds: kling.defaultShotSeconds,
    // The bag knobsFor(caps) looks a model's OWN block up in. Only `seedance25` declares one, and it
    // redeclares resolutions alone — nothing here moves a prompt byte today. It is mirrored anyway
    // so a future prompt-shaped knob in that block reaches the preview the same day it reaches the
    // renderer. A model whose knobsKey is absent from the bag falls back to the shared block below.
    knobs: { seedance25: { resolution: get('SEEDANCE25_RESOLUTION') || '720p' } },
  };
  return { kling, seedance };
}

/**
 * A `(KEY) => value` reader over the run's environment, as DATA.
 * Precedence mirrors the render child exactly: a variable already in the spawned process's env
 * (childEnv — even an explicit empty string) wins, because dotenv never overwrites an existing
 * variable; otherwise the value comes from <envRoot>/.env.
 */
async function envLookup({ root, envRoot, childEnv }) {
  const { readEnvFileOrExample, parseEnv, getEnvValue } = await import(path.join(root, 'src/lib/env-file.js'));
  const { text, source } = readEnvFileOrExample(envRoot);
  // ONLY a real .env counts. dotenv loads <envRoot>/.env and nothing else, so quoting
  // .env.example's placeholder values here would preview a prompt no child would ever send.
  const entries = source === '.env' ? parseEnv(text) : [];
  return (key) => {
    if (childEnv && Object.hasOwn(childEnv, key)) return String(childEnv[key] ?? '').trim();
    const raw = getEnvValue(entries, key);
    if (raw === undefined) return '';
    // parseEnv keeps a value verbatim (quotes included); dotenv strips a matching pair.
    return String(raw).trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  };
}

const CLIP_EXT = /\.(mp3|wav|mp4|mov)$/i;

/**
 * `(speaker) => clipPath|null`, mirroring src/lib/voices.js `getVoiceRefClip` (bundled clips on
 * disk, overridden by voices.json entries) without importing it — that module reads config.js.
 * Seedance cites a voiced character as `@AudioN` IN THE PROMPT, so whether a clip exists changes
 * the bytes; a preview that guessed would be wrong exactly for the cast that has voices.
 */
function voiceClipLookup(voicesDir, root, slug) {
  const dir = path.isAbsolute(voicesDir) ? voicesDir : path.resolve(root, voicesDir);
  const map = new Map();
  try {
    for (const f of fs.readdirSync(dir)) if (CLIP_EXT.test(f)) map.set(slug(f.replace(CLIP_EXT, '')), path.join(dir, f));
  } catch { /* no voices dir — nothing is voiced */ }
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(dir, 'voices.json'), 'utf8'));
    // A real registry entry always wins over the shipped-clip fallback — including one with no
    // ref_clip at all, which is how a minted-but-clipless voice falls back to native audio.
    for (const [key, v] of Object.entries(reg ?? {})) {
      const clip = v?.ref_clip;
      map.set(slug(key), clip ? (path.isAbsolute(clip) ? clip : path.resolve(root, clip)) : null);
    }
  } catch { /* no registry */ }
  return (name) => {
    const clip = map.get(slug(name ?? '')) ?? null;
    return clip && fs.existsSync(clip) ? clip : null;
  };
}

const utf8 = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');

/**
 * Everything a run needs to compose any of its jobs, loaded once (`/prompts` composes N jobs).
 * @returns {Promise<{caps:object, jobs:object[], viewFor:(jobId:string)=>object}>}
 */
async function createComposer({ root, envRoot, childEnv, spec, backend, voicesDir }) {
  const [models, compose, promptSettings, castGroups, text] = await Promise.all([
    import(path.join(root, 'src/lib/render-models.js')),
    import(path.join(root, 'src/lib/prompt-compose.js')),
    import(path.join(root, 'src/lib/prompt-settings.js')),
    import(path.join(root, 'src/lib/cast-groups.js')),
    import(path.join(root, 'src/lib/text.js')),
  ]);
  const { capsFor, normalizeBackend, refLabel } = models;
  const { composeKlingStoryboard, composeSeedanceJobPrompt, pinBytesOf, promptFingerprint, chooseSeamMode, planSeamRefs } = compose;
  const { klingPromptSettings, seedancePromptSettings } = promptSettings;
  const { characterGroups, jobSpeakers } = castGroups;
  const { slug } = text;

  let caps;
  try {
    caps = capsFor(normalizeBackend(backend ?? spec?.render_backend ?? 'kling').id);
  } catch (e) {
    throw Object.assign(new Error(`cannot preview prompts: ${e.message}`), { statusCode: 409, hint: 'set a known render model on this run' });
  }
  const get = await envLookup({ root, envRoot, childEnv });
  const defaults = promptDefaults(get);
  // Wherever the render CHILD will look for voices: its own VOICES_DIR (childEnv when the caller
  // isolated the cast roots, else the .env), falling back to the dir this server serves.
  const voiceClipFor = voiceClipLookup(get('VOICES_DIR') || voicesDir || path.join(root, 'voices'), root, slug);
  const jobs = spec?.kling?.jobs ?? [];
  // A Kling render with no elements at all is text-to-video: no reference to seed a frame from, so
  // pipeline.renderSpec never chains one (mirrored here, or every job after the first would preview
  // an opening pin the render will not send).
  const textToVideoKling = caps.family === 'kling' && !(spec?.kling?.elements?.length);

  /**
   * Which boundary frames this job will really be handed on a FULL render from the plan: an
   * authored first_frame, and the chained still off the previous clip (pipeline.renderSpec's
   * `chain`). A CLOSING frame only ever arrives from a frame-conditioned re-render, never from the
   * plan — previewing one would promise an ending the render is not going to pin.
   */
  function boundariesFor(job, index) {
    const chain = defaults.kling.chainFrames && jobs.length > 1 && !textToVideoKling;
    return { hasSeamIn: Boolean(job.first_frame || (chain && index > 0)), hasSeamOut: Boolean(job.last_frame) };
  }

  /** The Kling storyboard: one ≤500-byte segment per shot, `@Element1` leading each. */
  function klingView(job, index) {
    const settings = klingPromptSettings(spec, defaults.kling);
    const groups = characterGroups(job, spec);
    const textToVideo = groups.every((g) => g.els.length === 0);
    const idxByName = new Map(groups.map((g, i) => [slug(g.name), i + 1]));
    const voiceTokenFor = textToVideo ? () => '' : (sp) => {
      const i = idxByName.get(slug(sp ?? '')) ?? (groups.length === 1 ? 1 : null);
      return i ? `@Element${i}` : '';
    };
    const opts = { lowercaseSpeech: true, leadRef: textToVideo ? null : '@Element1', voiceTokenFor };
    const { segments } = composeKlingStoryboard(job, spec, settings, opts);
    const pins = pinBytesOf('kling', job, spec, settings, opts);
    const cap = Number(settings.segmentMaxBytes);
    // Kling's budget is PER SEGMENT (fal rejects a 512-byte one), so the editor draws one meter per
    // shot. The joined document exists for the read-only sheet; its totals are the segments' sums.
    const prompt = segments.map((s) => s.prompt).join('\n\n');
    // Kling seeds a boundary frame through its Elements set, so the pin never touches the prompt
    // text — but the sheet still has to be able to SAY how this clip is joined to its neighbours.
    const { hasSeamIn, hasSeamOut } = boundariesFor(job, index);
    const seam = chooseSeamMode({
      caps,
      castRefCount: textToVideo ? 0 : groups.reduce((n, g) => n + g.els.length, 0),
      hasSeamIn,
      hasSeamOut,
    });
    return {
      prompt,
      segments: segments.map((s, i) => ({
        shotId: job.shots[i] ?? null,
        prompt: s.prompt,
        duration: s.duration,
        speaker: s.speaker,
        bytes: utf8(s.prompt),
        maxBytes: cap,
        pinBytes: pins[i] ?? 0,
      })),
      shotPrompts: null,
      refs: textToVideo ? [] : groups.map((g, i) => ({ ref: `@Element${i + 1}`, character: g.name })),
      bytes: utf8(prompt),
      maxBytes: cap * segments.length,
      segmentMaxBytes: cap,
      pinBytes: pins.reduce((a, b) => a + b, 0),
      seam: { in: seam.in.mode, out: seam.out.mode },
    };
  }

  /** Seedance: ONE rich multi-shot prompt per job, with the boundary pins the render will apply. */
  function seedanceView(job, index) {
    const settings = seedancePromptSettings(spec, caps, defaults.seedance);
    const groups = characterGroups(job, spec);
    // Cast references, laid out exactly as the renderer lays them out (group order, model cap).
    const refGroups = [];
    let castCount = 0;
    for (const g of groups) {
      const refs = [];
      for (const _e of g.els) {
        if (castCount >= caps.maxImages) break;
        castCount += 1;
        refs.push(refLabel(caps, 'Image', castCount));
      }
      refGroups.push({ name: g.name, refs });
    }
    const { hasSeamIn, hasSeamOut } = boundariesFor(job, index);
    const audioOn = !!settings.audioOn;
    // Voice references (@AudioN) ride the same gate as the renderer's: something to attach them to,
    // audio on, and a voiceMode that keeps the clip.
    const voiced = (castCount > 0 || hasSeamIn) && audioOn && defaults.seedance.voiceMode !== 'native'
      ? jobSpeakers(job, spec).filter((sp) => voiceClipFor(sp)).slice(0, caps.maxAudioRefs)
      : [];
    const audioLabels = new Map(voiced.map((sp, i) => [slug(sp), refLabel(caps, 'Audio', i + 1)]));
    const audioRefFor = (sp) => audioLabels.get(slug(sp ?? '')) ?? null;

    const seam = chooseSeamMode({ caps, castRefCount: castCount, hasSeamIn, hasSeamOut });
    const plan = planSeamRefs({
      caps,
      castRefs: Array.from({ length: castCount }, (_, i) => `cast:${i}`), // only ORDER and COUNT reach the prompt
      seamIn: seam.in.mode === 'soft' ? 'seam:in' : null,
      seamOut: seam.out.mode === 'soft' ? 'seam:out' : null,
      otherRefCount: caps.maxCombinedRefs != null ? voiced.length : 0,
    });
    const startFrameRef = plan.imageRefs.find((r) => r.kind === 'seamIn')?.label ?? null;
    const endFrameRef = plan.imageRefs.find((r) => r.kind === 'seamOut')?.label ?? null;

    // `feedback`/`nonce` are the RE-RENDER knobs (a director note, "Alternate take N"); a full
    // render from the plan sends neither, so a plan preview must not add them.
    const opts = { refGroups, audioRefFor, startFrameRef, endFrameRef, feedback: '', nonce: 0, shotSyntax: caps.shotSyntax };
    const { prompt, shotPrompts } = composeSeedanceJobPrompt(job, spec, settings, opts);

    let castSeen = 0;
    const groupOfRef = [];
    for (const g of refGroups) for (const _r of g.refs) groupOfRef.push(g.name);
    const refs = plan.imageRefs.map((r) => (
      r.kind === 'cast'
        ? { ref: r.label, character: groupOfRef[castSeen++] ?? null }
        : { ref: r.label, role: r.kind === 'seamIn' ? 'opening frame' : 'closing frame' }
    ));
    for (const sp of voiced) refs.push({ ref: audioRefFor(sp), character: sp, role: 'voice' });

    return {
      prompt,
      segments: null,
      shotPrompts,
      refs,
      bytes: utf8(prompt),
      maxBytes: Number(settings.promptMaxBytes),
      segmentMaxBytes: null,
      pinBytes: pinBytesOf('seedance', job, spec, settings, opts),
      seam: { in: seam.in.mode, out: seam.out.mode },
    };
  }

  function viewFor(jobId) {
    const index = jobs.findIndex((j) => j?.job_id === jobId);
    const job = jobs[index];
    if (!job) return null;
    const head = {
      jobId,
      backend: caps.id,
      endpointLabel: `${caps.providerLabel} ${caps.label}`,
      shots: [...(job.shots ?? [])],
      source: 'plan',
      take: null,
      sentAt: null,
      stale: false,
      fingerprint: promptFingerprint(spec, jobId),
    };
    try {
      return { ...head, ...(caps.family === 'kling' ? klingView(job, index) : seedanceView(job, index)) };
    } catch (e) {
      // One unbuildable job (a shot id the plan lost, a missing content_prompt) must not take the
      // whole prompt sheet down — the render would fail on exactly this message, so show it.
      return { ...head, prompt: '', segments: null, shotPrompts: null, refs: [], bytes: 0, maxBytes: 0, segmentMaxBytes: null, pinBytes: 0, error: e.message };
    }
  }

  return { caps, jobs, viewFor };
}

const TAKE_DIR_RE = /^(t\d+|render)$/;
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The provider's own name for a past take, from what that take recorded (never today's config). */
async function labelForRecordedBackend(root, backend, endpoint) {
  if (!backend) return endpoint ? String(endpoint) : 'the render provider';
  try {
    const { capsFor, normalizeBackend } = await import(path.join(root, 'src/lib/render-models.js'));
    const caps = capsFor(normalizeBackend(backend).id);
    return `${caps.providerLabel} ${caps.label}`;
  } catch {
    return String(backend);
  }
}

/**
 * A past take's prompt, verbatim from its `prompts.json` — immutable, and the only honest answer to
 * "what was actually sent for this clip". Never recomposed: the settings may have moved since.
 * Returns null when that take never wrote a sidecar for this job.
 */
async function takeView({ root, runDir, take, jobId }) {
  if (!TAKE_DIR_RE.test(String(take)) || !JOB_ID_RE.test(String(jobId))) return null;
  const candidates = [
    path.join(runDir, 'renders', String(take), String(jobId), 'prompts.json'),
    path.join(runDir, String(take), String(jobId), 'prompts.json'), // CLI runs keep their take beside the spec
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) return null;
  let sidecar;
  try { sidecar = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }

  const segments = Array.isArray(sidecar.segments) ? sidecar.segments : null;
  const prompt = typeof sidecar.prompt === 'string'
    ? sidecar.prompt
    : (segments ?? []).map((s) => String(s?.prompt ?? '')).join('\n\n');
  let sentAt = null;
  try { sentAt = fs.statSync(file).mtime.toISOString(); } catch { /* raced */ }
  // Ids and labels only — `audio_refs[].clip` and `seam_*.frame` are absolute host paths and must
  // never leave the server (the same contract serializeRun/serializeContinuity keep).
  const refs = [
    ...(sidecar.image_refs ?? []).map((r) => ({ ref: r.ref, ...(r.character ? { character: r.character } : {}), ...(r.id && !r.character ? { role: String(r.id) } : {}) })),
    ...(sidecar.audio_refs ?? []).map((r) => ({ ref: r.ref, character: r.speaker ?? null, role: 'voice' })),
  ];
  return {
    jobId: String(jobId),
    backend: sidecar.backend ?? null,
    endpointLabel: await labelForRecordedBackend(root, sidecar.backend, sidecar.endpoint),
    shots: [],
    source: 'take',
    take: String(take),
    sentAt,
    stale: false,
    fingerprint: null,
    prompt,
    segments: segments
      ? segments.map((s) => ({ shotId: null, prompt: s.prompt, duration: s.duration ?? null, speaker: s.speaker ?? null, bytes: utf8(s.prompt), maxBytes: null, pinBytes: null }))
      : null,
    shotPrompts: Array.isArray(sidecar.shot_prompts) ? sidecar.shot_prompts : null,
    refs,
    bytes: utf8(prompt),
    // A past take is read-only, and the budgets it was composed under are not recorded — quoting
    // today's cap as if it were that take's would be a guess, so the meter simply has no denominator.
    maxBytes: null,
    segmentMaxBytes: null,
    pinBytes: null,
    seam: sidecar.seam_in || sidecar.seam_out
      ? { in: sidecar.seam_in?.mode ?? null, out: sidecar.seam_out?.mode ?? null }
      : undefined,
  };
}

/**
 * One job's prompt view.
 * @param {{root:string, envRoot:string, childEnv?:object, runDir:string, spec:object,
 *          backend?:string, jobId:string, take?:string|null, voicesDir?:string}} p
 * @returns {Promise<object|null>} null when the job (or the requested take's sidecar) is unknown
 */
export async function buildPromptView({ root, envRoot, childEnv, runDir, spec, backend, jobId, take = null, voicesDir }) {
  if (take) return takeView({ root, runDir, take, jobId });
  const { viewFor } = await createComposer({ root, envRoot, childEnv, spec, backend, voicesDir });
  return viewFor(jobId);
}

/**
 * Every job of the CURRENT plan, in plan order.
 * @returns {Promise<{backend:string, jobs:string[], prompts:object[]}>}
 */
export async function buildPromptViews({ root, envRoot, childEnv, runDir, spec, backend, voicesDir }) {
  const { caps, jobs, viewFor } = await createComposer({ root, envRoot, childEnv, spec, backend, voicesDir });
  const ids = jobs.map((j) => j?.job_id).filter(Boolean);
  return { backend: caps.id, jobs: ids, prompts: ids.map((id) => viewFor(id)).filter(Boolean) };
}

export default { buildPromptView, buildPromptViews };
