# an-engine

The engine behind a licensed health-thread affiliate operation on X. A buyer owns the pages and the
accounts; the operator runs the engine for them on operator hosting, for a share of the profit.

**One clone per buyer.** This repository is the template. Each buyer gets a private clone
(`pi-<buyer>`) that adds only its own `config/*.json`; engine updates reach every clone as one merge
per release (see [docs/UPSTREAM.md](docs/UPSTREAM.md)).

## What is in it

| Area | What it does | Status |
|---|---|---|
| Core code | The live engine: run helpers, gates, picker, hot list, links, farm, reach, data jobs, pointed at config | **Ported (PR 2)** |
| Daily run | One brief a day, approved once, then written, gated, scheduled and read back (the skill) | Planned (PR 3) |
| Seed farm | Seed, pot and harvest skills; ships with 3 seeds | Planned (PR 3) |
| Money | CTA templates, product shelf from the buyer's Levanta catalogue, link minting and sentinel | Planned (PR 4) |
| Data | Airtable schema, daily swipe copy, registry, nightly facts, followers, weekly report + profit share | Planned (PR 5) |
| Reach | Publish retry, RT tier ladder (n8n), hook clips | Planned (PR 6) |
| Ops | Telegram, daily brief routine, sweep, Railway cron, page onboarding | Planned (PR 7) |
| Config + secrets | Buyer config layer, secrets contract, leftover-ID check | **Done (PR 1)** |

## Commands

```sh
npm test                  # unit tests
npm run check             # every gate: tests, example config, leftover ids (+ buyer config in a clone)
npm run check:config      # validate config/*.json in a buyer's clone
npm run secrets:status    # which secrets are set (never their values)
npm run check:leftovers   # no operator or other-buyer ids in tracked files
```

Node 22 or newer. `npm ci` installs the runtime dependencies.

## Layout

```
config/   *.example.json — copied and filled in a buyer's clone (engine, pages, products, airtable)
*.mjs     the engine's modules and command-line tools (ported from the live operation)
*.json    rules and shapes (laws, molds, hooks, topics); operator data ships empty
lib/      config.mjs (load + validate), secrets.mjs (the contract), leftovers.mjs (the id check)
scripts/  command-line entry points
tests/    node:test suites
docs/     architecture and the clone/upstream procedure
```
