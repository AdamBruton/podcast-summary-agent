// Ad-hoc podcast resolver. Given an arbitrary URL the user pasted into the
// ad-hoc field, figure out a single podcast episode to summarize and return a
// normalized row (medium='podcast') ready for upsertEpisode.
//
// This is the ad-hoc analog of rss.js's feed polling: rss.js handles SUBSCRIBED
// feeds (poll the whole feed, mint one row per item); this handles a ONE-OFF
// URL the user pasted — which might be:
//   - a direct audio file        (…/episode123.mp3)        → use it as-is
//   - an RSS/XML feed URL          (…/feed.xml)            → take the latest item
//   - an episode/show web page   (…/podcasts/ep-42)        → scrape the enclosure
//
// The transcribe router (stage 2, podcast branch) only needs `audio_url`; the
// rest is metadata for the brief header + episode list. We never download the
// audio here — that's the Modal WhisperX worker's job over HTTPS.

import Parser from 'rss-parser';
import { episodeId } from './rss.js';
import { log } from './log.js';

const FETCH_TIMEOUT_MS = 20000;
const UA = 'Mozilla/5.0 (compatible; podcast-summary-agent/1.0)';
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?[^"'\s]*)?$/i;
const AUDIO_URL = /https?:\/\/[^"'\s)<>]+\.(?:mp3|m4a|aac|ogg|oga|opus|wav|flac)(?:\?[^"'\s)<>]*)?/i;

const parser = new Parser({ timeout: FETCH_TIMEOUT_MS });

async function fetchUrl(url, { method = 'GET' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: '*/*' },
      signal: ctrl.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// Pull the first match of an Open Graph / meta tag by property or name.
function metaContent(html, key) {
  // matches both attribute orders: property/name before or after content
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${key}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeEntities(m[1].trim());
  }
  return null;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#x2F;/gi, '/');
}

function absolutize(maybeRelative, baseUrl) {
  try { return new URL(maybeRelative, baseUrl).toString(); }
  catch { return maybeRelative; }
}

// Walk a parsed JSON-LD value (object or array, possibly nested in @graph)
// looking for an audio content URL on a PodcastEpisode / AudioObject node.
function audioFromJsonLd(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) { const u = audioFromJsonLd(n); if (u) return u; }
    return null;
  }
  if (Array.isArray(node['@graph'])) {
    const u = audioFromJsonLd(node['@graph']); if (u) return u;
  }
  // Common shapes: {audio:{contentUrl}}, {associatedMedia:{contentUrl}},
  // or an AudioObject node with contentUrl directly.
  const candidates = [node.audio, node.associatedMedia, node];
  for (const c of candidates) {
    if (c && typeof c === 'object') {
      const url = c.contentUrl || c.url;
      if (typeof url === 'string' && AUDIO_EXT.test(url)) return url;
    }
  }
  return null;
}

function scrapeAudioFromHtml(html, baseUrl) {
  // 1. Open Graph audio (most podcast hosts emit this).
  for (const key of ['og:audio:secure_url', 'og:audio:url', 'og:audio', 'twitter:player:stream']) {
    const c = metaContent(html, key);
    if (c) return absolutize(c, baseUrl);
  }

  // 2. JSON-LD structured data.
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRe.exec(html))) {
    try {
      const url = audioFromJsonLd(JSON.parse(m[1].trim()));
      if (url) return absolutize(url, baseUrl);
    } catch { /* malformed JSON-LD block — skip */ }
  }

  // 3. <audio src> / <source src> tags.
  const tagRe = /<(?:audio|source)[^>]+src=["']([^"']+)["']/gi;
  while ((m = tagRe.exec(html))) {
    if (AUDIO_EXT.test(m[1])) return absolutize(m[1], baseUrl);
  }

  // 4. Last resort: first audio-looking URL anywhere in the markup.
  const bare = html.match(AUDIO_URL);
  if (bare) return absolutize(bare[0], baseUrl);

  return null;
}

function titleFromAudioUrl(audioUrl) {
  try {
    const last = new URL(audioUrl).pathname.split('/').pop() || 'episode';
    return decodeURIComponent(last).replace(AUDIO_EXT, '').replace(/[-_]+/g, ' ').trim() || 'Podcast episode';
  } catch {
    return 'Podcast episode';
  }
}

function hostName(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return 'Podcast'; }
}

function validHttpUrl(u) {
  if (!u) return null;
  try {
    const x = new URL(u);
    return (x.protocol === 'http:' || x.protocol === 'https:') ? x.toString() : null;
  } catch {
    return null;
  }
}

