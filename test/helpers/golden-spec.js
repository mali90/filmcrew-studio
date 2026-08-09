// The WS2-P0 GOLDEN SPEC and the case matrix that freezes today's prompt bytes.
//
// Why this exists: P0 lifts the prompt logic out of src/lib/kling.js and src/lib/seedance.js into
// pure, config-free modules (prompt-compose.js / prompt-settings.js). That refactor is only safe if
// it is provably BYTE-IDENTICAL — a single moved character changes what fal/Segmind renders and
// what the user is billed for. So: one deterministic spec that walks every branch of both builders,
// one case matrix over every option they take, and one checked-in fixture of the exact output.
//
// Everything here derives from examples/ocean-lighthouse/spec.json — the bundled, NON-PROPRIETARY
// sample. Nothing under profiles/, elements/references/, voices/ or runs/ may ever be referenced.
//
// Regenerate the fixture (deliberate prompt changes only — never to "fix" a red gate):
//     node test/helpers/golden-spec.js --write
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadGoldenSpec } from './fixtures.js';
import { neutralizeDotenv } from './env.js';

export const FIXTURE_PATH = path.join(ROOT, 'test/fixtures/prompt-golden.json');

/**
 * Pin every config value that feeds the two builders, so a developer's shell or .env can never move
 * the golden. MUST be called BEFORE `await import('../../src/lib/kling.js')` — config.js snapshots
 * process.env at import time.
 *
 * Not pinned because they are not env-tunable (hard model caps in config.js): kling.maxStoryboards
 * (6) and kling.maxJobSeconds (15). If either ever becomes an env knob, pin it here too.
 */
export function pinPromptEnv() {
  neutralizeDotenv();
  Object.assign(process.env, {
    LOG_LEVEL: 'error',
    // kling.js reads: segmentMaxBytes, defaultShotSeconds, nativeAudio (+ model/aspect/resolution
    // for klingConfigFor, pinned so the settings half of P0 is covered too).
    KLING_SEGMENT_MAX_BYTES: '500',
    KLING_DEFAULT_SHOT_SECONDS: '5',
    KLING_GENERATE_AUDIO: 'true',
    KLING_MODEL: 'kling-v3-omni',
    KLING_ASPECT: '9:16',
    KLING_RESOLUTION: '1080p',
    // seedance.js reads: promptMaxBytes, generateAudio (+ style/avoid/textRule, which must stay
    // EMPTY so the builder's own defaults are what the fixture pins).
    SEEDANCE_PROMPT_MAX_BYTES: '5000',
    SEEDANCE_GENERATE_AUDIO: 'true',
    SEEDANCE_STYLE: '',
    SEEDANCE_AVOID: '',
    SEEDANCE_TEXT_RULE: '',
    SEEDANCE_RESOLUTION: '480p',
    SEEDANCE25_RESOLUTION: '720p',
  });
}

// ── The spec ────────────────────────────────────────────────────────────────────────────────────
// Ocean Lighthouse's three shots, plus three more that exist ONLY to walk the byte-trim branches.

/** ~740 ASCII bytes: forces buildKlingStoryboard's trimToBytes + "..." path on a short-line shot. */
const LONG_SCENE = ('The keeper crosses the gallery deck against a rising gale, one hand on the rail, '
  + 'salt spray sheeting off the glass while the lamp turns behind him and the horizon goes white. ').repeat(4).trim();

/** ASCII padding then repeated multi-byte glyphs, so a 2- and a 4-byte code point straddle the
 *  segment budget's trim boundary (é = 2 bytes, — = 3, 🌊 = 4). The trim must never split one. */
const MULTIBYTE_SCENE = `${'Rain hammers the lamp room glass. '.repeat(9)}${'café—naïve—œuvre 🌊 '.repeat(12)}`.trim();

/** ~620 bytes of plain ASCII speech: the LINE alone blows the 500-byte cap, forcing the re-quote
 *  fallback (drop framing/camera, clip the quoted text, re-close the quote). */
const LONG_LINE = ('We ran the lamp by hand every single night, in every weather the Atlantic could think of, '
  + 'and not one ship went onto those rocks while I stood the watch, not one, ').repeat(3).trim();

