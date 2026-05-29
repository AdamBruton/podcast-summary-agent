# Modal hello-world — Phase 2a smoke test.
#
# Purpose: prove the Modal toolchain works end-to-end (auth → build a remote
# container → run a function in Modal's cloud → return a value to your laptop)
# BEFORE any GPU, model, or money is involved. This is CPU-only and runs for
# a few seconds, so it costs effectively nothing against the $30/mo free credit.
#
# This file is NOT part of the Node app and is NOT deployed to Railway. It's
# deployed/run separately to Modal. The Node pipeline will later call the real
# transcription worker (a sibling file) over HTTPS — never importing this code.
#
# Run it (ephemeral — spins up, runs, tears down, prints the result):
#     py -m modal run modal_worker/hello.py
#
# Note we invoke via `py -m modal` because the `modal` console script isn't on
# PATH in this Windows Python install; `py -m modal` always resolves correctly.

import modal

# An App is just a named namespace that groups functions together. The name
# shows up in your Modal dashboard (modal.com → Apps).
app = modal.App("podcast-hello")

# The image is the container filesystem your function runs inside, in Modal's
# cloud. For hello-world we need nothing beyond a base Python, so we use a
# slim Debian image pinned to a Python version. (The real WhisperX worker will
# add ffmpeg + torch + whisperx to an image like this.)
image = modal.Image.debian_slim(python_version="3.12")


# @app.function() marks this Python function to run REMOTELY in Modal's cloud,
# inside `image`. Without the decorator it'd just be a normal local function.
@app.function(image=image)
def hello(name: str = "world") -> str:
    # This body executes on a Modal container, not on your laptop. We import
    # inside the function and report a couple of facts that prove "this really
    # ran in the cloud" — the platform and the Python version of the container.
    import platform
    import sys
    return (
        f"hello {name} — this ran on Modal "
        f"({platform.system()} {platform.machine()}, Python {sys.version.split()[0]})"
    )


# @app.local_entrypoint() is the bit that runs on YOUR machine when you
# `modal run` this file. It orchestrates remote calls. `.remote()` invokes the
# function in the cloud and blocks until the result comes back; `.local()`
# (not used here) would run it on your laptop instead.
@app.local_entrypoint()
def main():
    print(hello.remote("podcast pipeline"))
