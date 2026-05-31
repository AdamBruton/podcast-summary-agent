// Tiny local web UI for editing config/sources.yaml.
//
// Start with: npm run web
// Then open: http://localhost:3000  (auto-opens in default browser)
//
// No auth — binds to localhost only. If you want it on your LAN, change the
// listen host. Don't expose to the public internet.

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  listAll, addChannel, removeChannel, patchChannel,
  addIndividual, removeIndividual,
} from '../lib/sources-store.js';
import { readProfile, writeProfile } from '../lib/profile-store.js';
import {
  listEpisodesWithCounts, getEpisodeDetail,
  setFeedback, getAllFeedbackWithContext,
  getEpisode, setEpisodeStatus,
  db, resetDb,
} from '../lib/db.js';
import { resolveHandle, videoIdFromUrl } from '../lib/youtube.js';
import { runEpisode, runDaily } from '../pipeline.js';
import { complete, parseJsonResponse, MODELS } from '../lib/claude.js';
import { loadPrompt, DB_PATH } from '../lib/config.js';
import { backupDatabase, snapshotForRestore, BACKUPS_DIR } from '../lib/backup.js';
import { log } from '../lib/log.js';
import { diffLines } from 'diff';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Railway sets PORT automatically. Local dev uses WEB_PORT (default 3000).
const PORT = Number(process.env.PORT) || Number(process.env.WEB_PORT) || 3000;
// Bind 0.0.0.0 when running in a container (Railway sets PORT); 127.0.0.1
// for local dev so the UI doesn't accidentally expose itself on the LAN.
const HOST = process.env.PORT ? '0.0.0.0' : '127.0.0.1';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check for Railway. Lightweight: just confirm the DB opens.
app.get('/healthz', (req, res) => {
  try {
    // Importing db here to avoid circular issues on cold start; cached after first call.
    import('../lib/db.js').then(({ db }) => {
      db().prepare('SELECT 1').get();
      res.status(200).json({ ok: true, ts: new Date().toISOString() });
    }).catch(err => res.status(500).json({ ok: false, err: err.message }));
  } catch (err) {
    res.status(500).json({ ok: false, err: err.message });
  }
});

// --- helpers ----------------------------------------------------------------

function wrap(handler) {
  return async (req, res) => {
    try {
      const result = await handler(req, res);
      if (result !== undefined && !res.headersSent) res.json(result);
    } catch (err) {
      const code = /not found/i.test(err.message) ? 404
                 : /required|already|must|bad/i.test(err.message) ? 400
                 : 500;
      res.status(code).json({ error: err.message });
    }
  };
}

function decodeParam(s) {
  return decodeURIComponent(s);
}

// --- routes -----------------------------------------------------------------

app.get('/api/sources', wrap(() => listAll()));

app.post('/api/sources/channels', wrap(req => addChannel(req.body)));

app.delete('/api/sources/channels/:handle', wrap(req => ({
  removed: removeChannel(decodeParam(req.params.handle)),
})));

app.patch('/api/sources/channels/:handle', wrap(req => {
  const r = patchChannel(decodeParam(req.params.handle), req.body);
  if (!r) throw new Error('not found');
  return r;
}));

app.post('/api/sources/individuals', wrap(req => ({ name: addIndividual(req.body.name) })));
app.delete('/api/sources/individuals/:name', wrap(req => ({ removed: removeIndividual(decodeParam(req.params.name)) })));

app.post('/api/resolve', wrap(async req => {
  const handle = req.body.handle;
  if (!handle?.startsWith('@')) throw new Error('handle must start with "@"');
  const channel_id = await resolveHandle(handle);
  if (!channel_id?.startsWith('UC')) {
    throw new Error(`resolution returned unexpected value: ${channel_id || '(empty)'}`);
  }
  return { handle, channel_id };
}));

// --- Profile (interest tuning) ---------------------------------------------

app.get('/api/profile', wrap(() => ({ content: readProfile() })));

app.put('/api/profile', wrap(req => {
  if (typeof req.body?.content !== 'string') throw new Error('content (string) is required');
  return writeProfile(req.body.content);
}));

// --- Episode inspector -----------------------------------------------------

app.get('/api/episodes', wrap(() => {
  const limit = 25;   // hardcoded for now; UI doesn't paginate yet
  return { episodes: listEpisodesWithCounts({ limit }) };
}));

app.get('/api/episodes/:video_id', wrap(req => {
  const detail = getEpisodeDetail(req.params.video_id);
  if (!detail) throw new Error('not found');
  return detail;
}));

