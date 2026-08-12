# Prompts: what gets sent, and how to change it

Every clip is one **job**, and every job is one prompt. This page is about that prompt: what it is
made of, who wrote each part, how big it is allowed to be, and what happens when you edit it.

You can read any job's prompt in the app — `Prompt` on the plan card, on a job card, or on a clip in
the review strip — or from the API:

```
GET  /api/runs/:id/prompts             every job of the current plan
GET  /api/runs/:id/prompt?job=K2       one job
GET  /api/runs/:id/prompt?job=K2&take=t1   what take t1 actually sent, verbatim
PUT  /api/runs/:id/prompt              save an edit
DELETE /api/runs/:id/prompt?job=K2     go back to the agents' text
```

Reading spends nothing: no model is called and no render is queued. The preview is composed by the
**same pure builder the renderer uses** (`src/lib/prompt-compose.js`), from the same plan and the
same settings — an integration test composes a job independently and compares the buffers, because a
preview that differs from what is sent by a single byte is a lie.

---

## What a composed prompt is made of

Two kinds of text go into every prompt, and the difference is the thing worth understanding:

- **Your words** — the authored scene body for each shot (`spec.shots[].kling.content_prompt`).
  Written by the agents when they planned the film; yours the moment you edit them.
- **The system's share** — everything composed *around* your words at render time: the style
  directive, the identity clause naming which reference image is which character, the on-screen-text
  rule, the speech rule, framing and camera clauses, a director note on a re-render, and any
  **boundary frame pins**.

