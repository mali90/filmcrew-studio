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
import { isSafeSegment } from './paths.js';
import { writeFileAtomic } from './atomic-file.js';
// Config-free siblings (no host import, so the lazy-import idiom above still holds): the voices
// registry and the two voice knobs are read the same way here and by the seam budget in
// run-service.js — a second reader is how a preview and a paid render start disagreeing.
import { voiceClipLookup, voiceKnobs, voicesDirFor } from './voice-refs.js';
// config.js's own boolean coercion, imported as a PURE RULE (the same standing this file's siblings
// give prompt-settings.js's audioFlag): rules come from the tree, DATA and paths still come from the
// run's `root` below. A trimmed copy here is how a preview and a paid render start disagreeing about
// a flag — the one thing this module exists to prevent.
import { envBool } from '../../../src/lib/env-file.js';

/**
 * The prompt-relevant knobs, mirrored from config.js (the `kling`, `seedance` and `seedance25`
 * blocks). The child renderer reads them through dotenv + config.js; this server may not, so the
 * DEFAULTS are duplicated here — deliberately, and nowhere else. Keep them in step with config.js:
 * a drifted default shows up as a preview that differs from the render, which the byte-parity test
 * in prompt-read.test.js catches.
 */
function promptDefaults(get) {
  // Mirrors config.js's numEnv exactly, NaN included: a knob that does not parse must reach the
  // preview as the same unreadable value it reaches the render as, and be refused by the same rule
  // (promptCapOf) — a fallback to the default here would preview a cap the render never applies.
  const num = (key, dflt) => { const v = get(key); return v === '' ? dflt : Number(v); };
  // Mirrors config.js's boolEnv by CALLING it — the same function, not a second regex. The trim it
  // applies is load-bearing: dotenv keeps padding inside a quoted value, so `KLING_CHAIN_FRAMES=
  // " true "` is ON in the render child, and a raw test here would preview an unchained plan for a
  // render that chains.
  const bool = (key, dflt) => envBool(get(key), dflt);
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
  // The two knobs that decide whether a voice clip rides come from voice-refs.js: the seam budget
  // in run-service.js asks the same question of the same .env, and one mirror cannot drift.
  const voices = voiceKnobs(get);
  const seedance = {
    resolution: get('SEEDANCE_RESOLUTION') || '480p',
    generateAudio: voices.audioOn,
    voiceMode: voices.voiceMode,
    // 0 = uncapped, mirroring config.js's own default: Segmind's 2.0/2.5 API pages declare no
    // prompt-length limit and fal's published Seedance schemas declare no maxLength on `prompt`, so
    // the knob only clamps for a user who sets one (a provider 422 is the reason to). A number here
    // that config.js does not share would meter an edit — and refuse a save — against a budget the
    // render never applies.
    promptMaxBytes: num('SEEDANCE_PROMPT_MAX_BYTES', 0),
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
  const { readEnvFileOrExample, dotenvValues } = await import(path.join(root, 'src/lib/env-file.js'));
  const { text, source } = readEnvFileOrExample(envRoot);
  // ONLY a real .env counts. dotenv loads <envRoot>/.env and nothing else, so quoting
  // .env.example's placeholder values here would preview a prompt no child would ever send.
  //
  // Read with DOTENV's grammar, not the wizard's line editor (parseEnv/getEnvValue): the editor
  // keeps a trailing `# comment` inside the value, ignores an `export ` prefix and reports the
  // FIRST assignment, while the child's dotenv strips the comment, accepts the prefix and keeps the
  // LAST — three ways for an ordinary .env to preview one prompt and pay for another.
  const values = source === '.env' ? dotenvValues(text) : Object.create(null);
  return (key) => {
    if (childEnv && Object.hasOwn(childEnv, key)) return String(childEnv[key] ?? '').trim();
    // No trim, no unquoting here: dotenv already did both, and its rule is the one the child got —
    // a QUOTED value keeps the padding inside its quotes, and trimming it away is a second reading.
    return values[key] ?? '';
  };
}

const utf8 = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');

// ── The overrides sidecar (P4) ──────────────────────────────────────────────────────────────────
// It lives at the RUN root, not in a take dir, because a revise overwrites spec.json and a take dir
// is immutable: an edit has to outlive both. `render()`/`rerenderJob()` snapshot it into the take
// they reserve, which is what makes a past take answerable ("this is what we sent, and why").

const OVERRIDES_FILE = 'prompt-overrides.json';
const OVERRIDES_SCHEMA = 1;

/**
 * A map keyed by JOB ID — with no prototype, because a job id is arbitrary validated text and
 * `{}` inherits members that behave like keys. `jobs['__proto__'] = edit` on a plain object hits
 * Object.prototype's SETTER: no own key appears, `Object.keys` stays empty, writeOverrides then
 * deletes the sidecar as "no edits left" and the user's words are gone. The reads are just as
 * wrong the other way — `jobs['toString']` on a plain object answers with an inherited function,
 * i.e. "yes, this job has an edit". Object spread would put the prototype back, so every copy goes
 * through here too.
 */
const jobMap = (from) => Object.assign(Object.create(null), from);

/** The run's saved edits, or an empty set. A corrupt sidecar reads as empty HERE (the preview must
 *  still render) — the renderers throw on it instead, before anything is submitted. */
function readOverrides(runDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(runDir, OVERRIDES_FILE), 'utf8'));
    const jobs = raw?.jobs;
    // JSON.parse defines `__proto__` as an ORDINARY own key, so a hand-written sidecar naming one
    // survives this copy intact — it is only assignment onto a plain object that loses it.
    return { schema: OVERRIDES_SCHEMA, jobs: jobMap(jobs && typeof jobs === 'object' && !Array.isArray(jobs) ? jobs : null) };
  } catch {
    return { schema: OVERRIDES_SCHEMA, jobs: jobMap(null) };
  }
}

