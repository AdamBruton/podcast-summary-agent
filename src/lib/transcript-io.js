// Wrapper for youtube-transcript.io — a third-party transcript API that
// runs the YouTube-interaction layer outside our infra. Solves the
// "yt-dlp from a Railway IP gets silently degraded" problem by letting
// us call a normal HTTP API instead of talking to YouTube directly.
//
// Auth: HTTP Basic with the token in the Authorization header.
// Endpoint: POST https://www.youtube-transcript.io/api/transcripts
// Body: { ids: ["videoId1", ...] }  (max 50 per request)
// Rate limit: 5 requests / 10 seconds (Retry-After respected on 429)
//
// The response shape isn't documented publicly. The parser tries the two
// shapes common to similar services and logs the raw body on first failure
// so we can quickly tighten if the actual shape differs.

import { log } from './log.js';

const API_URL = 'https://www.youtube-transcript.io/api/transcripts';
const RETRY_DEFAULT_S = 12;   // backoff if 429 and no Retry-After header

function authHeader() {
  const token = process.env.YOUTUBE_TRANSCRIPT_IO_TOKEN;
  if (!token) throw new Error('YOUTUBE_TRANSCRIPT_IO_TOKEN not set');
  return `Basic ${token}`;
}

// Fetch the transcript for a single video. Returns
//   { cues: [{start, end, text}], language }
// on success, or null if the API has no transcript for this video.
// Throws on HTTP errors other than "no transcript" (auth, rate limit
// after retry, malformed response).
export async function fetchTranscriptFromIO(video_id) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': authHeader(),
    },
    body: JSON.stringify({ ids: [video_id] }),
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') || RETRY_DEFAULT_S);
    log.warn(`transcript-io rate limited, sleeping ${retryAfter}s`);
    await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
    return fetchTranscriptFromIO(video_id);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`transcript-io HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return parseResponse(data, video_id);
}

// The API returns an array (one element per requested id). Each entry's
// transcript can be nested under several shapes seen across similar
// services. We try the known patterns in order and log the raw shape if
// none match so we can quickly add support for the real shape.
function parseResponse(data, video_id) {
  const entry = Array.isArray(data) ? data[0] : data;
  if (!entry) return null;

  // Shape A: { id, title, transcript: [{text, start, duration}] }
  // (youtube-transcript-api Python lib convention)
  if (Array.isArray(entry.transcript)) {
    return makeCues(entry.transcript, entry.language || 'en');
  }

  // Shape B: { id, tracks: [{ language, transcript: [{text, start, duration}] }] }
  if (Array.isArray(entry.tracks) && entry.tracks.length) {
    const track = entry.tracks.find(t => /^en/i.test(t.language || t.language_code || '')) || entry.tracks[0];
    if (Array.isArray(track?.transcript)) {
      return makeCues(track.transcript, track.language || track.language_code || 'en');
    }
  }

  // Shape C: { id, segments: [{text, start, duration}] }
  if (Array.isArray(entry.segments)) {
    return makeCues(entry.segments, entry.language || 'en');
  }

  // Shape D: { id, items: [{text, start, duration}] }
  if (Array.isArray(entry.items)) {
    return makeCues(entry.items, entry.language || 'en');
  }

  // Explicit "no transcript" / error sub-fields some APIs return.
  if (entry.error || entry.message || entry.errors) {
    log.info(`transcript-io: no transcript for ${video_id}`,
      { detail: entry.error || entry.message || entry.errors });
    return null;
  }

  // Unknown shape — log raw so we can add a parser for it.
  log.warn(`transcript-io: unknown response shape for ${video_id}; please add parser`, {
    keys: Object.keys(entry),
    sample: JSON.stringify(entry).slice(0, 400),
  });
  return null;
}

// Normalize segments → our cue shape. Segments arrive with {text, start, duration}
// (or sometimes {text, offset, duration} — offset = start in ms or s).
function makeCues(segments, language) {
  const cues = [];
  for (const s of segments) {
    if (!s || typeof s.text !== 'string') continue;
    const startRaw = s.start ?? s.offset ?? 0;
    const start = startRaw > 100_000 ? startRaw / 1000 : Number(startRaw);   // ms → s if huge
    const durRaw = s.duration ?? s.dur ?? 0;
    const dur = durRaw > 100_000 ? durRaw / 1000 : Number(durRaw);
    cues.push({
      start,
      end:  start + dur,
      text: s.text.trim(),
    });
  }
  if (cues.length === 0) return null;
  return { cues, language: language || 'en' };
}
