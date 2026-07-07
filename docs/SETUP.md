# Manual setup & everyday use

The fastest way to set up is `npm run init` (see the [README](../README.md)) — it detects your
system, guides account/key setup, validates keys live, and writes `.env` for you. This document is
the **manual walkthrough** for people who prefer to do it by hand, or who need to troubleshoot.

Provider/key specifics live in [PROVIDERS.md](PROVIDERS.md); limits and cost in [COST.md](COST.md).

> This guide assumes you have never opened a terminal before.
>
> **Open a terminal:** macOS — Applications → Utilities → **Terminal** (or Cmd-Space, type `Terminal`).
> Windows — Start → type **PowerShell** → Enter. To run a command, paste it and press Return/Enter.

---

## Step 1 — Install the prerequisites

### 1a. Node.js (version 20 or newer; **22+** if you'll use GitHub Copilot)

Installing Node also installs **npm**.

- **macOS:** download the **LTS** `.pkg` from https://nodejs.org/en/download and run it
  (Continue → Agree → Install). *(Homebrew users: `brew install node`.)*
- **Windows:** download the **LTS** `.msi` and click through, keeping "Add to PATH".
  *(Or PowerShell: `winget install OpenJS.NodeJS.LTS`.)*

Check (reopen the terminal first if you just installed):
```
node -v
npm -v
```
✅ Each prints a version; `node -v` is **v20+** (v22+ for Copilot).

### 1b. ffmpeg (includes ffprobe)

