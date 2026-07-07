# SKILL: kling-storyboard (writing segments for Kling 3.0 Omni)

Kling Omni renders a SEQUENCE of storyboard segments in one generation, with subjects/style pinned
by reference images (Elements). You write one `content_prompt` per shot.

## The identity rule (non-negotiable)
**Never put a subject's appearance into a prompt** — no hair, face, skin, outfit, colors, logos, or
exact shape. Identity travels as **pixels** (the reference Elements), not as text; describing it
fights the reference and causes drift. Refer to the subject by role or name only ("the mascot",
"the host", "the product", "Mara"). A neutral, feature-free stability phrase is fine
("consistent design, stable identity").

## A good content_prompt (≤512 chars)
Cover, in plain cinematic language:
1. **Setting** — where we are, time of day, atmosphere.
2. **Action** — what the subject is doing, in one beat.
3. **Mood / lighting** — e.g. "warm golden-hour side light", "cold overcast".
4. (Framing and camera move are added separately by the Cinematographer — don't repeat them here.)

Keep it one coherent moment. Maintain place/prop continuity with neighbouring shots so the cut feels
like one scene. Trim ruthlessly to stay under 512 characters.

## Caps (hard limits, per generation/job)
- ≤6 storyboard segments (shots) per job
- ≤15 seconds total per job
- ≤512 characters per segment
- ≤7 reference images per job

## Dialogue (don't write it in content_prompt)
Spoken lines live in `audio.voice.lines[]` (set by the Sound agent), keyed by `shot_id` — never in
`content_prompt`. When `generate_audio` is on, the renderer folds a shot's line into its segment so
Kling **speaks it natively** (lip-synced); make the speaking visible in the **action** ("leans in and
speaks to camera"), don't write the words. On the fal transport, a line's `speaker` (matched to a
registered voice) makes that character speak in its persistent minted voice.

## Multi-shot vs single-shot
- **Multi-shot** (default): several shots cut together inside one generation — tight, continuous.
- **Single-shot**: one shot per generation — use for one sustained continuous take. Either way, a
  video longer than 15s (or more than 6 shots) is split across multiple jobs and stitched in order.

## The same spec also renders on Seedance 2.0
Everything above is written for Kling, but the spec is backend-neutral and the Seedance backend
consumes the very same blocks: identity still travels as reference pixels (flat `@ImageN` refs
instead of Elements), dialogue still lives in `audio.voice.lines[]` (lip-synced to the character's
minted ref clip instead of a bound voice_id), and each job becomes ONE rich multi-shot prompt (no
per-segment 512-char squeeze). The caps taught here are the safe intersection of both backends —
the only extra Seedance rule is the job planner's 4-second minimum per job.
