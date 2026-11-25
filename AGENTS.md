# AGENTS.md

## Rules

1. **Engine stays neutral.** No ids, handles, Telegram chat ids, Typefully set ids or product lists
   outside `config/`. `npm run check:leftovers` must pass; before a release, run it again with
   `LEFTOVER_DENYLIST` set to the operator's private term list.
2. **Secrets go through `lib/secrets.mjs`.** A new credential is added to `SECRETS` and to
   `.env.example` (a test keeps them in step). Never print or log a value.
3. **Config goes through `lib/config.mjs`.** A new config field gets a validator line and a test.
4. **Gates:** `npm run check` (tests, example config, leftover ids) passes on every commit.
5. **Never crash on bad input.** Validate and report every problem at once; don't throw on the first.
6. **Writing is done in Claude sessions,** never through a model API from engine code.
7. **Commits:** one PR per build stage (see `docs/ARCHITECTURE.md`); merge commits.
