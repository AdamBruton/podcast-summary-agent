# Phase 2b — WhisperX on CPU, tiny model, short clip. CHEAP PROOF, no GPU.
#
# Goal: validate the WhisperX transcription code path + the image build on
# cheap CPU before we touch a GPU or pay anything meaningful. We deliberately:
#   - use the `tiny` model (fast, low quality — quality is a 2c concern)
#   - clip to the first 60s of audio (don't wait on slow CPU transcription)
#   - do TRANSCRIPTION ONLY: no word-alignment, no diarization. Diarization is
#     2c and is the part that needs the gated pyannote models + HF token.
#
# Run:
#     $env:PYTHONUTF8=1            # Windows: stops Modal's ✓ glyphs crashing the console
#     py -m modal run modal_worker/whisperx_cpu_test.py
#
# Output: the first transcript segments ({start,end,text}) — a preview of the
# cue contract our DB expects (speaker gets added in 2c).

import modal

app = modal.App("podcast-whisperx-cpu-test")

# CPU-only image. We install torch/torchaudio/torchvision from PyTorch's CPU
# wheel index (no CUDA → much smaller, faster build) and pin the matched trio
# torch 2.6.0 / torchaudio 2.6.0 / torchvision 0.21.0, then whisperx on top.
# `import whisperx` pulls in torch/torchaudio (alignment) and pyannote
# (diarization) at module load, so those must be present even though this test
# only runs the faster-whisper transcription path.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        # Matched CPU trio for torch 2.7.1 (whisperx 3.7.2 requires torch>=2.7.1).
        # Pinning the whole trio from the CPU index keeps versions consistent and
        # stops the whisperx install from pulling a mismatched/CUDA torch over it.
        "torch==2.7.1",
        "torchaudio==2.7.1",
        "torchvision==0.22.1",
        index_url="https://download.pytorch.org/whl/cpu",
    )
    .pip_install("whisperx==3.7.2")
)

# A real audio_url from your ingested podcasts (a16z, ~12 min). We clip to 60s.
DEFAULT_AUDIO_URL = (
    "https://mgln.ai/e/1344/afp-848985-injected.calisto.simplecastaudio.com/"
    "3f86df7b-51c6-4101-88a2-550dba782de8/episodes/"
    "0a48e90e-2555-4245-b3b9-3957c98ab2c4/audio/128/default.mp3"
    "?aid=rss_feed&feed=JGE3yC0V"
)


@app.function(image=image, cpu=2.0, memory=4096, timeout=900)
def transcribe_cpu_test(audio_url: str, clip_seconds: int = 60) -> dict:
    import subprocess
    import tempfile
    import urllib.request
    import os
    import torch
    import whisperx

    # torch 2.6+ flipped torch.load's `weights_only` default to True, which
    # rejects the pyannote VAD/diarization checkpoints whisperx loads (they
    # embed omegaconf objects). These checkpoints come from the official
    # pyannote HF repos (trusted), so we restore the old behavior. Must run
    # before any whisperx model load.
    _orig_torch_load = torch.load
    def _torch_load_full(*args, **kwargs):
        # Force, don't setdefault: lightning_fabric (used by pyannote) passes
        # weights_only=True explicitly, so a setdefault wouldn't override it.
        kwargs["weights_only"] = False
        return _orig_torch_load(*args, **kwargs)
    torch.load = _torch_load_full

    workdir = tempfile.mkdtemp()
    src = os.path.join(workdir, "full.mp3")
    clip = os.path.join(workdir, "clip.wav")

    # Download the episode. urllib follows the mgln.ai → simplecast redirect;
    # a real User-Agent avoids the occasional CDN that rejects the default one.
    req = urllib.request.Request(audio_url, headers={"User-Agent": "podcast-agent/0.1"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(src, "wb") as f:
        f.write(resp.read())
    downloaded_mb = round(os.path.getsize(src) / 1_048_576, 1)

    # Clip the first N seconds and normalize to 16kHz mono WAV (what ASR wants).
    subprocess.run(
        ["ffmpeg", "-y", "-i", src, "-t", str(clip_seconds),
         "-ac", "1", "-ar", "16000", clip],
        check=True, capture_output=True,
    )

    # Transcribe on CPU. compute_type="int8" is the CPU-friendly quantization.
    model = whisperx.load_model("tiny", device="cpu", compute_type="int8")
    audio = whisperx.load_audio(clip)
    result = model.transcribe(audio, batch_size=8)

    segments = [
        {"start": round(s["start"], 2), "end": round(s["end"], 2), "text": s["text"].strip()}
        for s in result.get("segments", [])
    ]
    return {
        "downloaded_mb": downloaded_mb,
        "clip_seconds": clip_seconds,
        "language": result.get("language"),
        "segment_count": len(segments),
        "segments": segments,
    }


@app.local_entrypoint()
def main(audio_url: str = DEFAULT_AUDIO_URL, clip_seconds: int = 60):
    out = transcribe_cpu_test.remote(audio_url, clip_seconds)
    print(f"\n--- WhisperX CPU test ---")
    print(f"downloaded: {out['downloaded_mb']} MB | clipped: {out['clip_seconds']}s "
          f"| language: {out['language']} | segments: {out['segment_count']}\n")
    for s in out["segments"]:
        print(f"  [{s['start']:>6.1f}–{s['end']:>6.1f}]  {s['text']}")
