// YouTube search + mechanical pre-filters for the Discovery feature.
//
// "Mechanical" = no LLM. Drops obvious junk (too-short, too-old, duplicate,
// from-already-subscribed-channel, title-pattern noise) before the LLM
// curation pass, to keep that pass cheap and high-signal.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hasEpisode, hasDiscovery } from './db.js';
import { DATA_DIR } from './config.js';
import { log } from './log.js';

// Same cookies handling as youtube.js — see comment there. Duplicated
// rather than importing because runYtDlp() here has different timeout
// defaults and we'd rather not factor out a shared utility for two callers.
const COOKIES_PATH = path.join(DATA_DIR, 'cookies.txt');
function cookieArgs() {
  return fs.existsSync(COOKIES_PATH) ? ['--cookies', COOKIES_PATH] : [];
}

// Title patterns that almost always indicate non-substantive content.
// Case-insensitive, word-boundaried.
const NOISE_TITLE_PATTERNS = [
  /\breact(s|ion|ing)?\b/i,            // "reacts to", "reaction"
  /\bcompilation\b/i,
  /\bbest of\b/i,
  /\bhighlights?\b/i,
  /\b(top|funniest|craziest) \d+\b/i,  // "top 10 Jensen moments"
  /\bshorts?\b/i,
  /\bclip(s|ped)?\b/i,
  /\b(in|under) \d+ (sec|min)/i,       // "Jensen in 60 seconds"
  /#shorts?\b/i,
];

function runYtDlp(args, { timeout = 60_000 } = {}) {
  const finalArgs = [...cookieArgs(), ...args];
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', finalArgs, { windowsHide: true });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`yt-dlp timeout ${timeout}ms`)); }, timeout);
    proc.on('error', err => { clearTimeout(timer); reject(err); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(-300)}`));
      resolve(stdout);
    });
  });
}

// Search YouTube via yt-dlp's "ytsearch" pseudo-URL. Returns raw video records.
// We use flat-playlist for speed (one request, no per-video metadata fetch).
// Flat results don't include channel_id, but they DO include channel name,
// title, duration, upload date — enough for mechanical filtering.
export async function searchYouTube(query, { count = 20 } = {}) {
  const out = await runYtDlp([
    `ytsearch${count}:${query}`,
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
  ]);
  return out.split('\n').filter(Boolean).map(line => {
    const v = JSON.parse(line);
    return {
      video_id:     v.id,
      title:        v.title,
      channel_name: v.channel,
      channel_id:   v.channel_id || null,
      duration_sec: v.duration,
      // yt-dlp gives a fuzzy date like "2 days ago" in flat mode for search results;
      // sometimes a full date. Pass through and let the filter normalize.
      upload_date:  v.upload_date || null,        // 'YYYYMMDD' when present
      url:          `https://www.youtube.com/watch?v=${v.id}`,
    };
  });
}

// Convert yt-dlp's upload_date ('YYYYMMDD') to ISO ('YYYY-MM-DD'), or null.
function normalizeUploadDate(s) {
  if (!s || !/^\d{8}$/.test(s)) return null;
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}

// Apply mechanical filters. Returns { kept, dropped: [{video, reason}, ...] }.
//
// subscribedChannelIds: a Set<string> of channel_ids we already poll daily
//   (so we don't re-process via discovery what the daily poll catches anyway).
export function filterCandidates(rawVideos, { lookbackDays, minDurationSec, subscribedChannelIds }) {
  const kept = [];
  const dropped = [];
  const cutoffMs = Date.now() - lookbackDays * 86_400_000;

  for (const v of rawVideos) {
    const uploadDate = normalizeUploadDate(v.upload_date);
    const enriched = { ...v, upload_date: uploadDate };

    if (hasEpisode(v.video_id)) {
      dropped.push({ video: enriched, reason: 'already in episodes' });
      continue;
    }
    if (hasDiscovery(v.video_id)) {
      dropped.push({ video: enriched, reason: 'already in discoveries' });
      continue;
    }
    if (v.channel_id && subscribedChannelIds.has(v.channel_id)) {
      dropped.push({ video: enriched, reason: `from subscribed channel (${v.channel_name})` });
      continue;
    }
    if (typeof v.duration_sec === 'number' && v.duration_sec < minDurationSec) {
      dropped.push({ video: enriched, reason: `duration ${v.duration_sec}s < ${minDurationSec}s floor` });
      continue;
    }
    if (uploadDate) {
      const uploadMs = Date.parse(uploadDate);
      if (Number.isFinite(uploadMs) && uploadMs < cutoffMs) {
        dropped.push({ video: enriched, reason: `older than ${lookbackDays}d (uploaded ${uploadDate})` });
        continue;
      }
    }
    const noisyTitle = NOISE_TITLE_PATTERNS.find(re => re.test(v.title || ''));
    if (noisyTitle) {
      dropped.push({ video: enriched, reason: `title matches noise pattern ${noisyTitle.source}` });
      continue;
    }
    kept.push(enriched);
  }
  return { kept, dropped };
}

// Convenience: search + filter in one call. Returns { kept, dropped, raw }.
export async function searchAndFilter(name, opts) {
  let raw;
  try {
    raw = await searchYouTube(name, { count: opts.resultsPerName });
  } catch (err) {
    log.warn(`search failed for "${name}"`, { err: err.message });
    return { kept: [], dropped: [], raw: [] };
  }
  const { kept, dropped } = filterCandidates(raw, opts);
  return { kept, dropped, raw };
}
