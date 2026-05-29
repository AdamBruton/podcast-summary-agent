// Loads .env, sources.yaml, and profile.md. Validates required env vars
// lazily — only what the requested stages actually need.

import { config as dotenvConfig } from 'dotenv';
// override: true so the project's .env wins over any stale/empty system env
// vars (e.g. an earlier ANTHROPIC_API_KEY set globally). When invoked from
// n8n with no .env file present, externally-set vars are still used.
dotenvConfig({ override: true });
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');
export const PROMPT_DIR = path.join(ROOT, 'prompts');

// Path strategy:
//
//   LOCAL dev (no RAILWAY_VOLUME_MOUNT_PATH):
//     DATA_DIR   = ROOT/data            (gitignored, runtime state)
//     CONFIG_DIR = ROOT/config          (git-tracked, edited via web UI)
//
//   RAILWAY production (RAILWAY_VOLUME_MOUNT_PATH set to e.g. /data):
//     DATA_DIR   = $RAILWAY_VOLUME_MOUNT_PATH         (persistent volume)
//     CONFIG_DIR = $RAILWAY_VOLUME_MOUNT_PATH/config  (persistent, editable
//                                                      via the deployed UI;
//                                                      seeded from ROOT/config
//                                                      on first run)
//
// Volume detection lets the same codebase run in both modes without
// per-environment config — locally you keep the git-tracked workflow;
// in production, edits land on the volume and survive deploys.
const railwayVolume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
export const DATA_DIR   = railwayVolume || path.join(ROOT, 'data');
export const CONFIG_DIR = railwayVolume
  ? path.join(railwayVolume, 'config')
  : path.join(ROOT, 'config');
export const TRANSCRIPT_DIR = path.join(DATA_DIR, 'transcripts');
export const BRIEF_DIR  = path.join(DATA_DIR, 'briefs');
export const DB_PATH    = path.join(DATA_DIR, 'state.db');

// Ensure runtime dirs exist on first import.
for (const d of [DATA_DIR, CONFIG_DIR, TRANSCRIPT_DIR, BRIEF_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

// First-run config seeding: in Railway mode, copy sources.yaml + profile.md
// from the image's bundled ROOT/config to the empty volume on first boot.
// Subsequent boots find the files already on the volume and skip.
if (railwayVolume) {
  const seedDir = path.join(ROOT, 'config');
  for (const file of ['sources.yaml', 'profile.md']) {
    const dest = path.join(CONFIG_DIR, file);
    const src  = path.join(seedDir,    file);
    if (!fs.existsSync(dest) && fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.error(`[config] seeded ${file} from image → volume`);
    }
  }
}

export function loadSources() {
  const raw = fs.readFileSync(path.join(CONFIG_DIR, 'sources.yaml'), 'utf8');
  const parsed = YAML.parse(raw);
  const channels = (parsed.channels || []).filter(c => c.enabled !== false);
  const podcasts = (parsed.podcasts || []).filter(p => p.enabled !== false);
  return {
    channels,
    // Podcasts are RSS feeds polled daily for new episodes. See src/lib/rss.js
    // and the podcast branch of src/stages/1-ingest.js.
    podcasts,
    // individuals is a list of names (people OR companies) that Discovery
    // searches for daily. See src/stages/1b-discover.js.
    individuals: parsed.individuals || [],
    discovery:   parsed.discovery   || null,
  };
}

export function loadProfile() {
  return fs.readFileSync(path.join(CONFIG_DIR, 'profile.md'), 'utf8');
}

export function loadPrompt(name) {
  return fs.readFileSync(path.join(PROMPT_DIR, `${name}.md`), 'utf8');
}

export function requireEnv(...keys) {
  const missing = keys.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}. ` +
      `Copy .env.example to .env and fill them in.`);
  }
  return Object.fromEntries(keys.map(k => [k, process.env[k]]));
}
