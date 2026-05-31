# Phases 2c + 2d — the real transcription worker: L4 GPU + large-v3 + word
# alignment + speaker diarization, plus the HTTPS endpoint the Node ingestion
# layer calls. Output cues match the data contract:
#   [{start, end, text, speaker}]
#
# Two ways to invoke:
#
#   1. Ephemeral, for local testing (Phase 2c):
#        $env:PYTHONUTF8=1
#        py -m modal run modal_worker/transcribe.py
#      Runs the local_entrypoint below against a short clip.
#
#   2. Deployed HTTPS endpoint (Phase 2d) — what the Node side actually uses:
#        py -m modal deploy modal_worker/transcribe.py
#      Publishes the FastAPI `web` app at a stable URL. See the Phase 2d
#      section at the bottom of this file for the request contract + auth.
#
# Cost: L4 is ~$0.000222/s. First GPU run also downloads ~4GB of models onto
# the cache Volume (one-time, on GPU time). Later runs reuse the Volume and
# skip the download.

import modal

app = modal.App("podcast-transcribe")

# Persistent Volume so model weights (whisper large-v3, wav2vec2 alignment,
# pyannote diarization) download ONCE and are reused across runs. Without this
# every cold start re-downloads multi-GB models on billed GPU time.
cache_vol = modal.Volume.from_name("whisperx-cache", create_if_missing=True)
CACHE_DIR = "/cache"

# GPU image: same proven recipe as the CPU test, but torch comes from the
# default (CUDA) index this time so it runs on the L4. HF_HOME/TORCH_HOME point
# at the Volume so all model downloads land in the persistent cache.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "torch==2.7.1",
        "torchaudio==2.7.1",
        "torchvision==0.22.1",
    )
    .pip_install("whisperx==3.7.2")
    .env({
        "HF_HOME": f"{CACHE_DIR}/huggingface",
        "TORCH_HOME": f"{CACHE_DIR}/torch",
    })
)

DEFAULT_AUDIO_URL = (
    "https://mgln.ai/e/1344/afp-848985-injected.calisto.simplecastaudio.com/"
    "3f86df7b-51c6-4101-88a2-550dba782de8/episodes/"
    "0a48e90e-2555-4245-b3b9-3957c98ab2c4/audio/128/default.mp3"
    "?aid=rss_feed&feed=JGE3yC0V"
)


