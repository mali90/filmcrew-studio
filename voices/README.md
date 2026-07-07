# Character voices

Persistent fal Kling `voice_id`s — the **audio analog of the `@Element` reference images** in
`elements/`. You mint one **once** per character from a clean reference clip, then it is replayed on
every generation so the character sounds identical in video #1, #50 and #200.

This folder holds `voices.json`, a registry mapping a character name → its minted `voice_id`, plus
a kept copy of each character's reference clip. The registry is git-ignored (the ids are
account-specific) and is created automatically by `mint-voice`.

> **The clip itself now matters too**: the **Seedance** backend lip-syncs to the mint-time clip
> (`ref_clip`, sent as its `@Audio1` reference), not to the `voice_id` — so `mint-voice` keeps a
> copy here and the file must stay on disk. Keep clips **≤ 15s** for best results (longer ones are
> auto-trimmed at render time). Entries without a clip still work: Seedance then voices the line
> natively, and Kling is unaffected either way.

## Activate the bundled sample voice ("Wren")

The project ships a sample cast member, **Wren**, with a profile, reference images and a voice
**clip** (`voices/wren.mp3`) — but not a `voice_id`, because those are account-specific. To give
Wren a persistent voice on *your* fal account, mint it once (the clip is already on disk, so this
just registers it and mints your id):

```bash
npm run mint-voice -- "Wren" voices/wren.mp3
```

Until you do, Kling still voices Wren's lines natively and Seedance falls back to native audio.

## Mint a voice (once per character)

```bash
npm run mint-voice -- <name> path/to/<name>_reference.wav
```

- Replace `<name>` with your own character's name (e.g. `host`, `guest`, `narrator`).
- Clip: **5–30 s, single speaker, clean** (no music/SFX). `.mp3` / `.wav` / `.mp4` / `.mov`.
- Costs ≈ **$0.007**. Mint freely until the character sounds right.
- Writes `voices/voices.json`, keyed by character name.

## Use a voice in a spec

A character is one fal *element* = its reference image(s) **plus** its bound voice. Two fields tie
them together — and the image must show a **clear frontal face** (fal binds the voice to the
detected face):

```json
"kling": { "elements": [
  { "id": "<name>-front", "role": "subject", "image": "elements/references/<name>_front.png", "character": "<name>" }
] },
"audio": { "generate_audio": true, "voice": { "lines": [
  { "text": "this line is spoken in the character's own voice.", "shot_id": "S1", "speaker": "<name>" }
] } }
```

At render time the fal renderer groups that character's images into one element with its bound
`voice_id`, references it in each shot's prompt as **`@Element1`** (so the element's face *and* voice
are used), and lowercases the English speech (a real Kling input rule). A single-character short
needs no `character` field — every job image becomes `@Element1`, voiced by the job's sole `speaker`.
**Max 2 distinct voiced characters per job;** for three or more, split them across separate jobs.

> Used on every render via the reference-to-video endpoint (default `…/o3/…/reference-to-video`).
