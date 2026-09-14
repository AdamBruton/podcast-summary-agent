// Volume housekeeping: what is on the data volume, and how to get space back.
//
// Background: the daily run died with SQLite's "database or disk is full"
// (2026-09-14). Everything persistent lives on ONE Railway volume — state.db
// (+ WAL), 14 rotated backups, config, and whatever legacy files earlier
// pipeline versions left behind (yt-dlp .vtt captions / audio downloads in
// transcripts/). Nothing bounded the total, nothing reported it, and a failed
// backup on a tight volume left a partial uncompressed snapshot behind every
// morning — so a nearly-full volume became a full one.
//
// This module gives the app three things:
//   diskReport()      — where the bytes are (volume, DB file + tables, dirs)
//   cleanupDisk()     — opt-in reclamation (partials, old backups, legacy
//                       files, old transcripts, VACUUM) used by the admin
//                       endpoint + CLI
//   housekeepDaily()  — the safe subset that runs at the start of every daily
//                       run so the volume stops filling up on its own
//
// The biggest steady-state consumer is transcripts.cues_json: ~0.2-0.5 MB per
// episode, kept forever, needed only until the episode is extracted (rank,
// compose and the inspector all work from candidates/rankings). Transcripts of
// delivered/skipped episodes older than TRANSCRIPT_RETENTION_DAYS are pruned;
// an ad-hoc re-run of an old URL simply re-fetches (transcript-io call, or a
// Modal GPU job for a podcast).

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DB_PATH, TRANSCRIPT_DIR, BRIEF_DIR, CONFIG_DIR } from './config.js';
import { db } from './db.js';
import { log } from './log.js';

export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

// Days after which the transcript of a delivered/skipped episode is dropped
// during daily housekeeping. 0 disables pruning.
export const TRANSCRIPT_RETENTION_DAYS = envInt('TRANSCRIPT_RETENTION_DAYS', 90);

// Same knob backup.js uses for rotation; exported from here so the cleanup
// defaults and the UI agree with the daily rotation.
export const BACKUP_KEEP_LAST_N = envInt('BACKUP_KEEP_LAST', 14);