// pageUrl may be missing or malformed (feed <link> values are frequently a bare
// host like "siriusxm.com"). Validate it: a bad page link becomes null so
// compose falls back to audio_url rather than emitting a broken relative <a>.
function buildRow({ pageUrl, audioUrl, title, showName, description, publishedAt }) {
  const page = validHttpUrl(pageUrl);
  return {
    video_id: episodeId({ feedUrl: page || audioUrl, audioUrl }),
    channel_id: null,
    channel_name: showName || hostName(page || audioUrl),
    title: title || titleFromAudioUrl(audioUrl),
    description: description || '',
    published_at: publishedAt || null,
    duration_sec: null,
    url: page || audioUrl,
    medium: 'podcast',
    feed_url: null,
    audio_url: audioUrl,
    episode_page_url: page,
    source: 'subscribed',
  };
}

function looksLikeFeed(contentType, body) {
  if (/(rss|atom|xml)/i.test(contentType)) return true;
  const head = body.slice(0, 400).toLowerCase();
  return head.includes('<rss') || head.includes('<feed') || head.includes('<?xml');
}

// Resolve a pasted URL to a single normalized podcast episode row. Throws a
// user-facing Error if no audio enclosure can be found.
export async function resolvePodcastEpisode(pageUrl) {
  const res = await fetchUrl(pageUrl);
  if (!res.ok) throw new Error(`fetching ${pageUrl} returned HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  const finalUrl = res.url || pageUrl; // post-redirect

  // (a) Direct audio file — by content-type or by extension on the final URL.
  // Don't download the audio: cancel the body stream (the Modal worker fetches
  // the bytes itself), then build straight from the URL.
  if (/^audio\//i.test(contentType) || AUDIO_EXT.test(finalUrl)) {
    res.body?.cancel?.().catch(() => {});
    log.info('ad-hoc podcast: direct audio URL', { url: finalUrl, contentType });
    return buildRow({ pageUrl: finalUrl, audioUrl: finalUrl });
  }

  const body = await res.text();

  // (b) RSS/Atom feed — take the most recent item (rss-parser yields newest-first).
  if (looksLikeFeed(contentType, body)) {
    const feed = await parser.parseString(body);
    const item = feed.items?.[0];
    const audioUrl = item?.enclosure?.url;
    if (!audioUrl) throw new Error(`feed at ${pageUrl} has no playable episodes`);
    log.info('ad-hoc podcast: feed → latest item', { show: feed.title, title: item.title });
    return buildRow({
      pageUrl: item.link,
      audioUrl,
      title: item.title,
      showName: feed.title,
      description: item.contentSnippet || item.content || '',
      publishedAt: item.isoDate || null,
    });
  }

  // (c) HTML page — scrape for the enclosure + metadata.
  const audioUrl = scrapeAudioFromHtml(body, finalUrl);
  if (!audioUrl) {
    throw new Error(
      `couldn't find a podcast audio file at ${pageUrl}. ` +
      `Paste the episode's direct audio URL (…/episode.mp3), the RSS feed, ` +
      `or a page that links the audio. Apple/Spotify pages don't expose the audio.`
    );
  }
  // Show name: the page's RSS <link> tag carries it as a `title` attribute on
  // most podcast hosts (Transistor/Simplecast/Libsyn/Buzzsprout/Podbean), and
  // it's the authoritative show name without a second fetch. Fall back to
  // og:site_name, then (in buildRow) the URL host.
  const showName = feedLinkTitle(body) || metaContent(body, 'og:site_name') || null;
  // Episode title: og:title is cleanest when present; else <title>, which on
  // many hosts is "Show | Episode" — strip the show segment we just resolved so
  // the brief doesn't repeat it. twitter:title is a last resort (often carries
  // trailing "| Episode N" cruft).
  const rawTitle = metaContent(body, 'og:title') || htmlTitle(body) || metaContent(body, 'twitter:title');
  log.info('ad-hoc podcast: scraped enclosure from page', { page: finalUrl, audioUrl, show: showName });
  return buildRow({
    pageUrl: finalUrl,
    audioUrl,
    title: stripShowFromTitle(rawTitle, showName),
    showName,
    description: metaContent(body, 'og:description'),
    publishedAt: metaContent(body, 'article:published_time'),
  });
}

function htmlTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].trim()) : null;
}

// Show name from the page's RSS/Atom <link> tag's `title` attribute.
function feedLinkTitle(html) {
  const tag = (html.match(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i) || [])[0];
  if (!tag) return null;
  const m = tag.match(/\btitle=["']([^"']+)["']/i);
  return m ? decodeEntities(m[1].trim()) : null;
}

// Drop a leading "Show | " or trailing " | Show" (also - – —) from an episode
// title, plus a trailing "| Episode N". Falls back to the original if stripping
// would empty it.
function stripShowFromTitle(title, show) {
  if (!title) return title;
  const SEP = '\\s*[|\\u2013\\u2014-]\\s*';
  let t = title.replace(new RegExp(`${SEP}(?:episode|ep\\.?)\\s*\\d+\\s*$`, 'i'), '');
  if (show) {
    const s = show.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`^${s}${SEP}`, 'i'), '').replace(new RegExp(`${SEP}${s}\\s*$`, 'i'), '');
  }
  return t.trim() || title;
}
