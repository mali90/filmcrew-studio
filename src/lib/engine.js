// The content engine: 8 LLM agents (0 Showrunner → 7 QC) each fill ONE block of a render-ready
// Production Spec, validated after every step, with a QC gate that re-runs only the responsible
// agent(s). On `pass`, the spec is ready for the Kling renderer (src/lib/kling.js).
//
// The orchestration is generic and data-driven (the AGENTS/SKILLS_FOR/TAG_OWNER tables below);
// agent behaviour lives entirely in engine/agents/*.md + engine/skills/*. Subjects/cast/style
// come from the brief + optional profiles/*.md + the element inventory — no hardcoded characters.
import fsp from 'node:fs/promises';
import path from 'node:path';
import config, { resolvePath } from '../../config.js';
import log from './logger.js';
import { ensureDir, writeJson, slug } from './util.js';
import { complete, extractJson } from './llm.js';
import { validateSpec } from './spec-schema.js';
import { RENDER_MODELS, capsFor, castLimitFor, normalizeBackend, demotesOpeningFrame } from './render-models.js';
import { knobsFor, seedancePromptSettings } from './prompt-settings.js';
import { voiceRefsRide } from './seedance-args.js';
import { buildInventory, inventoryText, characterRefs, refBelongsTo } from './elements.js';
import { getVoiceRefClip, voicesInventoryText } from './voices.js';
import { jobSpeakers } from './cast-groups.js';
import { SEEDANCE_TTV_GUIDANCE } from './seedance.js';

const DIR = resolvePath('engine');
const TEMPLATE = path.join(DIR, 'templates', 'spec.template.json');

const AGENTS = [
  '0-showrunner.md', '1-storyboard.md', '2-scene-director.md', '3-cinematographer.md',
  '4-casting.md', '5-sound.md', '6-job-planner.md', '7-qc.md',
];

// Knowledge docs inlined into each agent's prompt (engine/skills/<name>/SKILL.md).
const SKILLS_FOR = {
  0: ['concept-ideation', 'subject-consistency'],
  1: ['concept-ideation', 'kling-storyboard'],
  2: ['kling-storyboard', 'subject-consistency'],
  3: ['kling-storyboard'],
  4: ['subject-consistency'],
  5: ['sound-and-voice'],
  6: ['kling-storyboard'],
  7: ['kling-storyboard', 'subject-consistency'],
};

// QC tag -> agent index to re-run (the QC agent prefixes failing checks with [tag]).
const TAG_OWNER = { project: 0, shots: 1, content: 2, camera: 3, elements: 4, audio: 5, jobs: 6 };

const skillPath = (name) => path.join(DIR, 'skills', name, 'SKILL.md');

async function loadSkills(idx) {
  const out = [];
  for (const name of SKILLS_FOR[idx] ?? []) {
    try { out.push(`### SKILL: ${name}\n\n${await fsp.readFile(skillPath(name), 'utf8')}`); }
    catch (e) { log.warn(`skill "${name}" not found (${e.message})`); }
  }
  return out.join('\n\n---\n\n');
}

/**
 * The model FAMILY behind any accepted backend spelling — a compound `<model>@<provider>` id, a
 * legacy alias, or a bare model id whose provider entries have not landed yet. null when the name
 * is unknown, so the callers below can key off the family instead of a literal backend string.
 */
function familyOf(value) {
  if (typeof value === 'string' && Object.hasOwn(RENDER_MODELS, value)) return RENDER_MODELS[value].family;
  try { return capsFor(value).family; } catch { return null; }
}

/**
 * The effective render resolution for a backend's model — read from the SAME knob the render child
 * reads: the model's own config block (`caps.knobsKey`, falling back to the shared Seedance block)
 * for the Seedance family, config.kling for Kling. A per-run pick arrives through that same env
 * variable (run-service injects `caps.resolutionEnv` into every child spawn), so the planner's
 * context and the render can never disagree on it.
 */
function configuredResolution(caps) {
  if (caps.family === 'seedance') return knobsFor(caps, config)?.resolution || config.seedance.resolution;
  // An empty ladder means the model has NO selectable resolution (Kling's endpoint renders its own
  // fixed output) — a legacy KLING_RESOLUTION in .env is tolerated as the no-op it always was.
  return caps.resolutions?.length ? config.kling.resolution : null;
}

/** A Seedance render with NO cast AND NO reference image available is guaranteed text-to-video (the
 *  Casting agent has nothing to attach) — the only case where injecting the text-to-video prompt style
 *  + identity override is safe. A no-cast render whose folder holds a relevant image becomes
 *  image-to-video (Casting attaches by relevance), whose planning must stay unchanged. Keyed off the
 *  model FAMILY, so every Seedance model (2.0, 2.5, on any provider) takes this path. */
export function isTextToVideoPlan({ backend, cast, refCount }) {
  return familyOf(backend) === 'seedance' && !(cast?.length) && refCount === 0;
}

