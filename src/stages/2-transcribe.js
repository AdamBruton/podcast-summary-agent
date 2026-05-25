// Stage 2: Transcribe.
//
// Single source: youtube-transcript.io. They handle the YouTube interaction
// layer (proxies, auth, scraping) from their infra, so we sidestep the
// "yt-dlp from a Railway IP gets silently degraded" problem entirely.
//
// No fallback. Episodes whose transcript isn't returned by the API are
// marked 'skipped' with a clear reason. Acceptable tradeoff for the
// reliability + zero-vendor-management gain.

import { fetchTranscriptFromIO } from '../lib/transcript-io.js';
import { saveTranscript, getTranscript, setEpisodeStatus } from '../lib/db.js';
import { log } from '../lib/log.js';

export async function transcribeEpisode(episode) {
  const existing = getTranscript(episode.video_id);
  if (existing) {
    log.info('transcript cached', { video_id: episode.video_id, source: existing.source });
    return existing;
  }

  let result;
  try {
    result = await fetchTranscriptFromIO(episode.video_id);
  } catch (err) {
    log.warn('transcript-io fetch failed', { video_id: episode.video_id, err: err.message });
    setEpisodeStatus(episode.video_id, 'skipped', `transcript-io error: ${err.message}`);
    return null;
  }

  if (!result || !result.cues?.length) {
    log.warn('no transcript available', { video_id: episode.video_id });
    setEpisodeStatus(episode.video_id, 'skipped', 'no transcript from youtube-transcript.io');
    return null;
  }

  saveTranscript({
    video_id:     episode.video_id,
    source:       'transcript-io',
    language:     result.language,
    duration_sec: episode.duration_sec,
    cues:         result.cues,
  });
  log.ok('transcript fetched', {
    video_id: episode.video_id,
    cues:     result.cues.length,
    lang:     result.language,
  });
  return getTranscript(episode.video_id);
}
