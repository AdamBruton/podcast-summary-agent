// Wrapper for the WhisperX-on-Modal transcription worker (the Phase 2d HTTPS
// endpoint). Audio podcasts have no captions, so their audio enclosure is
// transcribed by a GPU worker on Modal. The Node side only ever talks to it
// over HTTPS — it never imports the Python. Mirrors src/lib/transcript-io.js
// in shape so stage 2 can treat both media the same way.
//
// Auth: a shared bearer token. On the worker it's the Modal secret
// `transcribe-auth` (key TRANSCRIBE_SECRET); here it's MODAL_TRANSCRIBE_SECRET.
// Sent as `Authorization: Bearer <token>`.
//
// Contract (job-queue, because a 90-min episode is ~14 min of GPU work — far
// too long for one synchronous request):
//   POST {url}/transcribe { audio_url, clip_seconds? }  -> { call_id }
//   GET  {url}/result/{call_id} -> 200 { status:'done', result } when finished
//                                  202 { status:'pending' } while running
//                                  410 once Modal's result-retention lapses
//
// Returns { cues: [{start,end,text,speaker}], language, speakers } on success,
// or null if the worker produced no usable transcript. Throws on hard errors
// (missing config, auth, expiry, timeout, malformed response).

import { log } from './log.js';

// Poll cadence + ceiling. The GPU function itself times out at 1800s; a cold
// start (model download on first run) or a queue can push wall-clock past that,
// so the client ceiling sits comfortably beyond the worker timeout.
const POLL_INTERVAL_MS = 15_000;
const MAX_WAIT_MS = 40 * 60_000;   // 40 min hard ceiling

function config() {
  const url = process.env.MODAL_TRANSCRIBE_URL;
  const secret = process.env.MODAL_TRANSCRIBE_SECRET;
  if (!url) throw new Error('MODAL_TRANSCRIBE_URL not set');
  if (!secret) throw new Error('MODAL_TRANSCRIBE_SECRET not set');
  return { base: url.replace(/\/+$/, ''), secret };
}

// Submit an audio URL to the worker and poll until the transcript is ready.
// `clipSeconds` (optional) limits transcription to the first N seconds — only
// used for cheap validation runs; production passes nothing (full episode).
export async function fetchTranscriptFromModal(audio_url, { clipSeconds } = {}) {
  const { base, secret } = config();
  const auth = { Authorization: `Bearer ${secret}` };

  // 1. Submit the job — returns immediately with a call_id to poll.
  const body = { audio_url };
  if (clipSeconds != null) body.clip_seconds = clipSeconds;
  const submitRes = await fetch(`${base}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(body),
  });
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => '<unreadable>');
    throw new Error(`modal submit HTTP ${submitRes.status}: ${text.slice(0, 200)}`);
  }
  const submit = await submitRes.json();
  const call_id = submit?.call_id;
  if (!call_id) throw new Error('modal submit returned no call_id');
  log.info('modal transcribe submitted', { call_id });

  // 2. Poll for the result. First poll waits one interval — the job has only
  //    just been queued, so an immediate check would always be 202.
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(`${base}/result/${call_id}`, { headers: auth });

    if (res.status === 202) continue;                       // still running
    if (res.status === 410) {
      throw new Error(`modal result expired for call_id ${call_id}`);
    }
    if (res.status === 502) {
      // Worker classified the job as failed (the GPU function raised). The
      // body carries the remote error type + message — surface it verbatim.
      const detail = await res.json().catch(() => null);
      throw new Error(
        `modal job failed (${detail?.error_type || 'unknown'}): ` +
        `${detail?.error || '<no detail>'} [call_id ${call_id}]`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '<unreadable>');
      throw new Error(`modal result HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    if (data?.status !== 'done') continue;                  // defensive: 200 but not done
    return parseResult(data.result, call_id);
  }
  throw new Error(
    `modal transcribe timed out after ${Math.round(MAX_WAIT_MS / 60_000)} min (call_id ${call_id})`,
  );
}

// Map the worker payload to our cue contract. The worker returns
//   { language, segment_count, speakers, cues: [{start,end,text,speaker}], ... }
// `speaker` is an anonymous diarization label (SPEAKER_NN) or null.
function parseResult(result, call_id) {
  if (!result || !Array.isArray(result.cues)) {
    log.warn('modal result missing cues', {
      call_id,
      keys: result ? Object.keys(result) : null,
    });
    return null;
  }
  const cues = result.cues
    .filter(c => c && typeof c.text === 'string' && c.text.trim())
    .map(c => ({
      start:   Number(c.start) || 0,
      end:     Number(c.end) || 0,
      text:    c.text.trim(),
      speaker: c.speaker ?? null,
    }));
  if (cues.length === 0) return null;
  return {
    cues,
    language: result.language || 'en',
    speakers: Array.isArray(result.speakers) ? result.speakers : [],
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
