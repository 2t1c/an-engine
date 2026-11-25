"""The clipping pipeline's hearing and captioning on Modal, so the Mac only fetches.

    modal deploy tools/clipgpu/modal_app.py       # once, and after a FilmCraft or reel-words.py change
    CLIPS_ON=modal node clip-thread.mjs ...     # hook clips render on Modal

Two functions:

- `hear` (T4 GPU): faster-whisper with word timestamps on the window's audio, the very model reel-words.py runs on
  the CPU (small.en), in float16 on CUDA. The client sends 16 kHz mono PCM (about 2 MB a minute, not the video), so
  the upload is small; matching the heard words to the transcript stays on the client (it is instant).
- `clip` (CPU only, no GPU): `filmcraft-cli clip <recipe>`, the same FilmCraft that burns the captions and watermark
  on the Mac. FilmCraft's encoder is software on Linux (its NVENC path is Windows only), so a GPU would sit idle;
  the win is cores and parallel reels: a batch's reels all render at once instead of three at a time on the Mac.

Cost: Modal bills by the second only while a container runs (T4 ≈ $0.59/h; CPU ≈ $0.047 per core-hour). Containers
stay warm `SCALEDOWN` seconds for the next reel of the batch, then stop and nothing is billed. The Whisper weights
live in the `clipgpu-cache` volume, so only the first call ever downloads them.

The FilmCraft binary is built from 2t1c/filmcraft on Ubuntu 24.04 (this image's base) and passed in with
`CLIPGPU_FILMCRAFT=/path/to/filmcraft-cli` at deploy time.
"""
import os
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
APP = "clipgpu"
GPU = "T4"
CPUS = 8.0
SCALEDOWN = 120  # seconds a warm container waits for the next reel before it stops (and stops billing)
CACHE = "/cache"
FILMCRAFT = os.environ.get("CLIPGPU_FILMCRAFT", "")

hear_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("faster-whisper==1.1.1", "requests", "nvidia-cublas-cu12==12.4.5.8", "nvidia-cudnn-cu12==9.1.0.70", "numpy<2.3")
    .env({"HF_HOME": f"{CACHE}/hf",
          # CTranslate2 finds cuBLAS/cuDNN in the pip wheels
          "LD_LIBRARY_PATH": "/usr/local/lib/python3.11/site-packages/nvidia/cublas/lib:"
                             "/usr/local/lib/python3.11/site-packages/nvidia/cudnn/lib"})
)

clip_image = modal.Image.from_registry("ubuntu:24.04", add_python="3.11")
if FILMCRAFT:
    clip_image = clip_image.add_local_file(FILMCRAFT, "/usr/local/bin/filmcraft-cli", copy=True).run_commands(
        "chmod +x /usr/local/bin/filmcraft-cli")

cache = modal.Volume.from_name("clipgpu-cache", create_if_missing=True)
app = modal.App(APP)


@app.cls(image=hear_image, gpu=GPU, cpu=2.0, memory=8192, timeout=900, scaledown_window=SCALEDOWN, volumes={CACHE: cache})
class Hear:
    model_name: str = modal.parameter(default="small.en")

    @modal.enter()
    def load(self):
        from faster_whisper import WhisperModel
        self.model = WhisperModel(self.model_name, device="cuda", compute_type="float16")
        cache.commit()

    @modal.method()
    def words(self, pcm: bytes, language: str = "en") -> dict:
        """[{start, end, text}] heard in 16 kHz mono s16le PCM, as reel-words.py's `heard` returns them."""
        import time

        import numpy as np
        t0 = time.time()
        audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768
        segs, _ = self.model.transcribe(audio, word_timestamps=True, language=language, vad_filter=False)
        words = [{"start": round(w.start, 3), "end": round(w.end, 3), "text": w.word.strip()}
                 for s in segs for w in s.words if w.word.strip()]
        return {"words": words, "seconds": time.time() - t0}


@app.function(image=clip_image, cpu=CPUS, memory=8192, timeout=1200, scaledown_window=SCALEDOWN)
def clip(recipe: dict, files: dict) -> dict:
    """Runs `filmcraft-cli clip` on a recipe whose paths point into /work (the client rewrote them) and the files it
    names, keyed by those paths. Returns FilmCraft's result and the finished mp4."""
    import json
    import subprocess
    import time

    t0 = time.time()
    for path, data in files.items():
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    Path(recipe["out"]).parent.mkdir(parents=True, exist_ok=True)
    rp = Path("/work/recipe.json")
    rp.write_text(json.dumps(recipe))
    run = subprocess.run(["filmcraft-cli", "clip", str(rp)], capture_output=True, text=True)
    if run.returncode:
        raise RuntimeError(f"filmcraft-cli clip exit {run.returncode}: {(run.stderr or run.stdout).strip()[-600:]}")
    text = run.stdout.strip()
    start = next((i for i, line in enumerate(text.splitlines()) if line.startswith("{")), None)
    result = json.loads("\n".join(text.splitlines()[start:])) if start is not None else {}
    return {"result": result, "mp4": Path(recipe["out"]).read_bytes(), "seconds": time.time() - t0}
