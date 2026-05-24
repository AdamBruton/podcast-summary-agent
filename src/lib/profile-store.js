// Simple read/write for config/profile.md. The file is plain markdown;
// no parsing, no transformations — we just round-trip the bytes so the
// web UI textarea can edit it freely.
//
// Changes take effect on the next rank pass (daily run, ad-hoc URL summary,
// or scripts/rerank.js). loadPrompt/loadProfile in config.js read fresh
// from disk on every call, so there's no in-memory cache to invalidate.

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';

const PROFILE_PATH = path.join(CONFIG_DIR, 'profile.md');

export function readProfile() {
  return fs.readFileSync(PROFILE_PATH, 'utf8');
}

export function writeProfile(content) {
  if (typeof content !== 'string') throw new Error('profile content must be a string');
  // Trivial sanity floor: don't let the user blank the file by accident.
  // 50 chars is small enough to allow legitimate trimming but big enough
  // to catch "oops I selected all and hit delete".
  if (content.trim().length < 50) {
    throw new Error('profile content looks suspiciously short — refusing to save (use the CLI if you really want to blank it)');
  }
  fs.writeFileSync(PROFILE_PATH, content, 'utf8');
  return { saved: true, bytes: Buffer.byteLength(content, 'utf8') };
}
