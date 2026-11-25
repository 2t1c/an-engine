#!/usr/bin/env python3
"""clipgpu.py — the client side of the clipping pipeline's Modal app (modal_app.py).

    python3 clipgpu.py clip RECIPE.json          # like `filmcraft-cli clip RECIPE.json`, rendered on Modal
    python3 clipgpu.py hear IN.mp4 OUT.json       # the heard words of IN's audio, on a Modal T4
    python3 clipgpu.py check                      # is the app deployed and are the tokens set?

`clip` uploads the recipe's source, fonts, caption presets and every other local file it names, renders on Modal,
writes the mp4 to the recipe's own `out` and prints FilmCraft's result JSON with `path` pointing at that file, so
clip-thread.mjs reads it exactly like a local run. Needs `pip install 'modal[api-proxy-support]'`, ffmpeg (hear),
and MODAL_TOKEN_ID / MODAL_TOKEN_SECRET in the environment. Exit 3 means Modal could not be used (not installed,
no tokens, not deployed); the caller falls back to the local CPU path then.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

APP = "clipgpu"
SR = 16000
UNAVAILABLE = 3


def _modal():
    if not (os.environ.get("MODAL_TOKEN_ID") and os.environ.get("MODAL_TOKEN_SECRET")) and not (Path.home() / ".modal.toml").exists():
        raise LookupError("no Modal tokens (MODAL_TOKEN_ID / MODAL_TOKEN_SECRET)")
    try:
        import modal
    except ImportError as e:
        raise LookupError("modal is not installed: pip install 'modal[api-proxy-support]'") from e
    return modal


def pcm16k(path):
    """The file's audio as 16 kHz mono s16le, the input Whisper wants (and a fraction of the video's size)."""
    return subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
                          capture_output=True, check=True).stdout


def hear_words(path, model="small.en", language="en"):
    """[{start, end, text}] heard on Modal, the same shape reel-words.py's CPU `heard` returns."""
    modal = _modal()
    try:
        cls = modal.Cls.from_name(APP, "Hear")
    except modal.exception.NotFoundError as e:
        raise LookupError("the clipgpu app is not on Modal: modal deploy tools/clipgpu/modal_app.py") from e
    call = cls(model_name=model).words.spawn(pcm16k(path), language)
    try:  # a cold GPU start is ~30 s; past the limit the caller hears on its own CPU instead of waiting
        r = call.get(timeout=float(os.environ.get("CLIPGPU_HEAR_TIMEOUT", "240")))
    except TimeoutError:
        call.cancel()
        raise
    return r["words"], r["seconds"]


def _rewrite(recipe):
    """The recipe with every local file or folder it names moved under /work/in, and the files to send."""
    files, seen = {}, {}

    def remote(p):
        p = Path(p).resolve()
        if p in seen:
            return seen[p]
        dest = f"/work/in/{len(seen)}/{p.name}"
        seen[p] = dest
        if p.is_dir():
            for f in sorted(p.rglob("*")):
                if f.is_file() and f.stat().st_size < 64 << 20:
                    files[f"{dest}/{f.relative_to(p)}"] = f.read_bytes()
        else:
            files[dest] = p.read_bytes()
        return dest

    def walk(v, k=None):
        if isinstance(v, dict):
            return {kk: walk(vv, kk) for kk, vv in v.items()}
        if isinstance(v, list):
            return [walk(x) for x in v]
        if isinstance(v, str) and k not in ("out", "text") and v.startswith(("/", "~", "./", "../")) and len(v) > 2 \
                and Path(v).expanduser().exists() and Path(v).expanduser().resolve() not in (Path("/"), Path.home()):
            return remote(Path(v).expanduser())
        return v

    out = walk(recipe)
    out["out"] = f"/work/out/{Path(recipe['out']).name}"
    return out, files


def clip(recipe_path):
    modal = _modal()
    recipe = json.loads(Path(recipe_path).read_text())
    remote_recipe, files = _rewrite(recipe)
    try:
        fn = modal.Function.from_name(APP, "clip")
    except modal.exception.NotFoundError as e:
        raise LookupError("the clipgpu app is not on Modal: modal deploy tools/clipgpu/modal_app.py") from e
    t0 = time.time()
    call = fn.spawn(remote_recipe, files)
    try:
        r = call.get(timeout=float(os.environ.get("CLIPGPU_CLIP_TIMEOUT", "900")))
    except TimeoutError:
        call.cancel()
        raise
    out = Path(recipe["out"]).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(r["mp4"])
    result = dict(r["result"], path=str(out), onModal={"seconds": round(r["seconds"], 1), "roundTrip": round(time.time() - t0, 1),
                                                         "sentMB": round(sum(len(b) for b in files.values()) / 1e6, 1)})
    print(json.dumps(result, indent=1))


def main(argv):
    if not argv or argv[0] not in ("clip", "hear", "check"):
        sys.exit(__doc__)
    try:
        if argv[0] == "clip":
            clip(argv[1])
        elif argv[0] == "hear":
            t0 = time.time()
            words, on = hear_words(argv[1], *(argv[3:4] or []))
            Path(argv[2]).write_text(json.dumps(words))
            print(json.dumps({"words": len(words), "seconds": round(time.time() - t0, 1), "onGpu": round(on, 1)}))
        else:
            modal = _modal()
            modal.Function.from_name(APP, "clip").hydrate()
            modal.Cls.from_name(APP, "Hear").hydrate()
            print("clipgpu is deployed and reachable")
    except LookupError as e:
        print(f"clipgpu: {e}", file=sys.stderr)
        sys.exit(UNAVAILABLE)


if __name__ == "__main__":
    main(sys.argv[1:])
