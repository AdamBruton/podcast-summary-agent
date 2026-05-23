// Stage 1: Ingest.
//
// Two entry points:
//   ingestEpisode(url) — for --episode flag, single video
//   ingestDaily(opts)   — for daily run, polls all configured sources
//
// Both return arrays of episode rows. Dedup is via SQLite (video_id PK).

import { loadSources } from '../lib/config.js';
import { upsertEpisode, getEpisode } from '../lib/db.js';
import { fetchMetadata, listChannelUploads, videoIdFromUrl, resolveHandle } from '../lib/youtube.js';
import { log } from '../lib/log.js';

export async function ingestEpisode(url) {
  const video_id = videoIdFromUrl(url);
  if (!video_id) throw new Error(`Could not parse YouTube video ID from: ${url}`);

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
