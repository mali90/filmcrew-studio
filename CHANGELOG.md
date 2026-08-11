# Changelog

## Unreleased

### Added
- **A delivered run can be reopened for changes — and until it is, the server itself refuses to
  spend on it.** Approving used to lock a run in the interface only: a stale tab, a second browser
  window, or a double-click that landed just after the approval still reached `POST /render` and
  billed you against a film you already had. `render`, `revise`, `rerender-job` and `assemble` now
  refuse a finalized run outright — 409, no child spawned, nothing submitted — with a message that
  names the way forward instead of just saying no. `POST /api/runs/:id/reopen` is that way forward:
  it moves one timestamp and deletes nothing. **Your delivered file stays exactly where it is**, and
  stays the run's linked final until a newer approval supersedes it; every delivery is kept in the
  manifest's `finals` history with the id of whatever replaced it, so a second approval writes a new
  file *beside* the first and never over it. A reopened run reads as `review` again — "complete"
  now means the approval is newer than the last reopen — so the ordinary render/revise/re-render
  path simply works again. Reopening is refused while a paid upscale is still running (that job is
  writing the very file being delivered) and on a run that was never approved. The reopen itself
  costs nothing at all: one line written to the run's manifest, no render, no model call.
  On screen, the way back is in the deliver card itself rather than behind an overflow menu:
  *Make changes* asks once, and the entire question is about what does **not** happen — it names
  your file and says it stays on disk and stays downloadable. A run that has delivered more than
  once shows which final is on screen and what it replaced (`final-2 · replaced final-1`), with
  every earlier file one click away under *Earlier finals*. Coming back in, the run explains itself
  where you land instead of in a toast that expires six seconds later: a standing notice above the
  stage names the file still on disk, and the approve button reads *Replace final* with the same
  promise underneath it. The history panel gains a leading glyph column and the rows that are not
  renders — what was delivered and whether it was upscaled, when the run was reopened, and every
  prompt edit or discard along the way.
- **Re-rendering one segment now shows you what it will do to its two joins, in plain words, before
  it spends anything.** Picking a clip in the review strip (or the rail's *Re-render one segment*
  row — both open the same dialog and post to the same endpoint) shows the neighbour it would start
  on, the clip that gets replaced, and the neighbour it would end on, with one live sentence
  underneath: *"K2 will start from K1's last frame and end on K3's opening frame — both joins stay
  seamless."* That last word is the point. **"Seamless" is said only where the model has a real
  first/last-frame anchor**; where a boundary frame rides as an extra reference image plus a prompt
  pin — every Seedance render on fal, and any Segmind segment carrying cast references — the
  sentence reads *"reference-guided, near-seamless"* and an amber row says plainly that the pin is
  close but not guaranteed frame-perfect. Nothing pinned reads as a scene cut. The strength comes
  from the renderer's own rule, so the sentence and the render cannot disagree. `Auto` mirrors the
  joins the cut already has and `Custom` opens on exactly what Auto would have done, so the first
  click changes nothing by surprise. Where the next clip really does start on this one's last frame,
  a warn row offers to re-render the tail as well and re-prices the button; where the ending is
  being pinned it says so instead of predicting a break it is preventing. On Segmind, a segment with
  cast references cannot have both an exact frame and its cast — the trade the renderer made, and
  why, is stated rather than swallowed. Every figure on the screen belongs to the paid button, which
  says `rate not on file` rather than invent one, and the one-time "this spends real money"
  confirmation appears *inside* the dialog: never a second scrim over the first.
- **A re-render can now be pinned to the clips on either side of it, and by default it keeps the
  joins the cut already has.** `POST /api/runs/:id/rerender-job` takes `boundaries` —
  `auto` · `both` · `start` · `end` · `none`. `auto` mirrors the cut as it stands: a joint that is
  whole today stays whole, and one that is already broken stays broken. It never quietly repairs a
  break, because repairing one costs money and is a thing you should be choosing, not discovering on
  the invoice. `both`/`start`/`end` ask outright, `none` renders the segment on its own. The new
  ability is the closing pin: pinning a segment's *ending* to the next clip's opening frame keeps the
  join downstream of it alive **without** re-rendering everything after it — until now the only way
  to keep that join was to pay for the whole tail. Whichever ends are pinned, the child is told both
  which frame (`--first-frame-from`) and which take it came off (`--seam-from`), so the joint stays
  readable afterwards and the seamless stitcher can still act on it. During a cascade the closing pin
  belongs to the last job in the chain and to no other — every earlier one's ending is defined by the
  job that follows it, so pinning it would fight the chain it was queued to rebuild. How strongly
  each end is actually held comes from the renderer's own `chooseSeamMode`, so only a native anchor
  is ever reported as a true seam; a reference-guided pin says so.
- **The prompt sheet now has an editor, and it meters what you type in the unit the model actually
  counts.** `Edit prompt` opens the words themselves — the authored scene body, not the composed
  prompt, because the style directive, the identity clause, the speech rules and the frame pins are
  re-composed on top at render time and re-composing them over themselves would send them twice. The
  meter draws against `maxBytes − pinBytes`: the room left for *your* words once the system's share
  is taken out, in UTF-8 **bytes**, so an em dash costs 3 and an emoji 4 — counting characters is how
  a 480-character edit sails past a 500-byte cap and dies at the provider instead of on screen. Kling
  gets one textarea and one meter per shot (its cap is per shot; fal rejects a 512-byte segment) and
  Seedance one for the whole job. Over budget, nothing is ever truncated for you: every byte you
  typed stays in the box, Save refuses, and the line says by how much — text cut behind your back is
  text you cannot fix. When the agents revise the plan under a saved edit, a banner says the one
  thing that matters first — *your edit is still what we'll send, word for word* — and offers
  `Refresh from plan` (loads the new text into the editor, **unsaved**) or `Discard edit` (confirmed
  first, and only then). An edit whose segment the agents re-cut away is listed with its text and a
  `Copy the text` before anything can discard it. Edited segments wear a pen in the review strip, and
  a warning beside it when the plan has moved. Saving is genuinely free — one local file write —
  which is exactly why the caption says so and says nothing renders until you re-render the segment.
