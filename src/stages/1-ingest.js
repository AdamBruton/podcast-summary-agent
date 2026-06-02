// Stage 1: Ingest.
//
// Entry points:
//   ingestEpisode(url)        — ad-hoc single episode, medium-agnostic:
//                               YouTube video URL OR podcast (audio/feed/page) URL
//   ingestDaily(opts)         — daily run, polls all configured YouTube channels
//   ingestPodcastsDaily(opts) — daily run, polls all configured podcast RSS feeds
//
// All return arrays of episode rows. Dedup is via SQLite (video_id PK).

import { loadSources } from '../lib/config.js';
import { upsertEpisode, getEpisode } from '../lib/db.js';
import { fetchMetadata, listChannelUploads, videoIdFromUrl, resolveHandle } from '../lib/youtube.js';
import { pollPodcasts } from '../lib/rss.js';
import { resolvePodcastEpisode } from '../lib/podcast-resolve.js';
import { log } from '../lib/log.js';

// Ad-hoc single-episode ingest. Auto-detects medium: anything that parses as a
// YouTube video ID goes the YouTube route; everything else is treated as a
// podcast URL (direct audio, RSS feed, or an episode page we scrape).
export async function ingestEpisode(url) {
  const video_id = videoIdFromUrl(url);
  return video_id ? ingestYouTubeEpisode(url, video_id) : ingestPodcastEpisode(url);
}

async function ingestYouTubeEpisode(url, video_id) {
  const existing = getEpisode(video_id);
  if (existing) {
    log.info(`episode already ingested`, { video_id, status: existing.status });
    return [existing];
  }

  const meta = await fetchMetadata(url);
  upsertEpisode(meta);
  log.ok(`ingested`, { video_id, title: meta.title.slice(0, 60) });
  return [getEpisode(video_id)];
}

// Resolve the pasted URL to a single podcast episode row (audio enclosure +
// metadata) and upsert it. upsertEpisode is idempotent (ON CONFLICT DO NOTHING),
// so re-pasting the same URL reuses the existing row; the ad-hoc caller resets
// its status via runEpisode's forceReprocess.
async function ingestPodcastEpisode(url) {
  const ep = await resolvePodcastEpisode(url);
  upsertEpisode(ep);
  const existing = getEpisode(ep.video_id);
  log.ok(`ingested podcast`, { video_id: ep.video_id, title: (ep.title || '').slice(0, 60) });
  return [existing];
}

export async function ingestDaily({ lookbackDays = 2 } = {}) {
  const { channels } = loadSources();
  const sinceDate = new Date(Date.now() - lookbackDays * 86400_000).toISOString().slice(0, 10);
  const newEpisodes = [];

  for (const ch of channels) {
    let channel_id = ch.channel_id;
    if (!channel_id && ch.handle) {
      try {
        channel_id = await resolveHandle(ch.handle);
        log.info(`resolved handle`, { name: ch.name, handle: ch.handle, channel_id });
      } catch (err) {
        log.warn(`handle resolve failed`, { name: ch.name, err: err.message });
        continue;
      }
    }
    if (!channel_id) {
      log.warn(`no channel_id for ${ch.name}, skipping`);
      continue;
    }

    let uploads;
    try {
      uploads = await listChannelUploads(channel_id, { limit: 5 });
    } catch (err) {
      log.warn(`failed listing ${ch.name}`, { err: err.message });
      continue;
    }

    for (const u of uploads) {
      if (getEpisode(u.video_id)) continue; // dedup
      let meta;
      try {
        meta = await fetchMetadata(u.url);
      } catch (err) {
        log.warn(`metadata fetch failed for ${u.video_id}`, { err: err.message });
        continue;
      }
      if (meta.published_at && meta.published_at < sinceDate) continue;
      upsertEpisode(meta);
      newEpisodes.push(getEpisode(meta.video_id));
      log.ok(`new`, { channel: ch.name, title: meta.title.slice(0, 60) });
    }
  }

  return newEpisodes;
}

// Poll every enabled podcast RSS feed and insert new episode rows
// (medium='podcast', status='new'). Mirrors ingestDaily for the audio world:
// rss.js is the metadata fetcher (yt-dlp's analog), pollPodcasts returns
// normalized rows ready for upsertEpisode. New podcast rows are picked up by
// the same resumableEpisodes() loop in the pipeline and routed to the Modal
// WhisperX transcriber by the medium-aware stage 2.
//
// `lookbackDays` matches ingestDaily's window so a daily run considers the same
// recency horizon across both media. `limit` caps items examined per feed.
export async function ingestPodcastsDaily({ lookbackDays = 2, limit = 25 } = {}) {
  const { podcasts } = loadSources();
  if (!podcasts || !podcasts.length) {
    log.info('no podcasts configured, skipping podcast ingest');
    return [];
  }

  const sinceDate = new Date(Date.now() - lookbackDays * 86400_000).toISOString().slice(0, 10);
  const candidates = await pollPodcasts(podcasts, { limit });
  const newEpisodes = [];

  for (const ep of candidates) {
    // Skip episodes older than the lookback window. Podcasts publish less often
    // than channels upload, but a fresh feed subscription can surface a long
    // back-catalog we don't want to transcribe all at once (each is billed GPU).
    if (ep.published_at && ep.published_at.slice(0, 10) < sinceDate) continue;
    if (getEpisode(ep.video_id)) continue; // dedup
    const isNew = upsertEpisode(ep);
    if (isNew) {
      newEpisodes.push(getEpisode(ep.video_id));
      log.ok(`new`, { podcast: ep.channel_name, title: (ep.title || '').slice(0, 60) });
    }
  }

  return newEpisodes;
}
