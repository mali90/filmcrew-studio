# Provenance — `tools/seamstitch`

Vendored from the author's private `jolly_dots_content_generation` repository (same copyright
holder, Muhammad Ali Mustafa). It is not third-party code: no upstream project, no separate
licence. It is covered by this repository's licence (`LICENSE`, FSL-1.1-MIT) like the rest of
the tree.

The package implements the two design documents vendored alongside it:
`SEAMLESS_STITCH_SPEC.md` and `SEAMLESS_STITCH_SPEC_ADDENDUM_AR.md`. Read those first — they
carry the offset math (§7.5), the colour-transform design (§7.3/§7.4), the AR-preserving
normalisation rules, and the verification gates.

It was validated in its home repo against **real generated footage** — the chained Kling render
under `runs/web-20260722215043-b1nx/renders/t1` — rather than by a synthetic Python test suite
(the `tests/` tree sketched in spec §4 was never built). In this repository the Node-side tests
are the coverage: `test/unit/stitch-math.test.js` is an independent JS re-derivation of
`graph.py`'s offset math, and `test/integration/seamstitch-cli.test.js` drives the real CLI over
ffmpeg-built chained fixtures.

`loopwrap.py` is currently unreferenced by anything this repo calls (`--loop` is not exposed by
the Node wrapper). It is kept deliberately, for a future seamless-loop delivery format.

Invocation is `-m` **with `PYTHONPATH` pointing at `tools/`** — the modules use relative
imports, so running a file directly will not work:

```
PYTHONPATH=<repoRoot>/tools python3 -m seamstitch SEG1 SEG2 -o OUT.mp4
```

## Local modifications

Kept minimal and confined to `__main__.py` and `graph.py`; `lut.py`, `verify.py`, `frames.py`,
`render.py`, `probe.py` and `loopwrap.py` are byte-identical to the source, so the numerics are
unchanged.

- `--json`: one machine-readable JSON object on stdout (all logs already went to stderr).
- `--joint-match` / `--joint-xfade`: per-joint continuity and per-joint crossfade length, so one
  run can stitch a chained joint seamlessly and hard-cut a scene change in the same timeline.