- **You can now edit the words we send, and they are kept word for word.** `PUT /api/runs/:id/prompt`
  saves one job's prompt to `<runDir>/prompt-overrides.json`; `DELETE …/prompt?job=K2` goes back to
  the agents' text. What is stored is **only what you typed** — the style directive, the identity
  clause, the text and speech rules and the seam pin sentences are re-composed on top at render
  time, from that render's own settings. That is not tidiness: a seam pin names a reference label
  (`@Image3`) that only exists once a particular render has laid its references out, so a stored pin
  would eventually point a future take at the wrong image. The sidecar lives at the run root, so a
  revise — which rewrites `spec.json` underneath it — leaves it untouched; if the plan really moved,
  the prompt view says `stale` and offers the new plan text alongside, while still sending your
  words verbatim. Each render snapshots the sidecar into the take it reserves and passes
  `--prompt-overrides` to the CLI, so a past take can answer "what did we send, and whose words were
  they?" from its own directory (`takes[].promptSource`, `prompts.json`'s `prompt_source`). Over
  budget is refused with the byte numbers rather than silently truncated — text cut behind your back
  is text you cannot fix — and an edit whose job the agents later re-cut away is kept and reported
  as orphaned, never dropped. Saving is genuinely free: one local file write, nothing submitted —
  nothing changes on screen until you re-render that segment, which does cost money.
  See [docs/PROMPTS.md](docs/PROMPTS.md).
- **You can now read the prompt before it is sent, from wherever the segment is on screen.** A
  `Prompt` control on the plan card (every job at once), on each job card, and on a clip you pick in
  the review strip opens one panel under the stage — an inline disclosure, not a modal, because
  reading is neither destructive nor paid. It shows the words themselves, the reference legend that
  rides along with them (`@Element1 = the lighthouse keeper`) and what else is pinned into every
  prompt for that job, and it meters the text against the model's real budget: `3,880 / 5,000 B`,
  amber from 90%, and on Kling one counter per shot segment against the 500 bytes fal actually
  enforces. Every number is the server's own count — nothing is recounted in the browser, because a
  second implementation of "how big is this prompt" is exactly how a preview starts lying. A version
  picker switches between the current plan and any past take that kept a `prompts.json`, and a past
  take is shown verbatim as it was sent, named with the provider **that take** recorded and the time
  it went out. Read-only in this step: no editing, and nothing here spends.
- **The prompt each segment will be sent is now readable from the server — composed by the same
  builder the renderer uses.** `GET /api/runs/:id/prompts` (every job of the current plan) and
  `GET /api/runs/:id/prompt?job=K2` return the exact text that would leave for the provider, the
  reference legend it cites (`@Image1`, `@Audio1`, the boundary pins), its UTF-8 byte count, the
  model's byte budget, and how much of that budget the SYSTEM already owns (front matter, guards,
  frame pins) so an editor can draw a real meter. This is not a second implementation: the server
  calls `src/lib/prompt-compose.js` — the same pure function the renderers call — and an
  integration test composes the same job independently and compares buffers, because a preview that
  differs from what is sent by a single byte is a lie. `&take=t2` serves that take's `prompts.json`
  verbatim instead: what was actually sent, when, and to which provider, never recomposed (the
  settings may have moved since). Reading spends nothing — no model is called and no render is
  queued. The run's `.env` is read as **data** for the byte budgets and never sourced into the
  server process, and the service is lazy-imported so web/server's static import graph stays
  config-free.
- **Per-joint seam lineage — every clip now records which clip it continues from.** `prompts.json`
  becomes `schema: 2` on both renderers and carries `seam_in { mode, frame, from: {take, job, clip} }`
  and `seam_out { mode, frame, frameSource, to }`; `render.json` carries the same per job, and it
  survives both the wholesale rewrite at the end of a render and a later `assemble --from`. Knowing
  *that* a seam frame was used said nothing about **which clip** it came from, so a cut mixing take
  2's first segment with take 1's second looked exactly like an intact chain — this is what the
  seam-invisible stitcher needs to stop falling back to a hard cut on mixed timelines.
- **Seamless stitching now reads that lineage, joint by joint.** `readContinuity` no longer answers
  "was this whole run chained?" from a single flag — it derives one verdict per joint from each
  clip's own recorded seam, using the same source-clip identity rule as the review read model (a
  unit test runs both implementations over the same fixtures and requires identical verdicts). A cut
  with one re-rendered segment therefore colour-matches and crossfades the joints that survived and
  hard-cuts only the one the re-render broke, where before the mixed timeline lost the seamless
  stitch entirely. Runs made before the lineage existed still read their run-level `chained` flag
  exactly as they did, an unknown run is still unknown (never guessed as "all cuts"), and
  `STITCH_ASSUME_CONTINUOUS=1` still forces all-true. A timeline whose every joint is a genuine cut
  is now assembled as a plain concat without a "seamless stitch skipped" warning — nothing was
  downgraded — and `STITCH_SEAMLESS=force` no longer fails on it. Local ffmpeg only: free.