/** Read-modify-write the sidecar. An empty result removes the file, so nothing downstream ever has
 *  to distinguish "no edits" from "a file full of nothing".
 *
 *  Written atomically (tmp + rename, the same helper web.json uses): truncating this file in place
 *  means a save killed halfway leaves bytes that do not parse, `readOverrides` above reads that as
 *  NO edits, and the next save writes a sidecar with every earlier edit missing — the user's words
 *  lost by a crash they never saw. */
function writeOverrides(runDir, mutate) {
  const file = path.join(runDir, OVERRIDES_FILE);
  const current = readOverrides(runDir);
  const next = mutate({ schema: OVERRIDES_SCHEMA, jobs: jobMap(current.jobs) });
  if (!Object.keys(next.jobs).length) {
    try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
    return next;
  }
  writeFileAtomic(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}

/**
 * Everything a run needs to compose any of its jobs, loaded once (`/prompts` composes N jobs).
 * @returns {Promise<{caps:object, jobs:object[], viewFor:(jobId:string)=>object}>}
 */
async function createComposer({ root, envRoot, childEnv, runDir, spec, backend, voicesDir }) {
  const [models, compose, promptSettings, castGroups, text, seedanceArgs] = await Promise.all([
    import(path.join(root, 'src/lib/render-models.js')),
    import(path.join(root, 'src/lib/prompt-compose.js')),
    import(path.join(root, 'src/lib/prompt-settings.js')),
    import(path.join(root, 'src/lib/cast-groups.js')),
    import(path.join(root, 'src/lib/text.js')),
    import(path.join(root, 'src/lib/seedance-args.js')),
  ]);
  const { capsFor, normalizeBackend, refLabel } = models;
  const { cappedAudioRefs, cappedCombinedRefs, fitAudioRef, voiceRefSpeakers } = seedanceArgs;
  const { composeKlingStoryboard, composeSeedanceJobPrompt, applyOverride, pinBytesOf, promptCapOf, promptFingerprint, chooseSeamMode, planSeamRefs, appliedSeamModes } = compose;
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
  // Wherever the render CHILD will look for voices — through the one resolution the seam budget
  // uses too, so a preview and the money question it feeds can never name different dirs.
  const voiceClipFor = voiceClipLookup(voicesDirFor({ get, root, voicesDir }), root, slug);
  // Renderer parity needs each clip's DURATION: fitAudioRef drops a clip under the model's
  // per-clip minimum before the paid submit, and a preview counting a doomed @AudioN would differ
  // from the wire prompt (the exactness this whole module exists for). Probed once here — the view
  // functions stay sync — and an unprobeable clip stays IN, exactly as the renderer sends it as-is.
  const { probeClip } = await import(path.join(root, 'src/lib/assemble.js'));
  const voiceDurS = new Map();
  for (const sp of new Set((spec?.audio?.voice?.lines ?? []).map((l) => l?.speaker).filter(Boolean))) {
    const clip = voiceClipFor(sp);
    if (!clip) continue;
    try { voiceDurS.set(slug(sp), (await probeClip(clip)).duration); } catch { /* unprobeable — kept */ }
  }
  const jobs = spec?.kling?.jobs ?? [];
  const overrides = readOverrides(runDir);
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

  /**
   * Every boundary pairing a render of this job could REALLY apply — what the meter has to survive.
   * The full render's own (above) is one of them; `rerender-job` resolves the rest over the cut
   * (web/server/lib/lineage.js resolveBoundaries), and it may pin either end wherever a neighbour
   * exists: `boundaries:'auto'` ends a nonterminal segment on its successor's opening frame the
   * moment that join is on record, and `'both'`/`'start'`/`'end'` force one outright.
   */
  function boundaryCandidates(job, index) {
    const plan = boundariesFor(job, index);
    const ends = (planned, hasNeighbour) => [...new Set([planned, hasNeighbour])];
    return ends(plan.hasSeamIn, index > 0).flatMap((hasSeamIn) =>
      ends(plan.hasSeamOut, index < jobs.length - 1).map((hasSeamOut) => ({ hasSeamIn, hasSeamOut })));
  }

  /** The Kling storyboard: one ≤500-byte segment per shot, `@Element1` leading each. */
  function klingView(job, index, override = null) {
    const settings = klingPromptSettings(spec, defaults.kling);
    const groups = characterGroups(job, spec);
    const textToVideo = groups.every((g) => g.els.length === 0);
    const idxByName = new Map(groups.map((g, i) => [slug(g.name), i + 1]));
    const voiceTokenFor = textToVideo ? () => '' : (sp) => {
      const i = idxByName.get(slug(sp ?? '')) ?? (groups.length === 1 ? 1 : null);
      return i ? `@Element${i}` : '';
    };
    const opts = { lowercaseSpeech: true, leadRef: textToVideo ? null : '@Element1', voiceTokenFor };
    const planned = composeKlingStoryboard(job, spec, settings, opts);
    // Exactly the call the renderer makes (kling.js → applyOverride), so a previewed override is the
    // same bytes an override renders — the whole point of one pure composer.
    const { segments } = override ? applyOverride(planned, override, settings) : planned;
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
    // What the EDITOR opens on. Not `segments[].prompt` — that is the COMPOSED segment, lead ref and
    // framing and camera included, and re-composing it would wrap the scaffolding a second time. The
    // editable thing is the authored scene body, exactly what `applyOverride` swaps in, so saving an
    // untouched draft re-composes to the same bytes.
    const planBodies = (job.shots ?? []).map((id) =>
      String((spec.shots ?? []).find((s) => s?.shot_id === id)?.kling?.content_prompt ?? ''));
    // Mirrors applyOverride's own fallback: a blank or missing entry leaves that shot on the plan.
    const draftSegments = planBodies.map((body, i) => {
      const edit = Array.isArray(override?.segments) ? override.segments[i] : i === 0 ? override?.prompt : undefined;
      return typeof edit === 'string' && edit.trim() ? edit : body;
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
      draft: draftSegments.join('\n\n'),
      draftSegments,
      // The agents' current text, offered ALONGSIDE an override (never instead of it) so the stale
      // banner's "Refresh from plan" has something to load and the reader can compare the two.
      ...(override ? {
        planPrompt: planned.segments.map((s) => s.prompt).join('\n\n'),
        planSegments: planned.segments.map((s) => s.prompt),
        planDraft: planBodies.join('\n\n'),
        planDraftSegments: planBodies,
      } : {}),
    };
  }

  /** Seedance: ONE rich multi-shot prompt per job, with the boundary pins the render will apply. */
  function seedanceView(job, index, override = null) {
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
    const audioOn = !!settings.audioOn;

    /**
     * Everything about this job that MOVES when the boundary frames move: which voice clips ride,
     * how the reference budget lays the images out, and therefore which pin sentences the front
     * matter carries. One function, called once for the render this view describes and again for
     * every render its byte meter has to survive — two copies of this layout is how a preview and a
     * paid render start disagreeing.
     */
    function layoutFor(hasSeamIn, hasSeamOut) {
      // Voice references (@AudioN) ride the renderer's gate itself, not a copy of it: something for
      // the clips to ride on (cast refs or a boundary frame at EITHER end), audio on, and a voiceMode
      // that keeps the clip.
      const candidates = voiceRefSpeakers({
        speakers: jobSpeakers(job, spec), hasClip: voiceClipFor,
        castRefCount: castCount, hasSeamIn, hasSeamOut, audioOn, voiceMode: defaults.seedance.voiceMode,
      });
      // …and the same REFUSAL. More voiced speakers than the model has @Audio slots is a hard error in
      // the renderer (before it fits a single clip), so slicing the list to fit here would present a
      // ready-looking preview for a job that can never be sent. viewFor turns the throw into the job's
      // `error` — the same shape an unbuildable prompt already reports, and the sheet already words it
      // as "the render would fail on the same message".
      cappedAudioRefs(caps, job.job_id, candidates.length);
      // The renderer's own drop rule, same inputs: window sized by the PRE-drop candidate count, a
      // clip under the per-clip minimum never reaches the wire — so it never reaches the preview.
      const fitCaps = { ...caps, audioBudgetS: caps.audioBudgetS ?? 15 };
      const voiced = candidates.filter((sp) => {
        const dur = voiceDurS.get(slug(sp));
        return dur == null || fitAudioRef(dur, fitCaps, { refCount: candidates.length || 1 }) !== 'drop';
      });
      const audioLabels = new Map(voiced.map((sp, i) => [slug(sp), refLabel(caps, 'Audio', i + 1)]));
      const audioRefFor = (sp) => audioLabels.get(slug(sp ?? '')) ?? null;

      // The combined budget (fal 2.5 counts images + audio + video against one cap), checked BEFORE
      // the seam layout for the same reason the renderer checks it before uploading anything: only the
      // CAST and the surviving voice clips count, because planSeamRefs drops a soft-pinned boundary
      // frame rather than overrun. Without this the preview happily drops cast refs the renderer would
      // never get to drop — it throws first — and `refs` below would cite labels no render can send.
      cappedCombinedRefs(caps, { images: castCount, audio: voiced.length });

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
      return {
        voiced,
        audioRefFor,
        seam,
        plan,
        opts: { refGroups, audioRefFor, startFrameRef, endFrameRef, feedback: '', nonce: 0, shotSyntax: caps.shotSyntax },
      };
    }

    // The FULL render from the plan: the prompt, the references and the seam verdicts this view
    // reports are that render's, byte for byte (a refusal here is still the job's `error`).
    const { hasSeamIn, hasSeamOut } = boundariesFor(job, index);
    const { voiced, audioRefFor, seam, plan, opts } = layoutFor(hasSeamIn, hasSeamOut);
    const planned = composeSeedanceJobPrompt(job, spec, settings, opts);
    // The renderer's own call (seedance.js → applyOverride): the user's words with THIS render's
    // front matter and seam pins re-composed over them, and clamped only where a cap is set —
    // Seedance ships uncapped, and a user's words are never clamped either way. Preview === wire, still.
    const { prompt, shotPrompts } = override ? applyOverride(planned, override, settings) : planned;
    // The editable body: the composed prompt with the SYSTEM front matter taken back off, which is
    // precisely what `applyOverride` re-composes over. Saving it untouched yields the same bytes.
    const planBody = planned.prompt.startsWith(planned.front)
      ? planned.prompt.slice(planned.front.length).replace(/^\n{1,2}/, '')
      : planned.prompt;
    const edited = typeof override?.prompt === 'string'
      ? override.prompt
      : Array.isArray(override?.segments) ? override.segments.join('\n') : '';
    const draft = edited.trim() ? edited : planBody;

    let castSeen = 0;
    const groupOfRef = [];
    for (const g of refGroups) for (const _r of g.refs) groupOfRef.push(g.name);
    const refs = plan.imageRefs.map((r) => (
      r.kind === 'cast'
        ? { ref: r.label, character: groupOfRef[castSeen++] ?? null }
        : { ref: r.label, role: r.kind === 'seamIn' ? 'opening frame' : 'closing frame' }
    ));
    for (const sp of voiced) refs.push({ ref: audioRefFor(sp), character: sp, role: 'voice' });

    // The meter's denominator is not THIS render's pins but the widest pin set any render of this
    // segment can apply (boundaryCandidates): the saved words are re-composed under whichever
    // boundaries the re-render resolves, and `applyOverride` MEASURES the result against the cap —
    // `assertOverrideFits` then refuses the render rather than trimming words somebody is paying to
    // send. Metering the plan's pins alone accepted an edit a `boundaries:'auto'` re-render could
    // not fit — once by truncating it from the end mid-paid-render, now by refusing to send at all —
    // with nothing on screen having said so. A pairing the renderer would REFUSE (more
    // voiced speakers than @Audio slots once a frame makes the job reference-to-video) reserves
    // nothing: that render throws before it spends, so it can never cut anybody's words.
    const pinBytes = Math.max(...boundaryCandidates(job, index).map((b) => {
      try { return pinBytesOf('seedance', job, spec, settings, layoutFor(b.hasSeamIn, b.hasSeamOut).opts); } catch { return 0; }
    }));

    return {
      prompt,
      segments: null,
      shotPrompts,
      refs,
      bytes: utf8(prompt),
      // "No cap" travels as null, never 0: the editor's denominator is `maxBytes − pinBytes`, and a
      // 0 there goes negative and meters every draft as instantly over — refusing saves the renderer
      // would happily accept. The wire shape already carries null for a past take's unrecorded budget.
      maxBytes: promptCapOf(settings) || null,
      segmentMaxBytes: null,
      pinBytes,
      // What the render will really APPLY, not what it wished for: a soft pin whose reference lost
      // its slot to the image budget (a full cast at maxImages) pins nothing, and the sheet must say
      // so — this is the pre-flight signal that a joint is going to be a scene cut.
      seam: appliedSeamModes(seam, plan.imageRefs),
      draft,
      draftSegments: null,
      // The agents' current text, offered alongside an override — never in place of it.
      ...(override ? {
        planPrompt: planned.prompt,
        planSegments: planned.shotPrompts,
        planDraft: planBody,
        planDraftSegments: null,
      } : {}),
    };
  }

  function viewFor(jobId) {
    const index = jobs.findIndex((j) => j?.job_id === jobId);
    const job = jobs[index];
    if (!job) return null;
    const override = overrides.jobs?.[jobId] ?? null;
    const fingerprint = promptFingerprint(spec, jobId);
    const head = {
      jobId,
      backend: caps.id,
      endpointLabel: `${caps.providerLabel} ${caps.label}`,
      shots: [...(job.shots ?? [])],
      source: override ? 'override' : 'plan',
      take: null,
      sentAt: null,
      // The plan moved under a saved edit. It changes NOTHING about what gets sent — a stale
      // override is still used verbatim — it only earns the banner that offers Refresh/Discard.
      stale: Boolean(override?.fingerprint && override.fingerprint !== fingerprint),
      updatedAt: override?.updatedAt ?? null,
      fingerprint,
      // The versions the reader can switch to. Derived from what is ON DISK, not from the manifest's
      // take list: a take that failed before this job, or one made before sidecars existed, has no
      // "as sent" text to show, and offering it would open onto a 404.
      availableTakes: takesWithPrompts(runDir, jobId),
    };
    try {
      return { ...head, ...(caps.family === 'kling' ? klingView(job, index, override) : seedanceView(job, index, override)) };
    } catch (e) {
      // One unbuildable job (a shot id the plan lost, a missing content_prompt) must not take the
      // whole prompt sheet down — the render would fail on exactly this message, so show it.
      // No budget is on RECORD for a job that cannot be composed, and null is how every other
      // absence travels — a 0 would read as "your words have no room", which is a different claim.
      return { ...head, prompt: '', segments: null, shotPrompts: null, refs: [], bytes: 0, maxBytes: null, segmentMaxBytes: null, pinBytes: 0, error: e.message };
    }
  }

  /** Saved edits whose job the plan no longer has. Kept, and reported with their text — the agents
   *  re-cutting the segments must never silently delete words a user typed. */
  function orphanedOverrides() {
    const planned = new Set(jobs.map((j) => j?.job_id).filter(Boolean));
    return Object.entries(overrides.jobs ?? {})
      .filter(([jobId]) => !planned.has(jobId))
      .map(([jobId, o]) => ({
        jobId,
        ...(typeof o?.prompt === 'string' ? { prompt: o.prompt } : {}),
        ...(Array.isArray(o?.segments) ? { segments: o.segments } : {}),
        updatedAt: o?.updatedAt ?? null,
      }));
  }

  return { caps, jobs, viewFor, orphanedOverrides, fingerprintFor: (jobId) => promptFingerprint(spec, jobId) };
}

const TAKE_DIR_RE = /^(t\d+|render)$/;
// A job id is whatever the PLAN called it, and a take's sidecar sits in a directory of that name, so
// the only question worth asking here is whether it is safe to join onto a path (isSafeSegment). It
// used to be asked as a charset whitelist, which quietly answered a different one: `__proto__` is a
// job id this build supports end to end — the spec accepts it, the override maps are null-prototype
// so an edit for it saves, the renderers write its prompts.json — yet a leading underscore made its
// version picker permanently empty and its as-sent prompt unreachable.
const isJobId = (jobId) => isSafeSegment(String(jobId));

/** Newest take first: t12 before t3, and the legacy unnumbered `render` dir last. */
function byTakeNewestFirst(a, b) {
  const n = (t) => (t === 'render' ? -1 : Number(t.slice(1)));
  return n(b) - n(a);
}

// The sidecar schema that first recorded `submitted_at`. Older sidecars could not say whether their
// job ever left the machine, so they are read exactly as they always were — a run's history is not
// something to erase because a later build learned to ask a better question.
const SUBMITTED_AT_SCHEMA = 3;

/**
 * Did a provider ever ACCEPT this take's job? The renderers write the sidecar BEFORE they submit —
 * that is deliberate, so a render that dies still leaves the prompt behind — which makes the file's
 * existence proof only that we composed something. A take that never reached a provider (no
 * SEGMIND_API_KEY, no FAL_KEY, a payload the endpoint rejected) must not be offered as a version and
 * labelled "sent": that is the sheet claiming to show what was sent when nothing was.
 */
const wasSubmitted = (sidecar) =>
  Boolean(sidecar) && (Boolean(sidecar.submitted_at) || Boolean(sidecar.request_id)
    || Number(sidecar.schema ?? 0) < SUBMITTED_AT_SCHEMA);

/** One take's sidecar for this job, parsed, or null (absent, unreadable, or never submitted). */
function submittedSidecarAt(file) {
  let sidecar;
  try { sidecar = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  return wasSubmitted(sidecar) ? sidecar : null;
}

/**
 * The takes that really SENT a prompt for this job, newest first — the version picker's options,
 * and the only take ids `?take=` will answer for. Ids only: no path leaves this function.
 */
function takesWithPrompts(runDir, jobId) {
  if (!runDir || !isJobId(jobId)) return [];
  const found = new Set();
  // Web runs keep takes under renders/; a CLI run keeps them beside the spec (takeView reads both).
  for (const base of [path.join(runDir, 'renders'), runDir]) {
    let names = [];
    try { names = fs.readdirSync(base); } catch { continue; } // no renders/ yet — nothing was sent
    for (const name of names) {
      if (!TAKE_DIR_RE.test(name)) continue;
      if (submittedSidecarAt(path.join(base, name, String(jobId), 'prompts.json'))) found.add(name);
    }
  }
  // …and a CLI render given the run dir itself (`render.js --out <runDir>`) has no take dir at all:
  // renderSpec writes <runDir>/<jobId>/prompts.json beside the run's own render.json, the layout
  // run-scan reads that run's status from. It is the unnumbered take under a third spelling, so it
  // answers to the same id — and a nested `render/` take, being the more specific one, wins the id
  // in takeView below.
  if (submittedSidecarAt(path.join(runDir, String(jobId), 'prompts.json'))) found.add('render');
  return [...found].sort(byTakeNewestFirst);
}

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
 * Returns null when that take never wrote a sidecar for this job — or wrote one it never sent.
 */
async function takeView({ root, runDir, take, jobId }) {
  if (!TAKE_DIR_RE.test(String(take)) || !isJobId(jobId)) return null;
  const candidates = [
    path.join(runDir, 'renders', String(take), String(jobId), 'prompts.json'),
    path.join(runDir, String(take), String(jobId), 'prompts.json'), // CLI runs keep their take beside the spec
    // …and a CLI render pointed at the run dir has no take dir: <runDir>/<jobId>/prompts.json. Only
    // the unnumbered id can mean it (takesWithPrompts offers it under that name), and it is read
    // LAST so a run that also has a real `render/` take keeps answering with the take dir.
    ...(String(take) === 'render' ? [path.join(runDir, String(jobId), 'prompts.json')] : []),
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) return null;
  // Same gate as the version picker, so a take id that is not offered cannot be reached by hand
  // either: this view labels its text "sent", and a take that never left must not wear that.
  const sidecar = submittedSidecarAt(file);
  if (!sidecar) return null;

  const segments = Array.isArray(sidecar.segments) ? sidecar.segments : null;
  const prompt = typeof sidecar.prompt === 'string'
    ? sidecar.prompt
    : (segments ?? []).map((s) => String(s?.prompt ?? '')).join('\n\n');
  // The recorded SUBMISSION time, which is the answer to "when was this sent". The file's mtime is
  // only a fallback for sidecars written before that was recorded, and it is a poor one: the
  // renderer rewrites the sidecar when the receipt lands, so on Segmind it dates a long job to the
  // moment it FINISHED.
  let sentAt = sidecar.submitted_at ?? null;
  if (!sentAt) { try { sentAt = fs.statSync(file).mtime.toISOString(); } catch { /* raced */ } }
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
    availableTakes: takesWithPrompts(runDir, jobId),
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
  const { viewFor } = await createComposer({ root, envRoot, childEnv, runDir, spec, backend, voicesDir });
  return viewFor(jobId);
}

/**
 * Every job of the CURRENT plan, in plan order.
 * @returns {Promise<{backend:string, jobs:string[], prompts:object[], orphaned:object[]}>}
 */
export async function buildPromptViews({ root, envRoot, childEnv, runDir, spec, backend, voicesDir }) {
  const { caps, jobs, viewFor, orphanedOverrides } = await createComposer({ root, envRoot, childEnv, runDir, spec, backend, voicesDir });
  const ids = jobs.map((j) => j?.job_id).filter(Boolean);
  return { backend: caps.id, jobs: ids, prompts: ids.map((id) => viewFor(id)).filter(Boolean), orphaned: orphanedOverrides() };
}

// ── Editing (P4) ────────────────────────────────────────────────────────────────────────────────

const badRequest = (message, hint) => Object.assign(new Error(message), { statusCode: 400, hint });

/**
 * How many bytes of a job's budget the user's own words may spend: the model's cap minus what the
 * SYSTEM already owns. Measured from the same composer the render uses, so the meter in the editor
 * and the check here can never disagree — which is why BOTH branches read a missing cap the way
 * PromptEditor's `roomFor` reads it (no limit), not as a limit of zero that refuses every save.
 * @returns {{perSegment:(number|null)[]}|{whole:number|null}} `null` where the model has no cap
 *   (Seedance ships uncapped) — there is nothing to be over, so nothing to refuse.
 */
function budgetOf(view) {
  if (Array.isArray(view.segments)) {
    return { perSegment: view.segments.map((s) => (s.maxBytes == null ? null : Math.max(0, Number(s.maxBytes) - Number(s.pinBytes ?? 0)))) };
  }
  if (view.maxBytes == null) return { whole: null };
  return { whole: Math.max(0, Number(view.maxBytes) - Number(view.pinBytes ?? 0)) };
}

/**
 * Save one job's prompt override.
 *
 * The text is stored VERBATIM — no trimming, no truncation, no system pins. Over budget is a 400
 * carrying the numbers the meter shows, never a quiet clip: a user who cannot see what was cut
 * cannot fix it, and the bytes that would be lost are the ones they cared about most.
 *
 * @param {{jobId:string, prompt?:string, segments?:string[]}} edit
 * @returns {Promise<object|null>} the fresh PromptView, or null when the job is not in this plan
 */
export async function savePromptOverride({ root, envRoot, childEnv, runDir, spec, backend, voicesDir, jobId, prompt, segments }) {
  const composer = await createComposer({ root, envRoot, childEnv, runDir, spec, backend, voicesDir });
  const job = composer.jobs.find((j) => j?.job_id === jobId);
  if (!job) return null;
  const view = composer.viewFor(jobId);
  if (view?.error) throw Object.assign(new Error(`job "${jobId}" cannot be composed: ${view.error}`), { statusCode: 409, hint: 'fix the plan (or revise it) before editing this prompt' });

  const hasSegments = Array.isArray(segments);
  if (hasSegments && segments.some((s) => typeof s !== 'string')) throw badRequest('every entry of "segments" must be text', 'one entry per shot, in shot order');
  if (!hasSegments && typeof prompt !== 'string') throw badRequest('send "prompt" (the whole job) or "segments" (one per shot)', `job ${jobId} has ${job.shots?.length ?? 0} shot(s)`);
  const bodies = hasSegments ? segments : [prompt];
  if (!bodies.some((s) => String(s ?? '').trim())) throw badRequest('an empty prompt would send nothing', 'write the shot, or discard the edit to go back to the plan');

  const budget = budgetOf(view);
  if (budget.perSegment) {
    // Kling's cap is per segment, so an edit has to arrive per segment — a single blob could only be
    // guessed apart, and a wrong guess is a paid render of the wrong words.
    if (!hasSegments && (job.shots?.length ?? 0) > 1) {
      throw badRequest(`job ${jobId} renders ${job.shots.length} shots and Kling's byte cap is per shot`, 'send "segments": one entry per shot, in shot order');
    }
    if (hasSegments && segments.length !== view.segments.length) {
      throw badRequest(`expected ${view.segments.length} segment(s), got ${segments.length}`, 'one entry per shot, in shot order');
    }
    bodies.forEach((s, i) => {
      const cap = budget.perSegment[i];
      if (cap == null) return; // no cap on this segment ⇒ nothing to be over (the meter says the same)
      const bytes = utf8(s);
      if (bytes > cap) throw badRequest(`shot ${i + 1} is ${bytes} bytes; the room left for your words is ${cap} bytes (over by ${bytes - cap})`, 'trim it — nothing is truncated for you, because you would not see what went');
    });
  } else {
    if (hasSegments) throw badRequest(`job ${jobId} renders as ONE prompt on this model`, 'send "prompt" — the whole job in one document');
    const bytes = utf8(prompt);
    // A save may only be refused where a limit EXISTS. With none (`whole: null`) the words go
    // through untouched — refusing here would block an edit the renderer accepts word for word.
    if (budget.whole != null && bytes > budget.whole) throw badRequest(`the edit is ${bytes} bytes; the room left for your words is ${budget.whole} bytes (over by ${bytes - budget.whole})`, 'trim it — nothing is truncated for you, because you would not see what went');
  }

  writeOverrides(runDir, (next) => {
    next.jobs[jobId] = {
      ...(hasSegments ? { segments: [...segments] } : { prompt }),
      // The plan this edit was written against. A later mismatch is what raises the stale banner —
      // and only the banner: a stale override is still sent word for word.
      fingerprint: composer.fingerprintFor(jobId),
      updatedAt: new Date().toISOString(),
    };
    return next;
  });
  // Re-read through the ordinary path, so what the editor gets back is exactly what a reload gets.
  return buildPromptView({ root, envRoot, childEnv, runDir, spec, backend, voicesDir, jobId });
}

/**
 * Discard one job's override and go back to the agents' text.
 * @returns {Promise<object|null>} the restored PromptView, or null when the job is not in this plan
 */
export async function discardPromptOverride({ root, envRoot, childEnv, runDir, spec, backend, voicesDir, jobId }) {
  const planned = (spec?.kling?.jobs ?? []).some((j) => j?.job_id === jobId);
  // `Object.hasOwn`, never a bracket read — belt and braces over `jobMap`'s null prototype: on a
  // plain object `jobs['toString']` resolves to an INHERITED member and would answer "yes, there
  // was an edit" — a bogus 200, an SSE broadcast to every tab and a junk History row.
  const had = Object.hasOwn(readOverrides(runDir).jobs, jobId);
  // An orphaned override (its job is gone from the plan) is still discardable — that is the only way
  // the "1 edited prompt has no segment any more" row can be cleared.
  if (!planned && !had) return null;
  writeOverrides(runDir, (next) => { delete next.jobs[jobId]; return next; });
  if (!planned) return { jobId, source: 'plan', discarded: true };
  return buildPromptView({ root, envRoot, childEnv, runDir, spec, backend, voicesDir, jobId });
}

export default { buildPromptView, buildPromptViews, savePromptOverride, discardPromptOverride };