const MB = 1024 * 1024;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / (1024 * MB)).toFixed(2)} GB`;
}

// --- measurement -----------------------------------------------------------

// Free/total bytes of the filesystem holding DATA_DIR (the Railway volume in
// prod, the local disk in dev). null if statfs is unavailable.
export function volumeStats(dir = DATA_DIR) {
  try {
    const s = fs.statfsSync(dir);
    const bsize = Number(s.bsize);
    const total_bytes = Number(s.blocks) * bsize;
    const free_bytes  = Number(s.bavail) * bsize;
    const used_bytes  = total_bytes - free_bytes;
    return {
      total_bytes, free_bytes, used_bytes,
      used_pct: total_bytes ? Math.round((used_bytes / total_bytes) * 100) : null,
    };
  } catch {
    return null;
  }
}

function statSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

// Recursive size + file count. Missing dir → zeros.
export function dirUsage(dir) {
  let files = 0, bytes = 0;
  const walk = d => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) { files++; bytes += statSize(full); }
    }
  };
  walk(dir);
  return { files, bytes };
}

// Classify what's in backups/. Rotated snapshots are `state-<ts>.db.gz`.
// A bare `state-<ts>.db` is a leftover from a backup that died mid-way (VACUUM
// INTO or gzip failed — typically because the disk was full), and is never
// touched by rotation. `state.pre-restore-<ts>.db` are the uncompressed
// safety copies the restore endpoint takes; deliberately not rotated.
export function classifyBackups() {
  const out = { rotated: [], partial: [], pre_restore: [], other: [] };
  let names;
  try { names = fs.readdirSync(BACKUPS_DIR); } catch { return out; }
  const set = new Set(names);
  for (const name of names) {
    const full = path.join(BACKUPS_DIR, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    const entry = { name, full, bytes: st.size, mtime: st.mtimeMs };
    if (/^state\.pre-restore-.*\.db$/.test(name)) out.pre_restore.push(entry);
    else if (/^state-.*\.db$/.test(name)) out.partial.push(entry);
    else if (/^state-.*\.db\.gz$/.test(name)) {
      // A .gz whose uncompressed sibling still exists was never finished.
      if (set.has(name.slice(0, -3))) out.partial.push(entry);
      else out.rotated.push(entry);
    } else out.other.push(entry);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => b.mtime - a.mtime);
  return out;
}

function sum(list) { return list.reduce((n, f) => n + f.bytes, 0); }

export function dbFileStats() {
  try { db(); } catch { /* reported below via pages=null */ }
  const main = statSize(DB_PATH);
  const wal  = statSize(`${DB_PATH}-wal`);
  const shm  = statSize(`${DB_PATH}-shm`);
  const incoming = statSize(`${DB_PATH}.incoming`);
  let pages = null;
  try {
    const d = db();
    const page_size = Number(d.prepare('PRAGMA page_size').get().page_size);
    const page_count = Number(d.prepare('PRAGMA page_count').get().page_count);
    const freelist_count = Number(d.prepare('PRAGMA freelist_count').get().freelist_count);
    pages = { page_size, page_count, freelist_count, free_bytes: page_size * freelist_count };
  } catch { /* DB unreadable — report file sizes only */ }
  return { main_bytes: main, wal_bytes: wal, shm_bytes: shm, incoming_bytes: incoming, pages };
}

function tableRow(sql) {
  try { return db().prepare(sql).get(); } catch { return null; }
}

// Row counts + approximate payload bytes of the tables that can actually
// grow. LENGTH() on TEXT is the honest proxy for on-disk size here.
export function tableStats() {
  const q = (name, sql) => {
    const r = tableRow(sql);
    return { table: name, rows: Number(r?.rows || 0), bytes: Number(r?.bytes || 0) };
  };
  return [
    q('transcripts', `SELECT COUNT(*) rows, COALESCE(SUM(LENGTH(cues_json)),0) bytes FROM transcripts`),
    q('candidates',  `SELECT COUNT(*) rows, COALESCE(SUM(LENGTH(claim)+LENGTH(COALESCE(supporting_quote,''))),0) bytes FROM candidates`),
    q('episodes',    `SELECT COUNT(*) rows, COALESCE(SUM(LENGTH(COALESCE(description,''))+LENGTH(COALESCE(title,''))),0) bytes FROM episodes`),
    q('discoveries', `SELECT COUNT(*) rows, COALESCE(SUM(LENGTH(COALESCE(title,''))+LENGTH(COALESCE(decision_reason,''))),0) bytes FROM discoveries`),
    q('rankings',    `SELECT COUNT(*) rows, COALESCE(SUM(LENGTH(COALESCE(why_matters,''))+LENGTH(COALESCE(display_quote,''))),0) bytes FROM rankings`),
    q('cost_ledger', `SELECT COUNT(*) rows, 0 bytes FROM cost_ledger`),
  ];
}

// Transcripts the retention policy would drop right now.
export function prunableTranscripts(olderThanDays) {
  if (!olderThanDays || olderThanDays <= 0) return { rows: 0, bytes: 0 };
  const r = tableRow(`
    SELECT COUNT(*) rows, COALESCE(SUM(LENGTH(t.cues_json)),0) bytes
      FROM transcripts t
      JOIN episodes e ON e.video_id = t.video_id
     WHERE e.status IN ('delivered','skipped')
       AND e.ingested_at < datetime('now', '-${Math.floor(olderThanDays)} days')
  `);
  return { rows: Number(r?.rows || 0), bytes: Number(r?.bytes || 0) };
}

// Everything at the top level of DATA_DIR, so an unexpected hog (an `audio/`
// dir from an old pipeline, say) shows up instead of hiding in "other".
function topLevelEntries() {
  let names;
  try { names = fs.readdirSync(DATA_DIR, { withFileTypes: true }); } catch { return []; }
  return names.map(ent => {
    const full = path.join(DATA_DIR, ent.name);
    if (ent.isDirectory()) return { name: `${ent.name}/`, ...dirUsage(full) };
    return { name: ent.name, files: 1, bytes: statSize(full) };
  }).sort((a, b) => b.bytes - a.bytes);
}

export function diskReport() {
  const volume = volumeStats();
  const dbFiles = dbFileStats();
  const backups = classifyBackups();
  const legacy = dirUsage(TRANSCRIPT_DIR); // nothing reads this dir any more
  const briefs = dirUsage(BRIEF_DIR);
  const config = dirUsage(CONFIG_DIR);
  const tables = tableStats();
  const prunable = prunableTranscripts(TRANSCRIPT_RETENTION_DAYS);
  const low = volume && (volume.free_bytes < 100 * MB || volume.used_pct >= 90);
  return {
    data_dir: DATA_DIR,
    generated_at: new Date().toISOString(),
    volume,
    low_space: Boolean(low),
    db: {
      path: DB_PATH,
      ...dbFiles,
      total_bytes: dbFiles.main_bytes + dbFiles.wal_bytes + dbFiles.shm_bytes,
    },
    tables,
    transcript_retention_days: TRANSCRIPT_RETENTION_DAYS,
    prunable_transcripts: prunable,
    backups: {
      dir: BACKUPS_DIR,
      keep_last_n: BACKUP_KEEP_LAST_N,
      rotated:     { files: backups.rotated.length,     bytes: sum(backups.rotated) },
      partial:     { files: backups.partial.length,     bytes: sum(backups.partial) },
      pre_restore: { files: backups.pre_restore.length, bytes: sum(backups.pre_restore) },
      other:       { files: backups.other.length,       bytes: sum(backups.other) },
      total_bytes: sum([...backups.rotated, ...backups.partial, ...backups.pre_restore, ...backups.other]),
    },
    legacy_transcript_files: { dir: TRANSCRIPT_DIR, ...legacy },
    briefs: { dir: BRIEF_DIR, ...briefs },
    config: { dir: CONFIG_DIR, ...config },
    top_level: topLevelEntries(),
  };
}

// Plain-text summary for logs and the failure email.
export function formatDiskSummary(r) {
  const lines = [];
  if (r.volume) {
    lines.push(`Volume ${r.data_dir}: ${fmtBytes(r.volume.used_bytes)} used of ` +
               `${fmtBytes(r.volume.total_bytes)} (${r.volume.used_pct}%), ${fmtBytes(r.volume.free_bytes)} free`);
  } else {
    lines.push(`Volume ${r.data_dir}: (statfs unavailable)`);
  }
  lines.push(`state.db: ${fmtBytes(r.db.main_bytes)} + WAL ${fmtBytes(r.db.wal_bytes)}` +
             (r.db.pages ? ` (${fmtBytes(r.db.pages.free_bytes)} free inside the file)` : ''));
  for (const t of r.tables) {
    if (t.bytes || t.table === 'transcripts') lines.push(`  ${t.table}: ${t.rows} rows, ~${fmtBytes(t.bytes)}`);
  }
  lines.push(`backups/: ${r.backups.rotated.files} rotated (${fmtBytes(r.backups.rotated.bytes)})` +
             (r.backups.partial.files ? `, ${r.backups.partial.files} FAILED-BACKUP LEFTOVERS (${fmtBytes(r.backups.partial.bytes)})` : '') +
             (r.backups.pre_restore.files ? `, ${r.backups.pre_restore.files} pre-restore (${fmtBytes(r.backups.pre_restore.bytes)})` : ''));
  if (r.legacy_transcript_files.files) {
    lines.push(`transcripts/ (legacy, unused): ${r.legacy_transcript_files.files} files, ${fmtBytes(r.legacy_transcript_files.bytes)}`);
  }
  if (r.db.incoming_bytes) lines.push(`state.db.incoming (failed restore upload): ${fmtBytes(r.db.incoming_bytes)}`);
  if (r.prunable_transcripts.rows) {
    lines.push(`prunable transcripts (>${r.transcript_retention_days}d, delivered/skipped): ` +
               `${r.prunable_transcripts.rows} rows, ~${fmtBytes(r.prunable_transcripts.bytes)}`);
  }
  return lines.join('\n');
}

// --- reclamation -----------------------------------------------------------

function unlinkAll(entries) {
  let files = 0, bytes = 0;
  for (const f of entries) {
    try { fs.unlinkSync(f.full); files++; bytes += f.bytes; }
    catch (err) { log.warn('could not delete', { file: f.full, err: err.message }); }
  }
  return { files, bytes };
}

// Failed-backup leftovers + a stranded restore upload. Always safe: none of
// these are ever read by anything.
export function removePartialFiles() {
  const { partial } = classifyBackups();
  const targets = [...partial];
  const incoming = `${DB_PATH}.incoming`;
  const incomingBytes = statSize(incoming);
  if (incomingBytes) targets.push({ full: incoming, bytes: incomingBytes });
  return unlinkAll(targets);
}

// Keep the newest `keep` rotated snapshots, delete the rest.
export function trimBackups(keep = BACKUP_KEEP_LAST_N) {
  const { rotated } = classifyBackups();
  return unlinkAll(rotated.slice(Math.max(0, keep)));
}

export function removePreRestoreSnapshots() {
  return unlinkAll(classifyBackups().pre_restore);
}

// transcripts/ held yt-dlp .vtt captions and audio downloads before the
// transcript-io / Modal era. Nothing reads it now.
export function removeLegacyTranscriptFiles() {
  let files = 0, bytes = 0;
  const walk = d => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) { walk(full); try { fs.rmdirSync(full); } catch { /* not empty */ } }
      else {
        const b = statSize(full);
        try { fs.unlinkSync(full); files++; bytes += b; }
        catch (err) { log.warn('could not delete legacy file', { file: full, err: err.message }); }
      }
    }
  };
  walk(TRANSCRIPT_DIR);
  return { files, bytes };
}

// Drop cues_json for delivered/skipped episodes older than N days. Frees pages
// inside state.db for reuse (the file itself only shrinks on VACUUM), which is
// enough to stop growth. Candidates/rankings/feedback are untouched.
export function pruneTranscripts(olderThanDays = TRANSCRIPT_RETENTION_DAYS) {
  if (!olderThanDays || olderThanDays <= 0) return { rows: 0, bytes: 0, skipped: 'retention disabled' };
  const before = prunableTranscripts(olderThanDays);
  if (!before.rows) return { rows: 0, bytes: 0 };
  const info = db().prepare(`
    DELETE FROM transcripts
     WHERE video_id IN (
       SELECT t.video_id
         FROM transcripts t
         JOIN episodes e ON e.video_id = t.video_id
        WHERE e.status IN ('delivered','skipped')
          AND e.ingested_at < datetime('now', '-${Math.floor(olderThanDays)} days')
     )
  `).run();
  return { rows: Number(info.changes), bytes: before.bytes };
}

// Fold the WAL back into the main file and truncate it to zero bytes. Cheap,
// and the only writer is this process, so it always succeeds.
export function checkpointWal() {
  try { db().exec('PRAGMA wal_checkpoint(TRUNCATE)'); return true; }
  catch (err) { log.warn('wal checkpoint failed', { err: err.message }); return false; }
}

// Rewrite state.db without its free pages. In WAL mode the whole new image
// passes through the WAL on the same volume, so it needs roughly the DB's
// size in free space — on a full volume this would fail exactly like the
// daily run did, so it's guarded and never automatic.
export function vacuumDb() {
  const before = dbFileStats();
  const vol = volumeStats();
  const need = Math.ceil(before.main_bytes * 1.2) + 16 * MB;
  if (vol && vol.free_bytes < need) {
    return {
      ok: false,
      skipped: `not enough free space to VACUUM safely: ${fmtBytes(vol.free_bytes)} free, need ~${fmtBytes(need)}`,
    };
  }
  db().exec('VACUUM');
  checkpointWal();
  const after = dbFileStats();
  return { ok: true, before_bytes: before.main_bytes, after_bytes: after.main_bytes,
           freed_bytes: Math.max(0, before.main_bytes - after.main_bytes) };
}

// One call for the admin endpoint / CLI. Every step is opt-in; defaults are
// the ones that never lose anything you'd miss.
export function cleanupDisk({
  partials = true,
  legacyFiles = true,
  keepBackups = null,          // number → trim rotated snapshots to that many
  preRestore = false,
  pruneTranscriptDays = null,  // number → prune; null → skip
  vacuum = false,
} = {}) {
  const actions = [];
  let freed = 0;
  const step = (name, fn) => {
    try {
      const r = fn();
      actions.push({ action: name, ...r });
      freed += r.bytes || r.freed_bytes || 0;
    } catch (err) {
      actions.push({ action: name, error: err.message });
      log.warn(`disk cleanup step failed: ${name}`, { err: err.message });
    }
  };
  if (partials) step('remove failed-backup leftovers', removePartialFiles);
  if (legacyFiles) step('remove legacy transcripts/ files', removeLegacyTranscriptFiles);
  if (Number.isFinite(keepBackups)) step(`trim backups to newest ${keepBackups}`, () => trimBackups(keepBackups));
  if (preRestore) step('remove pre-restore snapshots', removePreRestoreSnapshots);
  if (Number.isFinite(pruneTranscriptDays) && pruneTranscriptDays > 0) {
    step(`prune transcripts older than ${pruneTranscriptDays}d`, () => pruneTranscripts(pruneTranscriptDays));
  }
  step('checkpoint WAL', () => ({ ok: checkpointWal(), bytes: 0 }));
  if (vacuum) step('VACUUM state.db', vacuumDb);
  const report = diskReport();
  log.ok('disk cleanup done', { freed_bytes: freed, free_now: report.volume?.free_bytes });
  return { freed_bytes: freed, actions, report };
}

// Start-of-daily-run housekeeping: log where the bytes are, clear anything a
// previous failed run left behind, apply transcript retention, truncate the
// WAL. Never throws — callers still wrap it, but a housekeeping problem must
// not block the brief.
export function housekeepDaily() {
  const summary = {};
  try {
    summary.partials = removePartialFiles();
    summary.legacy = removeLegacyTranscriptFiles();
    summary.pruned = pruneTranscripts(TRANSCRIPT_RETENTION_DAYS);
    summary.wal_checkpoint = checkpointWal();
  } catch (err) {
    log.warn('housekeeping step failed (continuing)', { err: err.message });
  }
  let report = null;
  try {
    report = diskReport();
    const meta = {
      volume_free: fmtBytes(report.volume?.free_bytes),
      volume_used_pct: report.volume?.used_pct,
      db: fmtBytes(report.db.main_bytes),
      backups: fmtBytes(report.backups.total_bytes),
      pruned_transcripts: summary.pruned?.rows || 0,
      removed_partials: summary.partials?.files || 0,
      removed_legacy: summary.legacy?.files || 0,
    };
    if (report.low_space) log.warn('volume is nearly full — free space via the Disk usage panel', meta);
    else log.info('disk housekeeping', meta);
  } catch (err) {
    log.warn('disk report failed', { err: err.message });
  }
  return { ...summary, report };
}
