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
import { resolveHandle } from '../lib/youtube.js';

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
