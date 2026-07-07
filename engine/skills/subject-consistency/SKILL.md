# SKILL: subject-consistency

Keeping subjects/style identical across every shot and every job.

## How consistency works here
- Identity is pinned by **reference Elements** (images in `elements/references/`), NOT by prompt
  words. The same reference images feed every job, so the subject looks the same throughout.
- **Subject profiles** (`profiles/*.md`, when provided) describe each subject's personality, role,
  do/don'ts, and world — they steer the writing (tone, behaviour, setting), not the rendered look.

## Practical rules
- Choose 1–4 clean reference images per subject that show it clearly; avoid busy or ambiguous shots.
- Reuse the SAME element ids across jobs so identity doesn't drift between stitched segments.
- In prompts, never describe appearance (see the identity rule) — let the references do that job.
- Respect each subject's profile: keep behaviour and world on-model; don't contradict the bible.
- For continuity across a hard cut (e.g. job K2 should start where K1 ended), the Job Planner can
  seed a job's `first_frame` with a chosen frame image.