// --- Feedback (per-candidate thumbs) ---------------------------------------

app.post('/api/feedback', wrap(req => {
  const { candidate_id } = req.body || {};
  const rating = req.body?.rating ?? null;   // 'up' | 'down' | null
  if (typeof candidate_id !== 'number') throw new Error('candidate_id (number) is required');
  return setFeedback(candidate_id, rating);
}));

// --- LLM profile refinement -------------------------------------------------
// Aggregates all feedback + current profile, asks Claude to suggest a revised
// profile. Returns { summary, revised_profile }. User reviews + applies (or
// edits) via the regular PUT /api/profile.

app.post('/api/profile/suggest', wrap(async () => {
  const feedback = getAllFeedbackWithContext();
  if (feedback.length === 0) {
    const current = readProfile();
    return {
      summary: 'No feedback to learn from yet — go give some thumbs ratings on the episode inspector and try again.',
      revised_profile: current,
      diff: [],
    };
  }

  const profile = readProfile();
  const system = `${loadPrompt('profile-refine')}\n\n---\n\n# Current profile.md (to revise)\n\n${profile}`;

  // Sort feedback so false positives/negatives come first — they're the
  // training signal that drives changes.
  const labeled = feedback.map(f => ({
    ...f,
    outcome:
      f.selected === 1 && f.rating === 'up'   ? 'correct (selected, kept)' :
      f.selected === 1 && f.rating === 'down' ? "FALSE POSITIVE (selected, shouldn't have been)" :
      f.selected === 0 && f.rating === 'up'   ? 'FALSE NEGATIVE (dropped, should have been included)' :
                                                'correct (dropped, kept dropped)',
  })).sort((a, b) => {
    const errA = a.outcome.startsWith('FALSE') ? 0 : 1;
    const errB = b.outcome.startsWith('FALSE') ? 0 : 1;
    return errA - errB;
  });

  const compact = labeled.map(f => ({
    outcome:          f.outcome,
    episode:          `${f.channel_name}: ${f.episode_title}`,
    speaker:          f.speaker,
    category:         f.category,
    novelty_score:    f.novelty_score,
    claim:            f.claim,
    why_matters_when_selected: f.why_matters || null,
    quote:            f.supporting_quote,
  }));

  const userMsg = [
    `You have ${feedback.length} labeled outcomes. False positives and false negatives appear first; they're your training signal.`,
    '',
    '```json',
    JSON.stringify(compact, null, 2),
    '```',
    '',
    'Propose a revised profile.md and explain the change. Return the JSON object specified in the system prompt.',
  ].join('\n');

  const { text } = await complete({
    model: MODELS.SONNET,
    system,
    messages: [{ role: 'user', content: userMsg }],
    max_tokens: 8192,
    telemetry: { stage: 'profile-refine' },
  });

  let parsed;
  try { parsed = parseJsonResponse(text); }
  catch (err) { throw new Error(`could not parse model response: ${err.message}`); }
  if (!parsed?.summary || !parsed?.revised_profile) {
    throw new Error('model returned malformed suggestion (missing summary or revised_profile)');
  }

  // Compute line-level diff so the UI can render a track-changes view.
  // diffLines returns [{ value, added?, removed?, count }, …] — each chunk
  // is one or more contiguous lines that are unchanged, added, or removed.
  const diff = diffLines(profile, parsed.revised_profile);
  return { ...parsed, diff };
}));

// Ad-hoc: process a single YouTube URL right now, email the brief immediately,
// and leave the episode in 'ranked' status so it ALSO rolls up into tomorrow's
// daily brief. Blocks for the full pipeline duration (typically 1-3 min).
// Pass { dryRun: true } in the body to write HTML to disk instead of sending
// (useful for local testing without spending tokens on the email path).
app.post('/api/summarize-url', wrap(async req => {
  const url = req.body?.url?.trim();
  if (!url) throw new Error('url is required');
  const vid = videoIdFromUrl(url);
  if (!vid) throw new Error('not a recognizable YouTube URL');
  const dryRun = req.body.dryRun === true;

  // No socket idle timeout — Express defaults to none, but Node's HTTP layer
  // may close after 2 min. Disable for this long-running request.
  req.setTimeout(0);

  // Ad-hoc semantics: the user explicitly wants this URL processed NOW,
  // regardless of any prior state. Reset 'skipped' or 'delivered' to 'new'
  // so processEpisode doesn't early-out at the status check. The daily-cron
  // path keeps its respect-skip/delivered behavior (unchanged) — this only
  // applies to ad-hoc URL submissions.
  const prior = getEpisode(vid);
  if (prior && prior.status !== 'new') {
    setEpisodeStatus(vid, 'new', null);
  }

  const result = await runEpisode({ url, dryRun, markDeliveredOnSend: false });

  // If deliver returned `empty`, the pipeline ran but found nothing to brief
  // (most often: transcript-io returned no transcript). Surface the actual
  // skip reason from the DB so the UI shows a real error instead of a
  // misleading "Brief emailed" success.
  if (result?.empty) {
    const ep = getEpisode(vid);
    const reason = ep?.skip_reason
      ? `episode skipped: ${ep.skip_reason}`
      : `episode produced no ranked items (status: ${ep?.status || 'unknown'})`;
    throw new Error(reason);
  }

  return {
    ok:        true,
    video_id:  vid,
    sent:      !!result?.delivered,
    path:      result?.path || null,
    rolled_up: true,
  };
}));

