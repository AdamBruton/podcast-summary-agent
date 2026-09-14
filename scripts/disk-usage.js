// Show where the data volume's bytes are, and optionally reclaim some.
//
// Usage:
//   node scripts/disk-usage.js                    # report only
//   node scripts/disk-usage.js --cleanup          # safe defaults: failed-backup
//                                                 # leftovers, legacy files,
//                                                 # transcript retention, WAL
//   node scripts/disk-usage.js --cleanup --keep-backups 7 --prune-days 60 --vacuum
//   node scripts/disk-usage.js --json             # machine-readable report
//
// Same logic as the web UI's "Disk usage & housekeeping" panel; handy over
// `railway ssh` when the UI is unreachable.

import { diskReport, cleanupDisk, formatDiskSummary, TRANSCRIPT_RETENTION_DAYS } from '../src/lib/disk.js';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  if (i === -1 || i === args.length - 1) return fallback;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : fallback;
};

if (flag('--cleanup')) {
  const result = cleanupDisk({
    partials: true,
    legacyFiles: true,
    keepBackups: opt('--keep-backups', null),
    preRestore: flag('--pre-restore'),
    pruneTranscriptDays: opt('--prune-days', TRANSCRIPT_RETENTION_DAYS),
    vacuum: flag('--vacuum'),
  });
  for (const a of result.actions) console.log(JSON.stringify(a));
  console.log(`\nfreed ~${result.freed_bytes} bytes\n`);
  console.log(formatDiskSummary(result.report));
} else if (flag('--json')) {
  console.log(JSON.stringify(diskReport(), null, 2));
} else {
  console.log(formatDiskSummary(diskReport()));
}
