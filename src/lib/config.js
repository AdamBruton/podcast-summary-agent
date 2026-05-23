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
export const CONFIG_DIR = path.join(ROOT, 'config');
export const DATA_DIR   = path.join(ROOT, 'data');
export const TRANSCRIPT_DIR = path.join(DATA_DIR, 'transcripts');
export const BRIEF_DIR  = path.join(DATA_DIR, 'briefs');
export const DB_PATH    = path.join(DATA_DIR, 'state.db');
export const PROMPT_DIR = path.join(ROOT, 'prompts');

// Ensure runtime dirs exist on first import.
for (const d of [DATA_DIR, TRANSCRIPT_DIR, BRIEF_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

export function loadSources() {
  const raw = fs.readFileSync(path.join(CONFIG_DIR, 'sources.yaml'), 'utf8');
  const parsed = YAML.parse(raw);
  // Flatten channels + companies (both are YouTube channels). individuals are
  // a separate concept used by the ranker.
  const channels = [...(parsed.channels || []), ...(parsed.companies || [])]
    .filter(c => c.enabled !== false);
  return {
    channels,
    individuals: parsed.individuals || [],
    discovery:   parsed.discovery   || null,   // see src/stages/1b-discover.js DEFAULTS
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