// --- Admin: DB backup & restore --------------------------------------------
//
// These endpoints are protected by Cloudflare Access in production. Locally
// the server binds to 127.0.0.1, so no extra auth is needed. The restore
// endpoint must NOT be exposed to the public internet — if you ever bind to
// 0.0.0.0 without an auth layer in front, gate this behind a token.

// List on-volume snapshots so the user can see what's there before restoring.
app.get('/api/admin/backups', wrap(() => {
  if (!fs.existsSync(BACKUPS_DIR)) return { backups: [] };
  const items = fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.endsWith('.db.gz') || f.endsWith('.db'))
    .map(name => {
      const full = path.join(BACKUPS_DIR, name);
      const st = fs.statSync(full);
      return { name, bytes: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  return { backups: items, dir: BACKUPS_DIR };
}));

// Trigger an on-demand backup (also runs daily via pipeline). emailIfDue is
// off for manual runs — a button-press shouldn't surprise-email a copy.
app.post('/api/admin/backup', wrap(async () => {
  const result = await backupDatabase({ emailIfDue: false });
  return { ok: true, file: path.basename(result.path), bytes: result.bytes };
}));

// Replace state.db with an uploaded snapshot. Expects raw application/octet-
// stream (the browser reads the file via FileReader and POSTs the buffer).
// Snapshots the existing DB, writes the upload to a temp file, then swaps
// it in atomically and resets the singleton DB handle so the next query
// opens against the new file. The process keeps running — no restart
// needed, which matters because Railway's restartPolicyType=ON_FAILURE
// would not restart the service after a process.exit(0).
app.post('/api/admin/restore-db',
  express.raw({ type: 'application/octet-stream', limit: '500mb' }),
  wrap(req => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 100) {
      throw new Error('bad request: expected a binary state.db upload (application/octet-stream)');
    }
    // SQLite header magic: bytes 0-15 are ASCII "SQLite format 3" + NUL.
    // If the upload is gzipped (0x1f 0x8b), tell the user to gunzip first.
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      throw new Error('bad upload: file is gzipped; gunzip it first then try again');
    }
    const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
    if (Buffer.compare(buf.subarray(0, 16), SQLITE_MAGIC) !== 0) {
      throw new Error('not a valid SQLite database (bad header)');
    }

    // Snapshot current DB while it's still open so a botched restore is
    // recoverable.
    let preRestorePath;
    try {
      preRestorePath = snapshotForRestore();
    } catch (err) {
      throw new Error(`could not snapshot current DB before restore: ${err.message}`);
    }

    // Write upload to a sibling temp file first, then atomic rename — keeps
    // the live DB intact if disk fills up mid-write.
    const tmpPath = `${DB_PATH}.incoming`;
    fs.writeFileSync(tmpPath, buf);

    // Close the live connection and drop the singleton so the swap below is
    // safe (the OS can replace the file even while a handle is open, but the
    // existing connection would then be pointing at the wrong inode and
    // queries would behave unpredictably).
    resetDb();

    // Stale WAL/SHM sidecars from the pre-restore DB would be applied on
    // re-open and corrupt the freshly uploaded snapshot.
    for (const ext of ['-wal', '-shm']) {
      const sidecar = `${DB_PATH}${ext}`;
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    }
    fs.renameSync(tmpPath, DB_PATH);

    // Eagerly reopen so any error (bad upload, schema-incompatible DB) is
    // surfaced in this response rather than the next unrelated request. db()
    // also runs the migration pass, so the new file picks up any columns
    // added since whenever it was snapshotted.
    db();

    log.ok('state.db replaced and reopened', {
      bytes: buf.length,
      pre_restore_backup: path.basename(preRestorePath),
    });

    return {
      ok: true,
      bytes: buf.length,
      pre_restore_backup: path.basename(preRestorePath),
      note: 'Database swapped in place. Refresh the page now to see the new data.',
    };
  })
);