- **The review read model answers, per segment, whether it really continues from the one before
  it.** `GET /api/runs/:id` (and the library list) now carry `continuity[]`, one entry per clip in
  the cut, computed by a pure rule: a segment continues from its predecessor **iff the clip its
  opening frame was taken off is the clip currently at that position** — not merely "a seam frame
  was used". Re-rendering one segment therefore breaks exactly the joint after it and nothing else.
  Runs made before the lineage existed are reconstructed from take history and marked
  `confidence: 'derived'`, so the UI can say *join unknown* instead of claiming a link it cannot
  see. Take/job ids only: no filesystem path is ever serialized. The manifest gained `clipLineage`
  (which take each job's newest clip came out of, with its seams), and a composed cut now carries
  every clip's own `seamIn`/`seamOut` into `render.json` instead of dropping them.
- **The review page draws that continuity.** The clip row under the player became a proper
  continuity strip: each segment is a tile (fixed height, width from the run's aspect, so all six
  ratios work), and *between* the tiles the join itself is drawn — a solid rule with a chevron where
  a clip really does start on its neighbour's last frame, two offset stubs where that link is
  broken, a divider where the cut is a scene cut by design, a dashed rule where the answer was
  reconstructed. Each tile carries a chip saying which of those it is in words (*joined* · *join
  broken* · *scene cut* · *join unknown*), and one shared line under the strip explains the hovered
  clip's joins in plain language — no legend, no popovers. A reconstructed (pre-lineage) run says so
  and never claims a link it cannot see. The strip no longer wraps: a chain folded onto a second
  line lies about which clip follows which, so it scrolls instead. Read-only — nothing here spends.
- **Boundary frames are applied honestly, per model.** One decision (`chooseSeamMode`) now answers
  "how is this clip pinned to its neighbours?" for the renderers, the prompt preview and the UI
  copy: `native` (a real first/last-frame anchor — the only mode anything may call *seamless*),
  `soft` (the frame rides as an extra reference image plus a prompt pin — near-seamless,
  reference-guided), `none`, and the runtime-only `unsupported`. fal's Seedance endpoints can never
  report native — they carry no frame anchors at all — and Segmind goes native only on a cast-less
  segment, because its native slots exclude reference images. At the reference cap the closing pin
  is dropped first, then the opening one, and only then a cast reference: identity outranks a hint.
  Where the provider offers it and the clip feeds another segment we now keep the **generator's own
  closing still** (`return_last_frame`) instead of an ffmpeg re-encode, recorded as `frameSource`.
- **Kling's closing frame (`end_image_url`) ships with a one-shot fallback.** The input is
  documented but unverified in practice, so a validation rejection naming it re-submits the
  identical payload once without it and records `seam_out.mode: 'unsupported'` — anything else
  propagates on the first attempt. fal bills per accepted submit, so nothing here retries blindly.
- **`--first-frame-from` / `--last-frame-from` / `--prompt-overrides` on `render` and `render-job`.**
  Point a boundary flag at a still and it is used as-is; point it at a **clip** and the frame that
  touches this segment is grabbed (the neighbour's last frame for an opening pin, its first frame
  for a closing pin). Opening-frame precedence is `--first-frame-from` > the spec's authored
  `job.first_frame` > the chained seam frame, and the recorded lineage follows the frame that was
  actually used — a clip that opened on an authored or hand-picked frame no longer names a source
  clip it did not continue from. All three flags are validated before anything is queued — a typo
  costs nothing.
- **Settings › Keys holds the Segmind key too.** Setup could ask for it, but afterwards there was
  nowhere in the app to rotate or add one — a Segmind install had to hand-edit `.env`. The field
  sits beside the fal one with the same masked placeholder and the same live *Validate*, which
  probes the model your default backend actually names (a 2.0 install is no longer judged against
  the 2.5 slug). **An empty field never clears a stored key**: only keys you actually type are
  written, so saving a new fal key leaves a configured `SEGMIND_API_KEY` exactly where it was. The
  card's blurb now names the provider that bills *this* install rather than assuming fal, and says
  which key each part of the pipeline needs — a fal-only and a Segmind-only install are both
  ordinary setups. Now that the field exists, a failing Segmind key in the health list carries a
  *Fix in Keys* button that lands you on it, instead of only naming the `.env` variable — but only
  when the check is hard (your backend really does render on Segmind); a fal install still sees the
  quiet optional note it saw before.
- **The health check now tells you when your ffmpeg is too old to stitch a seam, instead of you
  finding out in the finished film.** It only ever proved that ffmpeg *runs* — and a build older
  than **4.3** runs perfectly well, then can't crossfade, because the filter the seamless stitcher
  uses (`xfade`) doesn't exist before 4.3; the stitch falls back to a hard cut at every seam.
  `npm run doctor` and the web health card now read the version off `ffmpeg -version`, show it when
  it's fine, and when it isn't say what it costs and give you the upgrade command for your OS. It is
  a **warning, never a blocker**: the video still delivers, and the app never installs or upgrades
  ffmpeg for you — you run that command, as you always have. A version we can't read (a git snapshot
  like `N-1234-gabcdef`) is reported as unknown and passes; a binary that works but won't label
  itself is no evidence of a problem. The minimum is written down in `docs/SETUP.md` beside the
  install commands.

