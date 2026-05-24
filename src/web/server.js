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
import { listEpisodesWithCounts, getEpisodeDetail } from '../lib/db.js';
import { resolveHandle, videoIdFromUrl } from '../lib/youtube.js';
import { runEpisode } from '../pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEB_PORT) || 3000;
const HOST = '127.0.0.1';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

  const result = await runEpisode({ url, dryRun, markDeliveredOnSend: false });
  return {
    ok:        true,
    video_id:  vid,
    sent:      !!result?.delivered,
    path:      result?.path || null,
    rolled_up: true,    // episode will appear in tomorrow's daily run
  };
}));

// --- start ------------------------------------------------------------------

const server = app.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`Podcast sources UI running at ${url}`);
  console.log('Edits write directly to config/sources.yaml. Ctrl+C to stop.');
  openBrowser(url);
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