/**
 * The golden spec: 6 shots across 3 jobs, deep-cloned per call so a case may mutate it freely.
 *
 * Branch coverage, shot by shot:
 *   S1  beat:'hook' + the episode's first shot  → Seedance HOOK_PREFIX; a shot_id-matched line
 *   S2  no line of its own                      → picks up the at_s-only line via lineForShot's window
 *   S3  no line at all                          → Kling's "No dialogue in this shot" directive
 *   S4  ~740B scene prose + a short line        → trimToBytes + "..." (Kling), untouched (Seedance)
 *   S5  multi-byte scene prose, no line         → trim boundary lands on é / — / 🌊
 *   S6  short scene prose + a ~620B line        → Kling's re-quote fallback
 *
 * Jobs: K1 = S1,S2,S3 (13s) · K2 = S4,S5 (9s) · K3 = S6 (4s) — all inside Kling's 6-segment/15s caps.
 */
export function goldenSpec() {
  const spec = loadGoldenSpec();

  spec.project.title = 'Prompt Golden';
  spec.project.cast = ['the lighthouse keeper', 'the gull'];

  spec.shots.push(
    {
      shot_id: 'S4',
      beat: 'turn',
      duration_s: 5,
      description: 'The keeper crosses the gallery deck in a gale.',
      kling: {
        content_prompt: LONG_SCENE,
        shot_size: 'medium',
        perspective: 'handheld eye level',
        camera_move: 'slow arc to the left',
      },
    },
    {
      shot_id: 'S5',
      beat: 'turn',
      duration_s: 4,
      description: 'Rain on the lamp room glass.',
      kling: {
        content_prompt: MULTIBYTE_SCENE,
        shot_size: 'close_up',
        // Deliberately blank: covers the size-only framing lead and the empty-camera branch in both
        // builders (Kling's `tail`, Seedance's `cameraClause`).
        perspective: '',
        camera_move: '',
      },
    },
    {
      shot_id: 'S6',
      beat: 'payoff',
      duration_s: 4,
      description: 'The keeper talks to the gull on the rail.',
      kling: {
        content_prompt: 'The keeper leans on the rail beside a grey gull, both looking out at the flat morning sea.',
        shot_size: 'medium_wide',
        perspective: 'low angle',
        // Present so the re-quote fallback is seen DROPPING both the framing lead and the camera
        // clause, not merely omitting a clause that was empty anyway.
        camera_move: 'static lock-off',
      },
    },
  );

  // Two speakers → the multi-name identityClause and per-speaker voice notes on the Seedance side,
  // and speaker→@ElementN token mapping on the Kling side.
  spec.audio.voice.lines = [
    { shot_id: 'S1', text: 'Forty years I kept this light.', speaker: 'keeper' },
    { text: 'The light stays on.', at_s: 6, speaker: 'gull' }, // at_s-only → lineForShot's window path (S2)
    { shot_id: 'S4', text: 'Every night, in every weather.', speaker: 'keeper', tone: 'weary' },
    { shot_id: 'S6', text: LONG_LINE, speaker: 'gull' },
  ];

  // A non-default transition type after S1 and after S4 (the connectors path); S2→S3 falls through
  // to the default "Cut to:".
  spec.assembly = { transitions: [{ after_shot: 'S1', type: 'match_cut' }, { after_shot: 'S4', type: 'whip' }] };

  spec.kling.jobs = [
    { job_id: 'K1', shots: ['S1', 'S2', 'S3'], elements: ['subject'] },
    { job_id: 'K2', shots: ['S4', 'S5'], elements: ['subject'] },
    { job_id: 'K3', shots: ['S6'], elements: ['subject'] },
  ];
  return spec;
}

/** The same spec with native audio OFF (drops every dialogue clause, speaker list and voice note). */
export function goldenSpecAudioOff() {
  const spec = goldenSpec();
  spec.kling.generate_audio = false;
  return spec;
}

// ── Reference-label styles ──────────────────────────────────────────────────────────────────────
// The builders never invent a label — the renderer hands them in (refLabel(caps, …)). Running the
// matrix over all three styles proves the builders stay label-agnostic, which is what lets one pure
// composer serve Kling, fal Seedance 2.0/2.5 and Segmind Seedance without a fork.
export const REF_STYLES = {
  compact: (kind, n) => `@${kind}${n}`,
  spaced: (kind, n) => `@${kind} ${n}`,
  bracket: (kind, n) => `[${kind}${n}]`,
};