### Fixed
- **Starring a cast now sends the character's FULL reference set, not one image each.** A run with
  three starred characters — each carrying seven reference views — could reach a Seedance render
  with a single image per character: the Casting agent's "pick the smallest set" guidance biased it
  toward a sample, exactly the habit starring exists to override (the per-model cast caps were sized
  around each cast bringing its whole set). Three layers fix it: the casting brief now carries a
  STARRED-cast rule with the budget arithmetic spelled out (all of a starred character's images, the
  per-job reference budget split evenly across the starred cast, the seam slot left free on chained
  renders); the agents' element inventory groups references per starred character with a count, and
  the Hard caps line states the combined-reference budget (fal Seedance 2.5's 50) and Kling's
  per-character ceiling so the arithmetic has its numbers; and — because a paid render must not hang
  on prompt adherence — the engine now tops the plan up **deterministically** after the QC gate:
  any starred character with fewer element entries than its available references gets the rest
  attached mechanically, within the same caps the validator and renderers enforce, with one log
  line saying what was added.
  with no `.env` at all.** The server may not import `config.js` (that would let a request
  reconfigure the running process), so it re-declares the prompt-shaping defaults by hand. Every
  test that compared preview against wire wrote an explicit `.env` first, so both sides read the
  same number and the *defaults* path — the one a fresh install actually takes — was never
  exercised: a budget changed in `config.js` alone would have shown you a meter measuring against
  one cap while the render used another. The two sets of defaults are now composed against each
  other byte for byte, so a drift fails the suite instead of reaching a user's screen.
- **A pin the reference budget is about to drop is no longer sold as a join.** The re-render dialog
  and the prompt sheet asked the model *"can you pin this end?"* but not the budget *"is there a slot
  left for it?"* — so on a segment carrying a full cast (a Seedance model takes nine images; two
  characters with seven references each fill that on their own) both screens promised
  *"near-seamless (reference-guided)"* and the render, correctly, dropped the pin and delivered a
  scene cut. Both now read the same composed answer the renderer acts on, so a boundary that cannot
  be pinned says so **before** the paid button, not afterwards in the clip strip. The seam rule and
  its budget arithmetic now live in one module that the renderers, the server and the browser all
  import, replacing the hand-kept TypeScript copy of the rule.
- **Replanning a delivered run was still possible.** `render`, `revise`, `rerender-job` and
  `assemble` refuse a finalized run, but `POST /api/runs/:id/plan` — a full engine pass that also
  rewrites `spec.json` — did not, leaving the plan behind your delivered file rewritable from a
  stale tab. It is guarded like the rest now.
- **A prompt edit can no longer be silently dropped from a render you paid for.** If the saved-edits
  sidecar existed but could not be read or copied into the take, the web path used to fall back to
  the agents' words, label the take `plan`, and say nothing. It now refuses the render (409) and
  names the file — the same refusal the command line has always made.
- **A transient fal fetch race no longer looks like an unsupported field.** fal answers HTTP 422
  both when a Kling argument is wrong *and* when its worker briefly cannot fetch a reference URL we
  just uploaded — and the second message names the field too. The closing-frame fallback read that
  as a rejection, permanently recorded `seam_out: unsupported` (a lie the continuity strip and the
  seamless stitcher then acted on) and submitted a **second billed render**. It now tells the two
  apart, exactly as the ordinary retry loop already did.
- **The provider's own closing still is kept under the name the seam reads.** The downloaded frame
  was matched by the URL's filename, which real CDNs content-hash — so outside the test mocks the
  paid-for frame was never found, every seam fell back to an ffmpeg grab, and a stray PNG was left
  in the take. The transport now names that file at download time (and the mocks serve hashed URLs,
  so the test can fail again).
- A re-approval landing in the **same millisecond** as the reopen that enabled it was read as
  superseded: the run sat out of `complete` forever while every spending endpoint stayed unlocked on
  a delivered file. An approval cannot precede its own reopen, so equal timestamps now count as
  delivered.
- `DELETE /api/runs/:id/prompt?job=__proto__` (or `constructor`, or `toString`) answered 200,
  broadcast a prompt-override event to every open tab and filed a history row for a job that never
  existed. Inherited object members are no longer mistaken for saved edits.
- A provider's **closing still is a courtesy, not the purchase**: a `return_last_frame` image that is
  advertised and then fails to download (an expired CDN record) no longer throws away the render it
  came with. The clip has already been generated and billed by that point, and the same frame is
  reproducible locally, so the download is skipped with a warning and the seam frame is grabbed with
  ffmpeg instead (`seam_out.frameSource: 'ffmpeg'`). A missing **video** is still a hard error.
- The first-run wizard's end-to-end walkthrough followed the old step order and stalled on a key
  field that had moved: the backend picker comes **before** the render key now (which key you are
  asked for depends on which provider your backend bills), and the test walks it that way.

### Changed
- **Segmind's prices are on file — and they are roughly half fal's for the same model.** Every
  Segmind surface used to say the rate was "not on file yet", because it genuinely wasn't: the price
  table shipped three `PRICE CHECK REQUIRED` rows and the interface refused to guess. Those rows are
  now filled in from segmind.com's own pricing pages, checked **2026-08-10** and recorded (with the
  date) in each row's `_source`: **Seedance 2.0** at `$0.0703/s` (480p), `$0.1512/s` (720p),
  `$0.34/s` (1080p) and `$1.3721/s` (4k); **Seedance 2.5** at `$0.1065/s` (480p) and `$0.2389/s`
  (720p), with **no 1080p or 4k tier published** — pinning one is refused rather than priced at a
  tier that does not exist; and **Topaz** at a flat `$0.125/s` billed on the *input* clip's duration,
  with no per-target breakdown, so `UPSCALE_TARGET_RESOLUTION` changes what you get and not what you
  pay. Comparable fal rates are `$0.135/$0.3024` and `$0.2205/$0.4730` — the gap is real, and each
  row says so in prose so a future reader does not "correct" it back. Rows stay independent (no
  aliasing), so filling one in can never silently reprice another. Setup cards, the create-page hint,
  the plan and re-render buttons, the approve-time upscale and the run's cost ledger all quote real
  Segmind money now instead of the amber *Price not set* note. A Segmind 2.5 render carrying **video
  references** bills a ~40% cheaper video-to-video tier that the estimate does not model, so it reads
  high rather than low for those runs — noted in the row, as fal's 2.5 row already notes its own.