// --- Daily-brief scheduler --------------------------------------------------
//
// Replaces the separate Railway "cron" service that previously ran
// `npm run brief` on a schedule. That setup was split-brained: Railway
// volumes are single-attach, so the cron and web services each had their
// own state.db — daily-run output never made it into the web UI.
//
// Single in-process scheduler fixes that for good: one service, one
// volume, one DB. Scheduler fires once a day at DAILY_HOUR_UTC (08:00
// UTC = 4am EDT / 3am EST — the hour is fixed in UTC, so it drifts an
// hour relative to ET across DST changes; that's intentional and
// acceptable for a morning brief). Moved earlier (was 10:00 UTC) to add
// buffer for podcast transcription: a 90-min episode is ~14 min of GPU
// and several can land in one run, so we start before dawn ET to keep
// the brief in the inbox by morning. Manual triggers via
// POST /api/admin/run-daily are also supported (fire-and-forget; client
// doesn't wait for the full pipeline).

const DAILY_HOUR_UTC = 8;
let dailyTimer = null;
let dailyRunning = false;

function msUntilNextDailyRun() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(DAILY_HOUR_UTC, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleDailyRun() {
  if (dailyTimer) clearTimeout(dailyTimer);
  const ms = msUntilNextDailyRun();
  const at = new Date(Date.now() + ms).toISOString();
  log.info('daily brief scheduled', { at, in_hours: (ms / 3600_000).toFixed(2) });
  dailyTimer = setTimeout(async () => {
    await runDailyInBackground('scheduled');
    scheduleDailyRun();
  }, ms);
}

async function runDailyInBackground(trigger) {
  if (dailyRunning) {
    log.warn('daily run already in progress, ignoring new trigger', { trigger });
    return;
  }
  dailyRunning = true;
  const startedAt = Date.now();
  log.info('daily run starting', { trigger });
  try {
    await runDaily({});
    log.ok('daily run finished', { trigger, ms: Date.now() - startedAt });
  } catch (err) {
    log.error('daily run failed', { trigger, err: err.message, stack: err.stack });
  } finally {
    dailyRunning = false;
  }
}

// Manual trigger for the daily brief. Returns immediately; the actual run
// continues in the background. Useful for testing the pipeline on prod
// after a config change without waiting for 11:00 UTC.
app.post('/api/admin/run-daily', wrap(() => {
  if (dailyRunning) {
    return { started: false, reason: 'a daily run is already in progress' };
  }
  // Fire-and-forget. The .catch is belt-and-suspenders — runDailyInBackground
  // already catches and logs, but Node would still emit unhandled-rejection
  // warnings if the function ever threw synchronously before the try block.
  runDailyInBackground('manual').catch(err =>
    log.error('manual daily trigger crashed', { err: err.message })
  );
  return {
    started: true,
    note: 'Daily run started in the background. Watch service logs for progress; typical duration 5-10 min.',
  };
}));

// --- start ------------------------------------------------------------------

const server = app.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`Podcast sources UI running at ${url}`);
  console.log('Edits write directly to config/sources.yaml. Ctrl+C to stop.');
  // Only auto-open the browser when running locally on Windows/macOS/Linux
  // desktop. In a container (Railway, Docker) there's no browser to open.
  if (HOST === '127.0.0.1') openBrowser(url);
  // Scheduler runs only in Railway mode (PORT env var set). Locally, use
  // `npm run brief` for manual daily runs — no point firing a real daily
  // at 11:00 UTC against a dev DB. Override by setting RUN_DAILY_LOCALLY=1.
  if (process.env.PORT || process.env.RUN_DAILY_LOCALLY) {
    scheduleDailyRun();
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is in use. Set WEB_PORT=<other> and try again.`);
    process.exit(1);
  }
  throw err;
});

function openBrowser(url) {
  try {
    const cmd =
      process.platform === 'win32'  ? ['cmd',  ['/c', 'start', '', url]] :
      process.platform === 'darwin' ? ['open', [url]] :
                                       ['xdg-open', [url]];
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Browser auto-open is best-effort. The URL is already printed above.
  }
}
