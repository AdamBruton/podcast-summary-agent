// yt-dlp subprocess wrapper. We shell out rather than use any JS YouTube
// library because yt-dlp is the most resilient YouTube tool in existence —
// it tracks YouTube changes daily and Just Works.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TRANSCRIPT_DIR, DATA_DIR } from './config.js';
import { log } from './log.js';

// YouTube increasingly blocks unauthenticated requests from datacenter IPs
// (Railway, AWS, etc.) with "Sign in to confirm you're not a bot". The fix
// is to pass a Netscape-format cookies.txt exported from a logged-in browser.
// We look for it at <DATA_DIR>/cookies.txt — locally that's ./data/cookies.txt
// (gitignored), on Railway it's /data/cookies.txt (volume-mounted).
// When the file isn't present, we run without cookies (fine for residential
// IPs like a home machine).
const COOKIES_PATH = path.join(DATA_DIR, 'cookies.txt');
function cookieArgs() {
  return fs.existsSync(COOKIES_PATH) ? ['--cookies', COOKIES_PATH] : [];
}

function run(args, { timeout = 120_000 } = {}) {
  // Prepend --cookies <file> if cookies.txt is present. Checked per-call so a
  // freshly-uploaded cookies file is picked up without a restart.
  const finalArgs = [...cookieArgs(), ...args];
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
// We grab metadata for the first video on the channel's videos tab — that's
// the cheapest way to coax yt-dlp to populate the channel_id field reliably.
// `--flat-playlist` is NOT used because it leaves channel_id blank.
export async function resolveHandle(handle) {
  const url = `https://www.youtube.com/${handle}/videos`;
  const out = await run([
    '--playlist-end', '1',
    '--skip-download',
    '--print', '%(channel_id)s',
    '--no-warnings',
    url,
  ]);
  return out.trim().split('\n').pop().trim();
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

// Fetch auto-generated captions. Returns { cues: [{start, end, text}], language }
// or null if none are available.
export async function fetchCaptions(video_id) {
  const url = youtubeUrl(video_id);
  const outDir = TRANSCRIPT_DIR;
  const tmpl = path.join(outDir, `${video_id}.%(ext)s`);
  try {
    await run([
      '--write-auto-subs',
      '--sub-langs', 'en.*,en',
      '--sub-format', 'vtt',
      '--skip-download',
      '--convert-subs', 'vtt',
      '-o', tmpl,
      '--no-warnings',
      url,
    ]);
  } catch (err) {
    log.warn(`captions fetch failed for ${video_id}`, { err: err.message });
    return null;
  }
  // yt-dlp writes <id>.<lang>.vtt — find whichever appeared.
  const file = fs.readdirSync(outDir)
    .find(f => f.startsWith(`${video_id}.`) && f.endsWith('.vtt'));
  if (!file) return null;
  const lang = file.slice(video_id.length + 1, -4);
  const vtt = fs.readFileSync(path.join(outDir, file), 'utf8');
  return { cues: parseVtt(vtt), language: lang };
}

// Download audio for Whisper fallback. Returns path to mp3.
// Forces 16kHz mono at 32kbps so even ~1.5hr episodes fit under Groq's 25MB
// upload limit. Whisper only sees 16kHz mono internally anyway, so this is
// lossless from the model's POV.
export async function downloadAudio(video_id) {
  const url = youtubeUrl(video_id);
  const out = path.join(TRANSCRIPT_DIR, `${video_id}.mp3`);
  await run([
    '-x',
    '--audio-format', 'mp3',
    '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000 -ab 32k',
    '-o', out.replace('.mp3', '.%(ext)s'),
    '--no-warnings',
    url,
  ], { timeout: 600_000 });
  return out;
}

// --- VTT parser -------------------------------------------------------------
// YouTube auto-captions are quirky: they emit rolling overlapping cues so the
// raw text duplicates heavily. We dedupe by collapsing adjacent identical
// trailing text fragments.

function vttTimeToSec(t) {
  // 00:01:23.456 → 83.456
  const [h, m, s] = t.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function parseVtt(text) {
  const lines = text.split(/\r?\n/);
  const cues = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^(\d\d:\d\d:\d\d\.\d{3})\s+-->\s+(\d\d:\d\d:\d\d\.\d{3})/);
    if (m) {
      const start = vttTimeToSec(m[1]);
      const end   = vttTimeToSec(m[2]);
      const textLines = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        // Strip VTT inline tags like <00:00:01.234><c>word</c>
        const cleaned = lines[i].replace(/<[^>]+>/g, '').trim();
        if (cleaned) textLines.push(cleaned);
        i++;
      }
      const txt = textLines.join(' ').trim();
      if (txt) cues.push({ start, end, text: txt });
    } else {
      i++;
    }
  }
  return dedupeRollingCues(cues);
}

// YouTube auto-captions emit each phrase 2-3 times as the rolling window
// advances. Keep only the longest version of each duplicated stretch.
function dedupeRollingCues(cues) {
  const out = [];
  let prev = '';
  for (const c of cues) {
    if (c.text === prev) continue;
    // If current is a prefix of previous or vice versa, prefer the longer one.
    if (prev && (c.text.startsWith(prev) || prev.startsWith(c.text))) {
      const longer = c.text.length > prev.length ? c : out[out.length - 1];
      if (longer === c) out[out.length - 1] = c;
      prev = longer.text;
      continue;
    }
    out.push(c);
    prev = c.text;
  }
  return out;
}
