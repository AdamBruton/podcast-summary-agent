// yt-dlp subprocess wrapper. We shell out rather than use any JS YouTube
// library because yt-dlp is the most resilient YouTube tool in existence —
// it tracks YouTube changes daily and Just Works.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { log } from './log.js';

// YouTube increasingly blocks unauthenticated requests from datacenter IPs
// (Railway, AWS, etc.) with "Sign in to confirm you're not a bot". The fix
// is to pass a Netscape-format cookies.txt exported from a logged-in browser.
// We look for it at <DATA_DIR>/cookies.txt — locally that's ./data/cookies.txt
// (gitignored), on Railway it's /data/cookies.txt (volume-mounted).
// When the file isn't present, we run without cookies (fine for residential
// IPs like a home machine).
const COOKIES_PATH = path.join(DATA_DIR, 'cookies.txt');

// Args we want on EVERY yt-dlp invocation:
//   --cookies <file>            (if available) auth-as-logged-in-user — required
//                               to get past datacenter-IP bot challenges on Railway.
//   --ignore-no-formats-error   our metadata-only operations (resolveHandle,
//                               listChannelUploads, fetchMetadata) don't need a
//                               downloadable format; without this flag yt-dlp aborts
//                               when the default format selector can't find anything
//                               (live streams, premieres, members-only, regional
//                               restrictions on the first video of a channel).
function commonArgs() {
  const args = ['--ignore-no-formats-error'];
  if (fs.existsSync(COOKIES_PATH)) args.unshift('--cookies', COOKIES_PATH);
  return args;
}

function run(args, { timeout = 120_000 } = {}) {
  // Prepend common args. Checked per-call so a freshly-uploaded cookies file
  // is picked up without a restart.
  const finalArgs = [...commonArgs(), ...args];
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', finalArgs, { windowsHide: true });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`yt-dlp timeout after ${timeout}ms`));
    }, timeout);
    proc.on('error', err => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        return reject(new Error('yt-dlp not found on PATH. Install with: winget install yt-dlp.yt-dlp'));
      }
      reject(err);
    });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(-500)}`));
      resolve(stdout);
    });
  });
}

// Extract video ID from any YouTube URL form (watch?v=, youtu.be/, /shorts/).
export function videoIdFromUrl(url) {
  const m = url.match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([\w-]{11})/);
  return m ? m[1] : null;
}

export function youtubeUrl(video_id, t = null) {
  const base = `https://www.youtube.com/watch?v=${video_id}`;
  return t != null ? `${base}&t=${Math.floor(t)}s` : base;
}

// Resolve an @handle to a canonical channel_id (UC...).
//
// Strategy: --flat-playlist (cheap, no per-video metadata fetch) + --print
// scoped to the PLAYLIST (the "playlist:" prefix). yt-dlp treats a channel's
// /videos URL as a playlist, and channel_id is a playlist-level field that's
// reliably populated — unlike the per-video channel_id field, which often
// resolves to literal "NA" in flat mode.
export async function resolveHandle(handle) {
  const url = `https://www.youtube.com/${handle}/videos`;
  const out = await run([
    '--flat-playlist',
    '--playlist-end', '1',
    '--print', 'playlist:%(channel_id)s',
    '--no-warnings',
    url,
  ]);
  const channelId = out.trim().split('\n').pop().trim();
  if (!channelId.startsWith('UC')) {
    throw new Error(`yt-dlp did not return a UC… channel_id; got: "${channelId}"`);
  }
  return channelId;
}

// List recent uploads from a channel by channel_id. Returns array of
// { video_id, title, upload_date, duration, url } (newest first).
export async function listChannelUploads(channel_id, { limit = 10 } = {}) {
  const url = `https://www.youtube.com/channel/${channel_id}/videos`;
  // --flat-playlist is fast (one request) and gives us enough to filter
  // before we pay for full metadata fetch on actually-new items.
  const out = await run([
    '--flat-playlist',
    '--playlist-end', String(limit),
    '--dump-json',
    '--no-warnings',
    url,
  ], { timeout: 60_000 });
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .map(v => ({
      video_id:    v.id,
      title:       v.title,
      duration:    v.duration,
      url:         youtubeUrl(v.id),
    }));
}

// Full metadata for a single video.
export async function fetchMetadata(url) {
  const out = await run([
    '--dump-json',
    '--skip-download',
    '--no-warnings',
    url,
  ]);
  const m = JSON.parse(out);
  return {
    video_id:     m.id,
    channel_id:   m.channel_id,
    channel_name: m.channel,
    title:        m.title,
    description:  m.description || '',
    published_at: m.upload_date
      ? `${m.upload_date.slice(0,4)}-${m.upload_date.slice(4,6)}-${m.upload_date.slice(6,8)}`
      : null,
    duration_sec: m.duration,
    url:          youtubeUrl(m.id),
  };
}

// Caption fetching + audio downloading were removed when we moved transcription
// to youtube-transcript.io (see src/lib/transcript-io.js + src/stages/2-transcribe.js).
// yt-dlp is now used ONLY for ingest-stage operations: resolveHandle,
// listChannelUploads, fetchMetadata — and for the YouTube search in
// discovery-search.js. Both have proven reliable enough from Railway with
// cookies + ignore-no-formats-error; transcripts were the unreliable case.