/** The shared project context every agent sees (brief, config defaults + caps, elements, profiles). */
export function contextBlock(ctx) {
  const k = config.kling;
  // Per-model caps ride on the ctx buildCtx built; a hand-assembled ctx (unit tests, callers that
  // only hold a backend name) gets them derived from the backend it names, so the Job Planner is
  // never told Kling's numbers for a Seedance plan.
  const caps = ctx.caps ?? capsFor(ctx.backend);
  // The RENDERING MODEL's own knob (per-run picks ride it too) — quoting config.kling.resolution
  // for a Seedance plan advertised a resolution that render was never going to use.
  const resolution = ctx.resolution ?? configuredResolution(caps);
  return [
    '## Project context',
    `- Brief: ${ctx.brief}`,
    `- Defaults: model=${k.model}, aspect_ratio=${ctx.aspectRatio ?? k.aspectRatio}, resolution=${resolution ?? 'endpoint-native (not selectable)'}, ` +
      `multi_shot=${k.multiShot}, native_audio=${k.nativeAudio}, target_duration≈${ctx.durationTargetS}s`,
    `- Render backend: ${caps.id}`,
    // Every number here is the RENDERING MODEL's own (registry caps), with the shared fallbacks for
    // the caps a model leaves undeclared — the same pair spec-schema's validateJobs applies, so the
    // planner is never told a window the validator will then reject.
    // The reference budget names every cap the CASTING arithmetic needs: the per-job image cap, a
    // declared combined budget (fal 2.5 counts images+audio+video together), and the per-character
    // ceiling on models whose elements slice extra views off at render (Kling's frontal + N refs).
    `- Hard caps: ≤${caps.maxSegments ?? 6} shots/job, ≤${caps.maxSeconds}s/job, ≤${caps.maxSegmentChars ?? 512} chars/segment, ≤${caps.maxImages} reference images/job` +
      (caps.maxCombinedRefs != null ? `, ≤${caps.maxCombinedRefs} references/job combined across images+audio+video` : '') +
      (caps.maxRefsPerElement != null ? `, ≤${1 + caps.maxRefsPerElement} images per character (1 frontal + ${caps.maxRefsPerElement} references)` : ''),
    ...(caps.family === 'seedance'
      ? [`- Seedance packing rule: every job must total ${caps.minSeconds}–${caps.maxSeconds}s (a job under ${caps.minSeconds}s fails validation — merge short shots); the caps above are this model's own.`,
         // Mirrors the render-time policy (seam-rule.js SEAM_PRIORITY): pins yield to cast refs,
         // so the planner may fill every slot with element refs — never under-fill to protect a seam.
         `- Reference budget: element refs may use all ${caps.maxImages} image slots. The opening/seam frame${config.kling.chainFrames ? ' (chained jobs and any authored first_frame)' : ' (an authored first_frame)'} rides a slot only when one is FREE — when the budget is full the seam pin is dropped, not a cast reference, and that joint becomes a plain cut.`]
      : []),
    // Guaranteed text-to-video (Seedance, no cast, AND no reference image the Casting agent could
    // attach): steer the shot prose with the Seedance 2.0 guidelines from the start. Absent for
    // image-to-video (a cast selected, or any reference image on disk) and for Kling, so those plans
    // are byte-for-byte unchanged — see isTextToVideoPlan / buildCtx.
    ...(ctx.textToVideo
      ? ['',
         '## Seedance text-to-video — prompt style (this render has NO reference image; the video is built from the shot prompts alone)',
         SEEDANCE_TTV_GUIDANCE,
         '- IDENTITY: overriding the scene-director\'s usual "never describe the subject\'s appearance" rule — since no reference image pins identity here, DO describe each subject\'s look concretely (build, clothing, colours, distinctive features) and keep it consistent across every shot.']
      : []),
    // aspect_ratio and resolution are the MODEL's own lists — a hardcoded enum here once offered
    // the planner "4k, 1080p, 720p" for Seedance 2.5, whose whole ladder is 480p/720p.
    '- Valid enums: shot_size ∈ {extreme_close_up, close_up, medium_close_up, medium, medium_wide, wide, extreme_wide}; ' +
      `aspect_ratio ∈ {${caps.aspects.join(', ')}}; kling.model_name ∈ {kling-v3-omni, kling-video-o1}; ` +
      (caps.resolutions.length
        ? `kling.resolution ∈ {${caps.resolutions.join(', ')}}`
        : 'kling.resolution — OMIT this field (the endpoint renders its own fixed output; no tier is selectable)'),
    '',
    '## Available elements (the Casting agent must pick `image` paths from THIS list)',
    ctx.inventoryText,
    '',
    '## Registered character voices (fal transport — set a VO line `speaker` to one of these names to lock its voice)',
    ctx.voicesText,
    '',
    ...(ctx.castNames?.length
      ? ['', `## Featured cast (REQUIRED): build the story around ${ctx.castNames.join(' and ')} — their profiles below are the only cast; do not invent other named characters.`]
      : []),
    '',
    '## Subject profiles (consistency reference — keep subjects/style on-model)',
    ctx.profilesText || '(none provided)',
    // The selected environment (the Home "Set in" pick / --environment) is the authoritative
    // world/mood/style bible. It is the LAST block so it is the final word, and it explicitly
    // OVERRIDES a character's own "## World & style" notes — the per-idea environment beats the
    // character's baked-in world when they conflict. Absent unless an environment was selected.
    ...(ctx.environmentText
      ? ['',
         `## Set in — ${ctx.environmentName || 'Environment'} (REQUIRED world/mood/style bible)`,
         'This is the authoritative setting, mood, lighting, palette, era, and weather for EVERY shot —' +
           ' build the whole video inside it.',
         'PRECEDENCE: this environment OVERRIDES any character\'s own "## World & style" notes when they' +
           ' conflict — the per-idea environment takes priority and wins.',
         ctx.environmentText]
      : []),
  ].join('\n');
}

/** Build + run one agent; returns the COMPLETE updated spec object. */
async function runAgent(idx, spec, ctx, extraNote = '') {
  const agentMd = await fsp.readFile(path.join(DIR, 'agents', AGENTS[idx]), 'utf8');
  const skills = await loadSkills(idx);
  const prompt = [
    'You are one agent in a pipeline that fills ONE Production Spec JSON. Do your job, then return',
    'the COMPLETE updated spec as a single JSON object — your section newly filled, every other block',
    'kept EXACTLY as given. Output ONLY the JSON (no prose, no markdown fences).',
    '',
    `# AGENT INSTRUCTIONS\n${agentMd}`,
    '',
    `# SKILLS (reference knowledge)\n${skills}`,
    '',
    contextBlock(ctx),
    '',
    extraNote ? `${extraNote}\n` : '',
    `# CURRENT PRODUCTION SPEC (JSON)\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``,
    '',
    'Return the COMPLETE updated Production Spec JSON now.',
  ].join('\n');

  let lastErr;
  for (let tryN = 0; tryN < 2; tryN++) {
    const p = tryN === 0 ? prompt : `${prompt}\n\nIMPORTANT: your previous reply could not be parsed. Return ONLY the single JSON object — no prose, no fences, starting with { and ending with }.`;
    try {
      const text = await complete({ prompt: p });
      const next = extractJson(text);
      if (!next || typeof next !== 'object' || !next.spec_version) throw new Error('returned a non-spec object');
      return next;
    } catch (e) { lastErr = e; log.warn(`Agent ${idx} parse attempt ${tryN + 1} failed: ${e.message}`); }
  }
  throw new Error(`Agent ${idx} could not return a valid spec JSON: ${lastErr?.message}`);
}

/**
 * Run an agent, validating up to its block; on failure re-prompt the SAME agent with the errors.
 * `seedNote` (optional) is an instruction that persists across every attempt — the revision flow
 * uses it to carry director feedback into the agent's prompt.
 */
async function runAgentValidated(idx, spec, ctx, maxFix, seedNote = '') {
  let cur = spec;
  let errNote = '';
  for (let attempt = 0; attempt <= maxFix; attempt++) {
    const note = [seedNote, errNote].filter(Boolean).join('\n\n');
    const candidate = await runAgent(idx, cur, ctx, note);
    const upTo = idx === 7 ? 6 : idx; // QC validates the full creative spec (blocks 0..6) before judging
    const v = validateSpec(candidate, { upTo, backend: ctx.backend });
    if (v.ok) return candidate;
    const errors = v.errors.map((e) => `- ${e}`).join('\n');
    errNote = `## Fix these validation problems from your previous attempt\n${errors}`;
    log.warn(`Agent ${idx} validation failed (attempt ${attempt + 1}/${maxFix + 1}):\n${errors}`);
    cur = candidate; // let it see its own draft + the errors
  }
  throw new Error(`Agent ${idx} (${AGENTS[idx]}) could not produce a valid section after ${maxFix + 1} attempts`);
}