const refGroupsFor = (style) => {
  const L = REF_STYLES[style];
  return [
    { name: 'keeper', refs: [L('Image', 1), L('Image', 2)] },
    { name: 'gull', refs: [L('Image', 3)] },
  ];
};

const audioRefForStyle = (style) => {
  const L = REF_STYLES[style];
  const map = { keeper: L('Audio', 1), gull: L('Audio', 2) };
  return (sp) => map[sp] ?? null;
};

const voiceTokenForStyle = (style) => {
  const L = REF_STYLES[style];
  const map = { keeper: L('Element', 1), gull: L('Element', 2) };
  return (sp) => map[sp] ?? '';
};

// ── The case matrix ─────────────────────────────────────────────────────────────────────────────
// Each case is pure DATA (no closures) so the fixture writer and the test build identical inputs.

/** @typedef {{name:string, builder:'kling'|'seedance', jobId:string, audioOff?:boolean, opts:object}} GoldenCase */

/** @returns {GoldenCase[]} every case, in a stable order (the fixture is keyed by `name`). */
export function goldenCases() {
  /** @type {GoldenCase[]} */
  const cases = [];

  // ── Kling ────────────────────────────────────────────────────────────────
  // bare defaults: no lead ref, no lowercasing, no voice tokens
  cases.push({ name: 'kling/K1/bare', builder: 'kling', jobId: 'K1', opts: {} });
  // the shipping fal shape
  for (const jobId of ['K1', 'K2', 'K3']) {
    cases.push({
      name: `kling/${jobId}/fal-compact`,
      builder: 'kling',
      jobId,
      opts: { lowercaseSpeech: true, leadRef: '@Element1', refStyle: 'compact' },
    });
  }
  // a non-@ElementN label set proves the 500B budget math is computed from the ACTUAL label bytes
  cases.push({
    name: 'kling/K2/fal-bracket',
    builder: 'kling',
    jobId: 'K2',
    opts: { lowercaseSpeech: true, leadRef: '[Element1]', refStyle: 'bracket' },
  });
  // text-to-video: no lead ref and no voice token → "The character says:"
  cases.push({ name: 'kling/K3/text-to-video', builder: 'kling', jobId: 'K3', opts: { lowercaseSpeech: true } });
  // audio off: neither a dialogue nor a no-dialogue directive anywhere
  cases.push({
    name: 'kling/K1/audio-off',
    builder: 'kling',
    jobId: 'K1',
    audioOff: true,
    opts: { lowercaseSpeech: true, leadRef: '@Element1', refStyle: 'compact' },
  });

  // ── Seedance: the full option matrix ─────────────────────────────────────
  for (const refStyle of ['compact', 'spaced', 'bracket']) {
    for (const shotSyntax of ['connectors', 'numbered']) {
      cases.push({
        name: `seedance/K1/${refStyle}/${shotSyntax}/plain`,
        builder: 'seedance',
        jobId: 'K1',
        opts: { refStyle, shotSyntax, nonce: 0, feedback: '' },
      });
      cases.push({
        name: `seedance/K1/${refStyle}/${shotSyntax}/pinned-take2-note`,
        builder: 'seedance',
        jobId: 'K1',
        opts: {
          refStyle,
          shotSyntax,
          startFrameRefIndex: 4, // → the style's Image-4 label, i.e. the demoted seam frame
          nonce: 2,
          feedback: 'hold the lamp room wider and keep the lens in frame',
        },
      });
    }
  }
  // authored transitions (whip after S4) and the byte-trim shots
  cases.push({ name: 'seedance/K2/compact/connectors/plain', builder: 'seedance', jobId: 'K2', opts: { refStyle: 'compact', shotSyntax: 'connectors' } });
  cases.push({ name: 'seedance/K3/compact/numbered/plain', builder: 'seedance', jobId: 'K3', opts: { refStyle: 'compact', shotSyntax: 'numbered' } });
  // audio off
  cases.push({ name: 'seedance/K1/compact/connectors/audio-off', builder: 'seedance', jobId: 'K1', audioOff: true, opts: { refStyle: 'compact', shotSyntax: 'connectors' } });
  // the front-matter clauses (style / avoid / custom text rule)
  cases.push({
    name: 'seedance/K1/compact/connectors/clauses',
    builder: 'seedance',
    jobId: 'K1',
    opts: {
      refStyle: 'compact',
      shotSyntax: 'connectors',
      style: 'Rendered in hand-painted watercolor with visible paper grain.',
      avoidClause: 'The keeper never wears a hat.',
      textClause: 'Only the word "FIN" may appear on screen.',
    },
  });
  // the whole-prompt byte clamp: front matter survives, the tail yields, no split code point
  cases.push({
    name: 'seedance/K2/compact/connectors/clamped-900',
    builder: 'seedance',
    jobId: 'K2',
    opts: { refStyle: 'compact', shotSyntax: 'connectors', maxBytes: 900 },
  });
  // no cast refs at all (text-to-video): no identity clause, no @Audio notes
  cases.push({ name: 'seedance/K1/none/connectors/text-to-video', builder: 'seedance', jobId: 'K1', opts: { refStyle: null, shotSyntax: 'connectors' } });

  return cases;
}