- **macOS (Homebrew):** if you don't have Homebrew, run
  `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`,
  then `brew install ffmpeg`.
  *(No Homebrew? Download a static build via https://ffmpeg.org/download.html — e.g.
  https://evermeet.cx/ffmpeg/ — and put `ffmpeg`/`ffprobe` on your PATH, e.g. `/usr/local/bin`.)*
- **Windows (winget):** `winget install -e --id Gyan.FFmpeg`, then **close and reopen** PowerShell.
  *(No winget? Get "ffmpeg-release-full" from https://www.gyan.dev/ffmpeg/builds/, unzip, add its
  `bin` folder to your PATH.)*

Check (in a **new** terminal):
```
ffmpeg -version
ffprobe -version
```
✅ Both print version info. "command not found" / "not recognized" → reopen the terminal (PATH hasn't
updated yet).

---

## Step 2 — Get the project

- **Download ZIP:** on the project's GitHub page click green **Code → Download ZIP**, then unzip
  (macOS: double-click; Windows: right-click → Extract All). Move the folder somewhere easy, like
  Documents.
- **git:** `git clone https://github.com/mali90/filmcrew-studio.git`

**Open a terminal inside that folder** (the step most beginners miss):
- **macOS:** type `cd ` (with a space), drag the project folder from Finder into the Terminal window,
  press Return. *(Or right-click the folder → Services → New Terminal at Folder, if enabled.)*
- **Windows:** open the folder in File Explorer, click the address bar, type `powershell`, Enter.
  *(Or right-click inside the folder → Open in Terminal.)*

✅ `ls` (macOS) / `dir` (Windows) lists `package.json`, `config.js`, `.env.example`, and folders like
`elements` and `examples`. Keep this terminal open.

---

## Step 3 — Install dependencies

```
npm install
```
Downloads the one helper library (`dotenv`). ✅ Finishes with no red `ERR!` lines and a `node_modules`
folder appears. (Yellow `warn` notes are harmless.) When it finishes it prints a reminder to run
`npm run init`.

---

## Step 4 — Keys and settings (`.env`)

The tool reads your keys and choices from a text file named `.env`. The easiest path is
**`npm run init`**, which writes it for you. To do it by hand:

1. Copy the template: `cp .env.example .env` (Windows: `Copy-Item .env.example .env`).
2. Open it: macOS `open -e .env` (TextEdit; Format → Make Plain Text) · Windows `notepad .env` ·
   or `code .env`.
3. Fill in your keys — see **[PROVIDERS.md](PROVIDERS.md)** for exactly which accounts to create, the
   key URLs, and every `.env` line (render backend, LLM provider, voices, optional overrides).
   Remember: value right after `=`, no spaces, no quotes, no `<placeholder>` brackets, no trailing
   spaces. **Save** the file.

---

## Step 5 — Health check

```
npm run doctor
```
Checks Node, ffmpeg/ffprobe, your `.env` keys, and your chosen provider. ✅ Every line passes. ❌ A
failing line names exactly what's missing — fix it and re-run. See [Troubleshooting](#troubleshooting).

---

## Step 6 — Make your first video

The bundled example ships with its reference image at `elements/references/subject.png` — nothing to
add.

**Render the example:** the bundled example plans as a single ~13s job, so it renders whole — at the
economical default resolution this doubles as the cheap way to confirm keys/credits. (`--` separates
npm's options from the tool's — always include it.)
```
npm run render -- --spec examples/ocean-lighthouse/spec.json
```
✅ Writes `out/ocean-lighthouse.mp4`. Open the project folder in Finder/File Explorer → `out/` →
double-click the `.mp4`. 🎬

**Your own idea, start to finish** (plans *and* renders):
```
npm run engine -- --brief "a lighthouse keeper watches a storm roll in over the ocean at dusk" --render
```
Replace the quoted text with your idea. `--render` actually makes the video. On a long video that
plans into several render jobs, add `--probe` to render only the first job as a cheap test (a short
single-job video has no probe — it renders whole either way).

---

## Everyday use

All commands run from a terminal inside the project folder. Note the **double dash** `--` before flags.

**Plan + render from one line:**
```
npm run engine -- --brief "your idea here" --render
```
- `--brief "text"` (or `--brief-file path.txt`) — your idea.
- `--render` — actually generate (omit to only write the plan/spec).
- `--probe` — multi-job plans only: render just the first job, no stitch (a single-job plan
  renders fully, with a warning that `--probe` was ignored).
- `--upscale` — also upscale (extra cost).
- `--out runs/NAME` — where working files go.
- `--duration N` — target length in seconds.

**Render an existing plan:** `npm run render -- --spec runs/<id>/spec.json`
*(also accepts `--upscale`, and — on multi-job specs — `--probe`).*

**Voiced video on fal (consistent character + voice):**
```
npm run mint-voice -- <name> path/to/<name>_reference.wav        # once per character
npm run engine -- --brief "your idea featuring <name>" --render
```
See [PROVIDERS.md](PROVIDERS.md#character-voices) and
[../voices/README.md](../voices/README.md).

**Finish a prior run without re-rendering (no cost):**
```
npm run assemble -- --from runs/<run-id>
```
Stitches already-generated clips into `out/<title>.mp4` — the main use is promoting a `--probe` take
you liked (a probe prints the exact `--from` path). Add `--upscale` for higher quality (that step does
cost). A probe renders only the first of a plan's several jobs, so the stitched result covers just
that first job.

**Upscale a finished video:**
```
npm run upscale -- --in out/ocean-lighthouse.mp4
```
optional `--factor <1-4>` (auto-picks to reach ~1080p when omitted), optional `--model Proteus`.

> You can also run `node src/cli/engine.js …` directly instead of `npm run …`.

---

## Add your own characters / look (Elements & profiles)

**Elements (reference images)** — pin the look by showing pictures, not words. Drop
`.png`/`.jpg`/`.jpeg`/`.webp` files (any filename) into:
- `elements/references/` — main batch (up to **7** per generation).
- `elements/first-frame/` — *(optional)* lock the opening frame.
- `elements/last-frame/` — *(optional)* lock the closing frame.

> ⚠️ **Switching to your own images? Remove the bundled sample first.** The engine feeds **every**
> image in `elements/references/` to Kling, so delete/move `elements/references/subject.png`
> (macOS `rm elements/references/subject.png` · Windows `Remove-Item elements/references/subject.png`,
> or drag it to Trash) before rendering your own brief.

**Profiles** — a recurring character/world is a short Markdown file in `profiles/` describing tone,
behaviour, and world so the engine keeps it consistent. Copy `profiles/example-subject.md` to start.

> Common defaults (resolution, aspect, audio…) are the **Optional overrides** in `.env` — see
> [PROVIDERS.md](PROVIDERS.md#optional-overrides-env). The full list lives in `config.js`.

---

## Troubleshooting

**"command not found" / "is not recognized"** (node, npm, ffmpeg, or a CLI) — not installed, or the
terminal hasn't noticed it yet. Finish the relevant install (or `npm install -g …`), then **close and
reopen** the terminal. Re-check with `node -v`, `ffmpeg -version`.

**`npm run doctor` reports failures** — read the line; it names the problem (a blank key, a provider
picked without its key/CLI login, ffmpeg off PATH). Fix that item and re-run.

**`.env` not filled in** — make sure you created `.env` (not just `.env.example`), values have no
spaces around `=`, no quotes, no `<...>` brackets, no trailing spaces, and you **saved**.

**The example won't render / "no reference image"** — restore any PNG to
`elements/references/subject.png`.

**Copilot won't work** — it's CLI-only: `LLM_TRANSPORT=cli`, active subscription, installed with
Node 22+, logged in via `copilot` → `/login` (or a PAT with "Copilot Requests").

**It cost more than expected** — you ran a full render (or `--upscale`). While experimenting with
long multi-job videos, use `--probe` (first job only) and finish a liked probe for free with
`npm run assemble`. See [COST.md](COST.md).

---

## How it works (for the curious)

The **engine** is 8 small AI "agents," each filling in one block of the movie plan ("spec"):

| # | Agent | What it decides |
|---|-------|-----------------|
| 0 | Showrunner / Concept | The overall idea and tone |
| 1 | Storyboard Writer | The sequence of beats/scenes |
| 2 | Scene Director | What happens in each scene |
| 3 | Cinematographer | Camera angles, movement, framing |
| 4 | Casting / Elements | Which subjects and reference images to use |
| 5 | Sound / Voice | Audio and any spoken lines |
| 6 | Job Planner | Splits the work into Kling "jobs" within the limits |
| 7 | Continuity / QC | Checks everything is consistent and valid |

A **QC** step re-runs any agent whose block fails validation, so the plan is sound before a single
(paid) frame is rendered.

**Config vs. spec:** `config.js` holds your *defaults* (resolution, aspect…) for every project; the
**spec** is the *plan for one specific video* (JSON written by the engine, or a file like
`examples/ocean-lighthouse/spec.json`).


## Config vs. spec — two kinds of settings

- **`config.js`** — your *defaults* (aspect ratio, budgets, endpoints) that apply to every project,
  each overridable per-key in `.env`.
- the **spec** — the *plan for one specific video*, written by the engine (or read from a file like
  `examples/ocean-lighthouse/spec.json`). It's just a JSON file describing the shots.
