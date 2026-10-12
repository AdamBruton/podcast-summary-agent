// Regression test for volume housekeeping (src/lib/disk.js + backup.js):
// classification of backups/ leftovers, transcript retention, daily
// housekeeping, backup rotation + partial cleanup, and guarded VACUUM.
// Runs against a throwaway data dir (RAILWAY_VOLUME_MOUNT_PATH is set BEFORE
// config.js is imported, so nothing touches ./data or the real volume).
//
//   node scripts/test-disk-housekeeping.js

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const VOL = fs.mkdtempSync(path.join(os.tmpdir(), 'psa-disk-test-'));
process.env.RAILWAY_VOLUME_MOUNT_PATH = VOL;
const { db, upsertEpisode, saveTranscript, setEpisodeStatus, getTranscript } = await import('../src/lib/db.js');
const disk = await import('../src/lib/disk.js');
const { backupDatabase } = await import('../src/lib/backup.js');
const { DATA_DIR, TRANSCRIPT_DIR } = await import('../src/lib/config.js');
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok:', m); };

// Seed: 3 episodes with big transcripts; two old+delivered, one recent+ranked.
const cues = Array.from({ length: 3000 }, (_, i) => ({ start: i, end: i + 1, text: 'lorem ipsum dolor sit amet '.repeat(4) }));
for (const [id, status, age] of [['old1', 'delivered', 200], ['old2', 'skipped', 120], ['new1', 'ranked', 5], ['old3', 'delivered', 10]]) {
  upsertEpisode({ video_id: id, title: id, url: 'u' });
  saveTranscript({ video_id: id, source: 'transcript-io', language: 'en', duration_sec: 100, cues });
  setEpisodeStatus(id, status);
  db().prepare(`UPDATE episodes SET ingested_at = datetime('now', ?) WHERE video_id = ?`).run(`-${age} days`, id);
}
// Leftovers: partial backup, truncated gz w/ sibling, legacy files, stranded restore upload.
fs.mkdirSync(disk.BACKUPS_DIR, { recursive: true });
fs.writeFileSync(path.join(disk.BACKUPS_DIR, 'state-2026-09-13T08-00-00.db'), Buffer.alloc(50000));
fs.writeFileSync(path.join(disk.BACKUPS_DIR, 'state-2026-09-12T08-00-00.db'), Buffer.alloc(50000));
fs.writeFileSync(path.join(disk.BACKUPS_DIR, 'state-2026-09-12T08-00-00.db.gz'), Buffer.alloc(100));
fs.writeFileSync(path.join(disk.BACKUPS_DIR, 'state.pre-restore-2026-01-01T00-00-00.db'), Buffer.alloc(70000));
fs.mkdirSync(path.join(TRANSCRIPT_DIR, 'sub'), { recursive: true });
fs.writeFileSync(path.join(TRANSCRIPT_DIR, 'abc.en.vtt'), 'x'.repeat(1000));
fs.writeFileSync(path.join(TRANSCRIPT_DIR, 'sub', 'abc.mp3'), Buffer.alloc(200000));
fs.writeFileSync(path.join(DATA_DIR, 'state.db.incoming'), Buffer.alloc(3000));
// Make 16 rotated backups to check trimming keeps the newest.
for (let i = 0; i < 16; i++) {
  const f = path.join(disk.BACKUPS_DIR, `state-2026-08-${String(i + 1).padStart(2, '0')}T08-00-00.db.gz`);
  fs.writeFileSync(f, Buffer.alloc(10));
  const t = new Date(Date.UTC(2026, 7, i + 1)); fs.utimesSync(f, t, t);
}

let r = disk.diskReport();
console.log(disk.formatDiskSummary(r));
assert(r.backups.partial.files === 3, 'partials classified (2 .db + 1 orphan .gz)');
assert(r.backups.rotated.files === 16, 'rotated classified');
assert(r.backups.pre_restore.files === 1, 'pre-restore classified');
assert(r.legacy_transcript_files.files === 2, 'legacy files counted');
assert(r.db.incoming_bytes === 3000, 'incoming counted');
assert(r.prunable_transcripts.rows === 2, 'prunable = old delivered + old skipped only');
assert(r.volume && r.volume.total_bytes > 0, 'statfs works');

// housekeepDaily: partials + legacy + prune(90d) + checkpoint; rotated untouched.
const hk = disk.housekeepDaily();
assert(hk.partials.files === 4, 'housekeeping removed 3 partials + incoming');
assert(hk.legacy.files === 2, 'housekeeping removed legacy files');
assert(hk.pruned.rows === 2, 'housekeeping pruned 2 transcripts');
assert(getTranscript('new1') && getTranscript('old3'), 'recent + young transcripts kept');
assert(!getTranscript('old1') && !getTranscript('old2'), 'old transcripts gone');
r = disk.diskReport();
assert(r.backups.rotated.files === 16 && r.backups.pre_restore.files === 1, 'housekeeping leaves rotated + pre-restore');
assert(r.db.wal_bytes === 0, 'WAL truncated');

// Real backup then rotation to 14.
const b = await backupDatabase();
assert(fs.existsSync(b.path) && b.bytes > 0, 'backup written');
r = disk.diskReport();
assert(r.backups.rotated.files === 14 && r.backups.partial.files === 0, 'rotation kept 14, no partial left');
assert(fs.existsSync(path.join(disk.BACKUPS_DIR, 'state-2026-08-16T08-00-00.db.gz')) && !fs.existsSync(path.join(disk.BACKUPS_DIR, 'state-2026-08-01T08-00-00.db.gz')), 'rotation dropped oldest');

// cleanupDisk with everything + vacuum shrinks the file.
const mainBefore = r.db.main_bytes;
const c = disk.cleanupDisk({ keepBackups: 3, preRestore: true, pruneTranscriptDays: 7, vacuum: true });
console.log(JSON.stringify(c.actions, null, 1));
assert(c.report.backups.rotated.files === 3 && c.report.backups.pre_restore.files === 0, 'cleanup trimmed + removed pre-restore');
assert(!getTranscript('old3') && getTranscript('new1'), 'cleanup pruned 10d-old delivered, kept ranked');
const vac = c.actions.find(a => a.action === 'VACUUM state.db');
assert(vac.ok && c.report.db.main_bytes < mainBefore, `vacuum shrank ${mainBefore} -> ${c.report.db.main_bytes}`);
fs.rmSync(VOL, { recursive: true, force: true });
console.log('ALL OK');
