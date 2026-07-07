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
import { validateSpec, RENDER_BACKENDS, ASPECTS } from './spec-schema.js';
import { buildInventory, inventoryText } from './elements.js';
import { voicesInventoryText } from './voices.js';

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

/** The shared project context every agent sees (brief, config defaults + caps, elements, profiles). */
function contextBlock(ctx) {
  const k = config.kling;
  return [
    '## Project context',
    `- Brief: ${ctx.brief}`,
    `- Defaults: model=${k.model}, aspect_ratio=${ctx.aspectRatio ?? k.aspectRatio}, resolution=${k.resolution}, ` +
      `multi_shot=${k.multiShot}, native_audio=${k.nativeAudio}, target_duration≈${ctx.durationTargetS}s`,
    `- Render backend: ${ctx.backend}`,
    `- Hard caps: ≤${k.maxStoryboards} shots/job, ≤${k.maxJobSeconds}s/job, ≤512 chars/segment, ≤${k.maxRefImages} reference images/job`,
    ...(ctx.backend === 'seedance'
      ? [`- Seedance packing rule: every job must total ${config.seedance.minJobSeconds}–${config.seedance.maxJobSeconds}s (a job under ${config.seedance.minJobSeconds}s fails validation — merge short shots); other caps are identical.`]
      : []),
    '- Valid enums: shot_size ∈ {extreme_close_up, close_up, medium_close_up, medium, medium_wide, wide, extreme_wide}; ' +
      'aspect_ratio ∈ {16:9, 9:16, 1:1}; kling.model_name ∈ {kling-v3-omni, kling-video-o1}; ' +
      'kling.resolution ∈ {4k, 1080p, 720p}',
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

/** Validate backend + aspect up-front (BEFORE any LLM spend) and build the shared agent context. */
async function buildCtx({ brief, backend, aspectRatio, durationTargetS, cast }) {
  const be = backend ?? config.render.backend;
  if (!RENDER_BACKENDS.includes(be)) {
    throw new Error(`Unknown render backend "${be}" — use one of: ${RENDER_BACKENDS.join(', ')} (RENDER_BACKEND in .env, or --backend).`);
  }
  if (aspectRatio !== undefined && !ASPECTS.includes(aspectRatio)) {
    throw new Error(`Unknown aspect ratio "${aspectRatio}" — use one of: ${ASPECTS.join(', ')}.`);
  }
  return {
    brief,
    backend: be,
    aspectRatio, // undefined = config default (contextBlock falls back to config.kling.aspectRatio)
    durationTargetS: durationTargetS ?? config.kling.defaultShotSeconds * 3,
    inventoryText: inventoryText(buildInventory()),
    voicesText: voicesInventoryText(),
    profilesText: await loadProfiles(cast),
    castNames: cast?.length ? [...cast] : null,
  };
}

/** Stamp an explicitly requested aspect onto the finished spec (it drives the render). */
function stampAspect(spec, aspectRatio) {
  if (!aspectRatio) return;
  if (spec.project && typeof spec.project === 'object') spec.project.aspect_ratio = aspectRatio;
  if (spec.kling && typeof spec.kling === 'object') spec.kling.aspect_ratio = aspectRatio;
}

/**
 * Run the full engine for one brief.
 * @param {{brief:string, runDir:string, durationTargetS?:number, backend?:string, aspectRatio?:string, cast?:string[], maxFix?:number, maxQc?:number}} p
 *   `backend`: render backend the spec is planned for ('kling' default) — the job planner packs to
 *   its caps and the incremental validation enforces them. `aspectRatio` (16:9|9:16|1:1): overrides
 *   the config default in the agents' context and is stamped onto the final spec. `cast` (character
 *   names with profiles/<name>.md): narrows the injected profiles to those characters and directs
 *   the agents to star them; unknown names throw before any LLM spend.
 * @returns {Promise<{spec:object, passed:boolean}>}
 */
export async function runEngine({ brief, runDir, durationTargetS, backend, aspectRatio, cast, maxFix = config.engine.maxFix, maxQc = config.engine.maxQc }) {
  // buildCtx rejects a bad backend/aspect/cast (typo'd flag or env) BEFORE any LLM spend —
  // otherwise the whole 8-agent plan runs, gets stamped with the bogus name, and only render fails.
  const ctx = await buildCtx({ brief, backend, aspectRatio, durationTargetS, cast });
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

  stampAspect(spec, ctx.aspectRatio);
  spec.render_backend = ctx.backend; // the spec is planned FOR this backend — renders must not silently fall back to the config default
  if (ctx.castNames) spec.cast = ctx.castNames; // revisions re-inject the same starred profiles
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
export async function reviseSpec({ spec, runDir, feedback, scope, owners, brief, backend, aspectRatio, maxFix = config.engine.maxFix, maxQc = config.engine.maxQc }) {
  if (!feedback || !String(feedback).trim()) throw new Error('reviseSpec needs non-empty feedback (what should change?).');
  const v0 = validateSpec(spec, { upTo: 7, backend: backend ?? spec?.render_backend ?? config.render.backend });
  if (!v0.ok) throw new Error(`reviseSpec needs a valid spec to start from:\n - ${v0.errors.join('\n - ')}`);
  // a typo'd scope must fail loudly — silently widening 'K9' or 'contnet' to a whole-spec revision
  // sends the feedback to the wrong agents and re-runs more than the caller asked to pay attention to
  if (scope && scope !== 'whole' && TAG_OWNER[scope] === undefined && !scopeShots(spec, scope)) {
    const jobIds = (spec?.kling?.jobs ?? []).map((j) => j?.job_id).filter(Boolean);
    throw new Error(`Unknown revision scope "${scope}" — use 'whole', a spec block (${Object.keys(TAG_OWNER).join(', ')}), or a job id (${jobIds.join(', ') || 'none in this spec'}).`);
  }
  const ctx = await buildCtx({
    brief: brief ?? `${spec.project?.title ?? ''} — ${spec.project?.logline ?? ''}`.trim(),
    backend: backend ?? spec?.render_backend,
    // default to the aspect the spec was PLANNED with — advertising the config default here would
    // tell the owner agents to "fix" a 16:9 spec toward the .env's 9:16 mid-revision
    aspectRatio: aspectRatio ?? spec?.kling?.aspect_ratio ?? spec?.project?.aspect_ratio,
    durationTargetS: spec.project?.duration_target_s,
    cast: Array.isArray(spec?.cast) && spec.cast.length ? spec.cast : undefined, // same starred profiles as the plan
  });
  ensureDir(runDir);

  const ownerList = owners?.length
    ? [...new Set(owners)].sort((a, b) => a - b)
    : (ownersForScope(scope) ?? await routeFeedback(feedback));
  if (ownerList.some((o) => !Number.isInteger(o) || o < 0 || o > 6)) {
    throw new Error(`reviseSpec owners must be agent indices 0–6 (got: ${ownerList.join(', ')}).`);
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

  stampAspect(cur, ctx.aspectRatio);
  cur.render_backend = ctx.backend; // a revision keeps (or deliberately changes) the planned backend — never loses it
  if (ctx.castNames) cur.cast = ctx.castNames;
  const final = validateSpec(cur, { upTo: 7, backend: ctx.backend });
  const passed = cur.qc?.status === 'pass' && final.ok;
  await writeJson(path.join(runDir, 'spec.json'), cur);
  if (!final.ok) log.warn(`Revised spec has ${final.errors.length} structural issue(s):\n - ${final.errors.join('\n - ')}`);
  return { spec: cur, passed, owners: ownerList };
}

export default { runEngine, reviseSpec, ownersForScope, parseRouterTags, scopeShots };
