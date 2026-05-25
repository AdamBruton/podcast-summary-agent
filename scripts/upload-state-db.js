// Upload a local state.db to the production web service. This is the
// auto-migration path when seeding prod from local dev (replaces the
// SSH + base64-paste flow).
//
// Usage:
//   node scripts/upload-state-db.js [path-to-local-state.db]
//
// Defaults the local file to ./data/state.db. Required env:
//   ADMIN_UPLOAD_URL          full URL, e.g. https://brief.adambruton.co/api/admin/restore-db
//   CF_ACCESS_CLIENT_ID       Cloudflare Access service token ID
//   CF_ACCESS_CLIENT_SECRET   Cloudflare Access service token secret
//
// The Cloudflare service token must be issued for the Access application
// protecting brief.adambruton.co (Zero Trust → Service Auth → Service Tokens),
// and the Access policy must include an "Include: Service Token" rule
// matching that token.
//
// On success the remote service exits and Railway restarts it; wait ~30
// seconds before hitting the UI again.

import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from '../src/lib/config.js';

const url = process.env.ADMIN_UPLOAD_URL;
if (!url) {
  console.error('ADMIN_UPLOAD_URL is required (e.g. https://brief.adambruton.co/api/admin/restore-db)');
  process.exit(1);
}

const cfId = process.env.CF_ACCESS_CLIENT_ID;
const cfSecret = process.env.CF_ACCESS_CLIENT_SECRET;
if (!cfId || !cfSecret) {
  console.error('CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required to pass Cloudflare Access');
  process.exit(1);
}

const localPath = process.argv[2] || DB_PATH;
if (!fs.existsSync(localPath)) {
  console.error(`local file not found: ${localPath}`);
  process.exit(1);
}

const buf = fs.readFileSync(localPath);
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
if (Buffer.compare(buf.subarray(0, 16), SQLITE_MAGIC) !== 0) {
  console.error(`${localPath} doesn't look like a SQLite database (bad header). If it's gzipped, gunzip it first.`);
  process.exit(1);
}

console.log(`uploading ${path.resolve(localPath)} (${buf.length} bytes) → ${url}`);

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type':            'application/octet-stream',
    'CF-Access-Client-Id':     cfId,
    'CF-Access-Client-Secret': cfSecret,
  },
  body: buf,
});

const text = await res.text();
if (!res.ok) {
  console.error(`upload failed: HTTP ${res.status} ${res.statusText}`);
  console.error(text.slice(0, 2000));
  process.exit(1);
}

try {
  const j = JSON.parse(text);
  console.log(`✓ uploaded ${j.bytes} bytes`);
  console.log(`  pre-restore snapshot saved as: ${j.pre_restore_backup}`);
  console.log(`  ${j.note || 'service is restarting'}`);
} catch {
  console.log('upload OK (server response was not JSON):', text);
}
process.exit(0);
