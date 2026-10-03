# Brief for agents working on diku3d in parallel

The shared brief every worker agent was given in the September 2026 rounds
(see LEARNINGS.md). Hand it over verbatim, plus a per-wave file listing who owns
what, and the agent's own task.

## Hard rules

- Work only in your own git worktree (`../diku3d-<name>`, branch
  `wave<N>-<name>`), never in the main checkout or another agent's worktree.
  The `merc21` submodule must be initialised there:
  `git -c protocol.file.allow=always submodule update --init --reference <main>/merc21`.
- Commit on your branch at solid milestones, in the repo's style (imperative,
  evocative subject; body explains why). Do not push or merge to main.
- Read CLAUDE.md fully first, and LEARNINGS.md for your topic.
- Do not edit LEARNINGS.md, README.md or CLAUDE.md — several branches editing
  them conflict. Put findings, traps and README-worthy changes in your final
  report; the coordinator writes the docs.
- Stay inside your file domain; tiny, self-contained hunks elsewhere only
  when unavoidable, and name them in the report.
- No runtime dependencies, nothing fetched at runtime, no hand-modelled or
  downloaded assets: models come from `tools/blender/*.py`.
- Before finishing: `git merge main` yourself (others land meanwhile),
  resolve keeping both sides, re-run every check and your key measurements.
  Kill your own server.

## Shared machines: no MCP browser, no MCP Blender

- Serve your worktree on your own port: `python3 serve.py <PORT> &`.
- Look with `tools/judge/headless/drive.mjs` (see its header for setup). Read
  PNGs to judge them; measure the composited frame with `tools/judge/probe.js`.
- Blender, headless and parallel-safe:
  `/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python-expr "import sys; sys.path.insert(0,'<WORKTREE>/tools/blender'); import build_all; build_all.run(only=['<module>'])"`.
  `lib.py` writes beside the script, so a worktree writes its own `assets/`.
  Render previews headless and look at them before exporting.

## Checks before calling anything done

    node --check src/*.js src/rules/*.js
    node tools/import-check.mjs
    node tools/parse-check.mjs
    node tools/layout-check.mjs      # Midgaard 93%, mean 94% — must not drop
    node tools/world-check.mjs
    node tools/game-check.mjs; node tools/magic-check.mjs; node tools/rules-check.mjs
    node tools/people-check.mjs; node tools/shell-check.mjs; node tools/clutter-check.mjs
    node tools/exit-check.mjs --strict   # "...0 with no door, ... (0 not barred)" and "strict: ok"

…plus screenshots at noon and dusk/night, near and mid-distance, draw calls,
triangles and frame time before vs after, and a zero-pixel diff with
`?cull=off` against on for anything that renders.

## Final report

Concise and factual: what was built (files, functions, assets, API), measured
before/after numbers, screenshot paths, known remaining faults, learnings and
traps, README-worthy changes. Everything committed on the branch.
