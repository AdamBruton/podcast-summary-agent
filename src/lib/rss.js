// Podcast RSS adapter. Parallel to src/lib/youtube.js — same role
// (source-specific metadata fetcher) for a different platform. yt-dlp
// equivalent for the podcast world is a feed parser; we use rss-parser.
//
// Episode IDs are pod_<16-hex>. Stable as long as either (a) the publisher's
// <guid> is stable, or (b) the audio URL + published_at combination is stable.
// The hash incorporates the normalized feed URL so the same episode appearing
// in two different feeds (rare — usually republishes) gets distinct IDs,
// matching our "one row per source" model.

import Parser from 'rss-parser';
import crypto from 'node:crypto';
import { log } from './log.js';

const parser = new Parser({
  timeout: 20000,
});

function normalizeFeedUrl(url) {
  // Drop query string + fragment + lowercase host. Some feed providers append
  // tracking params that vary per-fetch; including those in the ID seed would
  // produce a new pod_<hex> on every poll. Path is left case-sensitive (some
  // feed paths are).
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    u.host = u.host.toLowerCase();
    return u.toString();
  } catch {
    return String(url).trim();
  }
}

// Mint a stable pod_<16hex> id. Exported so the ad-hoc podcast resolver
// (podcast-resolve.js) shares the exact same id scheme as feed polling.
export function episodeId({ feedUrl, guid, audioUrl, publishedAt }) {
  const seed = guid
    ? `${normalizeFeedUrl(feedUrl)}|${guid}`
    : `${normalizeFeedUrl(feedUrl)}|${audioUrl || ''}|${publishedAt || ''}`;
  const hash = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
  return `pod_${hash}`;
}

function durationToSeconds(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.floor(value) : null;
  const s = String(value).trim();
  if (!s) return null;
  // HH:MM:SS or MM:SS
  if (/^\d+(:\d+){1,2}$/.test(s)) {
    let total = 0;
    for (const p of s.split(':')) total = total * 60 + Number(p);
    return total;
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function publishedISO(item) {
  if (item.isoDate) return item.isoDate;
  if (item.pubDate) {
    const d = new Date(item.pubDate);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function toEpisode({ podcastName, feedUrl, item }) {
  const audioUrl = item.enclosure?.url || null;
  const episodePageUrl = item.link || null;
  const publishedAt = publishedISO(item);
  const video_id = episodeId({
    feedUrl,
    guid: item.guid,
    audioUrl,
    publishedAt,
  });
  return {
    video_id,
    channel_id: null,
    channel_name: podcastName,
    title: item.title || '',
    description: item.contentSnippet || item.content || '',
    published_at: publishedAt,
    duration_sec: durationToSeconds(item.itunes?.duration),
    url: episodePageUrl || audioUrl || feedUrl,
    medium: 'podcast',
    feed_url: feedUrl,
    audio_url: audioUrl,
    episode_page_url: episodePageUrl,
    source: 'subscribed',
  };
}

export async function fetchFeed(feedUrl) {
  return parser.parseURL(feedUrl);
}

// List recent episodes from one podcast as normalized rows ready for
// upsertEpisode. Returned newest-first (matches the order rss-parser yields).
export async function listPodcastEpisodes(podcast, { limit = 25 } = {}) {
  const feed = await fetchFeed(podcast.url);
  const items = Array.isArray(feed.items) ? feed.items.slice(0, limit) : [];
  return items.map(item => toEpisode({
    podcastName: podcast.name,
    feedUrl: podcast.url,
    item,
  }));
}

// Iterate all enabled podcasts and return normalized episode rows. Per-feed
// failures are logged and don't block the others.
export async function pollPodcasts(podcasts, { limit = 25 } = {}) {
  const out = [];
  for (const p of podcasts) {
    if (p.enabled === false) continue;
    try {
      const eps = await listPodcastEpisodes(p, { limit });
      out.push(...eps);
    } catch (err) {
      log.warn(`feed fetch failed for ${p.name}`, { err: err.message, url: p.url });
    }
  }
  return out;
}