/**
 * The QC gate + targeted re-runs, shared by runEngine and reviseSpec. Runs the QC agent, and on a
 * fail routes the flagged blocks back to their owning agents for up to `maxQc` cycles. `filePrefix`
 * names the per-cycle artifacts (spec-07-qc1.json for the initial plan, spec-r07-qc1.json for a
 * revision); `seedNote` (revision feedback) rides into every agent prompt of the loop.
 */
async function qcLoop(spec, ctx, { runDir, maxFix, maxQc, filePrefix = 'spec-07-qc', seedNote = '' }) {
  for (let cycle = 0; cycle <= maxQc; cycle++) {
    log.step(`Engine — QC (cycle ${cycle + 1}/${maxQc + 1})`);
    spec = await runAgentValidated(7, spec, ctx, maxFix, seedNote);
    await writeJson(path.join(runDir, `${filePrefix}${cycle + 1}.json`), spec);
    if (spec.qc?.status === 'pass') { log.info('✓ QC pass'); break; }
    const owners = failedOwners(spec.qc);
    if (!owners.length) { log.warn('QC failed but named no routable section — stopping.'); break; }
    if (cycle >= maxQc) { log.warn('QC still failing — out of cycles.'); break; }
    log.warn(`QC fail → re-running agents [${owners.join(', ')}]. Notes: ${spec.qc?.notes ?? ''}`);
    for (const o of owners) {
      log.step(`Engine — revising agent ${AGENTS[o]}`); // observable step: monitors track redo re-runs
      spec = await runAgentValidated(o, spec, ctx, maxFix, seedNote);
    }
  }
  return spec;
}

/** Parse the QC block's failing [tag]s into a sorted, de-duped list of agent indices to re-run. */
function failedOwners(qc) {
  const idxs = new Set();
  for (const c of qc?.checks ?? []) {
    if (c?.passed) continue;
    const m = String(c.check ?? '').match(/\[(\w+)\]/);
    if (m && TAG_OWNER[m[1]] !== undefined) idxs.add(TAG_OWNER[m[1]]);
  }
  if (!idxs.size && qc?.notes) for (const tag of Object.keys(TAG_OWNER)) if (String(qc.notes).includes(`[${tag}]`)) idxs.add(TAG_OWNER[tag]);
  return [...idxs].sort((a, b) => a - b);
}

/**
 * Concatenate subject profiles for the agent context. `cast` (array of character names) narrows
 * to just those profiles — an unknown name throws BEFORE any LLM spend (a typo'd star must not
 * silently plan without its character). No cast = every profile, exactly as before.
 */
async function loadProfiles(cast) {
  const dir = resolvePath(config.engine.profilesDir);
  let files = [];
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.md')).sort(); } catch { files = []; }
  if (cast?.length) {
    const bySlug = new Map(files.map((f) => [slug(f.replace(/\.md$/, '')), f]));
    files = cast.map((name) => {
      const hit = bySlug.get(slug(name));
      if (!hit) throw new Error(`Unknown cast member "${name}" — no profile found in ${config.engine.profilesDir}/ (have: ${[...bySlug.keys()].join(', ') || 'none'}).`);
      return hit;
    });
  }
  if (!files.length) return '';
  const parts = [];
  for (const f of files) parts.push(await fsp.readFile(path.join(dir, f), 'utf8'));
  return parts.join('\n\n---\n\n');
}

/**
 * Load the selected environment's world/mood/style bible (environments/<slug>.md). No environment =
 * '' (planning unchanged). A named environment with no file throws BEFORE any LLM spend — a typo'd
 * "Set in" must not silently plan without its world (parity with loadProfiles' unknown-cast throw).
 */
async function loadEnvironment(environment) {
  if (!environment) return '';
  const dir = resolvePath(config.engine.environmentsDir);
  let files = [];
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.md')).sort(); } catch { files = []; }
  const bySlug = new Map(files.map((f) => [slug(f.replace(/\.md$/, '')), f]));
  const hit = bySlug.get(slug(environment));
  if (!hit) throw new Error(`Unknown environment "${environment}" — no file found in ${config.engine.environmentsDir}/ (have: ${[...bySlug.keys()].join(', ') || 'none'}).`);
  return fsp.readFile(path.join(dir, hit), 'utf8');
}

