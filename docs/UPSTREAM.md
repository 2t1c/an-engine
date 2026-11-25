# One clone per buyer

## Making a buyer's clone

1. Create a private repo `2t1c/pi-<buyer>` (empty).
2. Push this engine into it and keep the engine as `upstream`:
   ```sh
   git clone https://github.com/2t1c/an-engine pi-<buyer> && cd pi-<buyer>
   git remote rename origin upstream
   git remote add origin https://github.com/2t1c/pi-<buyer>
   git push -u origin main
   ```
3. Copy each `config/*.example.json` to `config/*.json`, fill it in, commit.
4. `npm run check` must pass, including the buyer config step.

## Taking an engine release into a clone

```sh
git fetch upstream main
git checkout -b engine-<version> && git merge --no-edit upstream/main
npm run check
```

Open it as one PR in the clone. A clone never edits engine files (`lib/`, `scripts/`, `tests/`,
`docs/`); a change that one buyer needs goes into the engine first, so every clone receives it. The
only files a clone owns are `config/*.json`.