The system's share is re-composed on every render. It is never stored with your edit, and never
edited directly — see [what an override does not change](#what-an-override-does-not-change).

### Kling: one prompt per shot

A Kling job is a **storyboard** of up to 6 segments, one per shot, and each segment is composed as:

```
@Element1  Medium close-up, slight low angle.  <your scene body>  Marie says: "…"  Camera: slow push in.
└ lead ref └ framing (system) ────────────────┘└ yours ─────────┘└ speech (system)└ camera (system)
```

Each segment is capped **independently** (fal rejects a 512-byte segment; the builder trims at 500).
When a segment does not fit, the **scene body** is trimmed and the spoken line is protected — the
words a character says are never cut mid-sentence to make room for camera prose. If even that is not
enough, framing and camera are dropped so the dialogue survives.

### Seedance: one rich prompt per job

A Seedance job is **one document** covering every shot, opening with front matter and then the shots
themselves — chained with connectors ("Cut to:", "Match cut to:") on 2.0, numbered `Shot 1:`,
`Shot 2:` on 2.5:

```
<style>  <identity clause>  <avoid>  <text rule>  <speech rule>  [director note]  [seam pins]
[voice-reference sentences]

Shot 1: Wide, eye level. <your scene body> Camera: slow pan. Marie says: "…" (tone: wry).
Shot 2: …
```

The whole document is sent as written — there is no per-shot budget on Seedance, and no whole-prompt
one either unless you set `SEEDANCE_PROMPT_MAX_BYTES` yourself.

---

## Byte budgets, per model

Budgets are counted in **UTF-8 bytes, not characters** — an em dash costs 3 and an emoji 4. Counting
characters is exactly how a 480-character edit sails past a 500-byte cap and dies at the provider
instead of on screen.

| Backend | Budget | Counted over | Knob |
|---|---|---|---|
| `kling-o3@fal` | **500 B per shot segment** (≤6 segments per job) | each segment separately | `KLING_SEGMENT_MAX_BYTES` |
| `seedance-2.0@fal` · `@segmind` | **none** | the whole job prompt | `SEEDANCE_PROMPT_MAX_BYTES` |
| `seedance-2.5@fal` · `@segmind` | **none** | the whole job prompt | `SEEDANCE_PROMPT_MAX_BYTES` |

Seedance ships **uncapped**: no provider documents a prompt-length limit for these models (Segmind's
2.0/2.5 API pages state none), so a long multi-shot prompt reaches the model whole. ByteDance, the
model's owner, *recommends* keeping a prompt under about 1000 words — that is quality guidance about
what the model attends to, not an API limit, and the pipeline does not enforce it. Set
`SEEDANCE_PROMPT_MAX_BYTES` to a number if a provider ever answers 422 on prompt length; unset, empty
and `0` all mean uncapped. Kling's per-segment cap is the opposite kind of number: fal's Kling o3
schema really rejects a 512-byte segment, so it is enforced.

The meter you edit against is **not** the raw cap. It is:

```
room for your words  =  maxBytes − pinBytes
```

where `pinBytes` is what the system's share already owns in that job — front matter, guards, framing,
speech clauses, frame pins. The server measures it with the same composer the render uses
(`pinBytesOf`), so the number in the editor and the number the render enforces cannot disagree. On
Kling you get one meter per shot, because the cap is per shot; on Seedance, one for the job.

Where there is no cap, there is no denominator: the meter shows the byte **count** alone and Save
never refuses on length. An editor that invented a limit would be the cap again, wearing a meter.

**Nothing is ever truncated for you when you edit.** Over budget, every byte you typed stays in the
box, Save refuses, and the message says by how much. Text cut behind your back is text you cannot
fix. (The *agents'* text is a different matter: the builder does trim an over-long planned segment to
fit, which is why an untouched prompt can already show as over budget — trimming it yourself is how
you choose what goes.)

---

## Where the pins come from

A **pin** is a boundary frame: the neighbouring clip's frame this segment must start on, or arrive
at. Pins are how a multi-job film stops looking like a slideshow, and they reach the model in one of
two ways depending on the backend:

- **native** — the frame goes in the model's own first/last-frame input. Only this may be called
  *seamless*.
- **soft** — the frame rides as an extra reference image, plus a sentence in the prompt pinning it:
  *"Use @Image3 as the literal first frame of this clip and continue its motion seamlessly forward."*
  That sentence is part of the system's share, and it costs bytes — which is why the meter's
  denominator moves when a segment gains a pin.

Which one you get is decided once, in `src/lib/seam-rule.js`, from the backend's declared caps and
its reference budget — never guessed per surface. A soft pin needs a free image slot, and at a full
cast it does not get one: `SEAM_PRIORITY` gives up the closing pin, then the opening one, before it
gives up a single identity reference, and the sheet reports that end as a cut before you pay. fal's Seedance endpoints have no frame anchor at all and are therefore *always*
soft; Segmind's native slots exclude reference images, so a segment with cast references keeps the
cast and soft-pins the frame; Kling anchors the opening frame natively and treats the closing frame
as best-effort. The full matrix is in [PROVIDERS.md](PROVIDERS.md#seam-modes-how-a-boundary-frame-is-actually-applied).

A soft pin cites a reference **label** (`@Image3`) that only exists once a particular render has laid
its references out. That is why a pin sentence is never stored in a saved edit: a stored `@Image3`
would eventually point at a different image in a future take.

Where the frames themselves come from:

- inside a full render, each job is chained to the previous clip's closing still;
- on a re-render, from whichever neighbours you chose (`boundaries: auto | both | start | end | none`);
- by hand, with `--first-frame-from` / `--last-frame-from` on `npm run render` and `npm run render-job`
  — point either at a PNG to use it as-is, or at a **clip** to have the right end grabbed for you.

---

## Editing a prompt

`Edit prompt` opens **your words** — the authored scene body — not the composed prompt. Editing the
composed text would mean re-composing the style directive and the frame pins over themselves, and
sending them twice.

Saving writes `<runDir>/prompt-overrides.json`:

```jsonc
{
  "schema": 1,
  "jobs": {
    "K2": {
      "segments": ["…your words for shot 1…", "…shot 2…"],  // or "prompt" on Seedance
      "fingerprint": "…",          // the plan this edit was written against
      "updatedAt": "2026-08-09T…"
    }
  }
}
```

It lives at the **run root**, not in a take directory, for two reasons: a revise rewrites
`spec.json` underneath it, and a take directory is immutable. An edit has to outlive both. When a
render starts, the sidecar is **snapshotted into the take** it reserves and passed to the CLI with
`--prompt-overrides`, so a past take can answer "what did we send, and whose words were they?" from
its own directory (`takes[].promptSource`, and `prompt_source` in that take's `prompts.json`).

Saving is genuinely free: one local file write. Nothing is submitted and nothing is billed — and
nothing changes on screen until you re-render that segment, which does cost money.

### What an override does *not* change

- **The system's share.** Style, identity clause, text and speech rules, framing/camera clauses and
  frame pins are re-composed on top of your words at render time, from that render's own settings.
- **Which shots exist, or how long they are.** An override is text, not structure. Changing the cut
  is what revise and re-render are for.
- **What the agents wrote.** The plan is untouched; `DELETE …/prompt?job=K2` restores the agents'
  text byte-for-byte, and the sheet offers it side by side while an edit is saved.

### When the plan moves underneath an edit

A revise rewrites the plan while your edit stands. Nothing is silently resolved:

- your edit is **still what gets sent, word for word** — that is stated first, before anything else;
- the view marks itself `stale` and offers `Refresh from plan` (loads the new text into the editor,
  **unsaved**, so you decide) or `Discard edit` (confirmed first);
- an edit whose shot the agents re-cut away is **kept and reported** as orphaned, with its text and a
  copy button, rather than dropped.

---

## Reading what a past take sent

`?take=t1` serves that take's `prompts.json` **verbatim** — the exact text that went out, when, and
to which provider that take recorded at the time. It is never recomposed, because the settings may
have moved since; for the same reason it carries no byte budget (quoting today's cap as if it were
that take's would be a guess).

Past takes are read-only. The version picker only offers takes that really kept a sidecar — a take
that failed before this job, or one made before sidecars existed, has nothing honest to show.

---

## Try it without spending anything

```bash
npm --prefix web/server run demo
```

The zero-spend demo boots with a seeded run whose cut has one whole join and one broken one. Open the
URL it prints, pick a clip in the strip, and `Prompt` shows exactly what would be sent, metered in
bytes. Edit it, save it, and the clip wears a pen. Nothing in that loop reaches a provider.
