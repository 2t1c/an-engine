# CLAUDE.md

Read `AGENTS.md` first. This repo is the engine template; buyers run private clones of it.

- **Nothing buyer- or operator-specific in engine files.** Ids, handles, chat ids and products go in
  `config/*.json` (a clone's) or Railway variables, never in `lib/`, `scripts/`, `docs/` or examples.
- **Run `npm run check` before every commit.** It must pass.
- Reply style: lead with the result, bullets and tables, bold the load-bearing words, no narration.
