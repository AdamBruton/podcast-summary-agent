// Tiny local web UI for editing config/sources.yaml.
//
// Start with: npm run web
// Then open: http://localhost:3000  (auto-opens in default browser)
//
// No auth — binds to localhost only. If you want it on your LAN, change the
// listen host. Don't expose to the public internet.

import express from 'express';
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
} from '../lib/db.js';
import { resolveHandle, videoIdFromUrl } from '../lib/youtube.js';
import { runEpisode } from '../pipeline.js';
import { complete, parseJsonResponse, MODELS } from '../lib/claude.js';
import { loadPrompt } from '../lib/config.js';
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

// --- start ------------------------------------------------------------------

const server = app.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`Podcast sources UI running at ${url}`);
  console.log('Edits write directly to config/sources.yaml. Ctrl+C to stop.');
  // Only auto-open the browser when running locally on Windows/macOS/Linux
  // desktop. In a container (Railway, Docker) there's no browser to open.
  if (HOST === '127.0.0.1') openBrowser(url);
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
