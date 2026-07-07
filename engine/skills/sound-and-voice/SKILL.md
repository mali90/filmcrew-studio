# SKILL: sound-and-voice

## 1. Native Kling audio (`audio.generate_audio`)
- When `true`, Kling generates synchronized audio for each clip: ambience, SFX, and lip-synced
  speech when a character is visibly talking.
- Cheap and well-synced. Good default for most shorts.

## 2. Scripted dialogue (`audio.voice.lines`)
- Scripted lines the characters actually speak. When `generate_audio` is on, the renderer folds each
  line into its shot's prompt so Kling **speaks it natively** (lip-synced) — no separate dub pass.
- Each line: `{ text, shot_id (or at_s), speaker? }`. **One line per shot, ≤ ~2.5 words per second** of the shot's duration (a 3s shot ≈ 7 words) so the speech isn't crammed and garbled. Plain speakable text only — ASCII punctuation (no em-dashes/curly quotes), no emoji, ALL-CAPS, stage directions, or the speaker's name inside `text`.
- **To fix garbled dialogue, REWRITE lines shorter/plainer — never delete them.** A shot that still shows the character talking but has no line makes the renderer invent garbled pseudo-speech; to go wordless, the visuals must also stop showing speech.

## 3. Persistent character voices (`speaker`) — fal transport
- Set a line's `speaker` to a name from the context's "Registered character voices" list. On the fal
  transport the renderer binds that character's persistent minted `voice_id`, so the character sounds
  identical across every video (the audio analog of the Elements reference images).
- At most **2 distinct speakers per job**. Three+ talking characters → split into separate jobs.

## Choosing
- Pure visual / SFX short → `generate_audio: true`, no `voice`.
- Narrated explainer / spoken dialogue → `generate_audio: true` (ambience) + `voice.lines` (the script).
  If the dialogue must not clash with other on-screen talking, keep the rest of the footage wordless.
- Silent-by-design → `generate_audio: false`, no `voice`.

Never reference real songs/artists; keep audio brand-safe.