/** Validate backend + aspect + cast size up-front (BEFORE any LLM spend) and build the shared agent context. */
export async function buildCtx({ brief, backend, aspectRatio, durationTargetS, cast, environment }) {
  // Canonicalize FIRST: everything below is per-model (which ratios are legal, which caps the agents
  // are told, which id the spec is stamped with), and a typo'd backend must cost nothing. A legacy
  // 'kling'/'seedance' converges here on the same compound id as its `<model>@<provider>` spelling.
  const { id: be } = normalizeBackend(backend ?? config.render.backend, { hint: 'RENDER_BACKEND in .env, or --backend' });
  const caps = capsFor(be);
  // Judge the EFFECTIVE ratio — the flag when given, else the config default the plan would
  // inherit (KLING_ASPECT): a 4:3 default on a three-ratio model must not spend a whole planning
  // pass on a spec the renderer will then reject.
  const effAspect = aspectRatio ?? config.kling.aspectRatio;
  if (effAspect !== undefined && !caps.aspects.includes(effAspect)) {
    throw new Error(`Unknown aspect ratio "${effAspect}"${aspectRatio === undefined ? ' (the KLING_ASPECT config default)' : ''} — use one of: ${caps.aspects.join(', ')}.`);
  }
  // Cast cap, layer 1 of 3 (engine / server / UI). Every starred character burns reference-image
  // slots, so each model has a hard ceiling. This has to fire HERE — before loadProfiles and before
  // the first agent prompt — because an over-starred run can never render: planning it would be
  // eight agents of spend for a spec that dies at the renderer. Ordering also means an over-cap list
  // of unknown names reports the real problem ("too many") instead of "unknown cast member".
  const castLimit = castLimitFor(be);
  if (cast?.length > castLimit) {
    const over = cast.length - castLimit;
    throw new Error(`${caps.label} supports at most ${castLimit} starred character${castLimit === 1 ? '' : 's'} — you selected ${cast.length} (${cast.join(', ')}). Drop ${over === 1 ? 'one' : over}, or switch to a model with a higher cast limit.`);
  }
  // Judge the EFFECTIVE resolution the same way as the ratio above: it comes off the model's own
  // knob (a per-run pick rides that same env variable), and a tier the model does not render —
  // SEEDANCE25_RESOLUTION=1080p, say — must cost nothing instead of a full planning pass.
  const resolution = configuredResolution(caps);
  if (caps.resolutions.length && !caps.resolutions.includes(resolution)) {
    throw new Error(`Unknown resolution "${resolution}" (the ${caps.resolutionEnv} config default) — ${caps.label} renders: ${caps.resolutions.join(', ')}.`);
  }
  const inv = buildInventory();
  // The environment carries NO reference image, so it is loaded AFTER (and independently of) the
  // text-to-video decision — enriching a t2v prompt must never flip the render mode. `environment`
  // is deliberately NOT a param of isTextToVideoPlan below.
  const environmentText = await loadEnvironment(environment);
  return {
    brief,
    backend: be, // the CANONICAL `<model>@<provider>` id — what gets stamped onto the spec
    caps, // the rendering model's own caps: contextBlock's hard-caps lines read them
    aspectRatio, // undefined = config default (contextBlock falls back to config.kling.aspectRatio)
    resolution, // the effective (validated) resolution — contextBlock advertises it, stampResolution pins it
    durationTargetS: durationTargetS ?? config.kling.defaultShotSeconds * 3,
    // Guaranteed text-to-video? (no cast AND no reference image to attach — see isTextToVideoPlan)
    textToVideo: isTextToVideoPlan({ backend: be, cast, refCount: inv.filter((e) => e.type === 'reference').length }),
    inventoryText: inventoryText(inv, { castNames: cast?.length ? [...cast] : [] }),
    inventory: inv, // the scanned entries themselves — topUpStarredElements re-reads them post-plan
    voicesText: voicesInventoryText(),
    profilesText: await loadProfiles(cast),
    castNames: cast?.length ? [...cast] : null,
    environmentText,
    environmentName: (environmentText.match(/^#\s+(.+)$/m)?.[1] ?? '').trim(),
    environmentSlug: environment ? slug(environment) : null,
  };
}

/** Stamp an explicitly requested aspect onto the finished spec (it drives the render). */
function stampAspect(spec, aspectRatio) {
  if (!aspectRatio) return;
  if (spec.project && typeof spec.project === 'object') spec.project.aspect_ratio = aspectRatio;
  if (spec.kling && typeof spec.kling === 'object') spec.kling.aspect_ratio = aspectRatio;
}

/**
 * Stamp the effective resolution onto a KLING-family spec. The Kling renderer reads
 * spec.kling.resolution FIRST (klingPromptSettings) and the planner only ever copies the config
 * default into it — stamping makes the knob (and any per-run pick riding it as an env override)
 * govern the render instead of depending on the LLM copying the context line faithfully. The
 * Seedance family is deliberately untouched: its renderers ignore kling.resolution and read their
 * own knob at render time, so the value stays live rather than frozen at plan time.
 */
function stampResolution(spec, ctx) {
  if (ctx.caps?.family !== 'kling' || !ctx.resolution) return;
  if (spec.kling && typeof spec.kling === 'object') spec.kling.resolution = ctx.resolution;
}

/**
 * Post-plan normalization — the STARRED-cast contract, enforced in code. A starred character exists
 * precisely to pin identity, and the per-model cast caps were sized around each cast bringing its
 * FULL reference set (seedance-2.5's 4-cast cap = 4 casts × 7 refs + seam slots = 30). 4-casting.md
 * states the same rule to the LLM, but a paid render must not hang on prompt adherence: after the
 * plan lands, any starred character carrying fewer element entries than its available reference
 * images is topped up mechanically — no re-prompt — within the SAME budget validateJobs and the
 * renderers enforce: per-model maxImages, tightened by a declared combined-refs cap (fal 2.5's 50)
 * minus what that job's VOICE references will spend out of it, and capped at Kling's per-element
 * ceiling (frontal + maxRefsPerElement — extra views are sliced off at render).
 * The budget splits evenly across the starred cast; un-starred elements are never touched.
 *
 * The same budget is enforced in the other direction: a Casting agent that attached MORE references
 * than the model will carry (50 images plus a voice clip is 51 combined on fal Seedance 2.5) writes
 * a plan the schema accepts — it counts images against maxImages, and the combined cap is only
 * checked by the renderer, right before a paid upload round — so an over-budget starred set is
 * trimmed here rather than left to fail at submit.
 */
export function topUpStarredElements(spec, ctx) {
  const cast = ctx?.castNames ?? [];
  const k = spec?.kling;
  if (!cast.length || !k || typeof k !== 'object') return spec;
  const caps = ctx.caps ?? capsFor(ctx.backend);
  const inv = ctx.inventory ?? buildInventory();
  // The voice registry is per-install (and holds proprietary cast), so it is injectable for the
  // same reason `ctx.inventory` is: this deterministic layer is unit-tested over synthetic casts.
  const voiceClipFor = ctx.voiceClipFor ?? getVoiceRefClip;
  const els = Array.isArray(k.elements) ? k.elements : [];
  const jobs = Array.isArray(k.jobs) ? k.jobs : [];
  const imageCap = Number(caps.maxImages) || 0;
  const combinedCap = Number.isFinite(Number(caps.maxCombinedRefs)) ? Number(caps.maxCombinedRefs) : Infinity;
  // Voice references are NOT sacrificial. A seam pin is (SEAM_PRIORITY drops boundary pins before a
  // cast reference ever goes, which is why no seam slot is reserved below), but nothing drops a
  // voice clip: render-seedance's pre-upload combined check THROWS the moment images + audio pass
  // the model's combined cap — that check exists precisely so a paid upload round never precedes a
  // doomed submit. A roster topped up to all 50 slots plus one voiced line is therefore an
  // engine-produced plan that cannot render, so each job's expected audio demand is reserved here.
  // Counted exactly the way the renderer counts it (jobSpeakers ∩ a registered voice clip, capped
  // by maxAudioRefs); a job with no voiced speaker reserves nothing.
  //
  // …and only where the clips are really going to ride, asked of the ONE gate the renderer and the
  // prompt preview also ask (voiceRefsRide): with audio off, or SEEDANCE_VOICE_MODE=native, no
  // @AudioN is attached at all and the written line is voiced by the model, so a reserved slot per
  // speaker would starve a starred character of up to ten identity images for references nothing
  // sends. Its conditioning half is settled here rather than asked per job: every job whose IMAGE
  // budget this layer computes is carrying cast references, which is what makes it
  // reference-to-video. Seam frames stay out of it for the same reason no seam slot is reserved.
  const audioRides = combinedCap === Infinity ? false : voiceRefsRide({
    castRefCount: 1,
    audioOn: seedancePromptSettings(spec, caps, config.seedance).audioOn,
    voiceMode: config.seedance.voiceMode,
  });
  const audioDemand = (job) => {
    // per-kind budgets — a voice clip never takes an image slot — or no clip rides at all
    if (!audioRides) return 0;
    const speakers = Array.isArray(job?.shots) ? jobSpeakers(job, spec) : [];
    return Math.min(speakers.filter((sp) => voiceClipFor(sp)).length, Number(caps.maxAudioRefs) || 0);
  };
  /** What ONE job may spend on images: the image cap, and whatever its voice clips leave over. */
  const budgetFor = (job) => Math.max(0, Math.min(imageCap, combinedCap - audioDemand(job)));
  // A job with an empty/absent `elements` inherits the WHOLE roster at render time, so the roster
  // has to fit the tightest job that inherits it. When every job names its own subset the roster is
  // never sent whole and the widest job budget is the honest ceiling for the shared pool.
  const inheriting = jobs.filter((j) => !Array.isArray(j?.elements) || !j.elements.length);
  const rosterBudget = inheriting.length ? Math.min(...inheriting.map(budgetFor))
    : jobs.length ? Math.max(...jobs.map(budgetFor))
    : Math.max(0, Math.min(imageCap, combinedCap));
  const perElementCap = caps.maxRefsPerElement != null ? 1 + caps.maxRefsPerElement : Infinity;
  // An element belongs to a character by its `character` field when set, else by the same filename
  // convention the cast routes link with (id === slug, or "<slug>-…").
  const ownedBy = (e, cslug) => (e?.character ? slug(e.character) === cslug : refBelongsTo(String(e?.id ?? ''), cslug));
  const castSlugs = cast.map((name) => slug(name));
  // Split what the cast has LEFT, not the whole budget: un-starred props already sit in the roster
  // and are never touched, so counting their slots into the split hands the first character seats
  // the last one then finds taken — an allocation that depended on cast ORDER rather than on the
  // budget (budget 9, three props, two stars: 4 and 2 instead of 3 each).
  const nonCast = els.filter((e) => !castSlugs.some((cslug) => ownedBy(e, cslug))).length;
  const share = Math.min(Math.floor(Math.max(0, rosterBudget - nonCast) / cast.length), perElementCap);
  /**
   * Give back the references the budget cannot carry, before anything is topped up — the top-up's
   * own `els.length >= budget` guard only stops it from making an over-budget set WORSE. Removed
   * from the biggest starred set each time, so the trim lands where the crowding is, and never below
   * one reference per character: WHICH characters ride is Casting's call, and this layer only sizes
   * their reference sets. Un-starred elements are not ours to take (the same rule as the split).
   * @returns {object[]} the elements removed, so a job naming one by id can be repaired
   */
  const trimToBudget = (list, budget, slugs, ownedIn = (l, cs) => l.filter((e) => ownedBy(e, cs))) => {
    const cut = [];
    for (let over = list.length - budget; over > 0; over--) {
      const biggest = slugs.map((cs) => ownedIn(list, cs)).reduce((a, b) => (b.length > a.length ? b : a), []);
      if (biggest.length <= 1) break;
      const [gone] = list.splice(list.indexOf(biggest.at(-1)), 1);
      cut.push(gone);
    }
    return cut;
  };
  const trimmed = trimToBudget(els, rosterBudget, castSlugs);
  if (trimmed.length) {
    const gone = new Set(trimmed.map((e) => e.id));
    for (const job of jobs) {
      if (!Array.isArray(job?.elements) || !job.elements.length) continue;
      const kept = job.elements.filter((id) => !gone.has(id));
      // An explicit subset must never be left EMPTY: that means "inherit the whole roster"
      // (characterGroups), which would cast every character in the plan into a job the planner
      // wrote for one. Each character it named keeps a seat instead — the subset fill below then
      // widens that seat to the job's own share.
      job.elements = kept.length ? kept : castSlugs
        .filter((cs) => job.elements.some((id) => ownedBy(trimmed.find((e) => e.id === id), cs)))
        .map((cs) => els.find((e) => ownedBy(e, cs))?.id)
        .filter(Boolean);
    }
  }
  const added = [];
  for (const name of cast) {
    const cslug = slug(name);
    const owns = (e) => ownedBy(e, cslug);
    const avail = characterRefs(inv, name);
    const mine = els.filter(owns);
    const target = Math.min(avail.length, share);
    if (mine.length >= target) continue;
    const usedIds = new Set(els.map((e) => e.id));
    const usedImages = new Set(els.map((e) => e.image));
    // Keep the plan's own spelling when it named the character — characterGroups groups by the
    // EXACT string, and a second spelling would split one cast member into two element groups.
    const charName = mine.find((e) => e.character)?.character ?? name;
    const fresh = avail.filter((r) => !usedIds.has(r.id) && !usedImages.has(r.file)).slice(0, target - mine.length);
    for (const r of fresh) {
      if (els.length >= rosterBudget) break;
      els.push({ id: r.id, role: 'subject', image: r.file, character: charName });
      added.push(r.id);
    }
  }
  if (added.length && !Array.isArray(k.elements)) k.elements = els;

  // A job naming an explicit `elements` subset renders EXACTLY that subset (characterGroups), so a
  // starred character riding in one has to ride with the same references the roster carries — and
  // that holds even when the roster needed nothing added, which is the case the loop above walks
  // straight past: the Casting agent already placed the full set, only the Job Planner's subset
  // sampled a single id, and the job still submits one image. Filled per character in equal shares
  // of the JOB's own budget (its own voice refs, not the roster's worst case), so a tight job cannot
  // let the first character eat the last one's slots — and only where the character ALREADY rides,
  // because which characters a shot contains is the Job Planner's call, not this layer's.
  const byId = new Map(els.map((e) => [e.id, e]));
  let filled = 0;
  let cutFromJobs = 0;
  for (const job of jobs) {
    if (!Array.isArray(job?.elements) || !job.elements.length) continue; // inherits the whole roster
    const ownedInJob = (cslug) => job.elements.filter((id) => { const e = byId.get(id); return e && ownedBy(e, cslug); });
    const riding = castSlugs.filter((cslug) => ownedInJob(cslug).length);
    if (!riding.length) continue;
    const budget = budgetFor(job);
    // …and a subset can be over its OWN budget for the same reason the roster can — the planner
    // named more references than this job's voice clips leave room for. Trimmed against the job's
    // budget, which is the number the renderer will count.
    cutFromJobs += trimToBudget(job.elements, budget, riding, (ids, cs) => ids.filter((id) => ownedBy(byId.get(id), cs))).length;
    const others = job.elements.filter((id) => { const e = byId.get(id); return !e || !riding.some((cslug) => ownedBy(e, cslug)); }).length;
    const jobShare = Math.min(share, Math.floor(Math.max(0, budget - others) / riding.length));
    for (const cslug of riding) {
      const have = new Set(ownedInJob(cslug));
      for (const e of els) {
        if (have.size >= jobShare || job.elements.length >= budget) break;
        if (!ownedBy(e, cslug) || have.has(e.id)) continue;
        job.elements.push(e.id);
        have.add(e.id);
        filled += 1;
      }
    }
  }

  if (added.length) {
    log.info(`Casting top-up: starred cast pins its full reference set — added ${added.length} element(s) [${added.join(', ')}] (${share}/character across ${cast.length} starred, budget ${rosterBudget}).`);
  }
  if (filled) {
    log.info(`Casting top-up: filled ${filled} reference slot(s) in explicit job subsets, so a job that names its own elements sends the same set as the roster.`);
  }
  if (trimmed.length || cutFromJobs) {
    log.info(`Casting top-up: trimmed ${trimmed.length} roster reference(s)${trimmed.length ? ` [${trimmed.map((e) => e.id).join(', ')}]` : ''} and ${cutFromJobs} job-subset slot(s) — the plan carried more references than this model sends alongside its voice clips (budget ${rosterBudget}).`);
  }
  return spec;
}

/**
 * Run the full engine for one brief.
 * @param {{brief:string, runDir:string, durationTargetS?:number, backend?:string, aspectRatio?:string, cast?:string[], maxFix?:number, maxQc?:number}} p
 *   `backend`: render backend the spec is planned for (a `<model>@<provider>` id or a legacy
 *   'kling'/'seedance' alias; config default when omitted) — the job planner packs to that model's
 *   caps, the incremental validation enforces them, and the spec is stamped with the CANONICAL id.
 *   `aspectRatio` (one of the model's own ratios): overrides
 *   the config default in the agents' context and is stamped onto the final spec. `cast` (character
 *   names with profiles/<name>.md): narrows the injected profiles to those characters and directs
 *   the agents to star them; an over-cap list (more than the model's `castLimit`) or an unknown name
 *   throws before any LLM spend. `environment` (a single
 *   environments/<slug>.md): injects that world/mood/style bible with precedence over character
 *   world notes and is stamped onto the spec; an unknown slug throws before any LLM spend.
 * @returns {Promise<{spec:object, passed:boolean}>}
 */
export async function runEngine({ brief, runDir, durationTargetS, backend, aspectRatio, cast, environment, maxFix = config.engine.maxFix, maxQc = config.engine.maxQc }) {
  // buildCtx rejects a bad backend/aspect/cast/environment (typo'd flag or env) BEFORE any LLM spend —
  // otherwise the whole 8-agent plan runs, gets stamped with the bogus name, and only render fails.
  const ctx = await buildCtx({ brief, backend, aspectRatio, durationTargetS, cast, environment });
  ensureDir(runDir);

  let spec = JSON.parse(await fsp.readFile(TEMPLATE, 'utf8'));

  // 0 → 6: each agent fills its block, validated up to that block.
  for (let i = 0; i <= 6; i++) {
    log.step(`Engine — agent ${AGENTS[i]}`);
    spec = await runAgentValidated(i, spec, ctx, maxFix);
    await writeJson(path.join(runDir, `spec-${String(i).padStart(2, '0')}.json`), spec);
  }

  // 7 QC gate + targeted re-runs.
  spec = await qcLoop(spec, ctx, { runDir, maxFix, maxQc });

  // Deterministic layer of the starred-cast contract — after the QC gate, before the final gate.
  spec = topUpStarredElements(spec, ctx);

  stampAspect(spec, ctx.aspectRatio);
  stampResolution(spec, ctx);
  spec.render_backend = ctx.backend; // the CANONICAL id this spec was planned FOR — renders must not silently fall back to the config default
  if (ctx.castNames) spec.cast = ctx.castNames; // revisions re-inject the same starred profiles
  if (ctx.environmentSlug) spec.environment = ctx.environmentSlug; // revisions re-inject the same world bible
  const final = validateSpec(spec, { upTo: 7, backend: ctx.backend });
  const passed = spec.qc?.status === 'pass' && final.ok;
  await writeJson(path.join(runDir, 'spec.json'), spec);
  if (!final.ok) log.warn(`Final spec has ${final.errors.length} structural issue(s):\n - ${final.errors.join('\n - ')}`);
  return { spec, passed };
}

// ─── Revisions: route director feedback back through the agents ─────────────

/** scope → owning agent list: a spec block name maps via TAG_OWNER; 'whole'/a job id → null (router decides). */
export function ownersForScope(scope) {
  if (!scope || scope === 'whole') return null;
  const idx = TAG_OWNER[scope];
  return idx === undefined ? null : [idx];
}

/**
 * Owners from a feedback-router LLM reply: prefer a JSON {"tags":[...]} object anywhere in the
 * text, else inline [tag] markers. Unknown tags are dropped; result is de-duped + sorted. [] on garbage.
 */
export function parseRouterTags(text) {
  const s = String(text ?? '');
  const owners = new Set();
  const fromTags = (tags) => { for (const t of tags) if (TAG_OWNER[t] !== undefined) owners.add(TAG_OWNER[t]); };
  try {
    const json = extractJson(s);
    if (Array.isArray(json?.tags)) fromTags(json.tags.map(String));
  } catch { /* not JSON — fall through to inline markers */ }
  if (!owners.size) fromTags([...s.matchAll(/\[([a-z]+)\]/g)].map((m) => m[1]));
  return [...owners].sort((a, b) => a - b);
}

/** A job-id scope resolved to its shots (the feedback's WHERE), or null when scope isn't a job. */
export function scopeShots(spec, scope) {
  const job = (spec?.kling?.jobs ?? []).find((j) => j?.job_id === scope);
  return job ? [...job.shots] : null;
}

/** One-shot LLM routing of free-text feedback to owning agents; falls back to the content agent. */
async function routeFeedback(feedback) {
  const tags = Object.keys(TAG_OWNER);
  try {
    const reply = await complete({
      prompt: [
        '# REVISION ROUTER',
        'A human reviewer left feedback on an AI-video Production Spec. Decide which spec block(s)',
        `must change to apply it. Reply with ONLY a JSON object like {"tags":["content"]} choosing from: ${tags.map((t) => `"${t}"`).join(', ')}.`,
        'Guide: project=story/title/premise; shots=shot list/pacing/beats; content=what happens in a shot (scene prose);',
        'camera=framing/moves; elements=which characters/references appear; audio=dialogue/sfx/music; jobs=how shots pack into render jobs.',
        '',
        `Feedback: ${feedback}`,
      ].join('\n'),
    });
    const owners = parseRouterTags(reply);
    if (owners.length) return owners;
    log.warn('feedback router returned no usable tags — defaulting to the content agent');
  } catch (e) {
    log.warn(`feedback router failed (${e.message}) — defaulting to the content agent`);
  }
  return [TAG_OWNER.content];
}

/**
 * Revise an EXISTING spec from director feedback: route the feedback to its owning agents (explicit
 * `owners` > block-name `scope` > LLM router), re-run each with the feedback in their prompt, then
 * re-run the QC gate. Artifacts land in `runDir`: feedback.json, spec-rNN.json per re-run agent,
 * spec-r07-qcN.json per QC cycle, and the final spec.json.
 * @param {{spec:object, runDir:string, feedback:string, scope?:string, owners?:number[], brief?:string,
 *          backend?:string, aspectRatio?:string, maxFix?:number, maxQc?:number}} p
 *   `scope`: 'whole' (default), a spec block name ('content', 'audio', …), or a job id ('K2') —
 *   a job id narrows the feedback to that job's shots without pinning the agent choice.
 * @returns {Promise<{spec:object, passed:boolean, owners:number[]}>}
 */
export async function reviseSpec({ spec, runDir, feedback, scope, owners, brief, backend, aspectRatio, cast, maxFix = config.engine.maxFix, maxQc = config.engine.maxQc }) {
  if (!feedback || !String(feedback).trim()) throw new Error('reviseSpec needs non-empty feedback (what should change?).');
  // Judge the STARTING spec by the backend it was planned for — `backend` is the revision's TARGET
  // (the switch-and-revise workflow), and judging the old spec by the new model's caps would reject
  // exactly the specs the revision exists to adapt (e.g. a 9-ref Seedance plan moving to Kling).
  // The target still governs the revision itself: buildCtx below and the final validation.
  const v0 = validateSpec(spec, { upTo: 7, backend: spec?.render_backend ?? backend ?? config.render.backend });
  if (!v0.ok) throw new Error(`reviseSpec needs a valid spec to start from:\n - ${v0.errors.join('\n - ')}`);
  // a typo'd scope must fail loudly — silently widening 'K9' or 'contnet' to a whole-spec revision
  // sends the feedback to the wrong agents and re-runs more than the caller asked to pay attention to
  if (scope && scope !== 'whole' && TAG_OWNER[scope] === undefined && !scopeShots(spec, scope)) {
    const jobIds = (spec?.kling?.jobs ?? []).map((j) => j?.job_id).filter(Boolean);
    throw new Error(`Unknown revision scope "${scope}" — use 'whole', a spec block (${Object.keys(TAG_OWNER).join(', ')}), or a job id (${jobIds.join(', ') || 'none in this spec'}).`);
  }
  // A backend SWITCH can strand the persisted cast over the TARGET model's cap, and buildCtx's
  // create-time rejection offers no way out of a plan that already exists — so fail with the
  // revise-specific remediation first: an explicit `cast` (CLI --cast) picks who stays.
  const effCast = cast ?? (Array.isArray(spec?.cast) && spec.cast.length ? spec.cast : undefined);
  if (!cast && effCast) {
    const target = backend ?? spec?.render_backend ?? config.render.backend;
    const limit = castLimitFor(target);
    if (effCast.length > limit) {
      throw new Error(`This plan stars ${effCast.length} characters (${effCast.join(', ')}) but ${capsFor(normalizeBackend(target).id).label} takes at most ${limit} — pass --cast <names> to choose who stays (e.g. --cast ${effCast.slice(0, limit).join(',')}).`);
    }
  }
  // Cast identity is SLUG-based (profiles are looked up by slug), so a stored "wren" and
  // `--cast Wren` are the SAME character — compare normalized rosters, or a case difference
  // re-plans the whole story for nothing. Computed — and the scope conflict rejected — BEFORE
  // buildCtx and the LLM owner-routing call: an invalid command must not spend a routing prompt.
  const rosterOf = (a) => JSON.stringify([...a].map((n) => slug(String(n))).sort());
  const castSwitched = Boolean(cast) && rosterOf(cast) !== rosterOf(Array.isArray(spec?.cast) ? spec.cast : []);
  if (castSwitched && scope && scope !== 'whole') {
    // A cast switch re-plans the whole story; a narrowing scope would tell every agent to touch
    // only one block while the removed character lives everywhere else. Contradictory — refuse.
    throw new Error(`Changing the starred cast re-plans the whole story — drop --scope "${scope}" (or keep the cast unchanged for a scoped revision).`);
  }
  const ctx = await buildCtx({
    brief: brief ?? `${spec.project?.title ?? ''} — ${spec.project?.logline ?? ''}`.trim(),
    backend: backend ?? spec?.render_backend,
    // default to the aspect the spec was PLANNED with — advertising the config default here would
    // tell the owner agents to "fix" a 16:9 spec toward the .env's 9:16 mid-revision
    aspectRatio: aspectRatio ?? spec?.kling?.aspect_ratio ?? spec?.project?.aspect_ratio,
    durationTargetS: spec.project?.duration_target_s,
    cast: effCast, // the plan's starred profiles, unless the caller re-picked them for this revision
    environment: spec?.environment, // re-derive the same world bible from the persisted spec
  });
  ensureDir(runDir);

  let ownerList = owners?.length
    ? [...new Set(owners)].sort((a, b) => a - b)
    : (ownersForScope(scope) ?? await routeFeedback(feedback));
  if (ownerList.some((o) => !Number.isInteger(o) || o < 0 || o > 6)) {
    throw new Error(`reviseSpec owners must be agent indices 0–6 (got: ${ownerList.join(', ')}).`);
  }
  // A backend or cast SWITCH invalidates blocks the feedback may never mention: qcLoop re-judges
  // the jobs against the TARGET model's caps, a re-picked cast must re-pick its element
  // references, and a removed character's voice lines must not survive onto whoever remains
  // (stale audio.voice.lines[].speaker entries would voice the dropped character's dialogue
  // through the retained cast's element). So a backend switch forces Casting (4) + Job Planner
  // (6), and a cast switch forces Sound (5) as well — whatever the router chose.
  const revTarget = ctx.backend; // buildCtx already canonicalized the effective target
  const revSource = (() => { try { return normalizeBackend(spec?.render_backend).id; } catch { return revTarget; } })();
  if (revTarget !== revSource || castSwitched) {
    // A cast switch rewrites the STORY, not just the references: project.cast, the shot list and
    // every content_prompt speak about who is on screen, and agents 4–6 are told to preserve those
    // blocks — so switching cast re-runs every owner (it is a re-plan with the new cast). A
    // backend-only switch needs the cap owners (Casting + Job Planner) — plus the Scene Director
    // when the switch lands in Seedance TEXT-TO-VIDEO mode, whose guidance (concrete subject
    // descriptions, no reference images) the existing content_prompt prose was never written for.
    const forced = castSwitched ? [0, 1, 2, 3, 4, 5, 6] : (ctx.textToVideo ? [2, 4, 6] : [4, 6]);
    ownerList = [...new Set([...ownerList, ...forced])].sort((a, b) => a - b);
    log.info(castSwitched
      ? `Revision changes the starred cast${revTarget !== revSource ? ` (and the backend to ${revTarget})` : ''} — every planning agent re-runs: the story itself is being re-planned around the new cast.`
      : `Revision switches the backend to ${revTarget} — Casting and the Job Planner re-run to adapt the plan to its caps.`);
  }

  const jobShots = scopeShots(spec, scope);
  const note = [
    '## DIRECTOR FEEDBACK (revision)',
    'A human reviewer asked for the following changes to the CURRENT spec below. Apply them to YOUR',
    'block while keeping everything else intact.',
    jobShots ? `The feedback concerns ONLY job ${scope} (shots ${jobShots.join(', ')}) — leave other shots unchanged.` : '',
    `Feedback: ${String(feedback).trim()}`,
  ].filter(Boolean).join('\n');

  await writeJson(path.join(runDir, 'feedback.json'), { feedback: String(feedback).trim(), scope: scope ?? 'whole', owners: ownerList, at: new Date().toISOString() });

  let cur = spec;
  for (const o of ownerList) {
    log.step(`Engine — revising agent ${AGENTS[o]}`);
    cur = await runAgentValidated(o, cur, ctx, maxFix, note);
    await writeJson(path.join(runDir, `spec-r${String(o).padStart(2, '0')}.json`), cur);
  }
  cur = await qcLoop(cur, ctx, { runDir, maxFix, maxQc, filePrefix: 'spec-r07-qc', seedNote: note });

  // A revision re-runs Casting on backend/cast switches — the starred-cast contract holds here too.
  cur = topUpStarredElements(cur, ctx);

  stampAspect(cur, ctx.aspectRatio);
  // Same precedence as the aspect above: a revision keeps the resolution the spec was PLANNED with
  // (for a web run that is the per-run pick, re-injected into this child's env) — re-stamping the
  // bare config default would drift a CLI-planned spec whose .env moved since. Only a value the
  // TARGET model cannot render (a backend switch) falls back to the validated effective one.
  const plannedRes = cur.kling?.resolution;
  stampResolution(cur, { ...ctx, resolution: ctx.caps.resolutions.includes(plannedRes) ? plannedRes : ctx.resolution });
  // A revision keeps (or deliberately changes) the planned backend — never loses it — and re-stamps
  // it canonically, so revising a spec written before compound ids existed upgrades it in place.
  cur.render_backend = ctx.backend;
  if (ctx.castNames) cur.cast = ctx.castNames;
  if (ctx.environmentSlug) cur.environment = ctx.environmentSlug; // the revision re-stamps the same world bible
  const final = validateSpec(cur, { upTo: 7, backend: ctx.backend });
  const passed = cur.qc?.status === 'pass' && final.ok;
  await writeJson(path.join(runDir, 'spec.json'), cur);
  if (!final.ok) log.warn(`Revised spec has ${final.errors.length} structural issue(s):\n - ${final.errors.join('\n - ')}`);
  return { spec: cur, passed, owners: ownerList };
}

export default { runEngine, reviseSpec, ownersForScope, parseRouterTags, scopeShots, topUpStarredElements };
