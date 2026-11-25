# clipgpu

Optional GPU path for hook clips: the same FilmCraft render and the caption pass, run on Modal
instead of the clipper service. `clip-thread.mjs` uses it when `CLIPS_ON=modal`, and falls back to
the clipper service (`CLIPPER_URL`) on any failure.

```sh
python3 tools/clipgpu/clipgpu.py check                                   # deployed and reachable?
CLIPGPU_FILMCRAFT=/path/to/filmcraft-cli modal deploy tools/clipgpu/modal_app.py   # once, and after a FilmCraft change
```

Operator-hosted: the Modal account and its cost belong to the operator and pass through before the
profit split.
