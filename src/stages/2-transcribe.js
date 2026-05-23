// Stage 2: Transcribe.
//
// Strategy: try YouTube auto-captions first (free, fast). If unavailable,
// fall back to Groq Whisper API (cheap, fast, no native build). If no
// Groq key is set, log and skip — the episode marks as 'skipped'.

import fs from 'node:fs';
import path from 'node:path';
import Groq from 'groq-sdk';
import { saveTranscript, getTranscript, setEpisodeStatus } from '../lib/db.js';
import { fetchCaptions, downloadAudio } from '../lib/youtube.js';
import { log } from '../lib/log.js';

export async function transcribeEpisode(episode) {
  const existing = getTranscript(episode.video_id);
  if (existing) {
    log.info('transcript cached', { video_id: episode.video_id, source: existing.source });
    return existing;
  }

  // Try captions first.
  const caps = await fetchCaptions(episode.video_id);
  if (caps && caps.cues.length > 0) {
    saveTranscript({
      video_id: episode.video_id,
      source: 'captions',
      language: caps.language,
      duration_sec: episode.duration_sec,
      cues: caps.cues,
    });
    log.ok('captions', { video_id: episode.video_id, cues: caps.cues.length, lang: caps.language });
    return getTranscript(episode.video_id);
  }

  // Whisper fallback.
  if (!process.env.GROQ_API_KEY) {
    log.warn('no captions and no GROQ_API_KEY; skipping', { video_id: episode.video_id });
    setEpisodeStatus(episode.video_id, 'skipped', 'no_transcript_no_groq_key');
    return null;
  }

  log.info('falling back to Whisper (Groq)', { video_id: episode.video_id });
  const cues = await transcribeWithGroq(episode);
  if (!cues) return null; // status already marked 'skipped' inside transcribeWithGroq
  saveTranscript({
    video_id: episode.video_id,
    source: 'whisper',
    language: 'en',
    duration_sec: episode.duration_sec,
    cues,
  });
  return getTranscript(episode.video_id);
}

const GROQ_FILE_LIMIT = 25 * 1024 * 1024; // 25MB upload cap on Groq audio endpoint

async function transcribeWithGroq(episode) {
  const audioPath = await downloadAudio(episode.video_id);
  try {
    const size = fs.statSync(audioPath).size;
    if (size > GROQ_FILE_LIMIT) {
      const reason = `audio file ${(size / 1e6).toFixed(1)}MB exceeds Groq 25MB upload limit`;
      log.warn(reason, { video_id: episode.video_id, audioPath });
      setEpisodeStatus(episode.video_id, 'skipped', reason);
      return null;
    }
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const resp = await groq.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-large-v3-turbo',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });
    return (resp.segments || []).map(s => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
    }));
  } finally {
    try { fs.unlinkSync(audioPath); } catch {}
  }
}
