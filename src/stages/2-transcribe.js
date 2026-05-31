// Stage 2: Transcribe — medium-aware router.
//
//   medium=youtube  -> youtube-transcript.io (captions; the vendor handles the
//                      YouTube-interaction layer from their infra, so we
//                      sidestep the "yt-dlp from a Railway IP gets silently
//                      degraded" problem).
//   medium=podcast  -> WhisperX-on-Modal HTTPS worker. Audio podcasts have no
//                      captions at all, so we transcribe+diarize the audio.
//
// Both branches write the SAME cue contract into `transcripts`; only the
// `source` tag and (for podcasts) the per-cue `speaker` differ. No fallback in
// either branch — an episode whose transcript can't be produced is marked
// 'skipped' with a clear reason (the daily run accepts missed episodes over
// operational complexity).

import { fetchTranscriptFromIO } from '../lib/transcript-io.js';
import { fetchTranscriptFromModal } from '../lib/modal-transcribe.js';
import { saveTranscript, getTranscript, setEpisodeStatus } from '../lib/db.js';
import { log } from '../lib/log.js';

export async function transcribeEpisode(episode) {
  const existing = getTranscript(episode.video_id);
  if (existing) {
    log.info('transcript cached', { video_id: episode.video_id, source: existing.source });
    return existing;
  }

  const isPodcast = episode.medium === 'podcast';
  const source = isPodcast ? 'whisperx-modal' : 'transcript-io';

  let result;
  try {
    result = isPodcast
      ? await transcribePodcast(episode)
      : await fetchTranscriptFromIO(episode.video_id);
  } catch (err) {
    log.warn('transcribe failed', {
      video_id: episode.video_id,
      medium: episode.medium || 'youtube',
      err: err.message,
    });
    setEpisodeStatus(episode.video_id, 'skipped', `${source} error: ${err.message}`);
    return null;
  }

  if (!result || !result.cues?.length) {
    log.warn('no transcript available', {
      video_id: episode.video_id,
      medium: episode.medium || 'youtube',
    });
    setEpisodeStatus(episode.video_id, 'skipped', `no transcript from ${source}`);
    return null;
  }

  saveTranscript({
    video_id:     episode.video_id,
    source,
    language:     result.language,
    duration_sec: episode.duration_sec,
    cues:         result.cues,
  });
  log.ok('transcript fetched', {
    video_id: episode.video_id,
    source,
    cues:     result.cues.length,
    lang:     result.language,
    speakers: result.speakers?.length || undefined,
  });
  return getTranscript(episode.video_id);
}

// Podcast branch: hand the audio enclosure URL to the Modal WhisperX worker.
// Guard the precondition (audio_url must be present) BEFORE spending a slow,
// billed GPU job — a podcast row with no audio_url is a data problem upstream.
async function transcribePodcast(episode) {
  if (!episode.audio_url) {
    throw new Error('podcast episode has no audio_url');
  }
  return fetchTranscriptFromModal(episode.audio_url);
}
