# Architecture Review — Environments feature (uncommitted diff)

Scope: READ-ONLY architecture review of the current working tree implementing the
Environments feature per the authoritative design spec. Focus: pattern compliance,
naming, layering, resource/subscription lifecycle, API design, protected/read-only areas.

## Verdict

Solid. The feature is implemented as a faithful, minimal clone of the cast-feature
patterns across every layer (config → app.ctx → config-free route → engine/CLI → UI →
docs). No blocker or major architectural defects found. Two minor consistency items below.

## What was checked and is correct

- **Config-free route module** (`web/server/routes/environments.js`): statically imports
  ONLY `node:fs` / `node:path`; reads `{ root, environmentsDir }` from `app.ctx`; reaches
  host `slug` via the dynamic `host = (rel) => import(path.join(root, 'src/lib', rel))`
  pattern cloned verbatim from `cast.js`. No static `config.js` coupling — the demo/e2e
  leak canary is respected. Route is `await`-registered in `app.js` alongside cast.
- **app.ctx plumbing** mirrors cast exactly: `environmentsDir` resolved with the same
  default/override shape, decorated onto `app.ctx`, and the isolated-override child env
  line (`ENVIRONMENTS_DIR` only when the dir differs from `<root>/environments`) parallels
  the `PROFILES_DIR` line. Demo isolates it under `runs-demo/cast/environments`.
- **Layering**: routes never touch the engine directly; run creation threads through
  `run-service.createRun` → `--environment <slug>` CLI arg, and the recovery `plan(runId)`
  re-threads `m.environment` — parity with `--cast`. Manifest records it via `newManifest`.
- **Engine injection** (`src/lib/engine.js`): `loadEnvironment` throws on an unknown slug
  BEFORE any LLM spend (parity with `loadProfiles`); `buildCtx` is exported and enriches
  ctx with `environmentText/Name/Slug`; the environment block is appended LAST in
  `contextBlock` with explicit precedence-over-`## World & style` wording; `spec.environment`
  is stamped in both `runEngine` and `reviseSpec`. `isTextToVideoPlan` is byte-for-byte
  unchanged and deliberately does NOT receive `environment` — the render-mode coupling the
  spec flagged is respected (an environment enriches a TTV prompt, never flips render mode).
- **Spec schema**: `spec.environment` is an engine-stamped top-level key; `validateSpec`
  tolerates it exactly as it already tolerates top-level `spec.cast` (no schema change, as
  the spec directed).
- **API design**: `{error, hint}` error shape, `statusCode`/`hint` on thrown errors, 201 on
  create, 400 bad-name, 409 duplicate, 404 on missing — all consistent with cast. Client
  `api.ts` methods mirror the cast CRUD signatures.
- **Lifecycle**: the route opens no watchers/subscriptions/child processes — nothing to
  balance; no leak surface. `PUT`/`DELETE` guard the slug through `envPath` (SLUG_FILE),
  preventing path traversal on those routes.
- **Naming**: consistent throughout (`environmentsDir`, `ENVIRONMENTS_DIR`, `environment`
  slug, `EnvironmentView`/`EnvironmentsResponse`).
- **UI layering**: `EnvironmentCard` is text-only (accent-tinted `Mountain` badge, no
  `<img>`); editor routes live OUTSIDE `/cast/*` so they never shadow `/cast/:slug`;
  `CreateHero` "Set in" is single-select (`radiogroup`), hidden at zero environments,
  submit spreads `...(envSlug ? { environment } : {})` next to the cast spread.
- **Protected/read-only areas**: no proprietary cast assets touched. The bundled sample
  `environments/neon-city.md` is original synth-noir content, deliberately orthogonal to
  Wren's sea/lighthouse world (its `## Avoid` rejects sea/coast/daylight), and is added to
  `package.json` `files`. Docs (README/SETUP/web-README/CHANGELOG) updated; wording uses
  "before any LLM spend" and never calls planning "free" (policy respected).

## Findings (minor)

### M1 — Editor template uses `#` (h1) sub-headings; sample & spec use `##`
`web/ui/src/pages/Environment.tsx:19-20`. `TEMPLATE`/`PLACEHOLDER` seed the body with single
`#` headings (`# Light & atmosphere`, `# Palette`, `# Avoid`), whereas the shipped sample
`environments/neon-city.md` and the design spec use `##` sub-sections (`## Mood & tone`,
`## Avoid`, …). Two consequences: (a) a user who edits the sample and a user who creates
from the template get different heading conventions; (b) a template-seeded create saves a
file with multiple h1s (`# Name` then `# Light & atmosphere`), and because `excerptOf`
skips every `#`-prefixed line while the template's content lines are blank, the resulting
card renders the warn-colored "no description" nudge even though the user inserted the
template. Name derivation itself is NOT affected (the server's `displayName` picks the first
`# ` = the name). Cosmetic/consistency; align the template to `##` sub-headings.

### M2 — runs.js environment existence-check skips slug-shape validation (parity with cast)
`web/server/routes/runs.js:82`. The pre-LLM guard does
`fs.existsSync(path.join(app.ctx.environmentsDir, `${environment.trim()}.md`))` with no
SLUG_FILE shape check before the filesystem probe, so a `../`-laden value probes outside
`environmentsDir`. Harmless in practice — the value is then slug()-normalized by the engine's
`loadEnvironment`, so a traversal string never resolves to a real environment and the run
still throws before spend — and it is identical to the pre-existing, accepted cast guard a
few lines above. Noted only for defense-in-depth: the route module's own `envPath()` already
encapsulates SLUG_FILE validation that this cross-check could reuse for consistency.