/** Materialize a case's builder options (closures included) — shared by the writer and the test. */
export function optsFor(c) {
  const o = { ...c.opts };
  const style = o.refStyle;
  delete o.refStyle;
  delete o.startFrameRefIndex;

  if (c.builder === 'kling') {
    return { ...o, voiceTokenFor: style ? voiceTokenForStyle(style) : null };
  }
  if (!style) return { ...o, refGroups: [], audioRefFor: null, startFrameRef: null };
  const L = REF_STYLES[style];
  return {
    ...o,
    refGroups: refGroupsFor(style),
    audioRefFor: audioRefForStyle(style),
    startFrameRef: c.opts.startFrameRefIndex ? L('Image', c.opts.startFrameRefIndex) : null,
  };
}

/**
 * Run one case against the builders and return a JSON-serializable record.
 * @param {GoldenCase} c
 * @param {{buildKlingStoryboard:Function, buildSeedanceJobPrompt:Function}} builders
 */
export function runCase(c, { buildKlingStoryboard, buildSeedanceJobPrompt }) {
  const spec = c.audioOff ? goldenSpecAudioOff() : goldenSpec();
  const job = spec.kling.jobs.find((j) => j.job_id === c.jobId);
  if (!job) throw new Error(`golden case "${c.name}": no job ${c.jobId} in the golden spec`);
  const opts = optsFor(c);

  if (c.builder === 'kling') {
    const { segments, totalDuration } = buildKlingStoryboard(job, spec, opts);
    return {
      totalDuration,
      segments: segments.map((s) => ({
        prompt: s.prompt,
        duration: s.duration,
        speaker: s.speaker,
        bytes: Buffer.byteLength(s.prompt, 'utf8'),
      })),
    };
  }
  const { prompt, shotPrompts, totalDuration, speakers } = buildSeedanceJobPrompt(job, spec, opts);
  return {
    prompt,
    promptBytes: Buffer.byteLength(prompt, 'utf8'),
    shotPrompts,
    shotPromptBytes: shotPrompts.map((s) => Buffer.byteLength(s, 'utf8')),
    totalDuration,
    speakers,
  };
}

/** Build the whole fixture object (case name → record). */
export function buildFixture(builders) {
  const out = {};
  for (const c of goldenCases()) out[c.name] = runCase(c, builders);
  return out;
}

/** Read the checked-in fixture. Throws a pointed message when it is missing. */
export function readFixture() {
  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(`missing ${path.relative(ROOT, FIXTURE_PATH)} — generate it with: node test/helpers/golden-spec.js --write`);
  }
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

// ── `--write` regeneration hook (the TEST never writes) ─────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--write')) {
    console.error('usage: node test/helpers/golden-spec.js --write   # regenerate test/fixtures/prompt-golden.json');
    process.exit(2);
  }
  pinPromptEnv();
  const kling = await import('../../src/lib/kling.js');
  const seedance = await import('../../src/lib/seedance.js');
  const fixture = buildFixture({
    buildKlingStoryboard: kling.buildKlingStoryboard,
    buildSeedanceJobPrompt: seedance.buildSeedanceJobPrompt,
  });
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  console.error(`wrote ${path.relative(ROOT, FIXTURE_PATH)} — ${Object.keys(fixture).length} case(s)`);
}
