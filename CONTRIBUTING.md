# Contributing to Filmcrew Studio

Thanks for your interest! This is a community project — issues and pull requests are welcome.

## Getting set up

You need **Node.js 20+** and **ffmpeg**. Then:

```bash
npm install && npm run web:install   # root + web/server + web/ui deps
npm --prefix web/ui run build
npm run web                          # the studio opens at http://127.0.0.1:5177
```

The full setup (keys, planners, backends) is documented in the [README](README.md) and
[docs/SETUP.md](docs/SETUP.md).

## Running the tests

Everything is mocked — tests run with **no keys, no network, and no spend**:

```bash
npm test                        # root engine/render/spec suites
npm --prefix web/server test    # web server
npm --prefix web/ui run test    # web UI (vitest)
npm --prefix web/ui run e2e     # optional: Playwright against the zero-spend demo server
```

CI runs all of these on Node 20 and 22. Please make sure the suites pass before opening a PR.

## Pull requests

- Branch off `main` and open your PR against `main`.
- Keep changes focused; match the style and comment density of the surrounding code.
- Add or update tests for behavior changes.

## Please never commit

This repo has a deliberate anti-leak `.gitignore`. Do **not** commit:

- `.env` or any real API keys/tokens.
- Character assets you don't have the rights to — profiles, reference images, or voice clips
  (`profiles/*.md`, `elements/references/*`, `voices/*.mp3`, `voices/voices.json`). The bundled **Wren**
  sample is the only cast that ships.

If you accidentally commit a secret, rotate it at the provider immediately and mention it in your PR so
the history can be cleaned.
