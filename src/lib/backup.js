// Periodic state.db backups.
//
// Strategy: VACUUM INTO produces a clean, self-contained single-file snapshot
// regardless of WAL state, so we don't have to coordinate with live readers
// or care about -wal/-shm sidecars. Snapshot is gzipped to /data/backups/ and
// the directory is rotated to the last N files.
//
// Off-site: on the configured weekday (default Sunday UTC), the gzipped
// snapshot is attached to an email via Resend. State.db is ~1-2 MB in
// steady state, well under the message-size cap.
//
// Backup runs are intentionally non-fatal: if email is down or the volume
// is full, the daily brief should still go out. Callers wrap in try/catch.
//
// Volume safety (added after the 2026-09-14 "database or disk is full" outage):
// a snapshot needs roughly the DB's size in free space while the uncompressed
// copy and the gzip coexist, so we check the volume first and refuse loudly
// instead of pushing it to 100%; and a snapshot that dies mid-way cleans up
// after itself rather than leaving an uncompressed copy that rotation never
// touched (that leftover, every morning, is how a tight volume became full).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { DB_PATH } from './config.js';
import { sendEmail, emailConfigured } from './mailer.js';
import { db } from './db.js';
import { log } from './log.js';
import {
  BACKUPS_DIR, BACKUP_KEEP_LAST_N, classifyBackups, volumeStats, fmtBytes,
} from './disk.js';

export { BACKUPS_DIR };

// Keep this many gzipped snapshots on disk. Old ones (by mtime) are deleted.
// Override with BACKUP_KEEP_LAST (see disk.js).
const KEEP_LAST_N = BACKUP_KEEP_LAST_N;

// Headroom the volume must keep AFTER a snapshot is written. The daily run
// still has to append transcripts/candidates to state.db afterwards.
const MIN_FREE_AFTER_BACKUP = 64 * 1024 * 1024;

// UTC day-of-week (0 = Sunday) on which to email the weekly off-site copy.
// Daily cron runs at 11:00 UTC, so this stays in sync regardless of TZ.
const EMAIL_DOW = 0;

// Resend caps total message size at ~40 MB. Bail well below that so the
// base64-encoded payload (≈ +33% size) plus headers still fits.
const EMAIL_MAX_BYTES = 20 * 1024 * 1024;

function tsStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// Produces a clean snapshot. Returns the path to the gzipped file.
export async function backupDatabase({ emailIfDue = false } = {}) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  assertRoomForSnapshot();
  const snapshotPath = path.join(BACKUPS_DIR, `state-${tsStamp()}.db`);
  const gzipPath = `${snapshotPath}.gz`;

  try {
    // VACUUM INTO can't be parameter-bound; embed the path literal. Escape
    // single quotes defensively (DATA_DIR comes from env so could theoretically
    // contain anything).
    const escaped = snapshotPath.replace(/'/g, "''");
    db().exec(`VACUUM INTO '${escaped}'`);

    await pipeline(
      fs.createReadStream(snapshotPath),
      zlib.createGzip({ level: 9 }),
      fs.createWriteStream(gzipPath),
    );
  } catch (err) {
    // Don't leave a half-written snapshot (or a truncated .gz) on the volume.
    for (const p of [snapshotPath, gzipPath]) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* best effort */ }
    }
    throw err;
  }
  fs.unlinkSync(snapshotPath);

  const bytes = fs.statSync(gzipPath).size;
  log.ok('db backup written', { file: path.basename(gzipPath), bytes });

  rotateBackups();

  if (emailIfDue && new Date().getUTCDay() === EMAIL_DOW) {
    try { await emailBackup(gzipPath, bytes); }
    catch (err) { log.warn('email backup failed (local snapshot still OK)', { err: err.message }); }
  }

  return { path: gzipPath, bytes };
}

// Refuse to snapshot when the volume can't hold it. While the snapshot is
// being made, the uncompressed copy (≈ state.db) and the growing .gz coexist;
// we also insist on headroom for the rest of the day's writes. Throwing (not
// silently skipping) keeps the failure visible in the run log / admin UI.
function assertRoomForSnapshot() {
  const vol = volumeStats(BACKUPS_DIR);
  if (!vol) return; // statfs unavailable — proceed as before
  let dbBytes = 0;
  try { dbBytes = fs.statSync(DB_PATH).size; } catch { return; }
  const need = dbBytes + Math.ceil(dbBytes / 2) + MIN_FREE_AFTER_BACKUP;
  if (vol.free_bytes < need) {
    throw new Error(
      `backup skipped: volume has ${fmtBytes(vol.free_bytes)} free but a snapshot of ` +
      `state.db (${fmtBytes(dbBytes)}) needs ~${fmtBytes(need)}. ` +
      `Free space via the web UI "Disk usage" panel or \`node scripts/disk-usage.js --cleanup\`.`
    );
  }
}

function rotateBackups() {
  const files = classifyBackups().rotated; // newest first
  for (const f of files.slice(KEEP_LAST_N)) {
    try { fs.unlinkSync(f.full); log.info('rotated old backup', { name: f.name }); }
    catch (err) { log.warn('failed to delete old backup', { name: f.name, err: err.message }); }
  }
}

async function emailBackup(gzipPath, bytes) {
  if (!emailConfigured()) {
    log.info('email backup skipped: email env not configured');
    return;
  }
  if (bytes > EMAIL_MAX_BYTES) {
    log.warn('backup too large to email; on-volume copy only', { bytes });
    return;
  }
  const filename = path.basename(gzipPath);
  const dateStr = new Date().toISOString().slice(0, 10);
  const kb = Math.round(bytes / 1024);
  // Resend base64-encodes the Buffer itself; pass raw bytes.
  const { to } = await sendEmail({
    subject: `Podcast Intel: weekly DB backup ${dateStr} (${kb} KB)`,
    text: [
      `Weekly off-site copy of state.db is attached as ${filename}.`,
      '',
      'To restore:',
      '  1. Save the attachment and gunzip it to get state.db',
      '  2. Open the web UI > "Database backup & restore" > pick the file',
      '  3. The service will swap in the new DB and restart',
      '',
      `Local rotation keeps the last ${KEEP_LAST_N} snapshots on the volume at`,
      `${BACKUPS_DIR}.`,
    ].join('\n'),
    attachments: [{ filename, content: fs.readFileSync(gzipPath) }],
  });
  log.ok('weekly backup emailed', { to, filename, bytes });
}

// Used by the restore endpoint: take a one-off snapshot of the live DB before
// overwriting it. Returns the snapshot path so we can name it in the response.
export function snapshotForRestore() {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const out = path.join(BACKUPS_DIR, `state.pre-restore-${tsStamp()}.db`);
  const escaped = out.replace(/'/g, "''");
  try {
    db().exec(`VACUUM INTO '${escaped}'`);
  } catch (err) {
    // Fall back to a plain file copy if VACUUM fails (e.g. DB file missing).
    log.warn('VACUUM INTO failed; using file copy', { err: err.message });
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, out);
    else fs.writeFileSync(out, '');
  }
  return out;
}
