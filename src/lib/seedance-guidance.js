// Seedance 2.0 prompt-writing guidance (from https://fal.ai/learn/tools/how-to-use-seedance-2-0),
// condensed for the LLM planner. Kept in its OWN dependency-free module (NO config import) so the web
// server can import it statically without eagerly snapshotting config — the demo/e2e server sets
// FAL_BASE_URL after its static import chain, so a stray eager config load would point validators at
// the real fal.ai. Applied on the text-to-video path only (engine planning for a guaranteed-t2v render,
// and the content-policy "Revise" flow).
export const SEEDANCE_TTV_GUIDANCE = [
  'Write each shot as a director\'s shot description, NOT a keyword/tag list:',
  '- Lead with the subject and ONE clear action — say what moves and how it moves.',
  '- Then ONE camera move using a recognized term (dolly, rack focus, tracking shot, handheld, POV, aerial).',
  '- Then a CONCRETE sound cue (e.g. "the crack of thunder", "rain hitting a tin roof") so the audio has something to render.',
  '- One primary action and one camera move per shot — do not overload a shot.',
  '- Keep it to 2–4 plain sentences. NO comma-separated keyword/tag lists and no "cinematic, 4K, beautiful lighting" filler (it gives the model nothing to animate).',
].join('\n');