@app.function(
    image=image,
    gpu="L4",
    volumes={CACHE_DIR: cache_vol},
    secrets=[modal.Secret.from_name("huggingface")],  # injects HF_TOKEN
    timeout=1800,
)
def transcribe(audio_url: str, clip_seconds: int | None = None) -> dict:
    import os
    import subprocess
    import tempfile
    import time
    import urllib.request

    # --- compatibility shims: must run BEFORE whisperx/pyannote load models ---
    import huggingface_hub
    # pyannote.audio 3.4 still passes the removed `use_auth_token=` kwarg to
    # hf_hub_download/snapshot_download; the newer huggingface_hub that
    # transformers requires renamed it to `token`. Translate so both coexist
    # (no single hf_hub version satisfies pyannote AND transformers).
    def _hf_compat(orig):
        def _wrapped(*args, **kwargs):
            if "use_auth_token" in kwargs:
                kwargs["token"] = kwargs.pop("use_auth_token")
            return orig(*args, **kwargs)
        return _wrapped
    for _fn in ("hf_hub_download", "snapshot_download"):
        setattr(huggingface_hub, _fn, _hf_compat(getattr(huggingface_hub, _fn)))

    import torch
    # torch 2.7 defaults torch.load to weights_only=True, which rejects the
    # pyannote checkpoints (trusted HF sources). Force the old behavior before
    # any model load. (Established in the 2b CPU test.)
    _orig_torch_load = torch.load
    def _torch_load_full(*args, **kwargs):
        kwargs["weights_only"] = False
        return _orig_torch_load(*args, **kwargs)
    torch.load = _torch_load_full

    import whisperx

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        raise RuntimeError("HF_TOKEN not set — is the 'huggingface' Modal secret attached?")

    device = "cuda"
    workdir = tempfile.mkdtemp()
    src = os.path.join(workdir, "audio.mp3")
    proc = os.path.join(workdir, "audio.wav")

    # 1. Download the episode audio.
    t0 = time.time()
    req = urllib.request.Request(audio_url, headers={"User-Agent": "podcast-agent/0.1"})
    with urllib.request.urlopen(req, timeout=300) as resp, open(src, "wb") as f:
        f.write(resp.read())

    # 2. Decode to 16kHz mono WAV; optionally clip the first N seconds (for
    #    cheap validation runs). ffmpeg with -t limits duration.
    ff = ["ffmpeg", "-y", "-i", src]
    if clip_seconds:
        ff += ["-t", str(clip_seconds)]
    ff += ["-ac", "1", "-ar", "16000", proc]
    subprocess.run(ff, check=True, capture_output=True)
    t_download = round(time.time() - t0, 1)

    # 3. Transcribe with large-v3 on the GPU.
    t1 = time.time()
    model = whisperx.load_model("large-v3", device, compute_type="float16")
    audio = whisperx.load_audio(proc)
    result = model.transcribe(audio, batch_size=16)
    language = result.get("language")
    t_transcribe = round(time.time() - t1, 1)

    # 4. Word-level alignment (precise timestamps) via wav2vec2 for the language.
    t2 = time.time()
    align_model, metadata = whisperx.load_align_model(language_code=language, device=device)
    result = whisperx.align(
        result["segments"], align_model, metadata, audio, device,
        return_char_alignments=False,
    )
    t_align = round(time.time() - t2, 1)

    # 5. Speaker diarization (who spoke when) + assign speakers to segments.
    #    DiarizationPipeline location moved across whisperx versions; try both.
    t3 = time.time()
    try:
        from whisperx.diarize import DiarizationPipeline, assign_word_speakers
    except ImportError:
        from whisperx import DiarizationPipeline, assign_word_speakers
    diarize_model = DiarizationPipeline(use_auth_token=hf_token, device=device)
    diarize_segments = diarize_model(audio)
    result = assign_word_speakers(diarize_segments, result)
    t_diarize = round(time.time() - t3, 1)

    # 6. Build contract-shaped cues. Each segment carries a majority "speaker"
    #    after assign_word_speakers (None if diarization couldn't attribute it).
    cues = [
        {
            "start": round(float(s["start"]), 2),
            "end": round(float(s["end"]), 2),
            "text": s.get("text", "").strip(),
            "speaker": s.get("speaker"),
        }
        for s in result.get("segments", [])
    ]
    speakers = sorted({c["speaker"] for c in cues if c["speaker"]})

    # Persist any newly downloaded model weights to the Volume for next time.
    cache_vol.commit()

    return {
        "language": language,
        "clip_seconds": clip_seconds,
        "segment_count": len(cues),
        "speakers": speakers,
        "timings_sec": {
            "download_decode": t_download,
            "transcribe": t_transcribe,
            "align": t_align,
            "diarize": t_diarize,
        },
        "cues": cues,
    }


@app.local_entrypoint()
def main(audio_url: str = DEFAULT_AUDIO_URL, clip_seconds: int = 300):
    out = transcribe.remote(audio_url, clip_seconds)
    t = out["timings_sec"]
    print(f"\n--- WhisperX GPU (large-v3 + diarization) ---")
    print(f"clip: {out['clip_seconds']}s | language: {out['language']} "
          f"| segments: {out['segment_count']} | speakers: {out['speakers']}")
    print(f"timings(s): download+decode={t['download_decode']} transcribe={t['transcribe']} "
          f"align={t['align']} diarize={t['diarize']}\n")
    for c in out["cues"][:25]:
        spk = c["speaker"] or "?"
        print(f"  [{c['start']:>7.1f}–{c['end']:>7.1f}] ({spk})  {c['text']}")
    if len(out["cues"]) > 25:
        print(f"  ... +{len(out['cues']) - 25} more segments")