- **An upscale is flagged "no published rate" only when that is actually true.** The approve-time
  ledger decided by provider *name* — anything that was not fal was recorded as unpriced — so a
  Segmind upscale would have been written into the cost ledger as "estimate unavailable" while the
  estimate endpoint quoted it a real figure. It now asks the estimator instead of naming providers,
  and stays correct the next time a rate lands.
- **The unknown-price path is kept honest by a synthetic vendor, not by a real one.** Warning without
  blocking, never inventing a figure, and flagging unpriced spend so it can't read as free are all
  still exactly right for a vendor that publishes nothing — but every test proving it pointed at
  Segmind, so pricing Segmind would have quietly deleted the coverage. `prices.json` now carries two
  clearly-marked synthetic `examplevendor` rows for that purpose, a guard test fails on any *real*
  row still shipping unpriced or carrying a `_todo`, and no registry backend may point at the fake
  vendor.
- **The library list no longer pays for continuity.** Per-segment join facts are read from disk, and
  the list re-fetches on every progress tick during a render — so a busy library was doing dozens of
  synchronous reads a second on the same loop that streams progress, for a field only the run page
  uses. `GET /api/runs/:id` (and the run's live stream) still carry it; the library list does not.
- **The delivery history reaches the browser as file names, not host paths.** `finals[]` and the
  reopen entries in `history[]` used to ship absolute paths from the machine running the server; the
  interface only ever showed the file name. The current final keeps its full path, which is what
  *Reveal in Finder* and *Copy path* are for.
- Prompt-edit and prompt-discard rows in the history panel are capped at the most recent twenty.
  Editing a prompt is free and iterative, and every save used to be filed forever — in the run's
  manifest and in every state payload the page received. Reopens, takes and cuts are never compacted.
- **The zero-spend demo boots with a run whose cut has a broken join.**
  `npm --prefix web/server run demo` seeds a three-segment cut in which the middle clip was
  re-rendered under its neighbour — so the join chips, the prompt sheet's "as sent" take versions,
  the segment re-render dialog and the reopen path are one click from the banner instead of two
  minutes of mock rendering away. It is re-seeded on every boot (and on `POST /__demo/reseed`), so a
  walkthrough that approves or reopens it still starts from the same place next time. `/__demo/submits`
  reports each provider mock's render-submit count, which is how the Playwright walkthrough proves
  that reading a prompt, saving an edit and cancelling a paid dialog move nothing.
- A boundary frame that has to travel as a reference no longer **reserves** an image slot from the
  cast: it is a droppable soft pin, so a full-cast job is valid again. An authored `last_frame` on
  Segmind alongside cast references now soft-pins instead of failing validation, and `last_frame` no
  longer requires `first_frame`.
- The prompt builders moved into pure, config-free modules (`src/lib/prompt-compose.js`,
  `src/lib/prompt-settings.js`), byte-for-byte identical to what shipped — `kling.js`/`seedance.js`
  keep every export and become thin shims. This is what lets the web server show the exact bytes a
  render will send without pulling a developer's `.env` into its import graph.
- **Seam-invisible stitching.** A video over the model's window renders as several *chained* jobs —
  each seeded with the previous clip's last frame — and the local stitch now colour-matches every
  chained joint, drops the duplicated boundary frame (trimming one frame of audio to match) and
  crossfades, instead of hard-cutting and leaving a lighting "pop" plus a 1-frame hitch. Scene cuts
  in the same timeline stay cuts. It is pure local ffmpeg: no API call, no spend. The stitcher
  (`tools/seamstitch`, vendored — see its `PROVENANCE.md`) is extended here with per-joint continuity,
  per-joint crossfade lengths and a JSON report; the Node side adds `src/lib/seamstitch.js`,
  `src/lib/stitch-math.js` (an independent re-derivation of the offset math, used to check the
  tool's output), a `stitch` config block (`STITCH_*`), a SOFT doctor check,
  `npm run assemble -- --continuity/--stitcher`, and `stitcher`/`joints`/`matched` on cut records.
  See [docs/STITCHING.md](docs/STITCHING.md).

  It is **optional and self-disabling**: without python3 + numpy + pillow — or if anything at all
  goes wrong — assembly logs one warning and falls back to the hard-cut stitch, unchanged.
  **Per-joint seam lineage has since landed** (below), so the all-or-nothing flag this shipped with
  is gone: every joint is judged on its own recorded seam, and a timeline that mixes takes stitches
  the joints that survived instead of falling back wholesale. A run made before lineage existed
  still reads its old run-level flag, exactly as it did.
- **Segmind is a second render provider.** Both Seedance models now render on **fal.ai or Segmind** —
  `seedance-2.0@segmind` and `seedance-2.5@segmind` join the backend list, and you only need a key
  for the provider you actually use. A **Segmind-only install needs no fal account at all**: set
  `SEGMIND_API_KEY`, `SEGMIND_UPLOAD_MODE=data-uri` and `UPSCALE_PROVIDER=segmind` and the whole path
  from idea to finished 1080p master works. Kling 3.0 Omni stays fal-only, and minting persistent
  character voices still needs `FAL_KEY` — Segmind's own voice model is not wired up, so a
  Segmind-only setup has no minted voices. The same model can differ per provider and the planner is
  told the right numbers: Seedance 2.0 renders three aspect ratios on fal and six on Segmind, takes a
  `seed` on Segmind but not on fal, and has real first/last-frame slots there (mutually exclusive
  with reference images, so a job with cast refs carries the seam frame as its last reference, exactly
  as on fal). Full matrix in [docs/PROVIDERS.md](docs/PROVIDERS.md).
- **Segmind never pays twice for the same job.** Its transport resubmits only when something proves
  nothing was queued — an error Segmind answered with, or a connection that failed before the request
  could land. Once a `request_id` exists nothing re-POSTs (that would buy a second render), and a
  submit that dies mid-flight (timeout, reset socket) stops with a message pointing at the Segmind
  console, because it may already have been accepted and billed; only the polling GETs retry. Insufficient credits, content-policy rejections and expired result
  records each get their own actionable message instead of a generic failure, and every finished job
  records its `request_id`, reported cost and remaining credits in the run's `prompts.json` sidecar.
- **Seedance 2.5 on fal** (`seedance-2.5@fal`): 4–30s jobs, 4 starred cast members, all six aspect
  ratios, 480p/720p output, `[Image1]`-style reference citations, `Shot N:` prompt syntax, a `seed`
  the endpoint actually accepts, and a 50-reference combined budget across images, audio and video.
- **Topaz upscale runs on either provider.** `UPSCALE_PROVIDER=auto|fal|segmind` (default `auto` =
  wherever the run rendered, falling back to whichever provider has a key). Segmind's Topaz takes a
  `target_resolution` (`UPSCALE_TARGET_RESOLUTION`, default `1080p`) instead of fal's factor — and its
  `target_fps` is **pinned to the probed source frame rate**, because Segmind defaults it to 60 and
  would otherwise hand back a frame-interpolated clip with motion the take never had.
- **New setup checks.** `npm run doctor` gained `segmind-key` (blocking when your default backend
  renders on Segmind, informational otherwise) and `render-assets`, which catches the one broken
  combination — `SEGMIND_UPLOAD_MODE=fal-storage` with no `FAL_KEY` — instead of letting it fail on
  the first upload of a render, and recognises the keyless `data-uri` setup as valid.

### Changed
- **The estimator is provider-aware, and says so when it doesn't know a price.** Seedance 2.5 on fal
  carries real rates ($0.2205/s at 480p, $0.473/s at 720p). Segmind does **not** publish a public
  per-second rate for either Seedance model or its Topaz upscale, so those rows are deliberately
  empty: the estimate comes back as unknown rather than borrowing a sibling backend's rate or
  guessing one. The UI shows an amber **"Price not set"** note and **warns without blocking** — the
  render still costs real money, the rate just isn't on file yet. A genuinely unknown *backend* still
  fails loudly, as before.
- **Home's backend picker chooses a model and a provider.** Models with more than one provider
  (Seedance 2.0 and 2.5) offer the choice; Kling shows honestly that it runs on fal only. Cast
  ceilings, aspect lists and per-model hints follow the selected pair, and switching pairs re-picks
  anything the new one can't carry — the fal 2.5 entry shows its real per-second rate, the Segmind
  entries say the rate isn't on file rather than inventing a figure.
- **Render backends are now named `<model>@<provider>`** (`kling-o3@fal`, `seedance-2.0@fal`), and a
  planned spec records that canonical id in `render_backend` whichever spelling you typed, as does
  each rendered job's `prompts.json` sidecar — so an old clip can still say which *model* made it.
  The old one-word `kling`/`seedance` names stay accepted forever — on the CLI, in `.env`, and in every spec
  or manifest already on disk — so nothing needs migrating. Planning is now told the *rendering
  model's own* caps (Seedance 2.0's 9 reference images instead of Kling's 7, its own 4–15s job
  window and its own aspect-ratio list) instead of one hardcoded set for every backend.
- **Cost estimates follow the rename.** A CLI-created run now records the canonical id in its
  `render.json`, so the web app prices `kling-o3@fal`/`seedance-2.0@fal` off the same rate rows as
  the old one-word names — including Kling's cheaper audio-off tier, which a literal name check
  would have quietly overcharged. A model/provider pair with no rate table (`kling-o3@segmind`)
  still fails loudly instead of guessing a price.
- **Seedance renders fail fast on an argument the chosen model does not accept** — an aspect ratio or
  resolution outside that model's list, more reference images than it takes, or a kind of reference
  it has no input for — instead of paying for a provider round trip to be told the same thing.
- **Starring more characters than the chosen model can carry is now rejected before any LLM spend.**
  Each model has its own cast ceiling (Kling 3.0 Omni 1, Seedance 2.0 2) because every starred
  character costs reference-image slots. Over-starring used to plan a full 8-agent spec that could
  only ever fail at the renderer; the engine now stops at the flag with a message naming the model,
  its limit and the characters you picked, and `POST /api/runs` refuses the same request before it
  queues anything. On Home, the **Starring** row states the cap ("up to 1 for Kling 3.0 Omni"),
  greys out the pills you have no room for, and switching model unstars whoever no longer fits and
  says so — the cap is now unhittable rather than explained after the fact.
- **Aspect ratios are per model.** The app now understands six numeric ratios — `16:9`, `9:16`,
  `1:1`, `4:3`, `3:4` and `21:9` — and each run may only pick from the ones its own model renders
  (Kling 3.0 Omni and Seedance 2.0 keep today's three). Home's **Aspect** control offers exactly the
  selected model's ratios and re-picks for you if a switch invalidates your choice. The stitch canvas
  shapes itself for all six, never upscaling past the source clips. `adaptive`/`auto` are deliberately
  not offered: the stitcher needs a deterministic ratio.

### Fixed
- **Finalize/upscale now uses the cut you selected**, not always the newest. In review, switching to
  an earlier cut and clicking Approve (with or without upscale) previously finalized/upscaled the
  latest take instead — the preview selection never reached the server. The previewed cut is now
  threaded into `POST /api/runs/:id/approve`, and the finalize points at that cut's master while the
  upscale runs Topaz on that cut's own render (omitting the cut still finalizes the latest, unchanged).

## 1.4.0 — 2026-07-11

### Added
- **Environments** — a reusable, purely descriptive setting (world, mood, look): create/edit an
  environment bible (`environments/<slug>.md` — a name heading plus prose, no images or voice) in the
  new **Environments** section of the Cast page, then set exactly one per idea from Home's **Set in**
  picker and the 8-agent engine anchors the plan's look to it (its world/style takes precedence over a
  starred character's own world notes). New engine flag: `--environment <name>` (an unknown environment
  fails before any LLM spend; the spec records its environment so revisions re-inject the same setting).
  `ENVIRONMENTS_DIR` is env-overridable and the web demo isolates it; a sample environment, **Neon
  City**, ships in the box.

## 1.3.0 — 2026-07-08

### Added
- **Graceful Seedance content-policy handling.** When a benign render trips ByteDance's output
  moderation (`content_policy_violation` / "Output video has sensitive content" — a common false
  positive), the run no longer dies with an opaque "No rendered clips found". The flag surfaces a
  clear, actionable message, `finishRender` names the failed job and its reason, and — per the
  no-extra-cost rule — it is **never auto-retried** (a resubmit is a fresh paid generation).
- **"Revise to pass content check"** — a content-policy render failure now offers a one-click revise
  in the web app's Attention banner that re-plans with benign rewording + Seedance prompt guidance
  (uses your LLM, **no render spend**), so the next render dodges the false positive. New endpoint
  `POST /runs/:id/revise-content-policy`.
- **Seedance 2.0 prompt guidance during planning** — for a *guaranteed* text-to-video render
  (Seedance, no cast, no reference images on disk), the planner writes director-style shot prose
  from the start (subject + one action → one camera move → a concrete sound cue; no keyword/tag
  lists), per [fal.ai's Seedance guide](https://fal.ai/learn/tools/how-to-use-seedance-2-0).
  Image-to-video (cast/reference) and Kling planning are unchanged.

### Fixed
- `runFal` now classifies a transient fal fetch race (retryable) separately from a content-policy
  flag (fail-fast) and a genuine bad-argument 422 — a momentary "timeout while fetching resource"
  no longer kills a render.

## 1.2.0 — 2026-07-07

### Added
- **Text-to-video mode** — an idea that calls for no reference image now renders from the prompt
  alone. `kling.elements` may be empty; the Casting agent attaches only references relevant to the
  idea (and none when nothing fits), and the Seedance/Kling renderers submit to the text-to-video
  endpoint with no image refs. Previously every spec was forced to carry ≥1 reference, so an
  unrelated idea pulled in whatever images happened to sit in `elements/references/`.
- **A bundled voice clip auto-registers as a staged voice** — drop `voices/<name>.mp3` and the
  character is recognized as a staged (un-minted) voice in both the engine and the Cast page, ready
  to mint. The sample cast member **Wren** now ships with a voice.

### Changed
- **Relicensed MIT → FSL-1.1-MIT** (Functional Source License — source-available; converts to MIT
  two years after each release).
- **The Claude CLI installs via Anthropic's official native script**, not npm, in the setup wizard.
- The bundled example (ocean-lighthouse) and test fixtures now star **Wren**
  (`elements/references/wren-01.png`); the old 6 MB `subject.png` was removed.
- **Get started needs only Node.js** — the browser wizard installs and validates everything else.

### Fixed
- **Homebrew-installed ffmpeg is now detected** — the web server's child PATH gains the standard
  system tool dirs (`/opt/homebrew/bin`, `~/.local/bin`, …), so a GUI/launchd-started server finds
  brew's ffmpeg for both the health check and the render stitch.
- The live planning view no longer misses a spec block on a very short plan or when a client
  connects mid-planning (spec blocks replay on SSE connect).

## 1.1.0 — 2026-07-07

### Changed
- **Renamed the project to Filmcrew Studio** (`filmcrew-studio`). The old `kling-video-agents`
  name predated Seedance support and implied a Kling-only, Kuaishou-affiliated tool; the project
  is backend-neutral (Kling 3.0 Omni **or** Seedance 2.0) and the 8-agent planning engine is the
  star. All brand strings (package name + CLI bin, README, web app title/wordmark/About, CLI
  banners, LICENSE) now read Filmcrew Studio; every Kling/Seedance **model/backend** reference
  (`--backend`, `FAL_KLING_ENDPOINT`, `RENDER_BACKEND`, the spec's `kling` field, `src/lib/fal-kling.js`)
  is unchanged. Repo moved to `github.com/mali90/filmcrew-studio` (GitHub redirects the old path).

### Added
- **Library page** — the run library is its own top-nav destination (`/library`): intent filters
  with live counts (All / Waiting on you / Complete), runs needing attention pinned above the rest
  with a one-line error hint on their cards, and per-card delete. Home keeps the create hero, the
  queue strip, and a read-only Recent row (4 newest) with a See-all link.
- **Character profiles** — first-class characters (Cast page): create/edit a subject bible
  (`profiles/<slug>.md`), link reference images (filename-prefix convention the engine already
  matches), and attach a minted voice — then optionally **star characters in an idea** and the
  8-agent engine builds the plan around exactly those profiles. New engine flag: `--cast "a,b"`
  (filters injected profiles; unknown names fail before any LLM spend; the spec records its cast
  so revisions re-inject the same characters). All cast paths (`PROFILES_DIR`,
  `ELEMENTS_REFERENCES_DIR`, `VOICES_DIR`) are env-overridable; the web demo isolates them.
- **Settings, not .env** — the Seedance render resolution (480p/720p/1080p, priced) is now a
  first-class control on the web app's Settings page; nothing in the normal flow requires
  hand-editing `.env`.
- **Web app** (`npm run web`): a localhost studio UI over the whole pipeline — first-run setup
  wizard, idea → live 8-agent planning view (agent rail + spec inspector), backend/aspect/duration
  controls, cost estimates on every paid button, per-job render monitor with live logs, review
  player with per-clip strip and take history, change requests that re-run the planning engine,
  scoped job re-renders with seam-cascade warnings, approve + optional Topaz upscale, cast
  management (references, voice minting), settings with live key validation and health checks.
  See `web/README.md`.
- `npm run revise` (`src/cli/revise.js`): revise an existing spec from director feedback — routed
  back through the owning agents (explicit `--owners` > block `--scope` > an LLM router) + QC.
- `npm run render-job` (`src/cli/render-job.js`): re-render ONE job as a new take, with seam
  chaining from a prior render (`--seam-from`) and per-take `--feedback` (Seedance director note).
- `--aspect` on `npm run engine` — plans for 16:9 / 9:16 / 1:1 and stamps it onto the spec.
- `--out-name` on `render`/`assemble` — name the `out/` master explicitly.
- `doctor --json` — machine-readable health checks (used by the web app).
- `RUNS_DIR` / `OUT_DIR` / `WORK_DIR` / `CACHE_DIR` env overrides for the working paths.

### Changed
- **Probes are multi-job-only.** A probe renders just the first job, so on a single-job plan it
  was the full render at the same price shown twice. The plan-ready screen now offers only
  **Full render** on single-job plans (the server refuses `mode: probe` with a 409), the `--probe`
  CLI flag errors on a single-job spec, and `engine --render --probe` downgrades to a full render
  with a warning when the plan comes out single-job.
- **The zero-spend demo is no longer a user-facing mode** — it never produced a real video, so
  `npm run web:demo` is gone. The mock server lives on as the dev/e2e harness
  (`web/server/dev/demo.js`, started automatically by the Playwright suite).
- **Kling renders on the o3 STANDARD endpoint by default** (~720p at $0.112/s with audio,
  $0.084/s without — ~20% under pro) — approve's optional Topaz upscale delivers the 1080p final.
  `FAL_KLING_ENDPOINT` restores the pro endpoint (native 1080p, $0.14/s). With this, Kling is now
  the cheaper backend per second.
- **Resolution pickers are gone from Settings** for both backends: renders are deliberately small
  (Kling ~720p, Seedance 480p) and full quality comes from the approve-time upscale.
  `SEEDANCE_RESOLUTION` remains as an advanced env override.
- **Masters keep their aspect.** The stitch canvas was a fixed 1080x1920 portrait (inherited from
  the original 9:16-shorts pipeline) — every 16:9 and 1:1 master was silently center-cropped into
  9:16. The canvas now takes the run's aspect shape at `VIDEO_SHORT_SIDE` scale (default 1080);
  setting BOTH `VIDEO_WIDTH`/`VIDEO_HEIGHT` remains a full explicit override. Existing runs are
  repairable for free: `npm run assemble -- --from runs/<id>/renders/<take>` re-stitches from the
  intact clips.
- **The Kling resolution setting is gone — it never did anything.** fal's Kling o3 endpoints
  accept no resolution parameter (verified against the live API schema); output is the model's
  native 1080p at a flat price. The Settings/wizard controls that pretended otherwise were
  removed and replaced with a truthful note. Seedance resolution (a real API knob) is unchanged.
- **Approve's upscale disables itself when the master is already ≥1080p** — assembly now stamps
  the delivered size (`masterShortSide` in render.json, `shortSide` on cut records), and the UI
  refuses to sell a paid no-op ("This video is already 1080p — there's nothing to upscale.").
- **Seedance defaults to 480p** (`SEEDANCE_RESOLUTION`, was 1080p). fal bills Seedance 2.0 by
  pixel-seconds, so native 1080p is ≈ $0.68/s — about twice Kling — while 480p is ≈ $0.14/s; the
  approve step's Topaz upscale still delivers a 1080p master. Set `SEEDANCE_RESOLUTION=1080p` to
  restore native rendering. Probes now use the **standard** endpoint at 480p — the mini/fast tiers
  are no longer used anywhere (they drift character fidelity). The web app's cost estimates are
  resolution-aware and reflect the configured `SEEDANCE_RESOLUTION`.
- **Specs now remember their backend.** The engine stamps `render_backend` into every spec it
  plans (and revisions preserve it), so a spec planned for Seedance renders on Seedance even when
  your `.env` default says Kling. An explicit `--backend` flag still wins.
- Revisions default their aspect context to the aspect **the spec was planned with** (previously
  the config default could contradict the spec mid-revision), and a typo'd `--scope` now errors
  instead of silently widening to a whole-spec revision.
- `render-job` merges its result into the take's `render.json` instead of clobbering it (a cascade
  renders several jobs into one take dir), and Kling re-renders warn loudly that per-render
  `--feedback` is ignored (route feedback through `revise` — Kling has no prompt budget for notes).
- **`out/` masters are never overwritten.** Repeat renders of the same title now get `-2`, `-3`, …
  suffixes (previously the newest silently clobbered the file). If you scripted around the old
  fixed name, read the `master` path from the render's JSON output instead.
- `--upscale` now Topaz-lifts **each sub-1080p clip before stitching** (previously the post-stitch
  upscale silently no-opped because assembly had already scaled the master). This makes the
  480p-render + upscale path real — and it is real per-clip spend; see `docs/COST.md`.

## Earlier
- Seedance 2.0 (fal.ai) render backend alongside Kling — `--backend kling|seedance`,
  spec `render_backend`, `RENDER_BACKEND` env; per-job prompts, prompt-pinned seam frames,
  lip-sync from minted voice clips, `--take` retake nonce. (2026-07-02)
- Complete automated test suite (node:test) + CI; fal.ai as the only render backend; AI-guided
  `npm run init` setup wizard.
