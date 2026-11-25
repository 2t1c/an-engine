# Architecture

## The model

- **Buyer:** a solo health affiliate operator. Owns the X pages, Typefully, Levanta, Airtable and Telegram.
- **Operator:** runs the engine for the buyer (writing happens in the operator's Claude sessions, never
  through a model API) and hosts it: Railway for the cron and the clipper, n8n for the RT ladder flows.
- **Profit share:** Levanta commission on the buyer's account, minus the costs named in
  `config/engine.json` `profitShare.costs`, split at `profitShare.operatorPct` (50 by default).
- **RT ladder:** funded from a starting budget the buyer gives the operator; one RT bot per buyer.
- **Data:** the buyer receives the machinery, the CTA templates, 3 seeds, a daily copy of the
  operator's swipe threads, and a weekly high-level report. The operator's ledger, learnings, product
  data and other seeds never enter a clone.

## Where buyer-specific things live

| Thing | Place |
|---|---|
| Buyer name, time zone, posting window, profit split, features | `config/engine.json` |
| X pages (handle, Typefully set, subid prefix, RT lane) | `config/pages.json` |
| Product shelf | `config/products.json` (built from the buyer's Levanta catalogue) |
| Airtable table and record ids | `config/airtable.json` (written by the schema script) |
| Telegram topic ids, staging page | `config/engine.json` `telegram`, `burner` |
| Credentials | Railway variables on the buyer's cron service; names in `lib/secrets.mjs` |

Nothing else may hold an id, handle or chat id. `npm run check:leftovers` enforces the patterns
(Airtable and Telegram ids); the operator runs it with `LEFTOVER_DENYLIST` pointing at a private term
list (its own handles, set ids, subids) before every release, so the list itself never ships.

## Build plan

1. Skeleton: config layer, secrets contract, leftover-ID check
2. Core code: the live modules ported and pointed at config; operator data blanked
3. Skills: the daily run (short current guide) and the seed farm, 3 seeds, substance cards
4. Money: Levanta shelf builder, minting, link sentinel, CTA templates
5. Data: Airtable schema script, daily swipe copy, registry, facts, followers, weekly + profit-share report
6. Reach: publish retry, RT ladder n8n templates per buyer, hook clips
7. Ops: Telegram, brief routine, sweep, Railway cron, onboarding
8. Proof: full dry run on blank test accounts, SETUP.md and OPERATOR.md