# ---------------------------------------------------------------------------
# Phase 2d — HTTPS endpoint + shared secret.
#
# `py -m modal deploy modal_worker/transcribe.py` publishes the FastAPI app
# below at a stable HTTPS URL. The Node ingestion layer (Phase 3) POSTs an
# audio_url and polls for the result — it never imports this code, only talks
# HTTP.
#
# Why spawn + poll instead of one synchronous request: a 90-min episode is
# ~14 min of GPU work. Holding an HTTP connection open that long is fragile
# (client/proxy timeouts) and a dropped connection would re-run the job and
# burn GPU $. So we use Modal's job-queue pattern:
#     POST /transcribe      -> auth -> transcribe.spawn(...) -> {"call_id": id}
#     GET  /result/{id}     -> auth -> FunctionCall.from_id(id).get(timeout=0)
#                               -> 200 {"status":"done","result":{...}} when done
#                               -> 202 {"status":"pending"} while still running
#                               -> 410 once Modal's result-retention window lapses
#
# Auth is a shared bearer token. The expected value comes from the Modal secret
# `transcribe-auth` (key TRANSCRIBE_SECRET); the Node side sends it as
# `Authorization: Bearer <token>`. Create the secret once before deploying:
#     py -m modal secret create transcribe-auth TRANSCRIBE_SECRET=<random-hex>
# Generate a token with e.g. `python -c "import secrets;print(secrets.token_hex(32))"`.
#
# The web container is intentionally tiny (fastapi only, no torch) so it cold-
# starts fast and scales to zero — the expensive GPU image only spins up inside
# the spawned `transcribe` call.
# ---------------------------------------------------------------------------

web_image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "fastapi[standard]"
)


@app.function(
    image=web_image,
    secrets=[modal.Secret.from_name("transcribe-auth")],  # injects TRANSCRIBE_SECRET
)
@modal.concurrent(max_inputs=50)
@modal.asgi_app()
def web():
    import hmac
    import os

    from fastapi import FastAPI, Header, HTTPException
    from fastapi.responses import JSONResponse

    api = FastAPI(title="podcast-transcribe", version="2d")

    def _require_auth(authorization: str | None):
        expected = os.environ.get("TRANSCRIBE_SECRET")
        if not expected:
            # Worker misconfiguration, not a client error — make it loud (500)
            # rather than silently rejecting every request as unauthorized.
            raise HTTPException(500, "TRANSCRIBE_SECRET not configured on the worker")
        token = ""
        if authorization and authorization.lower().startswith("bearer "):
            token = authorization[len("bearer "):].strip()
        # constant-time compare so a wrong token can't be timing-probed.
        if not token or not hmac.compare_digest(token, expected):
            raise HTTPException(401, "missing or invalid bearer token")

    @api.post("/transcribe")
    def submit(body: dict, authorization: str | None = Header(default=None)):
        _require_auth(authorization)
        audio_url = (body or {}).get("audio_url")
        if not isinstance(audio_url, str) or not audio_url:
            raise HTTPException(400, "body must include a non-empty string 'audio_url'")
        clip_seconds = (body or {}).get("clip_seconds")
        if clip_seconds is not None and not isinstance(clip_seconds, int):
            raise HTTPException(400, "'clip_seconds' must be an integer or omitted")
        # Same-app reference: spawn the GPU function without blocking. Returns a
        # FunctionCall whose object_id the caller polls on /result.
        call = transcribe.spawn(audio_url, clip_seconds)
        return {"call_id": call.object_id}

    @api.get("/result/{call_id}")
    def result(call_id: str, authorization: str | None = Header(default=None)):
        _require_auth(authorization)
        function_call = modal.FunctionCall.from_id(call_id)
        try:
            out = function_call.get(timeout=0)
        except TimeoutError:
            # Not finished yet — 202 tells the poller to retry later.
            return JSONResponse({"status": "pending"}, status_code=202)
        except modal.exception.OutputExpiredError:
            # Modal discards results after its retention window; the caller must
            # resubmit rather than wait forever on a stale call_id.
            raise HTTPException(410, "result expired; resubmit the job")
        return {"status": "done", "result": out}

    return api
