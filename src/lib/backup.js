// Periodic state.db backups.
//
// Strategy: VACUUM INTO produces a clean, self-contained single-file snapshot
// regardless of WAL state, so we don't have to coordinate with live readers
// or care about -wal/-shm sidecars. Snapshot is gzipped to /data/backups/ and
// the directory is rotated to the last N files.
//
// Off-site: on the configured weekday (default Sunday UTC), the gzipped
// snapshot is attached to an email via SendGrid. State.db is ~1-2 MB in
// steady state, well under SendGrid's 30 MB attachment cap.
//
// Backup runs are intentionally non-fatal: if SendGrid is down or the volume
// is full, the daily brief should still go out. Callers wrap in try/catch.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import sgMail from '@sendgrid/mail';
import { DATA_DIR, DB_PATH } from './config.js';
import { db } from './db.js';
import { log } from './log.js';

export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

// Keep this many gzipped snapshots on disk. Old ones (by mtime) are deleted.
const KEEP_LAST_N = 14;

// UTC day-of-week (0 = Sunday) on which to email the weekly off-site copy.
// Daily cron runs at 11:00 UTC, so this stays in sync regardless of TZ.
const EMAIL_DOW = 0;

// SendGrid hard caps attachments at 30 MB. Bail well below that so the
// base64-encoded payload (≈ +33% size) still fits.
const EMAIL_MAX_BYTES = 20 * 1024 * 1024;

function tsStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// Produces a clean snapshot. Returns the path to the gzipped file.
export async function backupDatabase({ emailIfDue = false } = {}) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const snapshotPath = path.join(BACKUPS_DIR, `state-${tsStamp()}.db`);

  // VACUUM INTO can't be parameter-bound; embed the path literal. Escape
  // single quotes defensively (DATA_DIR comes from env so could theoretically
  // contain anything).
  const escaped = snapshotPath.replace(/'/g, "''");
  db().exec(`VACUUM INTO '${escaped}'`);

  const gzipPath = `${snapshotPath}.gz`;
  await pipeline(
    fs.createReadStream(snapshotPath),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(gzipPath),
  );
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

function rotateBackups() {
  const files = fs.readdirSync(BACKUPS_DIR)
    .filter(f => /^state-.*\.db\.gz$/.test(f))
    .map(f => {
      const full = path.join(BACKUPS_DIR, f);
      return { name: f, full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const f of files.slice(KEEP_LAST_N)) {
    try { fs.unlinkSync(f.full); log.info('rotated old backup', { name: f.name }); }
    catch (err) { log.warn('failed to delete old backup', { name: f.name, err: err.message }); }
  }
}

async function emailBackup(gzipPath, bytes) {
  const { SENDGRID_API_KEY, SENDGRID_FROM, SENDGRID_TO } = process.env;
  if (!SENDGRID_API_KEY || !SENDGRID_FROM || !SENDGRID_TO) {
    log.info('email backup skipped: SendGrid env not configured');
    return;
  }
  if (bytes > EMAIL_MAX_BYTES) {
    log.warn('backup too large to email; on-volume copy only', { bytes });
    return;
  }
  sgMail.setApiKey(SENDGRID_API_KEY);
  const filename = path.basename(gzipPath);
  const dateStr = new Date().toISOString().slice(0, 10);
  const kb = Math.round(bytes / 1024);
  await sgMail.send({
    to: SENDGRID_TO,
    from: SENDGRID_FROM,
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
    attachments: [{
      content: fs.readFileSync(gzipPath).toString('base64'),
      filename,
      type: 'application/gzip',
      disposition: 'attachment',
    }],
  });
  log.ok('weekly backup emailed', { to: SENDGRID_TO, filename, bytes });
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
