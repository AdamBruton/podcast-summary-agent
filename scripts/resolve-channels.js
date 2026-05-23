// One-time setup helper.
//
// For every entry in config/sources.yaml that has a `handle` but a blank
// `channel_id`, resolve the canonical UC... id via yt-dlp and write it
// back into the YAML *in place* — comments, key order, and formatting
// are preserved (we use yaml's Document API, not parse+stringify).
//
// Run when you add new sources, or once at first setup. Idempotent:
// entries that already have a channel_id are left alone.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { resolveHandle } from '../src/lib/youtube.js';
import { CONFIG_DIR } from '../src/lib/config.js';
import { log } from '../src/lib/log.js';

const YAML_PATH = path.join(CONFIG_DIR, 'sources.yaml');

async function fillIdsForList(node, label) {
  if (!node || !node.items) return { filled: 0, skipped: 0, failed: 0 };
  let filled = 0, skipped = 0, failed = 0;
  for (const item of node.items) {
    const name   = item.get('name');
    const handle = item.get('handle');
    const id     = item.get('channel_id');
    if (id) { skipped++; continue; }
    if (!handle) {
      log.warn(`no handle for ${label}: ${name}`);
      failed++;
      continue;
    }
    try {
      const resolved = await resolveHandle(handle);
      if (!resolved || !resolved.startsWith('UC')) {
        log.warn(`resolved value doesn't look like a channel_id`, { name, handle, got: resolved });
        failed++;
        continue;
      }
      item.set('channel_id', resolved);
      filled++;
      log.ok(`resolved ${label}`, { name, handle, channel_id: resolved });
    } catch (err) {
      log.warn(`resolve failed`, { name, handle, err: err.message });
      failed++;
    }
  }
  return { filled, skipped, failed };
}

const src = fs.readFileSync(YAML_PATH, 'utf8');
const doc = YAML.parseDocument(src);

const ch = await fillIdsForList(doc.get('channels'),  'channel');
const co = await fillIdsForList(doc.get('companies'), 'company');

if (ch.filled + co.filled > 0) {
  fs.writeFileSync(YAML_PATH, doc.toString(), 'utf8');
  log.ok('sources.yaml updated', {
    channels:  ch,
    companies: co,
  });
} else {
  log.info('nothing to update — all channel_ids already populated or all resolutions failed', {
    channels:  ch,
    companies: co,
  });
}
